import type { APIRoute } from 'astro';
import { DEV_TOKEN, DEV_URL, PROD_TOKEN, PROD_URL, COLLECTION_PREFIX } from '../../lib/env';
import { fetchSnapshot, filterSnapshot } from '@diff';

const TTL_MS = 5 * 60 * 1000;

// ── Interfaces ────────────────────────────────────────────────────────────────

interface PageItemDetail {
  id: number | string;
  status: string;
  title: string;
  permalink: string | null;
  slug: string | null;
  blockCount: number; // best-effort count from junction table
}

interface ItemDiff {
  field: 'status' | 'title' | 'permalink' | 'slug';
  dev: string | null;
  prod: string | null;
}

interface MatchedRow {
  matchKey: string;
  matchKeyType: 'permalink' | 'slug' | 'title' | 'id';
  dev: PageItemDetail | null;
  prod: PageItemDetail | null;
  diffs: ItemDiff[];
}

interface MatchedCollection {
  collection: string;
  label: string;
  devTotal: number;
  prodTotal: number;
  devOnlyCount: number;
  prodOnlyCount: number;
  changedCount: number;
  hasDiffs: boolean;
  rows: MatchedRow[];
  blockJunction: string | null;
  allowedBlockTypes: string[];
  devError?: string;
  prodError?: string;
}

