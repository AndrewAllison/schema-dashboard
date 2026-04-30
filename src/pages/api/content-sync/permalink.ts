import type { APIRoute } from 'astro';
import { COLLECTION_PREFIX, DEV_TOKEN, DEV_URL, PROD_TOKEN, PROD_URL } from '../../../lib/env';
import { fetchSnapshot } from '@diff';
import {
  buildFieldsByCollection,
  findParentFkField,
  getBlockInfoByPage,
  getPageCollections,
  getRelationEdges,
  isCollectionJunctionLike,
} from '../../../lib/content-sync-graph';
import {
  replayDeepGraphToDev,
  type SyncGraphNode,
  type SyncOperation,
  type SyncWarning,
} from '../../../lib/content-sync-replay';
import { bustContentDiffCache } from '../content-diff';
import { bustAllContentItemCache } from '../content-item';

type Mode = 'dry-run' | 'apply';

interface PermalinkSyncPayload {
  permalink: string;
  mode?: Mode;
  depth?: 'deep';
  targetStrategy?: 'update-existing';
  confirmApply?: boolean;
}

interface PlanStep {
  collection: string;
  sourceId: string | number;
  isRoot: boolean;
  isJunction: boolean;
}

function sanitizePermalink(input: string): string {
  const s = input.trim();
  if (!s) return '';
  if (s.startsWith('http://') || s.startsWith('https://')) {
    try {
      const u = new URL(s);
      return u.pathname;
    } catch {
      return s;
    }
  }
  return s.startsWith('/') ? s : `/${s}`;
}

function extractRefs(value: unknown): Array<{ collection: string | null; sourceId: string | number }> {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap(extractRefs);
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (typeof rec.collection === 'string' && (typeof rec.item === 'string' || typeof rec.item === 'number')) {
      return [{ collection: rec.collection, sourceId: rec.item }];
    }
    if (typeof rec.id === 'string' || typeof rec.id === 'number') {
      return [{ collection: null, sourceId: rec.id }];
    }
    return [];
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return [{ collection: null, sourceId: value }];
  }
  return [];
}

