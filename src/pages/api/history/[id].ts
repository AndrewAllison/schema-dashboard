import type { APIRoute } from 'astro';
import { getSnapshot, getPreviousSnapshot } from '../../../lib/schema-history';
import { COLLECTION_PREFIX } from '../../../lib/env';
import { diffSnapshots } from '@diff';

export const GET: APIRoute = async ({ params }) => {
  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ error: 'Missing id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const snapshot = getSnapshot(id);
  if (!snapshot) {
    return new Response(JSON.stringify({ error: 'Snapshot not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const prev   = getPreviousSnapshot(id);
  const prefix = COLLECTION_PREFIX();

  // Dev vs Prod at the time of this snapshot
  const devVsProd = diffSnapshots(snapshot.dev, snapshot.prod, prefix, false);

  let devDelta  = null;
  let prodDelta = null;

  if (prev) {
    // What changed in dev since the previous snapshot.
    // Convention: creates = in lhs not rhs, deletes = in rhs not lhs.
    // lhs = current snapshot, rhs = previous → creates = added, deletes = removed.
    devDelta  = diffSnapshots(snapshot.dev,  prev.dev,  prefix, false);
    // What changed in prod since the previous snapshot
    prodDelta = diffSnapshots(snapshot.prod, prev.prod, prefix, false);
  }

  return new Response(
    JSON.stringify({
      snapshot,
      prevTimestamp: prev?.timestamp ?? null,
      devVsProd,
      devDelta,
      prodDelta,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
