/**
 * Persistent store for schema history snapshots.
 * Snapshots are saved to .schema-history/ at the project root and should be
 * committed to source control so the audit trail is shared across the team.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchSnapshot, filterSnapshot } from '@diff';
import { DEV_URL, DEV_TOKEN, PROD_URL, PROD_TOKEN, COLLECTION_PREFIX } from './env';

const HISTORY_DIR = join(process.cwd(), '.schema-history');
const INDEX_FILE  = join(HISTORY_DIR, 'index.json');

export interface SnapshotCounts {
  devCollections: number;
  devFields: number;
  devRelations: number;
  prodCollections: number;
  prodFields: number;
  prodRelations: number;
}

export interface SnapshotMeta {
  id: string;
  timestamp: string;
  label?: string;
  counts: SnapshotCounts;
}

export interface FilteredSnapshot {
  collections: unknown[];
  fields: unknown[];
  relations: unknown[];
}

export interface SnapshotData extends SnapshotMeta {
  dev: FilteredSnapshot;
  prod: FilteredSnapshot;
}

function ensureHistoryDir(): void {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
}

function readIndex(): SnapshotMeta[] {
  try {
    if (existsSync(INDEX_FILE)) {
      return JSON.parse(readFileSync(INDEX_FILE, 'utf-8')) as SnapshotMeta[];
    }
  } catch { /* ignore parse errors */ }
  return [];
}

function writeIndex(entries: SnapshotMeta[]): void {
  ensureHistoryDir();
  writeFileSync(INDEX_FILE, JSON.stringify(entries, null, 2), 'utf-8');
}

/** Returns all snapshot metadata sorted newest-first. */
export function listSnapshots(): SnapshotMeta[] {
  return readIndex().slice().sort((a, b) => b.id.localeCompare(a.id));
}

/** Fetches current dev + prod schemas and saves a new snapshot. Returns the snapshot metadata. */
export async function saveSnapshot(label?: string): Promise<SnapshotMeta> {
  ensureHistoryDir();

  const prefix = COLLECTION_PREFIX();
  const [rawDev, rawProd] = await Promise.all([
    fetchSnapshot(DEV_URL(),  DEV_TOKEN()),
    fetchSnapshot(PROD_URL(), PROD_TOKEN()),
  ]);

  const dev  = filterSnapshot(rawDev,  prefix) as FilteredSnapshot;
  const prod = filterSnapshot(rawProd, prefix) as FilteredSnapshot;

  const id        = String(Date.now());
  const timestamp = new Date().toISOString();
  const counts: SnapshotCounts = {
    devCollections:  dev.collections.length,
    devFields:       dev.fields.length,
    devRelations:    dev.relations.length,
    prodCollections: prod.collections.length,
    prodFields:      prod.fields.length,
    prodRelations:   prod.relations.length,
  };

  const meta: SnapshotMeta = { id, timestamp, counts, ...(label ? { label } : {}) };
  const data: SnapshotData = { ...meta, dev, prod };

  const snapshotFile = join(HISTORY_DIR, `${id}.json`);
  writeFileSync(snapshotFile, JSON.stringify(data, null, 2), 'utf-8');

  const index = readIndex();
  index.push(meta);
  writeIndex(index);

  return meta;
}

/** Loads a full snapshot (including dev/prod data) by ID. Returns null if not found. */
export function getSnapshot(id: string): SnapshotData | null {
  const snapshotFile = join(HISTORY_DIR, `${id}.json`);
  try {
    if (existsSync(snapshotFile)) {
      return JSON.parse(readFileSync(snapshotFile, 'utf-8')) as SnapshotData;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Returns the snapshot taken immediately before the given ID, or null if this
 * is the first snapshot.
 */
export function getPreviousSnapshot(id: string): SnapshotData | null {
  const index = readIndex().slice().sort((a, b) => a.id.localeCompare(b.id));
  const pos   = index.findIndex(e => e.id === id);
  if (pos <= 0) return null;
  return getSnapshot(index[pos - 1].id);
}
