import type { APIRoute } from 'astro';
import { DEV_TOKEN, PROD_TOKEN, DEV_URL, PROD_URL, COLLECTION_PREFIX } from '../../lib/env';
import { fetchSnapshot, filterSnapshot } from '@diff';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { data: PageTreeData; fetchedAt: number }>();

interface BlockField {
  field: string;
  value: unknown;
}

interface BlockChoices {
  [blockType: string]: {
    [field: string]: Array<{ value: string; label: string }>;
  };
}

interface BlockItem {
  junctionId: string | number;
  sort: number;
  blockType: string;
  blockLabel: string;
  blockId: string;
  fields: BlockField[];
}

interface PageItem {
  id: string | number;
  title: string;
  status: string;
  slug: string | null;
  permalink: string | null;
  blockCount: number;
  blocks: BlockItem[];
}

interface PageTreeData {
  collection: string;
  label: string;
  junctionTable: string;
  allowedBlockTypes: string[];
  blockFieldChoices: BlockChoices;
  pages: PageItem[];
  fetchedAt: number;
  error?: string;
}

export const GET: APIRoute = async ({ url }) => {
  const collection = url.searchParams.get('collection');
  if (!collection) {
    return new Response(JSON.stringify({ error: 'Missing ?collection= parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const env = (url.searchParams.get('env') ?? 'prod') as 'dev' | 'prod' | 'both';
  const forceRefresh = url.searchParams.get('refresh') === 'true';
  const prefix = COLLECTION_PREFIX();

  try {
    if (env === 'both') {
      const [dev, prod] = await Promise.all([
        fetchPageTreeData('dev', collection, prefix, forceRefresh),
        fetchPageTreeData('prod', collection, prefix, forceRefresh),
      ]);
      return new Response(JSON.stringify({ env: 'both', dev, prod }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await fetchPageTreeData(env, collection, prefix, forceRefresh);
    return new Response(JSON.stringify({ env, ...data }), {
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

async function fetchPageTreeData(
  env: 'dev' | 'prod',
  collection: string,
  prefix: string,
  forceRefresh: boolean,
): Promise<PageTreeData> {
  const cacheKey = `${env}:${collection}`;
  const cached = cache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return cached.data;
  }

  const token = env === 'dev' ? DEV_TOKEN() : PROD_TOKEN();
  const base  = env === 'dev' ? DEV_URL()   : PROD_URL();

  const snapshot = await fetchSnapshot(base, token);
  const filtered = filterSnapshot(snapshot, prefix);

  // Index fields by collection
  const fieldsByCollection = new Map<string, any[]>();
  for (const f of (filtered.fields ?? [])) {
    if (!fieldsByCollection.has(f.collection)) fieldsByCollection.set(f.collection, []);
    fieldsByCollection.get(f.collection)!.push(f);
  }

  const allRelations: any[] = filtered.relations ?? [];

  // Find the M2M relation that connects this collection to a junction table
  const junctionRel = allRelations.find(
    (r: any) =>
      r.meta?.one_collection === collection &&
      r.meta?.junction_field != null &&
      allRelations.some(
        (r2: any) =>
          r2.collection === r.meta.many_collection &&
          Array.isArray(r2.meta?.one_allowed_collections) &&
          r2.meta.one_allowed_collections.length > 0,
      ),
  );

  if (!junctionRel) {
    const data: PageTreeData = {
      collection,
      label: formatLabel(collection, prefix),
      junctionTable: '',
      allowedBlockTypes: [],
      blockFieldChoices: {},
      pages: [],
      fetchedAt: Date.now(),
      error: 'No M2A block relation found for this collection',
    };
    cache.set(cacheKey, { data, fetchedAt: Date.now() });
    return data;
  }

  const junctionTable    = junctionRel.meta.many_collection as string;
  const pageFk           = junctionRel.field as string;

  // Find the M2A side of the junction
  const m2aRel = allRelations.find(
    (r: any) =>
      r.collection === junctionTable &&
      Array.isArray(r.meta?.one_allowed_collections) &&
      r.meta.one_allowed_collections.length > 0,
  );

  const itemField        = (m2aRel?.field as string)                              ?? 'item';
  const collectionField  = (m2aRel?.meta?.one_collection_field as string)         ?? 'collection';
  const allowedBlockTypes: string[] = (m2aRel?.meta?.one_allowed_collections as string[]) ?? [];

  // Build choice map for each allowed block type
  const blockFieldChoices: BlockChoices = {};
  for (const blockType of allowedBlockTypes) {
    const fields = fieldsByCollection.get(blockType) ?? [];
    for (const f of fields) {
      const choices: Array<{ value: unknown; text?: string }> = f.meta?.options?.choices ?? [];
      if (choices.length > 0) {
        if (!blockFieldChoices[blockType]) blockFieldChoices[blockType] = {};
        blockFieldChoices[blockType][f.field as string] = choices.map((c) => ({
          value: String(c.value),
          label: c.text ?? String(c.value),
        }));
      }
    }
  }

  // Fetch page items — include permalink if the collection has it
  const ITEM_FIELDS_WANTED = ['id', 'status', 'title', 'name', 'slug', 'permalink'];
  const availableFields = (fieldsByCollection.get(collection) ?? []).map((f: any) => f.field as string);
  const pageFields = ITEM_FIELDS_WANTED.filter((f) => availableFields.includes(f));
  if (!pageFields.includes('id')) pageFields.unshift('id');

  const pagesRes = await fetch(
    `${base}/items/${collection}?fields=${pageFields.join(',')}&limit=-1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const pagesData: any[] = pagesRes.ok ? ((await pagesRes.json()).data ?? []) : [];

  // Fetch all junction rows
  const junctionFieldList = ['id', 'sort', pageFk, itemField, collectionField].join(',');
  const junctionRes = await fetch(
    `${base}/items/${junctionTable}?fields=${encodeURIComponent(junctionFieldList)}&limit=-1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const junctionRows: any[] = junctionRes.ok ? ((await junctionRes.json()).data ?? []) : [];

  // Group junction rows by page ID; collect block IDs per type
  const blocksByPageId    = new Map<string, Array<{ junctionId: unknown; sort: number; blockType: string; blockId: string }>>();
  const blockIdsByType    = new Map<string, Set<string>>();

  for (const row of junctionRows) {
    const pageId    = String(row[pageFk]         ?? '');
    const blockType = String(row[collectionField] ?? '');
    const blockId   = String(row[itemField]       ?? '');
    if (!pageId || !blockType || !blockId) continue;

    if (!blocksByPageId.has(pageId)) blocksByPageId.set(pageId, []);
    blocksByPageId.get(pageId)!.push({ junctionId: row.id, sort: row.sort ?? 0, blockType, blockId });

    if (!blockIdsByType.has(blockType)) blockIdsByType.set(blockType, new Set());
    blockIdsByType.get(blockType)!.add(blockId);
  }

  // Fetch block items per type — only fetch "interesting" fields
  const blockItemsByTypeAndId = new Map<string, Map<string, any>>();
  await Promise.all(
    Array.from(blockIdsByType.entries()).map(async ([blockType, ids]) => {
      const allFields  = (fieldsByCollection.get(blockType) ?? []).map((f: any) => f.field as string);
      const choiceKeys = Object.keys(blockFieldChoices[blockType] ?? {});
      const interesting = ['id', 'internal_title', 'heading', 'title', 'name', ...choiceKeys]
        .filter((f) => allFields.includes(f));
      if (!interesting.includes('id')) interesting.unshift('id');

      const res = await fetch(
        `${base}/items/${blockType}?fields=${interesting.join(',')}&filter[id][_in]=${Array.from(ids).join(',')}&limit=-1`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const items: any[] = res.ok ? ((await res.json()).data ?? []) : [];
      const byId = new Map<string, any>();
      for (const item of items) byId.set(String(item.id), item);
      blockItemsByTypeAndId.set(blockType, byId);
    }),
  );

  // Assemble final tree
  const pages: PageItem[] = pagesData.map((page: any) => {
    const pageId = String(page.id);
    const jBlocks = (blocksByPageId.get(pageId) ?? []).slice().sort((a, b) => a.sort - b.sort);

    const blocks: BlockItem[] = jBlocks.map((jb) => {
      const raw = blockItemsByTypeAndId.get(jb.blockType)?.get(jb.blockId) ?? {};
      const fields: BlockField[] = Object.entries(raw)
        .filter(([k]) => k !== 'id')
        .map(([field, value]) => ({ field, value }));

      return {
        junctionId: jb.junctionId as string | number,
        sort:       jb.sort,
        blockType:  jb.blockType,
        blockLabel: formatLabel(jb.blockType, prefix),
        blockId:    jb.blockId,
        fields,
      };
    });

    return {
      id:         page.id,
      title:      page.title ?? page.name ?? page.slug ?? `#${page.id}`,
      status:     page.status ?? 'unknown',
      slug:       page.slug ?? null,
      permalink:  page.permalink ?? null,
      blockCount: blocks.length,
      blocks,
    };
  });

  const data: PageTreeData = {
    collection,
    label:            formatLabel(collection, prefix),
    junctionTable,
    allowedBlockTypes,
    blockFieldChoices,
    pages,
    fetchedAt: Date.now(),
  };

  cache.set(cacheKey, { data, fetchedAt: Date.now() });
  return data;
}

function formatLabel(collection: string, prefix: string): string {
  return collection
    .replace(new RegExp(`^${prefix}_`), '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
