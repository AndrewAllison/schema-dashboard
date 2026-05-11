import { fetchSnapshot } from '@diff';
import { DEV_TOKEN, DEV_URL, PROD_TOKEN, PROD_URL, COLLECTION_PREFIX } from './env';
import { getAllCollectionNames } from './content-sync-graph';
import { filterSnapshot } from './directus-schema-diff.js';

const TEXT_TYPES = new Set(['string', 'text', 'json']);

export interface ContentIndexEntry {
  env: 'dev' | 'prod';
  collection: string;
  label: string;
  id: string | number;
  title: string;
  permalink: string | null;
  searchCorpus: string;
  fieldValues: Record<string, string>;
}

export interface ContentIndex {
  entries: ContentIndexEntry[];
  collectionCount: number;
  fetchedAt: number;
  devSnapshotError?: string;
  prodSnapshotError?: string;
  fetchErrors: string[];
}

const TTL_MS = 5 * 60 * 1000;
let _cache: { index: ContentIndex; builtAt: number } | null = null;

export function bustContentIndex(): void {
  _cache = null;
}

function getCollectionFields(snapshot: any, prefix: string, collection: string): {
  textFields: { field: string; type: string }[];
  allFieldNames: Set<string>;
} {
  const filtered = filterSnapshot(snapshot, prefix);
  const relFields = new Set<string>(
    (filtered.relations ?? [])
      .filter((r: any) => r.collection === collection)
      .map((r: any) => r.field as string),
  );
  const allFieldNames = new Set<string>(
    (filtered.fields ?? [])
      .filter((f: any) => f.collection === collection)
      .map((f: any) => f.field as string),
  );
  const textFields: { field: string; type: string }[] = (filtered.fields ?? [])
    .filter((f: any) => f.collection === collection)
    .filter((f: any) => TEXT_TYPES.has(f.type as string))
    .filter((f: any) => !relFields.has(f.field as string))
    .map((f: any) => ({ field: f.field as string, type: f.type as string }));
  return { textFields, allFieldNames };
}

/**
 * Recursively extract plain text from TipTap/ProseMirror JSON doc nodes.
 * Handles both the Directus rich-text editor (TipTap) format and generic
 * JSON structures that contain string values worth indexing.
 */