async function fetchFirstByPermalink(
  base: string,
  token: string,
  collection: string,
  permalink: string,
): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams();
  params.set('filter[permalink][_eq]', permalink);
  params.set('fields', '*');
  params.set('limit', '1');

  const res = await fetch(`${base}/items/${collection}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.data?.[0] ?? null;
}

async function fetchItemById(
  base: string,
  token: string,
  collection: string,
  id: string | number,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `${base}/items/${collection}/${encodeURIComponent(String(id))}?fields=*`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const json = await res.json();
  return json?.data ?? null;
}

async function fetchItemsByParent(
  base: string,
  token: string,
  collection: string,
  parentField: string,
  parentId: string | number,
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  params.set(`filter[${parentField}][_eq]`, String(parentId));
  params.set('fields', '*');
  params.set('limit', '-1');
  const res = await fetch(`${base}/items/${collection}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const json = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

async function buildDeepGraph(
  prodBase: string,
  prodToken: string,
  prodSnapshot: any,
  prefix: string,
  rootCollection: string,
  rootId: string | number,
): Promise<{ nodes: SyncGraphNode[]; warnings: SyncWarning[] }> {
  const warnings: SyncWarning[] = [];
  const nodes: SyncGraphNode[] = [];
  const visited = new Set<string>();
  const queue: Array<{ collection: string; sourceId: string | number; isRoot?: boolean }> = [
    { collection: rootCollection, sourceId: rootId, isRoot: true },
  ];

  const pageInfo = getPageCollections(prodSnapshot, prefix);
  const blockInfo = getBlockInfoByPage(prodSnapshot, prefix, pageInfo.names).get(rootCollection) ?? null;
  const rootParentFk = blockInfo
    ? findParentFkField(blockInfo.junctionCollection, rootCollection, prodSnapshot, prefix)
    : null;

  const maxNodes = 600;
  while (queue.length > 0) {
    if (nodes.length >= maxNodes) {
      warnings.push({
        code: 'unresolved-relation',
        collection: rootCollection,
        sourceId: rootId,
        detail: `Traversal reached max node cap (${maxNodes}); remaining nodes skipped.`,
      });
      break;
    }

    const next = queue.shift()!;
    const key = `${next.collection}:${String(next.sourceId)}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const item = await fetchItemById(prodBase, prodToken, next.collection, next.sourceId);
    if (!item) {
      warnings.push({
        code: 'unresolved-relation',
        collection: next.collection,
        sourceId: next.sourceId,
        detail: `Could not fetch source item ${next.collection}/${String(next.sourceId)} from prod.`,
      });
      continue;
    }

    nodes.push({
      collection: next.collection,
      sourceId: next.sourceId,
      item,
      isRoot: !!next.isRoot,
    });

    // Generic outgoing relations.
    const edges = getRelationEdges(prodSnapshot, prefix, next.collection);
    for (const edge of edges) {
      const refs = extractRefs(item[edge.field]);
      for (const ref of refs) {
        const refCollection = ref.collection ?? edge.relatedCollection;
        if (!refCollection) continue;
        queue.push({ collection: refCollection, sourceId: ref.sourceId });
      }
    }

    // Special handling for root page block junction rows.
    if (
      next.collection === rootCollection &&
      blockInfo &&
      rootParentFk &&
      String(next.sourceId) === String(rootId)
    ) {
      const rows = await fetchItemsByParent(
        prodBase,
        prodToken,
        blockInfo.junctionCollection,
        rootParentFk,
        rootId,
      );
      for (const row of rows) {
        const rowId = row.id as string | number | undefined;
        if (rowId == null) continue;
        const rowKey = `${blockInfo.junctionCollection}:${String(rowId)}`;
        if (visited.has(rowKey)) continue;
        nodes.push({
          collection: blockInfo.junctionCollection,
          sourceId: rowId,
          item: row,
        });
        visited.add(rowKey);

        for (const val of Object.values(row)) {
          const refs = extractRefs(val);
          for (const ref of refs) {
            if (!ref.collection) continue;
            queue.push({ collection: ref.collection, sourceId: ref.sourceId });
          }
        }

        const jEdges = getRelationEdges(prodSnapshot, prefix, blockInfo.junctionCollection);
        for (const edge of jEdges) {
          const refs = extractRefs(row[edge.field]);
          for (const ref of refs) {
            const refCollection = ref.collection ?? edge.relatedCollection;
            if (!refCollection) continue;
            queue.push({ collection: refCollection, sourceId: ref.sourceId });
          }
        }
      }
    }
  }

  return { nodes, warnings };
}

function buildCollectionCounts(nodes: SyncGraphNode[]): Array<{ collection: string; count: number; junction: boolean }> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    counts.set(node.collection, (counts.get(node.collection) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([collection, count]) => ({
      collection,
      count,
      junction: isCollectionJunctionLike(collection),
    }))
    .sort((a, b) => b.count - a.count || a.collection.localeCompare(b.collection));
}

async function validateReplay(
  devBase: string,
  devToken: string,
  rootCollection: string,
  permalink: string,
): Promise<SyncOperation> {
  const devItem = await fetchFirstByPermalink(devBase, devToken, rootCollection, permalink);
  if (!devItem) {
    return {
      phase: 'validate',
      collection: rootCollection,
      action: 'error',
      message: `Validation failed: permalink ${permalink} not found in dev after sync.`,
    };
  }
  return {
    phase: 'validate',
    collection: rootCollection,
    sourceId: (devItem.id as string | number | undefined) ?? undefined,
    targetId: (devItem.id as string | number | undefined) ?? undefined,
    action: 'validate',
    message: `Validation ok: permalink ${permalink} resolves in dev.`,
  };
}

export const POST: APIRoute = async ({ request }) => {
  let payload: PermalinkSyncPayload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON body.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const permalink = sanitizePermalink(payload.permalink ?? '');
  const mode: Mode = payload.mode === 'apply' ? 'apply' : 'dry-run';
  const depth = payload.depth ?? 'deep';
  const targetStrategy = payload.targetStrategy ?? 'update-existing';
  const confirmApply = payload.confirmApply === true;

  if (!permalink) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing required field: permalink' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (depth !== 'deep') {
    return new Response(JSON.stringify({ ok: false, error: 'Only depth="deep" is currently supported.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (targetStrategy !== 'update-existing') {
    return new Response(JSON.stringify({ ok: false, error: 'Only targetStrategy="update-existing" is currently supported.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (mode === 'apply' && !confirmApply) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Apply mode requires confirmApply=true.',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const prefix = COLLECTION_PREFIX();
  const prodBase = PROD_URL();
  const devBase = DEV_URL();
  let prodToken: string;
  let devToken: string;
  try {
    prodToken = PROD_TOKEN();
    devToken = DEV_TOKEN();
  } catch (err: unknown) {
    return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const [prodSnapshotRes, devSnapshotRes] = await Promise.allSettled([
    fetchSnapshot(prodBase, prodToken),
    fetchSnapshot(devBase, devToken),
  ]);
  if (prodSnapshotRes.status !== 'fulfilled' || devSnapshotRes.status !== 'fulfilled') {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Failed to load snapshots from both environments.',
      detail: {
        prod: prodSnapshotRes.status === 'rejected' ? String(prodSnapshotRes.reason) : null,
        dev: devSnapshotRes.status === 'rejected' ? String(devSnapshotRes.reason) : null,
      },
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const prodSnapshot = prodSnapshotRes.value;
  const devSnapshot = devSnapshotRes.value;

  const pageCollections = getPageCollections(prodSnapshot, prefix).names;
  let rootCollection: string | null = null;
  let rootItem: Record<string, unknown> | null = null;

  for (const collection of pageCollections) {
    const item = await fetchFirstByPermalink(prodBase, prodToken, collection, permalink);
    if (item) {
      rootCollection = collection;
      rootItem = item;
      break;
    }
  }

  if (!rootCollection || !rootItem || rootItem.id == null) {
    return new Response(JSON.stringify({
      ok: false,
      error: `No prod page found by permalink ${permalink}.`,
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const graph = await buildDeepGraph(
    prodBase,
    prodToken,
    prodSnapshot,
    prefix,
    rootCollection,
    rootItem.id as string | number,
  );

  const prodFieldsByCollection = buildFieldsByCollection(prodSnapshot, prefix);
  const devFieldsByCollection = buildFieldsByCollection(devSnapshot, prefix);
  const fieldWarnings: SyncWarning[] = [];
  for (const node of graph.nodes) {
    const prodFields = new Set(prodFieldsByCollection.get(node.collection) ?? []);
    const devFields = new Set(devFieldsByCollection.get(node.collection) ?? []);
    for (const field of Object.keys(node.item)) {
      if (!prodFields.has(field)) continue;
      if (!devFields.has(field)) {
        fieldWarnings.push({
          code: 'missing-target-field',
          collection: node.collection,
          field,
          sourceId: node.sourceId,
          detail: `Field ${field} exists in prod node but not in dev schema for ${node.collection}.`,
        });
      }
    }
  }

  const orderedSteps: PlanStep[] = [...graph.nodes]
    .sort((a, b) => {
      if ((a.isRoot ? 1 : 0) !== (b.isRoot ? 1 : 0)) return a.isRoot ? -1 : 1;
      const aJ = isCollectionJunctionLike(a.collection) ? 1 : 0;
      const bJ = isCollectionJunctionLike(b.collection) ? 1 : 0;
      if (aJ !== bJ) return aJ - bJ;
      return a.collection.localeCompare(b.collection);
    })
    .map((n) => ({
      collection: n.collection,
      sourceId: n.sourceId,
      isRoot: !!n.isRoot,
      isJunction: isCollectionJunctionLike(n.collection),
    }));

  const plan = {
    permalink,
    rootCollection,
    rootSourceId: rootItem.id as string | number,
    nodeCount: graph.nodes.length,
    collections: buildCollectionCounts(graph.nodes),
    steps: orderedSteps,
  };

  if (mode === 'dry-run') {
    return new Response(JSON.stringify({
      ok: true,
      mode,
      summary: {
        plannedCreatesOrUpdates: graph.nodes.length,
        plannedCollections: plan.collections.length,
        warnings: graph.warnings.length + fieldWarnings.length,
      },
      plan,
      idMap: {},
      operations: [] as SyncOperation[],
      warnings: [...graph.warnings, ...fieldWarnings],
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const replay = await replayDeepGraphToDev({
    prodSnapshot,
    devSnapshot,
    prefix,
    prodBase,
    prodToken,
    devBase,
    devToken,
    nodes: graph.nodes,
    updateExisting: true,
  });

  const validateOp = await validateReplay(devBase, devToken, rootCollection, permalink);
  replay.operations.push(validateOp);
  if (validateOp.action === 'error') replay.summary.errors++;

  bustContentDiffCache();
  bustAllContentItemCache();

  return new Response(JSON.stringify({
    ok: replay.summary.errors === 0,
    mode,
    summary: replay.summary,
    plan,
    idMap: replay.idMap,
    operations: replay.operations,
    warnings: [...graph.warnings, ...fieldWarnings, ...replay.warnings],
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
