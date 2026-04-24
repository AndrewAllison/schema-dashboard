import type { APIRoute } from 'astro';
import { DEV_TOKEN, DEV_URL, PROD_TOKEN, PROD_URL, COLLECTION_PREFIX } from '../../lib/env';
import { fetchSnapshot, filterSnapshot } from '@diff';
import {
  mergeScalarFieldMeta,
  computeFieldNameDiffs,
  type ScalarFieldMeta,
} from '../../lib/content-fields';

const TTL_MS = 5 * 60 * 1000;

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface ContentItemSummary {
  id: number | string;
  status: string;
  title: string;
  permalink: string | null;
  slug: string | null;
  blockCount: number;
}

export interface ContentFieldNameDiff {
  field: string;
  fieldType: string;
}

export interface ContentMatchedRow {
  matchKey: string;
  matchKeyType: 'permalink' | 'slug' | 'title' | 'id';
  dev: ContentItemSummary | null;
  prod: ContentItemSummary | null;
  diffs: ContentFieldNameDiff[];
  diffCount: number;
}

export interface ContentMatchedCollection {
  collection: string;
  label: string;
  devTotal: number;
  prodTotal: number;
  devOnlyCount: number;
  prodOnlyCount: number;
  changedCount: number;
  inSyncCount: number;
  hasDiffs: boolean;
  rows: ContentMatchedRow[];
  scalarFields: ScalarFieldMeta[];
  blockJunction: string | null;
  allowedBlockTypes: string[];
  devError?: string;
  prodError?: string;
}

export interface ContentDiffData {
  matched: ContentMatchedCollection[];
  devOnlyCollections: string[];
  prodOnlyCollections: string[];
  fetchedAt: number;
  devSnapshotError?: string;
  prodSnapshotError?: string;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

let contentDiffCache: { data: ContentDiffData; fetchedAt: number } | null = null;

export function bustContentDiffCache(): void {
  contentDiffCache = null;
}

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

/** Find the FK field on the junction table pointing back to the parent collection. */
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

interface FetchItemsResult {
  items: ContentItemSummary[];
  valueMap: Map<string | number, Record<string, unknown>>;
  error?: string;
}

const CORE_FIELDS_WANTED = ['id', 'status', 'title', 'name', 'permalink', 'slug'] as const;

/** Only include core fields that actually exist in the collection's schema. */
function resolveCoreFields(availableFields: string[]): string[] {
  const fields = CORE_FIELDS_WANTED.filter(f => f === 'id' || availableFields.includes(f));
  if (!fields.includes('id')) fields.unshift('id');
  return fields;
}

async function fetchItemsWithScalarFields(
  base: string,
  token: string,
  collectionName: string,
  scalarFieldNames: string[],
  availableFields: string[],
): Promise<FetchItemsResult> {
  const coreFields = resolveCoreFields(availableFields);
  const allFields = [...new Set([...coreFields, ...scalarFieldNames])].join(',');

  try {
    const res = await fetch(
      `${base}/items/${collectionName}?fields=${allFields}&limit=-1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { items: [], valueMap: new Map(), error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }
    const json = await res.json();
    const raw: any[] = json.data ?? [];

    const items: ContentItemSummary[] = [];
    const valueMap = new Map<string | number, Record<string, unknown>>();

    for (const item of raw) {
      items.push({
        id:         item.id,
        status:     item.status ?? 'unknown',
        title:      item.title ?? item.name ?? item.permalink ?? item.slug ?? `#${item.id}`,
        permalink:  item.permalink ?? null,
        slug:       item.slug ?? null,
        blockCount: 0, // filled in separately
      });

      // Store all scalar field values keyed by item ID
      const values: Record<string, unknown> = {};
      for (const field of scalarFieldNames) {
        values[field] = item[field] ?? null;
      }
      // Include core fields in value map too
      values.status = item.status ?? null;
      values.title  = item.title  ?? item.name ?? null;
      values.slug   = item.slug   ?? null;
      valueMap.set(item.id, values);
    }

    return { items, valueMap };
  } catch (err: unknown) {
    return { items: [], valueMap: new Map(), error: err instanceof Error ? err.message : String(err) };
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
  } catch { /* best-effort */ }
  return countMap;
}

