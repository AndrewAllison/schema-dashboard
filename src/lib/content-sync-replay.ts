import {
  buildBestMatchKey,
  getRelationEdges,
  getWritableScalarFieldNames,
  isCollectionJunctionLike,
} from './content-sync-graph';

export interface SyncGraphNode {
  collection: string;
  sourceId: string | number;
  item: Record<string, unknown>;
  isRoot?: boolean;
}

export interface SyncSummary {
  created: number;
  updated: number;
  skipped: number;
  relationPatched: number;
  errors: number;
}

export interface SyncOperation {
  phase: 'upsert' | 'relations' | 'junctions' | 'validate';
  collection: string;
  sourceId?: string | number;
  targetId?: string | number;
  action: 'create' | 'update' | 'skip' | 'error' | 'validate';
  message: string;
}

export interface SyncWarning {
  code:
    | 'missing-target-collection'
    | 'missing-target-field'
    | 'unresolved-relation'
    | 'file-not-found'
    | 'unsupported-file-create';
  collection: string;
  field?: string;
  sourceId?: string | number;
  detail: string;
}

export interface ReplayResult {
  summary: SyncSummary;
  operations: SyncOperation[];
  warnings: SyncWarning[];
  idMap: Record<string, Record<string, string | number>>;
}

interface ReplayOptions {
  prodSnapshot: any;
  devSnapshot: any;
  prefix: string;
  prodBase: string;
  prodToken: string;
  devBase: string;
  devToken: string;
  nodes: SyncGraphNode[];
  updateExisting: boolean;
}

type IdMaps = Map<string, Map<string, string | number>>;

function mapToObject(idMap: IdMaps): Record<string, Record<string, string | number>> {
  const out: Record<string, Record<string, string | number>> = {};
  for (const [collection, map] of idMap.entries()) {
    out[collection] = Object.fromEntries(map.entries());
  }
  return out;
}

function putIdMap(idMap: IdMaps, collection: string, sourceId: string | number, targetId: string | number): void {
  if (!idMap.has(collection)) idMap.set(collection, new Map());
  idMap.get(collection)!.set(String(sourceId), targetId);
}

function getMappedId(idMap: IdMaps, collection: string, sourceId: unknown): string | number | null {
  if (sourceId == null) return null;
  return idMap.get(collection)?.get(String(sourceId)) ?? null;
}

function pickBody(item: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in item) body[field] = item[field];
  }
  return body;
}

