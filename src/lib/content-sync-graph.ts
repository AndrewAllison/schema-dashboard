import { filterSnapshot } from './directus-schema-diff.js';
import { EXCLUDED_FIELDS, SCALAR_TYPES } from './content-fields.ts';

export interface BlockInfo {
  junctionCollection: string;
  allowedBlockTypes: string[];
}

export interface PageCollectionResult {
  names: string[];
  fieldsByCollection: Map<string, string[]>;
}

export interface RelationEdge {
  collection: string;
  field: string;
  relatedCollection: string | null;
  meta: any;
  raw: any;
}

const RELATIONAL_TYPES = new Set([
  'alias',
  'o2m',
  'm2m',
  'm2a',
  'files',
  'translations',
]);

export function isBlockJunctionName(name: string): boolean {
  return /_blocks$/.test(name) || /_block_/.test(name) || /_blocks_/.test(name);
}

export function buildFieldsByCollection(snapshot: any, prefix: string): Map<string, string[]> {
  const filtered = filterSnapshot(snapshot, prefix);
  const map = new Map<string, string[]>();
  for (const f of (filtered.fields ?? [])) {
    if (!map.has(f.collection)) map.set(f.collection, []);
    map.get(f.collection)!.push(f.field as string);
  }
  return map;
}

export function getPageCollections(snapshot: any, prefix: string): PageCollectionResult {
  const filtered = filterSnapshot(snapshot, prefix);
  const fieldsByCollection = buildFieldsByCollection(snapshot, prefix);
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

export function getBlockInfoByPage(
  snapshot: any,
  prefix: string,
  pageCollectionNames: string[],
): Map<string, BlockInfo> {
  const filtered = filterSnapshot(snapshot, prefix);
  const blockInfoByPage = new Map<string, BlockInfo>();
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

export function findParentFkField(
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

export function getRelationEdges(snapshot: any, prefix: string, collection: string): RelationEdge[] {
  const filtered = filterSnapshot(snapshot, prefix);
  return (filtered.relations ?? [])
    .filter((rel: any) => rel.collection === collection)
    .map((rel: any) => ({
      collection,
      field: rel.field as string,
      relatedCollection: (rel.related_collection ?? rel.meta?.one_collection ?? null) as string | null,
      meta: rel.meta,
      raw: rel,
    }));
}

export function getWritableScalarFieldNames(
  snapshot: any,
  prefix: string,
  collection: string,
): string[] {
  const filtered = filterSnapshot(snapshot, prefix);
  const relationalFields = new Set(
    getRelationEdges(snapshot, prefix, collection).map((e) => e.field),
  );

  return (filtered.fields ?? [])
    .filter((f: any) => f.collection === collection)
    .filter((f: any) => SCALAR_TYPES.has(f.type as string))
    .filter((f: any) => !RELATIONAL_TYPES.has(f.type as string))
    .filter((f: any) => !relationalFields.has(f.field as string))
    .filter((f: any) => !EXCLUDED_FIELDS.has(f.field as string))
    .map((f: any) => f.field as string);
}

export function getAllCollectionNames(snapshot: any, prefix: string): Set<string> {
  const filtered = filterSnapshot(snapshot, prefix);
  return new Set((filtered.collections ?? []).map((c: any) => c.collection as string));
}

export function isCollectionJunctionLike(collection: string): boolean {
  return isBlockJunctionName(collection) || collection.includes('_junction');
}

export function buildBestMatchKey(item: Record<string, unknown>): { field: string; value: string } | null {
  const candidates = ['permalink', 'slug', 'title', 'name'];
  for (const field of candidates) {
    const raw = item[field];
    if (typeof raw === 'string' && raw.trim()) {
      return { field, value: raw.trim() };
    }
  }
  return null;
}

export function normalizeSystemFields(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (EXCLUDED_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}
