import type { APIRoute } from 'astro';
import { DEV_TOKEN, DEV_URL, PROD_TOKEN, PROD_URL, COLLECTION_PREFIX } from '../../lib/env';
import { fetchSnapshot, filterSnapshot } from '@diff';

const TTL_MS = 5 * 60 * 1000;

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface FieldInfo {
  field: string;
  type: string;
  required: boolean;
  note: string | null;
}

export interface PageUsage {
  collection: string;
  label: string;
  junctionCollection: string;
  inDev: boolean;
  inProd: boolean;
  devUsageCount: number;
  prodUsageCount: number;
}

export interface BlockDetailData {
  block: string;
  label: string;
  devFields: FieldInfo[];
  prodFields: FieldInfo[];
  fieldDiff: {
    devOnly: FieldInfo[];
    prodOnly: FieldInfo[];
    changed: { field: string; dev: FieldInfo; prod: FieldInfo }[];
    matched: FieldInfo[];
  };
  usedByPages: PageUsage[];
  fetchedAt: number;
  error?: string;
  devSnapshotError?: string;
  prodSnapshotError?: string;
}

// ── Cache (keyed by block name) ────────────────────────────────────────────

const blockDetailCache = new Map<string, { data: BlockDetailData; fetchedAt: number }>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatLabel(collection: string, prefix: string): string {
  return collection
    .replace(new RegExp(`^${prefix}_`), '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function extractFields(snapshot: any, prefix: string, collectionName: string): FieldInfo[] {
  const filtered = filterSnapshot(snapshot, prefix);
  return (filtered.fields ?? [])
    .filter((f: any) => f.collection === collectionName)
    .map((f: any): FieldInfo => ({
      field:    f.field as string,
      type:     (f.type as string) ?? 'unknown',
      required: !!(f.meta?.required),
      note:     (f.meta?.note as string) ?? null,
    }));
}

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

/** Find all page collections that reference the given block type in their allowedBlockTypes. */
function findPageUsagesInSnapshot(
  snapshot: any,
  prefix: string,
  blockName: string,
): Map<string, { junctionCollection: string }> {
  const filtered = filterSnapshot(snapshot, prefix);
  const pageCollectionNames = getPageCollectionNames(snapshot, prefix);
  const result = new Map<string, { junctionCollection: string }>();

  for (const rel of (filtered.relations ?? [])) {
    const allowed: string[] | undefined = rel.meta?.one_allowed_collections;
    if (!Array.isArray(allowed) || !allowed.includes(blockName)) continue;
    const junctionName: string = rel.collection;
    for (const pageName of pageCollectionNames) {
      if (junctionName.startsWith(pageName + '_')) {
        result.set(pageName, { junctionCollection: junctionName });
        break;
      }
    }
  }
  return result;
}

/** Get the discriminator column name on the junction table (the field that stores the block type name). */
function findCollectionField(snapshot: any, prefix: string, junctionCollection: string): string | null {
  const filtered = filterSnapshot(snapshot, prefix);
  for (const rel of (filtered.relations ?? [])) {
    if (rel.collection === junctionCollection && rel.meta?.one_allowed_collections) {
      return rel.meta.junction_field as string ?? null;
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

async function fetchUsageCount(
  base: string,
  token: string,
  junctionCollection: string,
  collectionField: string,
  blockName: string,
): Promise<number> {
  try {
    const url =
      `${base}/items/${junctionCollection}` +
      `?filter[${collectionField}][_eq]=${encodeURIComponent(blockName)}` +
      `&aggregate[count]=*&limit=0`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return 0;
    const json = await res.json();
    const raw = json.data?.[0]?.count;
    return raw != null ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

function computeFieldDiff(devFields: FieldInfo[], prodFields: FieldInfo[]) {
  const devMap  = new Map(devFields.map(f => [f.field, f]));
  const prodMap = new Map(prodFields.map(f => [f.field, f]));

  const devOnly:  FieldInfo[] = [];
  const prodOnly: FieldInfo[] = [];
  const changed:  { field: string; dev: FieldInfo; prod: FieldInfo }[] = [];
  const matched:  FieldInfo[] = [];

  for (const [name, df] of devMap) {
    const pf = prodMap.get(name);
    if (!pf) {
      devOnly.push(df);
    } else if (df.type !== pf.type || df.required !== pf.required) {
      changed.push({ field: name, dev: df, prod: pf });
    } else {
      matched.push(df);
    }
  }
  for (const [name, pf] of prodMap) {
    if (!devMap.has(name)) prodOnly.push(pf);
  }

  // Sort each group alphabetically
  [devOnly, prodOnly, matched].forEach(arr => arr.sort((a, b) => a.field.localeCompare(b.field)));
  changed.sort((a, b) => a.field.localeCompare(b.field));

  return { devOnly, prodOnly, changed, matched };
}

// ── API Route ─────────────────────────────────────────────────────────────────

export const GET: APIRoute = async ({ url }) => {
  const blockName    = url.searchParams.get('block');
  const forceRefresh = url.searchParams.get('refresh') === 'true';

  if (!blockName) {
    return new Response(JSON.stringify({ error: 'Missing required query param: block' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cached = blockDetailCache.get(blockName);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return new Response(JSON.stringify(cached.data), {
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

  // 1. Fetch both snapshots in parallel
  const [devSnapshotResult, prodSnapshotResult] = await Promise.allSettled([
    fetchSnapshot(devBase, devToken),
    fetchSnapshot(prodBase, prodToken),
  ]);

  const devSnapshotError  = devSnapshotResult.status  === 'rejected' ? String(devSnapshotResult.reason)  : undefined;
  const prodSnapshotError = prodSnapshotResult.status === 'rejected' ? String(prodSnapshotResult.reason) : undefined;
  const devSnapshot  = devSnapshotResult.status  === 'fulfilled' ? devSnapshotResult.value  : null;
  const prodSnapshot = prodSnapshotResult.status === 'fulfilled' ? prodSnapshotResult.value : null;

  // 2. Extract fields for this block from each env
  const devFields  = devSnapshot  ? extractFields(devSnapshot,  prefix, blockName) : [];
  const prodFields = prodSnapshot ? extractFields(prodSnapshot, prefix, blockName) : [];
  const fieldDiff  = computeFieldDiff(devFields, prodFields);

  // 3. Find which page collections use this block in each env
  const devPageUsages  = devSnapshot  ? findPageUsagesInSnapshot(devSnapshot,  prefix, blockName) : new Map<string, { junctionCollection: string }>();
  const prodPageUsages = prodSnapshot ? findPageUsagesInSnapshot(prodSnapshot, prefix, blockName) : new Map<string, { junctionCollection: string }>();

  const allPageNames = [...new Set([...devPageUsages.keys(), ...prodPageUsages.keys()])];

  // 4. Fetch usage counts per page collection per env
  const usedByPages: PageUsage[] = await Promise.all(
    allPageNames.map(async (pageName): Promise<PageUsage> => {
      const devInfo  = devPageUsages.get(pageName);
      const prodInfo = prodPageUsages.get(pageName);
      const junctionCollection = devInfo?.junctionCollection ?? prodInfo?.junctionCollection ?? '';

      const devCollField  = devSnapshot  && junctionCollection ? findCollectionField(devSnapshot,  prefix, junctionCollection) : null;
      const prodCollField = prodSnapshot && junctionCollection ? findCollectionField(prodSnapshot, prefix, junctionCollection) : null;

      const [devCount, prodCount] = await Promise.all([
        devInfo && devCollField
          ? fetchUsageCount(devBase,  devToken,  junctionCollection, devCollField,  blockName)
          : Promise.resolve(0),
        prodInfo && prodCollField
          ? fetchUsageCount(prodBase, prodToken, junctionCollection, prodCollField, blockName)
          : Promise.resolve(0),
      ]);

      return {
        collection: pageName,
        label: formatLabel(pageName, prefix),
        junctionCollection,
        inDev:  !!devInfo,
        inProd: !!prodInfo,
        devUsageCount:  devCount,
        prodUsageCount: prodCount,
      };
    }),
  );

  usedByPages.sort((a, b) => a.label.localeCompare(b.label));

  const data: BlockDetailData = {
    block: blockName,
    label: formatLabel(blockName, prefix),
    devFields,
    prodFields,
    fieldDiff,
    usedByPages,
    fetchedAt: Date.now(),
    devSnapshotError,
    prodSnapshotError,
  };

  blockDetailCache.set(blockName, { data, fetchedAt: Date.now() });

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
};