function buildItemMap(items: ContentItemSummary[]): Map<string, ContentItemSummary> {
  const map = new Map<string, ContentItemSummary>();
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

  if (!forceRefresh && contentDiffCache && Date.now() - contentDiffCache.fetchedAt < TTL_MS) {
    return new Response(JSON.stringify(contentDiffCache.data), {
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

  const bothSucceeded = !!devSnapshot && !!prodSnapshot;
  const devOnlyCollections  = bothSucceeded ? devCollectionNames.filter(n => !prodSet.has(n)) : [];
  const prodOnlyCollections = bothSucceeded ? prodCollectionNames.filter(n => !devSet.has(n))  : [];

  const uniqueShared = bothSucceeded
    ? [...new Set(devCollectionNames.filter(n => prodSet.has(n)))]
    : [...new Set([...devCollectionNames, ...prodCollectionNames])];

  // 3. For each shared collection, fetch items and compute field-level diffs
  const matchedCollections: ContentMatchedCollection[] = await Promise.all(
    uniqueShared.map(async (collectionName): Promise<ContentMatchedCollection> => {
      const label = formatLabel(collectionName, prefix);

      // Merge scalar fields from both envs
      const scalarFields = mergeScalarFieldMeta(devSnapshot, prodSnapshot, prefix, collectionName);
      const devScalarNames  = scalarFields.filter(f => f.inDev).map(f => f.field);
      const prodScalarNames = scalarFields.filter(f => f.inProd).map(f => f.field);

      // Block junction info (union of both envs)
      const devBlockInfo  = devSnapshot  ? getBlockInfoByPage(devSnapshot,  prefix, devCollectionNames).get(collectionName)  : undefined;
      const prodBlockInfo = prodSnapshot ? getBlockInfoByPage(prodSnapshot, prefix, prodCollectionNames).get(collectionName) : undefined;
      const blockJunction = devBlockInfo?.junctionCollection ?? prodBlockInfo?.junctionCollection ?? null;
      const allowedBlockTypes = [...new Set([
        ...(devBlockInfo?.allowedBlockTypes  ?? []),
        ...(prodBlockInfo?.allowedBlockTypes ?? []),
      ])];

      // Fetch items with all scalar fields from both envs in parallel
      const devAvailable  = devCollections.fieldsByCollection.get(collectionName)  ?? [];
      const prodAvailable = prodCollections.fieldsByCollection.get(collectionName) ?? [];
      const [devResult, prodResult] = await Promise.allSettled([
        devSnapshot  ? fetchItemsWithScalarFields(devBase,  devToken,  collectionName, devScalarNames,  devAvailable)
                     : Promise.resolve({ items: [] as ContentItemSummary[], valueMap: new Map(), error: 'No dev snapshot' }),
        prodSnapshot ? fetchItemsWithScalarFields(prodBase, prodToken, collectionName, prodScalarNames, prodAvailable)
                     : Promise.resolve({ items: [] as ContentItemSummary[], valueMap: new Map(), error: 'No prod snapshot' }),
      ]);

      const devFetch  = devResult.status  === 'fulfilled' ? devResult.value  : { items: [] as ContentItemSummary[], valueMap: new Map<string|number, Record<string, unknown>>(), error: String(devResult.reason) };
      const prodFetch = prodResult.status === 'fulfilled' ? prodResult.value : { items: [] as ContentItemSummary[], valueMap: new Map<string|number, Record<string, unknown>>(), error: String(prodResult.reason) };

      let devItems  = devFetch.items;
      let prodItems = prodFetch.items;

      // 4. Fetch block counts (best-effort)
      if (blockJunction) {
        const devFkField  = devSnapshot  ? findParentFkField(blockJunction, collectionName, devSnapshot,  prefix)  : null;
        const prodFkField = prodSnapshot ? findParentFkField(blockJunction, collectionName, prodSnapshot, prefix) : null;

        const [devBlockCounts, prodBlockCounts] = await Promise.all([
          devFkField  ? fetchBlockCounts(devBase,  devToken,  blockJunction, devFkField)  : Promise.resolve(new Map()),
          prodFkField ? fetchBlockCounts(prodBase, prodToken, blockJunction, prodFkField) : Promise.resolve(new Map()),
        ]);

        devItems  = devItems.map(item  => ({ ...item, blockCount: devBlockCounts.get(item.id)   ?? 0 }));
        prodItems = prodItems.map(item => ({ ...item, blockCount: prodBlockCounts.get(item.id) ?? 0 }));
      }

      // 5. Match items across envs
      const devMap  = buildItemMap(devItems);
      const prodMap = buildItemMap(prodItems);
      const allKeys = new Set([...devMap.keys(), ...prodMap.keys()]);
      const rows: ContentMatchedRow[] = [];

      for (const key of allKeys) {
        const devItem  = devMap.get(key)  ?? null;
        const prodItem = prodMap.get(key) ?? null;

        let diffs: ContentFieldNameDiff[] = [];

        if (devItem && prodItem) {
          const devValues  = devFetch.valueMap.get(devItem.id)   ?? {};
          const prodValues = prodFetch.valueMap.get(prodItem.id) ?? {};
          diffs = computeFieldNameDiffs(scalarFields, devValues, prodValues);
        }

        rows.push({
          matchKey:     matchKeyDisplay(key),
          matchKeyType: matchKeyType(key),
          dev:          devItem,
          prod:         prodItem,
          diffs,
          diffCount:    diffs.length,
        });
      }

      rows.sort((a, b) => a.matchKey.localeCompare(b.matchKey));

      const devOnlyCount  = rows.filter(r =>  r.dev && !r.prod).length;
      const prodOnlyCount = rows.filter(r => !r.dev &&  r.prod).length;
      const changedCount  = rows.filter(r =>  r.dev &&  r.prod && r.diffs.length > 0).length;
      const inSyncCount   = rows.filter(r =>  r.dev &&  r.prod && r.diffs.length === 0).length;

      return {
        collection: collectionName,
        label,
        devTotal:   devItems.length,
        prodTotal:  prodItems.length,
        devOnlyCount,
        prodOnlyCount,
        changedCount,
        inSyncCount,
        hasDiffs: devOnlyCount > 0 || prodOnlyCount > 0 || changedCount > 0,
        rows,
        scalarFields,
        blockJunction,
        allowedBlockTypes,
        devError:  devFetch.error,
        prodError: prodFetch.error,
      };
    }),
  );

  // Sort: collections with diffs first, then alphabetically
  matchedCollections.sort((a, b) => {
    if (a.hasDiffs && !b.hasDiffs) return -1;
    if (!a.hasDiffs && b.hasDiffs) return 1;
    return a.label.localeCompare(b.label);
  });

  const data: ContentDiffData = {
    matched: matchedCollections,
    devOnlyCollections,
    prodOnlyCollections,
    fetchedAt: Date.now(),
    devSnapshotError,
    prodSnapshotError,
  };

  contentDiffCache = { data, fetchedAt: Date.now() };

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
};