async function parseJsonSafe(res: Response): Promise<any> {
  const txt = await res.text().catch(() => '');
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

async function findExistingTargetItem(
  base: string,
  token: string,
  collection: string,
  sourceItem: Record<string, unknown>,
): Promise<string | number | null> {
  const key = buildBestMatchKey(sourceItem);
  if (!key) return null;
  const params = new URLSearchParams();
  params.set(`filter[${key.field}][_eq]`, key.value);
  params.set('fields', 'id');
  params.set('limit', '1');

  const res = await fetch(`${base}/items/${collection}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const json = await parseJsonSafe(res);
  return json?.data?.[0]?.id ?? null;
}

async function createItem(
  base: string,
  token: string,
  collection: string,
  body: Record<string, unknown>,
): Promise<{ id: string | number | null; error?: string }> {
  const res = await fetch(`${base}/items/${collection}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = await parseJsonSafe(res);
    return { id: null, error: `HTTP ${res.status}: ${json?.errors?.[0]?.message ?? json?.raw ?? 'create failed'}` };
  }
  const json = await parseJsonSafe(res);
  return { id: json?.data?.id ?? null };
}

async function patchItem(
  base: string,
  token: string,
  collection: string,
  id: string | number,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${base}/items/${collection}/${id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = await parseJsonSafe(res);
    return { ok: false, error: `HTTP ${res.status}: ${json?.errors?.[0]?.message ?? json?.raw ?? 'update failed'}` };
  }
  return { ok: true };
}

async function findDevFileBySignature(
  base: string,
  token: string,
  srcFile: Record<string, unknown>,
): Promise<string | number | null> {
  const filenameDisk = typeof srcFile.filename_disk === 'string' ? srcFile.filename_disk : null;
  const title = typeof srcFile.title === 'string' ? srcFile.title : null;
  if (!filenameDisk && !title) return null;

  const params = new URLSearchParams();
  if (filenameDisk) {
    params.set('filter[filename_disk][_eq]', filenameDisk);
  } else if (title) {
    params.set('filter[title][_eq]', title);
  }
  params.set('fields', 'id');
  params.set('limit', '1');

  const res = await fetch(`${base}/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const json = await parseJsonSafe(res);
  return json?.data?.[0]?.id ?? null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

async function mapRelationValue(
  value: unknown,
  relatedCollection: string | null,
  idMap: IdMaps,
  nodeLookup: Map<string, SyncGraphNode>,
  opts: ReplayOptions,
  warningCtx: { collection: string; field: string; sourceId: string | number },
  warnings: SyncWarning[],
): Promise<unknown> {
  if (value == null || relatedCollection == null) return value;

  const resolveOne = async (collection: string, srcId: unknown): Promise<string | number | null> => {
    if (srcId == null) return null;
    const mapped = getMappedId(idMap, collection, srcId);
    if (mapped != null) return mapped;

    if (collection === 'directus_files') {
      const node = nodeLookup.get(`directus_files:${String(srcId)}`);
      if (node) {
        const devId = await findDevFileBySignature(opts.devBase, opts.devToken, node.item);
        if (devId != null) {
          putIdMap(idMap, 'directus_files', srcId as string | number, devId);
          return devId;
        }
      }
      warnings.push({
        code: 'file-not-found',
        collection: warningCtx.collection,
        field: warningCtx.field,
        sourceId: warningCtx.sourceId,
        detail: `Could not map file source id ${String(srcId)} to an existing dev file.`,
      });
      return null;
    }
    return null;
  };

  if (Array.isArray(value)) {
    const mappedArr: unknown[] = [];
    for (const entry of value) {
      if (isObject(entry) && typeof entry.collection === 'string' && entry.item != null) {
        const mapped = await resolveOne(entry.collection, entry.item);
        if (mapped != null) mappedArr.push({ collection: entry.collection, item: mapped });
      } else if (isObject(entry) && entry.id != null) {
        const mapped = await resolveOne(relatedCollection, entry.id);
        if (mapped != null) mappedArr.push(mapped);
      } else {
        const mapped = await resolveOne(relatedCollection, entry);
        if (mapped != null) mappedArr.push(mapped);
      }
    }
    return mappedArr;
  }

  if (isObject(value) && typeof value.collection === 'string' && value.item != null) {
    const mapped = await resolveOne(value.collection, value.item);
    return mapped != null ? { collection: value.collection, item: mapped } : null;
  }

  if (isObject(value) && value.id != null) {
    return resolveOne(relatedCollection, value.id);
  }

  return resolveOne(relatedCollection, value);
}

export async function replayDeepGraphToDev(opts: ReplayOptions): Promise<ReplayResult> {
  const summary: SyncSummary = { created: 0, updated: 0, skipped: 0, relationPatched: 0, errors: 0 };
  const operations: SyncOperation[] = [];
  const warnings: SyncWarning[] = [];
  const idMap: IdMaps = new Map();
  const nodeLookup = new Map(opts.nodes.map((n) => [`${n.collection}:${String(n.sourceId)}`, n] as const));

  const availableDevCollections = new Set(
    (opts.devSnapshot?.collections ?? []).map((c: any) => c.collection as string),
  );

  const rootFirst = [...opts.nodes].sort((a, b) => {
    const aJ = isCollectionJunctionLike(a.collection) ? 1 : 0;
    const bJ = isCollectionJunctionLike(b.collection) ? 1 : 0;
    if ((a.isRoot ? 1 : 0) !== (b.isRoot ? 1 : 0)) return a.isRoot ? -1 : 1;
    if (aJ !== bJ) return aJ - bJ;
    return a.collection.localeCompare(b.collection);
  });

  const primaryNodes = rootFirst.filter((n) => !isCollectionJunctionLike(n.collection));
  const junctionNodes = rootFirst.filter((n) => isCollectionJunctionLike(n.collection));

  // Phase A: upsert primary records with scalar fields only.
  for (const node of primaryNodes) {
    if (!availableDevCollections.has(node.collection)) {
      warnings.push({
        code: 'missing-target-collection',
        collection: node.collection,
        sourceId: node.sourceId,
        detail: `Collection ${node.collection} does not exist in dev schema.`,
      });
      operations.push({
        phase: 'upsert',
        collection: node.collection,
        sourceId: node.sourceId,
        action: 'skip',
        message: 'Skipped: target collection missing in dev.',
      });
      summary.skipped++;
      continue;
    }

    if (node.collection === 'directus_files') {
      warnings.push({
        code: 'unsupported-file-create',
        collection: node.collection,
        sourceId: node.sourceId,
        detail: 'File binary copy is not supported by this endpoint; attempting ID mapping only.',
      });
      const mapped = await findDevFileBySignature(opts.devBase, opts.devToken, node.item);
      if (mapped != null) {
        putIdMap(idMap, node.collection, node.sourceId, mapped);
        operations.push({
          phase: 'upsert',
          collection: node.collection,
          sourceId: node.sourceId,
          targetId: mapped,
          action: 'skip',
          message: 'Mapped to existing dev file by filename/title signature.',
        });
      } else {
        operations.push({
          phase: 'upsert',
          collection: node.collection,
          sourceId: node.sourceId,
          action: 'skip',
          message: 'No matching dev file found.',
        });
      }
      summary.skipped++;
      continue;
    }

    const writable = getWritableScalarFieldNames(opts.devSnapshot, opts.prefix, node.collection);
    const body = pickBody(node.item, writable);
    let targetId: string | number | null = null;

    if (opts.updateExisting) {
      targetId = await findExistingTargetItem(opts.devBase, opts.devToken, node.collection, node.item);
    }

    if (targetId != null) {
      const updateRes = await patchItem(opts.devBase, opts.devToken, node.collection, targetId, body);
      if (!updateRes.ok) {
        summary.errors++;
        operations.push({
          phase: 'upsert',
          collection: node.collection,
          sourceId: node.sourceId,
          targetId,
          action: 'error',
          message: updateRes.error ?? 'Update failed',
        });
        continue;
      }
      putIdMap(idMap, node.collection, node.sourceId, targetId);
      summary.updated++;
      operations.push({
        phase: 'upsert',
        collection: node.collection,
        sourceId: node.sourceId,
        targetId,
        action: 'update',
        message: 'Updated existing dev item.',
      });
    } else {
      const createRes = await createItem(opts.devBase, opts.devToken, node.collection, body);
      if (!createRes.id) {
        summary.errors++;
        operations.push({
          phase: 'upsert',
          collection: node.collection,
          sourceId: node.sourceId,
          action: 'error',
          message: createRes.error ?? 'Create failed',
        });
        continue;
      }
      putIdMap(idMap, node.collection, node.sourceId, createRes.id);
      summary.created++;
      operations.push({
        phase: 'upsert',
        collection: node.collection,
        sourceId: node.sourceId,
        targetId: createRes.id,
        action: 'create',
        message: 'Created new dev item.',
      });
    }
  }

  // Phase B: patch relational fields on primary records.
  for (const node of primaryNodes) {
    const targetId = getMappedId(idMap, node.collection, node.sourceId);
    if (targetId == null) continue;
    const edges = getRelationEdges(opts.prodSnapshot, opts.prefix, node.collection);
    if (edges.length === 0) continue;

    const patchBody: Record<string, unknown> = {};
    for (const edge of edges) {
      if (!(edge.field in node.item)) continue;
      const mappedValue = await mapRelationValue(
        node.item[edge.field],
        edge.relatedCollection,
        idMap,
        nodeLookup,
        opts,
        { collection: node.collection, field: edge.field, sourceId: node.sourceId },
        warnings,
      );
      if (mappedValue == null) {
        warnings.push({
          code: 'unresolved-relation',
          collection: node.collection,
          field: edge.field,
          sourceId: node.sourceId,
          detail: `Could not resolve relation value for ${edge.field}; field was skipped.`,
        });
        continue;
      }
      patchBody[edge.field] = mappedValue;
    }

    if (Object.keys(patchBody).length === 0) continue;
    const patchRes = await patchItem(opts.devBase, opts.devToken, node.collection, targetId, patchBody);
    if (!patchRes.ok) {
      summary.errors++;
      operations.push({
        phase: 'relations',
        collection: node.collection,
        sourceId: node.sourceId,
        targetId,
        action: 'error',
        message: patchRes.error ?? 'Relation patch failed',
      });
      continue;
    }
    summary.relationPatched++;
    operations.push({
      phase: 'relations',
      collection: node.collection,
      sourceId: node.sourceId,
      targetId,
      action: 'update',
      message: 'Patched relational fields.',
    });
  }

  // Phase C: apply junction rows after targets exist.
  for (const node of junctionNodes) {
    if (!availableDevCollections.has(node.collection)) {
      warnings.push({
        code: 'missing-target-collection',
        collection: node.collection,
        sourceId: node.sourceId,
        detail: `Junction collection ${node.collection} missing in dev.`,
      });
      summary.skipped++;
      operations.push({
        phase: 'junctions',
        collection: node.collection,
        sourceId: node.sourceId,
        action: 'skip',
        message: 'Skipped junction: collection missing in dev.',
      });
      continue;
    }

    const writable = getWritableScalarFieldNames(opts.devSnapshot, opts.prefix, node.collection);
    const body: Record<string, unknown> = pickBody(node.item, writable);

    const edges = getRelationEdges(opts.prodSnapshot, opts.prefix, node.collection);
    for (const edge of edges) {
      if (!(edge.field in node.item)) continue;
      const mapped = await mapRelationValue(
        node.item[edge.field],
        edge.relatedCollection,
        idMap,
        nodeLookup,
        opts,
        { collection: node.collection, field: edge.field, sourceId: node.sourceId },
        warnings,
      );
      if (mapped != null) body[edge.field] = mapped;
    }

    let targetId: string | number | null = null;
    if (opts.updateExisting) {
      targetId = await findExistingTargetItem(opts.devBase, opts.devToken, node.collection, body);
    }

    if (targetId != null) {
      const patchRes = await patchItem(opts.devBase, opts.devToken, node.collection, targetId, body);
      if (!patchRes.ok) {
        summary.errors++;
        operations.push({
          phase: 'junctions',
          collection: node.collection,
          sourceId: node.sourceId,
          targetId,
          action: 'error',
          message: patchRes.error ?? 'Junction update failed',
        });
      } else {
        putIdMap(idMap, node.collection, node.sourceId, targetId);
        summary.updated++;
        operations.push({
          phase: 'junctions',
          collection: node.collection,
          sourceId: node.sourceId,
          targetId,
          action: 'update',
          message: 'Updated existing junction row.',
        });
      }
    } else {
      const createRes = await createItem(opts.devBase, opts.devToken, node.collection, body);
      if (!createRes.id) {
        summary.errors++;
        operations.push({
          phase: 'junctions',
          collection: node.collection,
          sourceId: node.sourceId,
          action: 'error',
          message: createRes.error ?? 'Junction create failed',
        });
      } else {
        putIdMap(idMap, node.collection, node.sourceId, createRes.id);
        summary.created++;
        operations.push({
          phase: 'junctions',
          collection: node.collection,
          sourceId: node.sourceId,
          targetId: createRes.id,
          action: 'create',
          message: 'Created junction row.',
        });
      }
    }
  }

  return { summary, operations, warnings, idMap: mapToObject(idMap) };
}
