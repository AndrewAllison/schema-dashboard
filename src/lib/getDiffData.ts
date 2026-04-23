/**
 * Shared helper — fetches or returns cached diff data and pre-computes
 * the counts needed for the sidebar nav.
 */
export async function getDiffData(url: URL) {
  const res  = await fetch(new URL('/api/diff', url));
  const data = await res.json();

  const diff = data.diff ?? {
    collections: { creates: [], updates: [], deletes: [] },
    fields:      { creates: [], updates: [], deletes: [] },
    relations:   { creates: [], updates: [], deletes: [] },
  };
  const renames: any[] = data.renames ?? [];
  const matched: { collections: any[]; fields: any[]; relations: any[] } = data.matched ?? {
    collections: [],
    fields:      [],
    relations:   [],
  };
  const junctionConflicts: any[] = data.junctionConflicts ?? [];

  interface EnvTotals { collections: number; fields: number; relations: number; }
  const emptyEnv = (): EnvTotals => ({ collections: 0, fields: 0, relations: 0 });
  const totals: { dev: EnvTotals; prod: EnvTotals } = data.totals ?? { dev: emptyEnv(), prod: emptyEnv() };

  const allUpdates = [
    ...diff.collections.updates,
    ...diff.fields.updates,
    ...diff.relations.updates,
  ];

  const countTier = (tier: string) =>
    allUpdates.flatMap((u: any) => u.changes).filter((c: any) => c.tier === tier).length;

  const counts = {
    devOnly:           diff.collections.creates.length + diff.fields.creates.length  + diff.relations.creates.length,
    prodOnly:          diff.collections.deletes.length + diff.fields.deletes.length  + diff.relations.deletes.length,
    renames:           renames.length,
    schema:            countTier('schema'),
    relations:         countTier('relations'),
    choices:           countTier('choices'),
    options:           countTier('options'),
    matched:           matched.collections.length,
    junctionConflicts: junctionConflicts.filter((c: any) => !c.isAliased).length,
  };

  return { diff, renames, matched, junctionConflicts, totals, counts, fetchedAt: data.fetchedAt as number | undefined, error: data.error as string | undefined };
}
