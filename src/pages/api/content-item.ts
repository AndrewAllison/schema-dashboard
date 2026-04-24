import type { APIRoute } from 'astro';
import { DEV_TOKEN, DEV_URL, PROD_TOKEN, PROD_URL, COLLECTION_PREFIX } from '../../lib/env';
import { fetchSnapshot, filterSnapshot } from '@diff';
import {
  mergeScalarFieldMeta,
  computeFieldValueDiffs,
  type ScalarFieldMeta,
  type ContentFieldValueDiff,
} from '../../lib/content-fields';

const TTL_MS = 5 * 60 * 1000;

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface ContentItemFull {
  id: number | string;
  status: string;
  title: string;
  permalink: string | null;
  slug: string | null;
  blockCount: number;
  fields: Record<string, unknown>;
}

export interface ContentItemData {
  collection: string;
  matchKey: string;
  matchKeyType: 'slug' | 'title' | 'id';
  dev: ContentItemFull | null;
  prod: ContentItemFull | null;
  diffs: ContentFieldValueDiff[];
  scalarFields: ScalarFieldMeta[];
  blockJunction: string | null;
  allowedBlockTypes: string[];
  fetchedAt: number;
  devError?: string;
  prodError?: string;
  error?: string;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const contentItemCache = new Map<string, { data: ContentItemData; fetchedAt: number }>();

export function bustContentItemCache(collection: string, key: string): void {
  contentItemCache.delete(`${collection}:${key}`);
}

export function bustAllContentItemCache(): void {
  contentItemCache.clear();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isBlockJunctionName(name: string): boolean {
  return /_blocks$/.test(name) || /_block_/.test(name) || /_blocks_/.test(name);
}

function getPageCollectionNames(snapshot: any, prefix: string): string[] {
  const filtered = filterSnapshot(snapshot, prefix);
  const fieldsByCollection = new Map<string, string[]>();
  for (const f of (filtered.fields ?? [])) {
    if (!fieldsByCollection.has(f.collection)) fieldsByCollection.set(f.collection, []);
    fieldsByCollection.get(f.collection)!.push(f.field as string);
  }
  return (filtered.collections ?? [])
    .filter((c: any) => {
      const name: string = c.collection;
      if (isBlockJunctionName(name)) return false;
      const fields = fieldsByCollection.get(name) ?? [];
      return fields.includes('status');
    })
    .map((c: any) => c.collection as string);
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

async function fetchBlockCount(
  base: string,
  token: string,
  junctionCollection: string,
  parentFkField: string,
  parentId: number | string,
): Promise<number> {
  try {
    const res = await fetch(
      `${base}/items/${junctionCollection}?filter[${parentFkField}][_eq]=${parentId}&aggregate[count]=*&limit=0`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return 0;
    const json = await res.json();
    const raw = json.data?.[0]?.count;
    return raw != null ? Number(raw) : 0;
  } catch { return 0; }
}

const CORE_FIELDS_WANTED = ['id', 'status', 'title', 'name', 'permalink', 'slug'] as const;

function resolveCoreFields(availableFields: string[]): string[] {
  const fields = CORE_FIELDS_WANTED.filter(f => f === 'id' || availableFields.includes(f));
  if (!fields.includes('id')) fields.unshift('id');
  return fields;
}

/** Build a map of collectionName → field names from a snapshot. */
function buildFieldsByCollection(snapshot: any, prefix: string): Map<string, string[]> {
  const filtered = filterSnapshot(snapshot, prefix);
  const map = new Map<string, string[]>();
  for (const f of (filtered.fields ?? [])) {
    if (!map.has(f.collection)) map.set(f.collection, []);
    map.get(f.collection)!.push(f.field as string);
  }
  return map;
}

interface FetchSingleResult {
  item: ContentItemFull | null;
  error?: string;
}

async function fetchSingleItem(
  base: string,
  token: string,
  collectionName: string,
  matchKeyType: 'slug' | 'title' | 'id',
  matchKeyValue: string,
  scalarFieldNames: string[],
  availableFields: string[],
): Promise<FetchSingleResult> {
  const coreFields = resolveCoreFields(availableFields);
  const allFields = [...new Set([...coreFields, ...scalarFieldNames])].join(',');

  try {
    let res: Response;

    if (matchKeyType === 'id') {
      // Direct fetch by ID
      res = await fetch(
        `${base}/items/${collectionName}/${encodeURIComponent(matchKeyValue)}?fields=${allFields}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } else {
      // Filter by slug or title
      const filterField = matchKeyType === 'slug' ? 'slug' : 'title';
      res = await fetch(
        `${base}/items/${collectionName}?filter[${filterField}][_eq]=${encodeURIComponent(matchKeyValue)}&fields=${allFields}&limit=1`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { item: null, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }

    const json = await res.json();

    // Single-item fetch returns `{ data: {...} }`, filtered fetch returns `{ data: [{...}] }`
    const raw: any = matchKeyType === 'id'
      ? json.data
      : (Array.isArray(json.data) ? json.data[0] : null);

    if (!raw) return { item: null };

    const fields: Record<string, unknown> = {};
    for (const field of scalarFieldNames) {
      fields[field] = raw[field] ?? null;
    }
    // Include core fields in fields map
    fields.status    = raw.status    ?? null;
    fields.title     = raw.title     ?? raw.name ?? null;
    fields.permalink = raw.permalink ?? null;
    fields.slug      = raw.slug      ?? null;

    return {
      item: {
        id:         raw.id,
        status:     raw.status ?? 'unknown',
        title:      raw.title ?? raw.name ?? raw.permalink ?? raw.slug ?? `#${raw.id}`,
        permalink:  raw.permalink ?? null,
        slug:       raw.slug ?? null,
        blockCount: 0, // filled in separately
        fields,
      },
    };
  } catch (err: unknown) {
    return { item: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── API Route ─────────────────────────────────────────────────────────────────

export const GET: APIRoute = async ({ url }) => {
  const collectionName = url.searchParams.get('collection');
  const key            = url.searchParams.get('key');
  const forceRefresh   = url.searchParams.get('refresh') === 'true';

  if (!collectionName || !key) {
    return new Response(JSON.stringify({ error: 'Missing required params: collection, key' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cacheKey = `${collectionName}:${key}`;
  const cached   = contentItemCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return new Response(JSON.stringify(cached.data), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse match key: format is "type:value" e.g. "slug:home-page"
  const colonIdx = key.indexOf(':');
  if (colonIdx === -1) {
    return new Response(JSON.stringify({ error: 'Invalid key format. Expected type:value (e.g. slug:home-page)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const keyTypeRaw   = key.slice(0, colonIdx);
  const keyValue     = key.slice(colonIdx + 1);
  const keyType: 'slug' | 'title' | 'id' =
    keyTypeRaw === 'slug' ? 'slug' : keyTypeRaw === 'title' ? 'title' : 'id';

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

  // 1. Fetch both snapshots
  const [devSnapshotResult, prodSnapshotResult] = await Promise.allSettled([
    fetchSnapshot(devBase, devToken),
    fetchSnapshot(prodBase, prodToken),
  ]);

  const devSnapshot  = devSnapshotResult.status  === 'fulfilled' ? devSnapshotResult.value  : null;
  const prodSnapshot = prodSnapshotResult.status === 'fulfilled' ? prodSnapshotResult.value : null;

  // 2. Merge scalar fields from both envs
  const scalarFields    = mergeScalarFieldMeta(devSnapshot, prodSnapshot, prefix, collectionName);
  const devScalarNames  = scalarFields.filter(f => f.inDev).map(f => f.field);
  const prodScalarNames = scalarFields.filter(f => f.inProd).map(f => f.field);

  // 3. Find block junction for this collection
  const devPageNames  = devSnapshot  ? getPageCollectionNames(devSnapshot,  prefix) : [];
  const prodPageNames = prodSnapshot ? getPageCollectionNames(prodSnapshot, prefix) : [];
  const devBlockInfo  = devSnapshot  ? getBlockInfoByPage(devSnapshot,  prefix, devPageNames).get(collectionName)  : undefined;
  const prodBlockInfo = prodSnapshot ? getBlockInfoByPage(prodSnapshot, prefix, prodPageNames).get(collectionName) : undefined;
  const blockJunction     = devBlockInfo?.junctionCollection ?? prodBlockInfo?.junctionCollection ?? null;
  const allowedBlockTypes = [...new Set([
    ...(devBlockInfo?.allowedBlockTypes  ?? []),
    ...(prodBlockInfo?.allowedBlockTypes ?? []),
  ])];

  // 4. Fetch the item from both envs in parallel
  // Build available-field maps so we only request fields that exist in each env's schema
  const devFieldsMap  = devSnapshot  ? buildFieldsByCollection(devSnapshot,  prefix) : new Map<string, string[]>();
  const prodFieldsMap = prodSnapshot ? buildFieldsByCollection(prodSnapshot, prefix) : new Map<string, string[]>();
  const devAvailable  = devFieldsMap.get(collectionName)  ?? [];
  const prodAvailable = prodFieldsMap.get(collectionName) ?? [];

  const [devFetchResult, prodFetchResult] = await Promise.allSettled([
    devSnapshot
      ? fetchSingleItem(devBase,  devToken,  collectionName, keyType, keyValue, devScalarNames,  devAvailable)
      : Promise.resolve({ item: null, error: 'No dev snapshot' }),
    prodSnapshot
      ? fetchSingleItem(prodBase, prodToken, collectionName, keyType, keyValue, prodScalarNames, prodAvailable)
      : Promise.resolve({ item: null, error: 'No prod snapshot' }),
  ]);

  const devFetch  = devFetchResult.status  === 'fulfilled' ? devFetchResult.value  : { item: null, error: String(devFetchResult.reason) };
  const prodFetch = prodFetchResult.status === 'fulfilled' ? prodFetchResult.value : { item: null, error: String(prodFetchResult.reason) };

  let devItem  = devFetch.item;
  let prodItem = prodFetch.item;

  // 5. Fetch block counts if a junction exists
  if (blockJunction && (devItem || prodItem)) {
    const devFkField  = devSnapshot  ? findParentFkField(blockJunction, collectionName, devSnapshot,  prefix)  : null;
    const prodFkField = prodSnapshot ? findParentFkField(blockJunction, collectionName, prodSnapshot, prefix) : null;

    const [devBlockCount, prodBlockCount] = await Promise.all([
      devItem  && devFkField  ? fetchBlockCount(devBase,  devToken,  blockJunction, devFkField,  devItem.id)  : Promise.resolve(0),
      prodItem && prodFkField ? fetchBlockCount(prodBase, prodToken, blockJunction, prodFkField, prodItem.id) : Promise.resolve(0),
    ]);

    if (devItem)  devItem  = { ...devItem,  blockCount: devBlockCount };
    if (prodItem) prodItem = { ...prodItem, blockCount: prodBlockCount };
  }

  // 6. Compute field-level diffs (with values)
  const diffs: ContentFieldValueDiff[] = devItem && prodItem
    ? computeFieldValueDiffs(scalarFields, devItem.fields, prodItem.fields)
    : [];

  const data: ContentItemData = {
    collection:  collectionName,
    matchKey:    keyValue,
    matchKeyType: keyType,
    dev:         devItem,
    prod:        prodItem,
    diffs,
    scalarFields,
    blockJunction,
    allowedBlockTypes,
    fetchedAt:   Date.now(),
    devError:    devFetch.error,
    prodError:   prodFetch.error,
  };

  contentItemCache.set(cacheKey, { data, fetchedAt: Date.now() });

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
};