function extractTextFromJson(value: unknown, depth = 0): string {
  if (depth > 8) return '';
  if (typeof value === 'string') {
    const t = value.trim();
    // Skip UUIDs, bare URLs, and very short tokens — they're noise
    if (t.length < 3) return '';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return '';
    if (/^https?:\/\//.test(t)) return '';
    return t;
  }
  if (Array.isArray(value)) {
    return value.map((v) => extractTextFromJson(v, depth + 1)).filter(Boolean).join(' ');
  }
  if (value !== null && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    // TipTap leaf node: { type: "text", text: "..." }
    if (typeof node.text === 'string') return extractTextFromJson(node.text, depth + 1);
    // TipTap branch node: { type: "...", content: [...] }
    if (Array.isArray(node.content)) return extractTextFromJson(node.content, depth + 1);
    // Generic fallback: walk all values
    return Object.values(node).map((v) => extractTextFromJson(v, depth + 1)).filter(Boolean).join(' ');
  }
  return '';
}

function formatLabel(collection: string, prefix: string): string {
  return collection
    .replace(new RegExp(`^${prefix}_`), '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

interface EnvFetchResult {
  entries: ContentIndexEntry[];
  errors: string[];
}

async function fetchEnvEntries(
  base: string,
  token: string,
  env: 'dev' | 'prod',
  snapshot: any,
  prefix: string,
): Promise<EnvFetchResult> {
  const collections = getAllCollectionNames(snapshot, prefix);
  const allEntries: ContentIndexEntry[] = [];
  const errors: string[] = [];

  const perCollection = await Promise.all(
    [...collections].map(async (collection) => {
      const { textFields, allFieldNames } = getCollectionFields(snapshot, prefix, collection);
      if (textFields.length === 0) return { entries: [], error: null };

      // Only request core fields that actually exist on this collection — Directus 403s if you ask for missing fields
      const CORE = ['id', 'title', 'name', 'permalink', 'slug'];
      const safeCore = CORE.filter((f) => allFieldNames.has(f));
      const fieldNames = textFields.map((f) => f.field);
      const allFields = [...new Set(['id', ...safeCore, ...fieldNames])].join(',');

      try {
        const res = await fetch(
          `${base}/items/${collection}?fields=${allFields}&limit=-1`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return { entries: [], error: `${env}/${collection} HTTP ${res.status}: ${body.slice(0, 120)}` };
        }
        const json = await res.json();
        const raw: any[] = json.data ?? [];
        const label = formatLabel(collection, prefix);
        const entries: ContentIndexEntry[] = [];

        for (const item of raw) {
          const fieldValues: Record<string, string> = {};
          const parts: string[] = [];

          for (const { field, type } of textFields) {
            const val = item[field];
            if (val == null) continue;

            if (type === 'json') {
              // TipTap / block-editor JSON — walk the tree and extract plain text
              let parsed = val;
              if (typeof val === 'string') {
                try { parsed = JSON.parse(val); } catch { continue; }
              }
              const extracted = extractTextFromJson(parsed).trim();
              if (extracted) {
                fieldValues[field] = extracted;
                parts.push(extracted);
              }
            } else if (typeof val === 'string' && val.trim()) {
              fieldValues[field] = val;
              parts.push(val);
            }
          }

          if (parts.length === 0) continue;

          const title =
            typeof item.title     === 'string' ? item.title     :
            typeof item.name      === 'string' ? item.name      :
            typeof item.permalink === 'string' ? item.permalink :
            typeof item.slug      === 'string' ? item.slug      :
            `#${item.id}`;

          entries.push({
            env,
            collection,
            label,
            id: item.id,
            title,
            permalink: item.permalink ?? item.slug ?? null,
            searchCorpus: parts.join(' ').toLowerCase(),
            fieldValues,
          });
        }

        return { entries, error: null };
      } catch (err) {
        return { entries: [], error: `${env}/${collection} threw: ${String(err)}` };
      }
    }),
  );

  for (const r of perCollection) {
    allEntries.push(...r.entries);
    if (r.error) errors.push(r.error);
  }

  return { entries: allEntries, errors };
}

export async function buildContentIndex(): Promise<ContentIndex> {
  if (_cache && Date.now() - _cache.builtAt < TTL_MS) return _cache.index;

  const prefix    = COLLECTION_PREFIX();
  const devBase   = DEV_URL();
  const prodBase  = PROD_URL();
  const devToken  = DEV_TOKEN();
  const prodToken = PROD_TOKEN();

  const [devResult, prodResult] = await Promise.allSettled([
    fetchSnapshot(devBase, devToken),
    fetchSnapshot(prodBase, prodToken),
  ]);

  const devSnapshot  = devResult.status  === 'fulfilled' ? devResult.value  : null;
  const prodSnapshot = prodResult.status === 'fulfilled' ? prodResult.value : null;

  const [devFetch, prodFetch] = await Promise.all([
    devSnapshot  ? fetchEnvEntries(devBase,  devToken,  'dev',  devSnapshot,  prefix) : Promise.resolve({ entries: [], errors: [] }),
    prodSnapshot ? fetchEnvEntries(prodBase, prodToken, 'prod', prodSnapshot, prefix) : Promise.resolve({ entries: [], errors: [] }),
  ]);

  const entries = [...devFetch.entries, ...prodFetch.entries];
  const fetchErrors = [...devFetch.errors, ...prodFetch.errors].slice(0, 20);
  const collectionCount = new Set(entries.map((e) => e.collection)).size;

  const index: ContentIndex = {
    entries,
    collectionCount,
    fetchedAt: Date.now(),
    fetchErrors,
    devSnapshotError:  devResult.status  === 'rejected' ? String(devResult.reason)  : undefined,
    prodSnapshotError: prodResult.status === 'rejected' ? String(prodResult.reason) : undefined,
  };

  _cache = { index, builtAt: Date.now() };
  return index;
}