interface PagesDiffData {
  matched: MatchedCollection[];
  devOnlyCollections: string[];
  prodOnlyCollections: string[];
  fetchedAt: number;
  devSnapshotError?: string;
  prodSnapshotError?: string;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

let pagesDiffCache: { data: PagesDiffData; fetchedAt: number } | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatLabel(collection: string, prefix: string): string {
  return collection
    .replace(new RegExp(`^${prefix}_`), '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function isBlockJunctionName(name: string): boolean {
  return /_blocks$/.test(name) || /_block_/.test(name) || /_blocks_/.test(name);
}

const ITEM_FIELDS_WANTED = ['id', 'status', 'title', 'name', 'permalink', 'slug'] as const;

function getPageCollections(snapshot: any, prefix: string): {
  names: string[];
  fieldsByCollection: Map<string, string[]>;
} {
  const filtered = filterSnapshot(snapshot, prefix);
  const fieldsByCollection = new Map<string, string[]>();
  for (const f of (filtered.fields ?? [])) {
    if (!fieldsByCollection.has(f.collection)) fieldsByCollection.set(f.collection, []);
    fieldsByCollection.get(f.collection)!.push(f.field as string);
  }
  const names = (filtered.collections ?? [])
    .filter((c: any) => {
      const name: string = c.collection;
      if (isBlockJunctionName(name)) return false;
      const fields = fieldsByCollection.get(name) ?? [];
      return fields.includes('status');
    })
    .map((c: any) => c.collection as string);
  return { names, fieldsByCollection };
}

/** Returns only the wanted fields that exist in the given collection per the snapshot. */
function resolveItemFields(fieldsByCollection: Map<string, string[]>, collectionName: string): string {
  const available = fieldsByCollection.get(collectionName) ?? [];
  const fields = ITEM_FIELDS_WANTED.filter(f => available.includes(f));
  // id is always included by Directus even if not in schema fields list
  if (!fields.includes('id')) fields.unshift('id');
  return fields.join(',');
}

function getBlockInfoByPage(
  snapshot: any,
  prefix: string,
  pageCollectionNames: string[],
): Map<string, { junctionCollection: string; allowedBlockTypes: string[] }> {
  const filtered = filterSnapshot(snapshot, prefix);
  const blockInfoByPage = new Map<string, { junctionCollection: string; allowedBlockTypes: string[] }>();
  for (const rel of (filtered.relations ?? [])) {
    const allowed: string[] | undefined = rel.meta?.one_allowed_collections;
    if (Array.isArray(allowed) && allowed.length > 0) {
      const junctionName: string = rel.collection;
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
  return blockInfoByPage;
}

async function fetchItems(
  base: string,
  token: string,
  collectionName: string,
  fields: string,
): Promise<{ items: PageItemDetail[]; error?: string }> {
  try {
    const res = await fetch(
      `${base}/items/${collectionName}?fields=${fields}&limit=-1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { items: [], error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }
    const json = await res.json();
    const raw: any[] = json.data ?? [];
    return {
      items: raw.map((item: any): PageItemDetail => ({
        id:         item.id,
        status:     item.status ?? 'unknown',
        title:      item.title ?? item.name ?? item.permalink ?? item.slug ?? `#${item.id}`,
        permalink:  item.permalink ?? null,
        slug:       item.slug ?? null,
        blockCount: 0, // filled in separately
      })),
    };
  } catch (err: unknown) {
    return { items: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchBlockCounts(
  base: string,
  token: string,
  junctionCollection: string,
  parentFkField: string,
): Promise<Map<string | number, number>> {
  const countMap = new Map<string | number, number>();
  try {
    const res = await fetch(
      `${base}/items/${junctionCollection}?fields=${parentFkField}&limit=-1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return countMap;
    const json = await res.json();
    for (const row of (json.data ?? [])) {
      const parentId = row[parentFkField];
      if (parentId != null) {
        countMap.set(parentId, (countMap.get(parentId) ?? 0) + 1);
      }
    }
  } catch { /* best-effort — ignore errors */ }
  return countMap;
}

/** Find the FK field on the junction table that points back to the parent collection. */
function findParentFkField(
  junctionCollection: string,
  parentCollection: string,
  snapshot: any,
  prefix: string,
): string | null {
  const filtered = filterSnapshot(snapshot, prefix);
  for (const rel of (filtered.relations ?? [])) {
    if (
      rel.collection === junctionCollection &&
      rel.meta?.one_collection === parentCollection
    ) {
      return rel.field as string;
    }
  }
  return null;
}

function buildItemMap(items: PageItemDetail[]): Map<string, PageItemDetail> {
  const map = new Map<string, PageItemDetail>();
  for (const item of items) {
    // Prefer permalink, then slug, then title, then id as match key
    const key = item.permalink
      ? `permalink:${item.permalink}`
      : item.slug
        ? `slug:${item.slug}`
        : item.title && !item.title.startsWith('#')
          ? `title:${item.title}`
          : `id:${item.id}`;
    map.set(key, item);
  }
  return map;
}

function computeItemDiffs(dev: PageItemDetail, prod: PageItemDetail): ItemDiff[] {
  const diffs: ItemDiff[] = [];
  if (dev.status !== prod.status) {
    diffs.push({ field: 'status', dev: dev.status, prod: prod.status });
  }
  if (dev.title !== prod.title) {
    diffs.push({ field: 'title', dev: dev.title, prod: prod.title });
  }
  if (dev.permalink !== prod.permalink) {
    diffs.push({ field: 'permalink', dev: dev.permalink, prod: prod.permalink });
  }
  if (dev.slug !== prod.slug) {
    diffs.push({ field: 'slug', dev: dev.slug, prod: prod.slug });
  }
  return diffs;
}

function matchKeyType(key: string): 'permalink' | 'slug' | 'title' | 'id' {
  if (key.startsWith('permalink:')) return 'permalink';
  if (key.startsWith('slug:'))      return 'slug';
  if (key.startsWith('title:'))     return 'title';
  return 'id';
}

function matchKeyDisplay(key: string): string {
  return key.replace(/^(permalink|slug|title|id):/, '');
}

// ── API Route ─────────────────────────────────────────────────────────────────

export const GET: APIRoute = async ({ url }) => {
  const forceRefresh = url.searchParams.get('refresh') === 'true';

  if (!forceRefresh && pagesDiffCache && Date.now() - pagesDiffCache.fetchedAt < TTL_MS) {
    return new Response(JSON.stringify(pagesDiffCache.data), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const prefix   = COLLECTION_PREFIX();
  const devBase  = DEV_URL();
  const prodBase = PROD_URL();
  let devToken: string;
  let prodToken: string;

  try {
    devToken  = DEV_TOKEN();
    prodToken = PROD_TOKEN();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 1. Fetch snapshots from both envs in parallel
  const [devSnapshotResult, prodSnapshotResult] = await Promise.allSettled([
    fetchSnapshot(devBase, devToken),
    fetchSnapshot(prodBase, prodToken),
  ]);

  const devSnapshotError  = devSnapshotResult.status  === 'rejected' ? String(devSnapshotResult.reason)  : undefined;
  const prodSnapshotError = prodSnapshotResult.status === 'rejected' ? String(prodSnapshotResult.reason) : undefined;

  const devSnapshot  = devSnapshotResult.status  === 'fulfilled' ? devSnapshotResult.value  : null;
  const prodSnapshot = prodSnapshotResult.status === 'fulfilled' ? prodSnapshotResult.value : null;

  // 2. Detect page collections in each env
  const devCollections  = devSnapshot  ? getPageCollections(devSnapshot,  prefix) : { names: [], fieldsByCollection: new Map<string, string[]>() };
  const prodCollections = prodSnapshot ? getPageCollections(prodSnapshot, prefix) : { names: [], fieldsByCollection: new Map<string, string[]>() };
  const devCollectionNames  = devCollections.names;
  const prodCollectionNames = prodCollections.names;

  const devSet  = new Set(devCollectionNames);
  const prodSet = new Set(prodCollectionNames);

  // When both snapshots are available, report collections unique to one side as orphans.
  // When a snapshot is missing, skip orphan banners — the error banner at the top
  // already explains the situation, and all available collections go into the diff grid.
  const bothSucceeded = !!devSnapshot && !!prodSnapshot;
  const devOnlyCollections  = bothSucceeded ? devCollectionNames.filter(n => !prodSet.has(n)) : [];
  const prodOnlyCollections = bothSucceeded ? prodCollectionNames.filter(n => !devSet.has(n)) : [];
  const sharedCollections   = devCollectionNames.filter(n => prodSet.has(n));

  // When only one snapshot succeeded, treat all its collections as "shared" (the other
  // side will surface errors per section inside the diff grid).
  const uniqueShared = bothSucceeded
    ? [...new Set(sharedCollections)]
    : [...new Set([...devCollectionNames, ...prodCollectionNames])];

  // 3. For each shared collection, fetch items from both envs
  const matchedCollections: MatchedCollection[] = await Promise.all(
    uniqueShared.map(async (collectionName): Promise<MatchedCollection> => {
      const label = formatLabel(collectionName, prefix);

      // Block junction info (union of both envs)
      const devBlockInfo  = devSnapshot  ? getBlockInfoByPage(devSnapshot,  prefix, devCollectionNames).get(collectionName)  : undefined;
      const prodBlockInfo = prodSnapshot ? getBlockInfoByPage(prodSnapshot, prefix, prodCollectionNames).get(collectionName) : undefined;
      const blockJunction = devBlockInfo?.junctionCollection ?? prodBlockInfo?.junctionCollection ?? null;
      const allowedBlockTypes = [...new Set([
        ...(devBlockInfo?.allowedBlockTypes  ?? []),
        ...(prodBlockInfo?.allowedBlockTypes ?? []),
      ])];

      // Fetch items from both envs in parallel, using only fields that exist in each env's schema
      const devFields  = resolveItemFields(devCollections.fieldsByCollection,  collectionName);
      const prodFields = resolveItemFields(prodCollections.fieldsByCollection, collectionName);
      const [devResult, prodResult] = await Promise.allSettled([
        devSnapshot  ? fetchItems(devBase,  devToken,  collectionName, devFields)  : Promise.resolve({ items: [] as PageItemDetail[], error: 'No dev snapshot' }),
        prodSnapshot ? fetchItems(prodBase, prodToken, collectionName, prodFields) : Promise.resolve({ items: [] as PageItemDetail[], error: 'No prod snapshot' }),
      ]);

      const devFetch  = devResult.status  === 'fulfilled' ? devResult.value  : { items: [] as PageItemDetail[], error: String(devResult.reason) };
      const prodFetch = prodResult.status === 'fulfilled' ? prodResult.value : { items: [] as PageItemDetail[], error: String(prodResult.reason) };

      let devItems  = devFetch.items;
      let prodItems = prodFetch.items;

      // 4. Fetch block counts (best-effort) if a junction exists
      if (blockJunction) {
        const devFkField  = devSnapshot  ? findParentFkField(blockJunction, collectionName, devSnapshot,  prefix)  : null;
        const prodFkField = prodSnapshot ? findParentFkField(blockJunction, collectionName, prodSnapshot, prefix) : null;

        const [devBlockCounts, prodBlockCounts] = await Promise.all([
          devFkField  ? fetchBlockCounts(devBase,  devToken,  blockJunction, devFkField)  : Promise.resolve(new Map()),
          prodFkField ? fetchBlockCounts(prodBase, prodToken, blockJunction, prodFkField) : Promise.resolve(new Map()),
        ]);

        devItems  = devItems.map(item  => ({ ...item,  blockCount: devBlockCounts.get(item.id)   ?? 0 }));
        prodItems = prodItems.map(item => ({ ...item,  blockCount: prodBlockCounts.get(item.id) ?? 0 }));
      }

      // 5. Match items across envs
      const devMap  = buildItemMap(devItems);
      const prodMap = buildItemMap(prodItems);

      const allKeys = new Set([...devMap.keys(), ...prodMap.keys()]);
      const rows: MatchedRow[] = [];

      for (const key of allKeys) {
        const devItem  = devMap.get(key)  ?? null;
        const prodItem = prodMap.get(key) ?? null;
        const diffs    = devItem && prodItem ? computeItemDiffs(devItem, prodItem) : [];

        rows.push({
          matchKey:     matchKeyDisplay(key),
          matchKeyType: matchKeyType(key),
          dev:          devItem,
          prod:         prodItem,
          diffs,
        });
      }

      // Sort rows alphabetically by matchKey
      rows.sort((a, b) => a.matchKey.localeCompare(b.matchKey));

      const devOnlyCount  = rows.filter(r => r.dev  && !r.prod).length;
      const prodOnlyCount = rows.filter(r => r.prod && !r.dev).length;
      const changedCount  = rows.filter(r => r.dev  && r.prod && r.diffs.length > 0).length;

      return {
        collection: collectionName,
        label,
        devTotal:   devItems.length,
        prodTotal:  prodItems.length,
        devOnlyCount,
        prodOnlyCount,
        changedCount,
        hasDiffs: devOnlyCount > 0 || prodOnlyCount > 0 || changedCount > 0,
        rows,
        blockJunction,
        allowedBlockTypes,
        devError:  devFetch.error,
        prodError: prodFetch.error,
      };
    }),
  );

  // Sort collections alphabetically
  matchedCollections.sort((a, b) => a.label.localeCompare(b.label));

  const data: PagesDiffData = {
    matched: matchedCollections,
    devOnlyCollections,
    prodOnlyCollections,
    fetchedAt: Date.now(),
    devSnapshotError,
    prodSnapshotError,
  };

  pagesDiffCache = { data, fetchedAt: Date.now() };

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
};
