import type { APIRoute } from 'astro';
import { getCached, setCache } from '../../lib/cache';
import { DEV_TOKEN, PROD_TOKEN, DEV_URL, PROD_URL, COLLECTION_PREFIX } from '../../lib/env';
import { loadAliases } from '../../lib/junction-aliases';

import {
  fetchSnapshot, diffSnapshots, findPossibleRenames, listMatched,
  findJunctionConflicts, applyJunctionAliases, filterSnapshot,
} from '@diff';

export const GET: APIRoute = async ({ url }) => {
  const forceRefresh = url.searchParams.get('forceRefresh') === 'true';

  // Aliases are not cached — read them fresh each time so adding/removing an alias
  // always reflects immediately even if the diff data is still cached.
  const aliases = loadAliases();

  if (!forceRefresh) {
    const cached = getCached();
    if (cached) {
      const rawDiff = (cached as any).rawDiff;
      if (rawDiff) {
        // Re-apply alias suppression on the raw diff (so adding/removing an alias
        // takes effect immediately without a full refetch).
        const diff = applyJunctionAliases(rawDiff, aliases);
        // Re-annotate isAliased on cached conflicts (keeps field/relation detail intact).
        const cachedConflicts: any[] = (cached as any).junctionConflicts ?? [];
        const junctionConflicts = cachedConflicts.map(c => ({
          ...c,
          isAliased: aliases.some(a => a.dev === c.dev && a.prod === c.prod),
        }));
        return new Response(
          JSON.stringify({ ...(cached as any), diff, junctionConflicts, isStale: false }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ...cached, isStale: false }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  try {
    const devSnapshot  = await fetchSnapshot(DEV_URL(),  DEV_TOKEN());
    const prodSnapshot = await fetchSnapshot(PROD_URL(), PROD_TOKEN());

    // Raw diff (before alias filtering) — stored in cache so alias changes are cheap
    const rawDiff  = diffSnapshots(devSnapshot, prodSnapshot, COLLECTION_PREFIX(), false);
    const renames  = findPossibleRenames(rawDiff.collections.creates, rawDiff.collections.deletes);
    const matched  = listMatched(devSnapshot, prodSnapshot, COLLECTION_PREFIX(), false);

    // Junction conflict detection (needs raw diff, before alias filtering)
    const rawConflicts      = findJunctionConflicts(rawDiff.collections.creates, rawDiff.collections.deletes);
    const junctionConflicts = annotateJunctionConflicts(rawConflicts, aliases);

    // Enrich conflicts with field/relation details from the snapshots
    const prefix = COLLECTION_PREFIX();
    const devF   = filterSnapshot(devSnapshot,  prefix);
    const prodF  = filterSnapshot(prodSnapshot, prefix);
    for (const c of junctionConflicts) {
      c.devFields    = devF.fields.filter((f: any)     => f.collection === c.dev);
      c.prodFields   = prodF.fields.filter((f: any)    => f.collection === c.prod);
      c.devRelations = devF.relations.filter((r: any)  => r.collection === c.dev);
      c.prodRelations= prodF.relations.filter((r: any) => r.collection === c.prod);
    }

    // Apply aliases — removes aliased pairs from creates/deletes
    const diff = applyJunctionAliases(rawDiff, aliases);

    // Absolute totals per environment (prefix-filtered)
    const totals = {
      dev:  { collections: devF.collections.length, fields: devF.fields.length,  relations: devF.relations.length  },
      prod: { collections: prodF.collections.length, fields: prodF.fields.length, relations: prodF.relations.length },
    };

    const entry = { rawDiff, diff, renames, matched, junctionConflicts, totals, fetchedAt: Date.now() };
    setCache(entry);
    return new Response(JSON.stringify({ ...entry, isStale: false }), {
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

function annotateJunctionConflicts(conflicts: any[], aliases: { dev: string; prod: string }[]) {
  return conflicts.map(c => ({
    ...c,
    isAliased: aliases.some(a => a.dev === c.dev && a.prod === c.prod),
  }));
}
