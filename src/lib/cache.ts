import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_FILE = join(process.cwd(), '.diff-cache.json');
const TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  diff: unknown;
  renames: unknown[];
  fetchedAt: number;
}

// In-process singleton (survives HMR for the process lifetime)
let memCache: CacheEntry | null = null;

export function getCached(): CacheEntry | null {
  if (memCache && !isStale(memCache)) return memCache;
  // Try file cache
  try {
    if (existsSync(CACHE_FILE)) {
      const raw = readFileSync(CACHE_FILE, 'utf-8');
      const entry: CacheEntry = JSON.parse(raw);
      if (!isStale(entry)) {
        memCache = entry;
        return entry;
      }
    }
  } catch { /* ignore */ }
  return null;
}

export function setCache(entry: CacheEntry): void {
  memCache = entry;
  try { writeFileSync(CACHE_FILE, JSON.stringify(entry), 'utf-8'); } catch { /* ignore */ }
}

export function bustCache(): void {
  memCache = null;
  try { if (existsSync(CACHE_FILE)) writeFileSync(CACHE_FILE, '', 'utf-8'); } catch { /* ignore */ }
}

function isStale(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt > TTL_MS;
}
