import type { APIRoute } from 'astro';
import { PROD_TOKEN, PROD_URL, COLLECTION_PREFIX } from '../../lib/env';
import { fetchSnapshot, filterSnapshot } from '@diff';

const TTL_MS = 5 * 60 * 1000;

export interface RelationDetail {
  /** Virtual field name on the page collection (e.g. "blocks", "tags") */
  fieldName: string;
  /** Junction / pivot table name */
  junctionCollection: string;
  /** FK column in the junction pointing back to the page (e.g. "adpower_redesign_pages_id") */
  junctionFk: string;
  /** The other FK column in the junction (points to the related item or is the M2A bridge) */
  junctionField: string;
  /** True when the relation is M2A (polymorphic builder) */
  isM2A: boolean;
  /** For M2A: the discriminator column name in the junction (usually "collection") */
  collectionField: string | null;
  /** For M2A: the allowed block/content types */
  allowedCollections: string[];
  /** For plain M2M: the related collection name */
  relatedCollection: string | null;
  /** Counts keyed by page ID. Each value has total + per-type breakdown for M2A. */
  countsByPageId: Record<string, { total: number; byType: Record<string, number> }>;
  error?: string;
}

export interface PageRelationsData {
  collection: string;
  label: string;
  items: Array<{ id: number | string; title: string; status: string; slug: string | null }>;
  relations: RelationDetail[];
  fetchedAt: number;
  error?: string;
}

// Per-collection cache
const cache = new Map<string, { data: PageRelationsData; fetchedAt: number }>();

export const GET: APIRoute = async ({ url }) => {
  const collection = url.searchParams.get('collection');
  if (!collection) {
    return new Response(JSON.stringify({ error: 'Missing ?collection= parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const forceRefresh = url.searchParams.get('refresh') === 'true';
  const cached = cache.get(collection);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return new Response(JSON.stringify(cached.data), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const token  = PROD_TOKEN();
    const base   = PROD_URL();
    const prefix = COLLECTION_PREFIX();

    const snapshot = await fetchSnapshot(base, token);
    const filtered = filterSnapshot(snapshot, prefix);

    const allRelations: any[] = filtered.relations ?? [];

    // --- Discover M2M relations for this page collection ---
    // A relation is M2M (from the page's perspective) when:
    //   meta.one_collection = this collection   AND   meta.junction_field is set
    const m2mRels = allRelations.filter(
      (r: any) => r.meta?.one_collection === collection && r.meta?.junction_field != null,
    );

    // Build relation detail objects
    const relDetails: Omit<RelationDetail, 'countsByPageId' | 'error'>[] = m2mRels.map((rel: any) => {
      const junctionTable = rel.meta.many_collection as string;
      // FK in the junction that points back to our page collection
      const junctionFk    = rel.field as string;
      // The other FK / bridge field in the junction
      const junctionField = rel.meta.junction_field as string;
      // Virtual field on the page (e.g. "blocks", "tags", "related_articles")
      const fieldName     = (rel.meta.one_field as string) ?? junctionField;

      // Is there an M2A relation on the other side of this junction?
      const m2aRel = allRelations.find(
        (r: any) =>
          r.collection === junctionTable &&
          r.field === junctionField &&
          Array.isArray(r.meta?.one_allowed_collections) &&
          r.meta.one_allowed_collections.length > 0,
      );

      // For plain M2M: find the related collection via the junction's other relation
      const otherSideRel = !m2aRel
        ? allRelations.find(
            (r: any) => r.collection === junctionTable && r.field === junctionField && r.related_collection,
          )
        : null;

      return {
        fieldName,
        junctionCollection: junctionTable,
        junctionFk,
        junctionField,
        isM2A:              !!m2aRel,
        collectionField:    (m2aRel?.meta?.one_collection_field as string | null) ?? (m2aRel ? 'collection' : null),
        allowedCollections: (m2aRel?.meta?.one_allowed_collections as string[]) ?? [],
        relatedCollection:  (otherSideRel?.related_collection as string | null) ?? null,
      };
    });

    // --- Fetch page items ---
    const itemsRes = await fetch(
      `${base}/items/${collection}?fields=id,status,title,name,slug&limit=-1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const items: any[] = itemsRes.ok ? ((await itemsRes.json()).data ?? []) : [];

    // --- Fetch junction item counts for each M2M relation ---
    const relations: RelationDetail[] = await Promise.all(
      relDetails.map(async (rel) => {
        try {
          const collField = rel.collectionField ?? 'collection';
          // Fetch only the FK (+ discriminator for M2A) — lightweight
          const fields = rel.isM2A
            ? `${rel.junctionFk},${collField}`
            : rel.junctionFk;

          const jRes = await fetch(
            `${base}/items/${rel.junctionCollection}?fields=${encodeURIComponent(fields)}&limit=-1`,
            { headers: { Authorization: `Bearer ${token}` } },
          );

          const countsByPageId: RelationDetail['countsByPageId'] = {};

          if (jRes.ok) {
            const { data: rows = [] } = await jRes.json();
            for (const row of rows) {
              const pageId = String(row[rel.junctionFk] ?? '');
              if (!pageId) continue;
              if (!countsByPageId[pageId]) countsByPageId[pageId] = { total: 0, byType: {} };
              countsByPageId[pageId].total++;
              if (rel.isM2A) {
                const blockType = String(row[collField] ?? 'unknown');
                countsByPageId[pageId].byType[blockType] =
                  (countsByPageId[pageId].byType[blockType] ?? 0) + 1;
              }
            }
          }

          return { ...rel, countsByPageId };
        } catch (err: unknown) {
          return {
            ...rel,
            countsByPageId: {},
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    const data: PageRelationsData = {
      collection,
      label: formatLabel(collection, prefix),
      items: items.map((item: any) => ({
        id:     item.id,
        title:  item.title ?? item.name ?? item.slug ?? `#${item.id}`,
        status: item.status ?? 'unknown',
        slug:   item.slug ?? null,
      })),
      relations,
      fetchedAt: Date.now(),
    };

    cache.set(collection, { data, fetchedAt: Date.now() });

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
