import type { APIRoute } from 'astro';
import { DEV_TOKEN, DEV_URL, PROD_TOKEN, PROD_URL, COLLECTION_PREFIX } from '../../lib/env';
import { fetchSnapshot, filterSnapshot } from '@diff';
import {
  mergeScalarFieldMeta,
  computeFieldValueDiffs,
  type ContentFieldValueDiff,
} from '../../lib/content-fields';

const TTL_MS = 5 * 60 * 1000;

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface BlockItemInstance {
  junctionId: number | string;
  sort: number;
  blockCollection: string;
  blockId: number | string;
  fields: Record<string, unknown>;
}

export interface BlockMatchedRow {
  /** Composite key: `{sort}:{blockCollection}` */
  matchKey: string;
  dev: BlockItemInstance | null;
  prod: BlockItemInstance | null;
  diffs: ContentFieldValueDiff[];
  diffCount: number;
}

export interface BlockDiffData {
  collection: string;
  itemMatchKey: string;
  devPageId: number | string | null;
  prodPageId: number | string | null;
  blockJunction: string | null;
  blocks: BlockMatchedRow[];
  totalDevBlocks: number;
  totalProdBlocks: number;
  changedBlocks: number;
  devOnlyBlocks: number;
  prodOnlyBlocks: number;
  fetchedAt: number;
  devError?: string;
  prodError?: string;
  error?: string;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const blockDiffCache = new Map<string, { data: BlockDiffData; fetchedAt: number }>();

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
): Map<string, { junctionCollection: string; allowedBlockTypes: string[]; sortField: string }> {
  const filtered = filterSnapshot(snapshot, prefix);
  const blockInfoByPage = new Map<string, { junctionCollection: string; allowedBlockTypes: string[]; sortField: string }>();
  for (const rel of (filtered.relations ?? [])) {
    const allowed: string[] | undefined = rel.meta?.one_allowed_collections;
    if (Array.isArray(allowed) && allowed.length > 0) {
      const junctionName: string = rel.collection;
      for (const pageName of pageCollectionNames) {
        if (junctionName.startsWith(pageName + '_')) {
          blockInfoByPage.set(pageName, {
            junctionCollection: junctionName,
            allowedBlockTypes: allowed,
            sortField: (rel.meta?.sort_field as string) ?? 'sort',
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

/** Find the discriminator field name on the junction (stores block type collection name). */
function findCollectionField(
  snapshot: any,
  prefix: string,
  junctionCollection: string,
): string | null {
  const filtered = filterSnapshot(snapshot, prefix);
  for (const rel of (filtered.relations ?? [])) {
    if (rel.collection === junctionCollection && rel.meta?.one_allowed_collections) {
      if (rel.meta.junction_field) return rel.meta.junction_field as string;
    }
  }
  // Fallback: look for a field named 'collection' on the junction table
  for (const f of (filtered.fields ?? [])) {
    if (f.collection === junctionCollection && f.field === 'collection') {
      return 'collection';
    }
  }
  return null;
}

/** Resolve page item ID by match key type. */
async function resolvePageItemId(
  base: string,
  token: string,
  collectionName: string,
  keyType: 'slug' | 'title' | 'id',
  keyValue: string,
): Promise<number | string | null> {
  try {
    let res: Response;
    if (keyType === 'id') {
      res = await fetch(
        `${base}/items/${collectionName}/${encodeURIComponent(keyValue)}?fields=id`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;
      const json = await res.json();
      return json.data?.id ?? null;
    } else {
      const filterField = keyType === 'slug' ? 'slug' : 'title';
      res = await fetch(
        `${base}/items/${collectionName}?filter[${filterField}][_eq]=${encodeURIComponent(keyValue)}&fields=id&limit=1`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;
      const json = await res.json();
      return (Array.isArray(json.data) ? json.data[0]?.id : null) ?? null;
    }
  } catch { return null; }
}

interface JunctionRow {
  junctionId: number | string;
  sort: number;
  blockCollection: string;
  blockId: number | string;
}

/** Fetch junction rows for a specific parent item ID. */
async function fetchJunctionRows(
  base: string,
  token: string,
  junctionCollection: string,
  parentFkField: string,
  parentId: number | string,
  sortField: string,
  collectionField: string,
): Promise<{ rows: JunctionRow[]; error?: string }> {
  try {
    // The item field stores the block item ID as a string in Directus M2A
    const fields = ['id', sortField, collectionField, 'item'].filter(Boolean).join(',');
    const res = await fetch(
      `${base}/items/${junctionCollection}?filter[${parentFkField}][_eq]=${parentId}&fields=${fields}&sort=${sortField}&limit=-1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { rows: [], error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }
    const json = await res.json();
    const raw: any[] = json.data ?? [];
    return {
      rows: raw.map((row: any, idx: number): JunctionRow => ({
        junctionId:      row.id,
        sort:            row[sortField] ?? idx,
        blockCollection: row[collectionField] ?? '',
        blockId:         row.item != null ? (isNaN(Number(row.item)) ? row.item : Number(row.item)) : '',
      })).filter(r => r.blockCollection && r.blockId !== ''),
    };
  } catch (err: unknown) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Batch-fetch block items grouped by collection type. Returns map of blockCollection → (blockId → fields). */
async function batchFetchBlockItems(
  base: string,
  token: string,
  rows: JunctionRow[],
  devSnapshot: any,
  prodSnapshot: any,
  prefix: string,
): Promise<Map<number | string, Record<string, unknown>>> {
  // Group row block IDs by collection
  const grouped = new Map<string, (number | string)[]>();
  for (const row of rows) {
    if (!grouped.has(row.blockCollection)) grouped.set(row.blockCollection, []);
    grouped.get(row.blockCollection)!.push(row.blockId);
  }

  const result = new Map<number | string, Record<string, unknown>>();

  await Promise.all(
    [...grouped.entries()].map(async ([blockColl, ids]) => {
      // Get scalar fields for this block collection
      const scalarFields = mergeScalarFieldMeta(devSnapshot, prodSnapshot, prefix, blockColl);
      const fieldNames   = scalarFields.map(f => f.field);
      const allFields    = [...new Set(['id', ...fieldNames])].join(',');
      const idFilter     = ids.join(',');

      try {
        const res = await fetch(
          `${base}/items/${blockColl}?filter[id][_in]=${idFilter}&fields=${allFields}&limit=-1`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) return;
        const json = await res.json();
        for (const item of (json.data ?? [])) {
          const fields: Record<string, unknown> = {};
          for (const field of fieldNames) {
            fields[field] = item[field] ?? null;
          }
          result.set(item.id, fields);
        }
      } catch { /* best-effort */ }
    }),
  );

  return result;
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

  const cacheKey = `block:${collectionName}:${key}`;
  const cached   = blockDiffCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return new Response(JSON.stringify(cached.data), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse match key
  const colonIdx = key.indexOf(':');
  if (colonIdx === -1) {
    return new Response(JSON.stringify({ error: 'Invalid key format. Expected type:value' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const keyTypeRaw = key.slice(0, colonIdx);
  const keyValue   = key.slice(colonIdx + 1);
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

  // 2. Find block junction for this collection
  const devPageNames  = devSnapshot  ? getPageCollectionNames(devSnapshot,  prefix) : [];
  const prodPageNames = prodSnapshot ? getPageCollectionNames(prodSnapshot, prefix) : [];
  const devBlockInfo  = devSnapshot  ? getBlockInfoByPage(devSnapshot,  prefix, devPageNames).get(collectionName)  : undefined;
  const prodBlockInfo = prodSnapshot ? getBlockInfoByPage(prodSnapshot, prefix, prodPageNames).get(collectionName) : undefined;
  const blockJunction = devBlockInfo?.junctionCollection ?? prodBlockInfo?.junctionCollection ?? null;

  if (!blockJunction) {
    const data: BlockDiffData = {
      collection: collectionName, itemMatchKey: key,
      devPageId: null, prodPageId: null, blockJunction: null,
      blocks: [], totalDevBlocks: 0, totalProdBlocks: 0,
      changedBlocks: 0, devOnlyBlocks: 0, prodOnlyBlocks: 0,
      fetchedAt: Date.now(),
    };
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  }

  const sortField = devBlockInfo?.sortField ?? prodBlockInfo?.sortField ?? 'sort';

  // 3. Resolve parent item IDs and find junction fields
  const [devPageId, prodPageId] = await Promise.all([
    devSnapshot  ? resolvePageItemId(devBase,  devToken,  collectionName, keyType, keyValue)  : Promise.resolve(null),
    prodSnapshot ? resolvePageItemId(prodBase, prodToken, collectionName, keyType, keyValue) : Promise.resolve(null),
  ]);

  const devFkField  = devSnapshot  ? findParentFkField(blockJunction, collectionName, devSnapshot,  prefix)  : null;
  const prodFkField = prodSnapshot ? findParentFkField(blockJunction, collectionName, prodSnapshot, prefix) : null;
  const devCollField  = devSnapshot  ? findCollectionField(devSnapshot,  prefix, blockJunction) : null;
  const prodCollField = prodSnapshot ? findCollectionField(prodSnapshot, prefix, blockJunction) : null;
  const collectionField = devCollField ?? prodCollField ?? 'collection';

  // 4. Fetch junction rows from both envs
  const [devJunctionResult, prodJunctionResult] = await Promise.allSettled([
    devPageId != null && devFkField
      ? fetchJunctionRows(devBase,  devToken,  blockJunction, devFkField,  devPageId,  sortField, collectionField)
      : Promise.resolve({ rows: [] as JunctionRow[], error: devPageId == null ? 'Item not found in dev' : 'No FK field found' }),
    prodPageId != null && prodFkField
      ? fetchJunctionRows(prodBase, prodToken, blockJunction, prodFkField, prodPageId, sortField, collectionField)
      : Promise.resolve({ rows: [] as JunctionRow[], error: prodPageId == null ? 'Item not found in prod' : 'No FK field found' }),
  ]);

  const devJunction  = devJunctionResult.status  === 'fulfilled' ? devJunctionResult.value  : { rows: [] as JunctionRow[], error: String(devJunctionResult.reason) };
  const prodJunction = prodJunctionResult.status === 'fulfilled' ? prodJunctionResult.value : { rows: [] as JunctionRow[], error: String(prodJunctionResult.reason) };

  const devRows  = devJunction.rows;
  const prodRows = prodJunction.rows;

  // 5. Batch-fetch block item fields
  const [devBlockFields, prodBlockFields] = await Promise.all([
    devRows.length  > 0 ? batchFetchBlockItems(devBase,  devToken,  devRows,  devSnapshot,  prodSnapshot, prefix) : Promise.resolve(new Map<number|string, Record<string, unknown>>()),
    prodRows.length > 0 ? batchFetchBlockItems(prodBase, prodToken, prodRows, devSnapshot,  prodSnapshot, prefix) : Promise.resolve(new Map<number|string, Record<string, unknown>>()),
  ]);

  // 6. Match blocks by composite key {sort}:{blockCollection}
  const devBlockMap  = new Map<string, JunctionRow>();
  const prodBlockMap = new Map<string, JunctionRow>();

  for (const row of devRows)  devBlockMap.set(`${row.sort}:${row.blockCollection}`, row);
  for (const row of prodRows) prodBlockMap.set(`${row.sort}:${row.blockCollection}`, row);

  const allBlockKeys = new Set([...devBlockMap.keys(), ...prodBlockMap.keys()]);
  const blocks: BlockMatchedRow[] = [];

  for (const blockKey of allBlockKeys) {
    const devRow  = devBlockMap.get(blockKey)  ?? null;
    const prodRow = prodBlockMap.get(blockKey) ?? null;

    let devInstance:  BlockItemInstance | null = null;
    let prodInstance: BlockItemInstance | null = null;
    let diffs: ContentFieldValueDiff[] = [];

    if (devRow) {
      devInstance = {
        junctionId:      devRow.junctionId,
        sort:            devRow.sort,
        blockCollection: devRow.blockCollection,
        blockId:         devRow.blockId,
        fields:          devBlockFields.get(devRow.blockId) ?? {},
      };
    }

    if (prodRow) {
      prodInstance = {
        junctionId:      prodRow.junctionId,
        sort:            prodRow.sort,
        blockCollection: prodRow.blockCollection,
        blockId:         prodRow.blockId,
        fields:          prodBlockFields.get(prodRow.blockId) ?? {},
      };
    }

    if (devInstance && prodInstance && devRow && prodRow) {
      const scalarFields = mergeScalarFieldMeta(devSnapshot, prodSnapshot, prefix, devRow.blockCollection);
      diffs = computeFieldValueDiffs(scalarFields, devInstance.fields, prodInstance.fields);
    }

    blocks.push({
      matchKey: blockKey,
      dev:      devInstance,
      prod:     prodInstance,
      diffs,
      diffCount: diffs.length,
    });
  }

  // Sort by sort order
  blocks.sort((a, b) => {
    const aSort = a.dev?.sort ?? a.prod?.sort ?? 0;
    const bSort = b.dev?.sort ?? b.prod?.sort ?? 0;
    return aSort - bSort;
  });

  const changedBlocks  = blocks.filter(b =>  b.dev &&  b.prod && b.diffs.length > 0).length;
  const devOnlyBlocks  = blocks.filter(b =>  b.dev && !b.prod).length;
  const prodOnlyBlocks = blocks.filter(b => !b.dev &&  b.prod).length;

  const data: BlockDiffData = {
    collection:      collectionName,
    itemMatchKey:    key,
    devPageId,
    prodPageId,
    blockJunction,
    blocks,
    totalDevBlocks:  devRows.length,
    totalProdBlocks: prodRows.length,
    changedBlocks,
    devOnlyBlocks,
    prodOnlyBlocks,
    fetchedAt:       Date.now(),
    devError:        devJunction.error,
    prodError:       prodJunction.error,
  };

  blockDiffCache.set(cacheKey, { data, fetchedAt: Date.now() });

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
};
