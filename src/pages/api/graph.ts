import type { APIRoute } from 'astro';
import { fetchSnapshot, filterSnapshot } from '@diff';
import { DEV_TOKEN, DEV_URL, COLLECTION_PREFIX } from '../../lib/env';

let graphCache: { data: GraphData; fetchedAt: number } | null = null;
const TTL = 5 * 60 * 1000;

interface NodeData {
  id: string;
  label: string;
  fullName: string;
  isJunction: boolean;
}

interface EdgeData {
  id: string;
  source: string;
  target: string;
  label: string;
  type: 'm2o' | 'm2m' | 'm2a';
  field: string;
  via?: string;
}

interface GraphData {
  nodes: { data: NodeData }[];
  edges: { data: EdgeData }[];
  fetchedAt: number;
}

export const GET: APIRoute = async ({ url }) => {
  const forceRefresh = url.searchParams.get('forceRefresh') === 'true';

  if (!forceRefresh && graphCache && Date.now() - graphCache.fetchedAt < TTL) {
    return new Response(JSON.stringify(graphCache.data), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const snapshot = await fetchSnapshot(DEV_URL(), DEV_TOKEN());
    const prefix = COLLECTION_PREFIX();
    const filtered = filterSnapshot(snapshot, prefix);
    const data = buildGraphData(filtered, prefix);
    graphCache = { data, fetchedAt: Date.now() };
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

function buildGraphData(snapshot: any, prefix: string): GraphData {
  const relations: any[] = snapshot.relations ?? [];
  const collections: any[] = snapshot.collections ?? [];

  // Collections involved in M2M/M2A as junction tables
  const junctionCollections = new Set<string>();
  for (const rel of relations) {
    if (rel.meta?.junction_field) {
      junctionCollections.add(rel.collection as string);
    }
  }

  const shortLabel = (name: string): string => {
    if (!prefix) return name;
    const stripped = name.startsWith(prefix + '_') ? name.slice(prefix.length + 1) : name;
    return stripped || name;
  };

  const collectionIds = new Set<string>(collections.map((c: any) => c.collection as string));

  const nodes: { data: NodeData }[] = collections.map((c: any) => ({
    data: {
      id: c.collection as string,
      label: shortLabel(c.collection),
      fullName: c.collection as string,
      isJunction: junctionCollections.has(c.collection as string),
    },
  }));

  const edges: { data: EdgeData }[] = [];
  const processedM2M = new Set<string>();

  for (const rel of relations) {
    const isM2A =
      Array.isArray(rel.meta?.one_allowed_collections) &&
      rel.meta.one_allowed_collections.length > 0;
    const isJunctionSide = !!rel.meta?.junction_field;

    if (isM2A) {
      // Find the owner collection via the sibling relation's junction_field
      const ownerRel = relations.find(
        (r: any) =>
          r.collection === rel.collection &&
          r.field === rel.meta.junction_field &&
          r.related_collection,
      );
      const source: string = ownerRel?.related_collection ?? rel.collection;

      for (const allowedCol of rel.meta.one_allowed_collections as string[]) {
        if (!collectionIds.has(source) || !collectionIds.has(allowedCol)) continue;
        const edgeId = `m2a-${rel.collection}-${allowedCol}`;
        if (!edges.some(e => e.data.id === edgeId)) {
          edges.push({
            data: {
              id: edgeId,
              source,
              target: allowedCol,
              label: 'M2A',
              type: 'm2a',
              field: rel.field as string,
              via: source !== rel.collection ? (rel.collection as string) : undefined,
            },
          });
        }
      }
    } else if (isJunctionSide) {
      // M2M: pair the two relations on the same junction table
      const otherField = rel.meta.junction_field as string;
      const otherRel = relations.find(
        (r: any) =>
          r.collection === rel.collection &&
          r.field === otherField &&
          !r.meta?.one_allowed_collections?.length,
      );

      if (otherRel?.related_collection && rel.related_collection) {
        const [a, b] = [rel.related_collection as string, otherRel.related_collection as string].sort();
        const key = `${a}|${b}|${rel.collection}`;
        if (!processedM2M.has(key)) {
          processedM2M.add(key);
          if (collectionIds.has(a) && collectionIds.has(b)) {
            edges.push({
              data: {
                id: `m2m-${key}`,
                source: rel.related_collection as string,
                target: otherRel.related_collection as string,
                label: 'M2M',
                type: 'm2m',
                field: `${rel.field} ↔ ${otherField}`,
                via: rel.collection as string,
              },
            });
          }
        }
      }
    } else if (rel.related_collection) {
      // Simple M2O
      const source = rel.collection as string;
      const target = rel.related_collection as string;
      if (collectionIds.has(source) && collectionIds.has(target)) {
        edges.push({
          data: {
            id: `m2o-${rel.collection}.${rel.field}`,
            source,
            target,
            label: 'M2O',
            type: 'm2o',
            field: rel.field as string,
          },
        });
      }
    }
  }

  return { nodes, edges, fetchedAt: Date.now() };
}
