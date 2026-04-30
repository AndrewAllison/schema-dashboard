import { filterSnapshot } from './directus-schema-diff.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ScalarFieldMeta {
  field: string;
  type: string;
  inDev: boolean;
  inProd: boolean;
}

export interface ContentFieldValueDiff {
  field: string;
  fieldType: string;
  dev: unknown;
  prod: unknown;
}

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Directus field types with actual database columns (scalar values).
 * Excludes relational types: alias, o2m, m2m, m2a, files, translations.
 */
export const SCALAR_TYPES = new Set([
  'string',
  'text',
  'integer',
  'bigInteger',
  'float',
  'decimal',
  'boolean',
  'date',
  'dateTime',
  'time',
  'timestamp',
  'uuid',
  'json',
  'csv',
  'hash',
]);

/**
 * System-managed audit fields — never show or sync these.
 */
export const EXCLUDED_FIELDS = new Set([
  'id',
  'date_created',
  'date_updated',
  'user_created',
  'user_updated',
]);

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns scalar field names for a collection, excluding relational FK fields
 * (which may have scalar types like `integer` but are foreign keys).
 */
export function getScalarFieldNames(
  snapshot: any,
  prefix: string,
  collectionName: string,
): string[] {
  const filtered = filterSnapshot(snapshot, prefix);

  // Build set of relational field names for this collection
  const relationalFields = new Set<string>();
  for (const rel of (filtered.relations ?? [])) {
    if (rel.collection === collectionName) {
      relationalFields.add(rel.field as string);
    }
  }

  return (filtered.fields ?? [])
    .filter((f: any) => f.collection === collectionName)
    .filter((f: any) => SCALAR_TYPES.has(f.type as string))
    .filter((f: any) => !relationalFields.has(f.field as string))
    .filter((f: any) => !EXCLUDED_FIELDS.has(f.field as string))
    .map((f: any) => f.field as string);
}

/**
 * Merges scalar fields from both environments, marking inDev/inProd flags.
 * Returns fields sorted alphabetically.
 */
export function mergeScalarFieldMeta(
  devSnapshot: any,
  prodSnapshot: any,
  prefix: string,
  collectionName: string,
): ScalarFieldMeta[] {
  const devFieldNames  = devSnapshot  ? getScalarFieldNames(devSnapshot,  prefix, collectionName) : [];
  const prodFieldNames = prodSnapshot ? getScalarFieldNames(prodSnapshot, prefix, collectionName) : [];

  // Get type info from snapshots
  function getTypeMap(snapshot: any): Map<string, string> {
    if (!snapshot) return new Map();
    const filtered = filterSnapshot(snapshot, prefix);
    const map = new Map<string, string>();
    for (const f of (filtered.fields ?? [])) {
      if (f.collection === collectionName) {
        map.set(f.field as string, f.type as string);
      }
    }
    return map;
  }

  const devTypeMap  = getTypeMap(devSnapshot);
  const prodTypeMap = getTypeMap(prodSnapshot);

  const merged = new Map<string, ScalarFieldMeta>();

  for (const field of devFieldNames) {
    merged.set(field, {
      field,
      type: devTypeMap.get(field) ?? 'string',
      inDev: true,
      inProd: false,
    });
  }

  for (const field of prodFieldNames) {
    const existing = merged.get(field);
    if (existing) {
      existing.inProd = true;
    } else {
      merged.set(field, {
        field,
        type: prodTypeMap.get(field) ?? 'string',
        inDev: false,
        inProd: true,
      });
    }
  }

  return [...merged.values()].sort((a, b) => a.field.localeCompare(b.field));
}

/**
 * Compares scalar field values between dev and prod.
 * Uses JSON.stringify for deep comparison of json-type fields.
 */
export function computeFieldValueDiffs(
  scalarFields: ScalarFieldMeta[],
  devValues: Record<string, unknown>,
  prodValues: Record<string, unknown>,
): ContentFieldValueDiff[] {
  const diffs: ContentFieldValueDiff[] = [];

  for (const { field, type } of scalarFields) {
    const devVal  = devValues[field]  ?? null;
    const prodVal = prodValues[field] ?? null;

    const devStr  = JSON.stringify(devVal);
    const prodStr = JSON.stringify(prodVal);

    if (devStr !== prodStr) {
      diffs.push({ field, fieldType: type, dev: devVal, prod: prodVal });
    }
  }

  return diffs;
}

/**
 * Returns field names that differ between dev and prod (names only, no values).
 */
export function computeFieldNameDiffs(
  scalarFields: ScalarFieldMeta[],
  devValues: Record<string, unknown>,
  prodValues: Record<string, unknown>,
): { field: string; fieldType: string }[] {
  return computeFieldValueDiffs(scalarFields, devValues, prodValues)
    .map(({ field, fieldType }) => ({ field, fieldType }));
}

/**
 * Truncates a string value for display in the UI.
 */
export function truncateValue(value: unknown, maxLength = 120): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return String(value);
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '…';
}
