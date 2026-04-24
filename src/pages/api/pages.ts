import type { APIRoute } from 'astro';
import { PROD_TOKEN, PROD_URL, COLLECTION_PREFIX } from '../../lib/env';
import { fetchSnapshot, filterSnapshot } from '@diff';

const TTL_MS = 5 * 60 * 1000;

interface PageItem {
  id: number | string;
  status: string;
  title: string;
  permalink: string | null;
  slug: string | null;
}

interface PageCollectionResult {
  collection: string;
  label: string;
  totalItems: number;
  statusBreakdown: Record<string, number>;
  hasContent: boolean;
  blockJunction: string | null;
  allowedBlockTypes: string[];
  items: PageItem[];
  error?: string;
}

interface PagesData {
  pageCollections: PageCollectionResult[];
  totalPages: number;
  totalPublished: number;
  emptyCollections: number;
  fetchedAt: number;
}

let pagesCache: { data: PagesData; fetchedAt: number } | null = null;

export const GET: APIRoute = async ({ url }) => {
  const forceRefresh = url.searchParams.get('refresh') === 'true';

  if (!forceRefresh && pagesCache && Date.now() - pagesCache.fetchedAt < TTL_MS) {
    return new Response(JSON.stringify(pagesCache.data), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const token  = PROD_TOKEN();
    const base   = PROD_URL();
    const prefix = COLLECTION_PREFIX();

    // 1. Get schema snapshot to understand the collection + relation structure
    const snapshot = await fetchSnapshot(base, token);
    const filtered = filterSnapshot(snapshot, prefix);

    const ITEM_FIELDS_WANTED = ['id', 'status', 'title', 'name', 'permalink', 'slug'];

    // Index field names by collection
    const fieldsByCollection = new Map<string, string[]>();
    for (const f of (filtered.fields ?? [])) {
      if (!fieldsByCollection.has(f.collection)) fieldsByCollection.set(f.collection, []);
      fieldsByCollection.get(f.collection)!.push(f.field as string);
    }

    // 2. Detect page collections: have a `status` field, not a junction/block-type table
    const pageCollectionNames: string[] = (filtered.collections ?? [])
      .filter((c: any) => {
        const name: string = c.collection;
        // Exclude junction-style or block-type tables by naming convention
        if (/_blocks$/.test(name))  return false;
        if (/_block_/.test(name))   return false;
        if (/_blocks_/.test(name))  return false;
        // Must have a status field
        const fields = fieldsByCollection.get(name) ?? [];
        return fields.includes('status');
      })
      .map((c: any) => c.collection as string);

    // 3. Detect M2A block relations: look for relations with `one_allowed_collections`
    //    set — these indicate a polymorphic builder field living in a junction table.
    const blockInfoByPage = new Map<string, { junctionCollection: string; allowedBlockTypes: string[] }>();
    for (const rel of (filtered.relations ?? [])) {
      const allowed: string[] | undefined = rel.meta?.one_allowed_collections;
      if (Array.isArray(allowed) && allowed.length > 0) {
        const junctionName: string = rel.collection;
        // Match this junction to its parent page collection by name prefix
        for (const pageName of pageCollectionNames) {
          if (junctionName.startsWith(pageName + '_')) {
            blockInfoByPage.set(pageName, {
              junctionCollection: junctionName,
              allowedBlockTypes: allowed,
            });
            break;
          }
        }
      }
    }

    // 4. Fetch content items for each page collection
    const pageCollections = await Promise.all(
      pageCollectionNames.map(async (collectionName): Promise<PageCollectionResult> => {
        try {
          // Build field list from only the fields that exist in this collection's schema
          const available = fieldsByCollection.get(collectionName) ?? [];
          const fields = ITEM_FIELDS_WANTED.filter(f => available.includes(f));
          if (!fields.includes('id')) fields.unshift('id');
          const res = await fetch(
            `${base}/items/${collectionName}?fields=${fields.join(',')}&limit=-1`,
            { headers: { Authorization: `Bearer ${token}` } },
          );

          let items: any[] = [];
          if (res.ok) {
            const json = await res.json();
            items = json.data ?? [];
          } else {
            const errText = await res.text().catch(() => '');
            return {
              collection: collectionName,
              label: formatLabel(collectionName, prefix),
              totalItems: 0,
              statusBreakdown: {},
              hasContent: false,
              blockJunction: null,
              allowedBlockTypes: [],
              items: [],
              error: `HTTP ${res.status}: ${errText.slice(0, 200)}`,
            };
          }

          // Aggregate by status
          const statusBreakdown: Record<string, number> = {};
          for (const item of items) {
            const s: string = item.status ?? 'unknown';
            statusBreakdown[s] = (statusBreakdown[s] ?? 0) + 1;
          }

          const blockInfo = blockInfoByPage.get(collectionName);

          return {
            collection: collectionName,
            label: formatLabel(collectionName, prefix),
            totalItems: items.length,
            statusBreakdown,
            hasContent: items.length > 0,
            blockJunction: blockInfo?.junctionCollection ?? null,
            allowedBlockTypes: blockInfo?.allowedBlockTypes ?? [],
            items: items.map((item: any): PageItem => ({
              id: item.id,
              status: item.status ?? 'unknown',
              title: item.title ?? item.name ?? item.permalink ?? item.slug ?? `#${item.id}`,
              permalink: item.permalink ?? null,
              slug: item.slug ?? null,
            })),
          };
        } catch (err: unknown) {
          return {
            collection: collectionName,
            label: formatLabel(collectionName, prefix),
            totalItems: 0,
            statusBreakdown: {},
            hasContent: false,
            blockJunction: null,
            allowedBlockTypes: [],
            items: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    // Sort: non-empty collections first, then alphabetically by label
    pageCollections.sort((a, b) => {
      if (a.hasContent !== b.hasContent) return a.hasContent ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

    const data: PagesData = {
      pageCollections,
      totalPages:       pageCollections.reduce((s, c) => s + c.totalItems, 0),
      totalPublished:   pageCollections.reduce((s, c) => s + (c.statusBreakdown['published'] ?? 0), 0),
      emptyCollections: pageCollections.filter(c => !c.hasContent).length,
      fetchedAt:        Date.now(),
    };

    pagesCache = { data, fetchedAt: Date.now() };

    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

function formatLabel(collection: string, prefix: string): string {
  return collection
    .replace(new RegExp(`^${prefix}_`), '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
