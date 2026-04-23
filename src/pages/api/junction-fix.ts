/**
 * POST /api/junction-fix
 *
 * Removes a mis-named junction table from prod via the Directus API so it can be
 * re-applied with the correct (dev) name through the normal "Dev Only" apply flow.
 *
 * Steps performed:
 *  1. Fetch the prod schema snapshot to enumerate every relation touching the junction.
 *  2. DELETE each of those relations (parent M2M fields + junction's own FK relations).
 *  3. DELETE the junction collection itself (Directus cascades field cleanup).
 *  4. Remove any saved alias for this pair and bust the diff cache.
 */
import type { APIRoute } from 'astro';
import { PROD_TOKEN, PROD_URL } from '../../lib/env';
import { loadAliases, saveAliases } from '../../lib/junction-aliases';
import { bustCache } from '../../lib/cache';
import { fetchSnapshot } from '@diff';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { prod } = await request.json() as { prod?: string };

    if (!prod) {
      return json400('prod collection name is required');
    }

    const base    = PROD_URL();
    const token   = PROD_TOKEN();
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // ── 1. Discover all relations that involve the junction ──────────────────
    const prodSnapshot = await fetchSnapshot(base, token);
    const allRelations: any[] = prodSnapshot.relations ?? [];

    // Relations ON the junction (many_collection = junction)
    // AND relations POINTING TO the junction (related_collection = junction)
    const relationsToDelete = allRelations.filter(
      (r: any) => r.collection === prod || r.related_collection === prod,
    );

    // ── 2. Delete each relation ─────────────────────────────────────────────
    const warnings: string[] = [];
    for (const r of relationsToDelete) {
      const res = await fetch(
        `${base}/relations/${encodeURIComponent(r.collection)}/${encodeURIComponent(r.field)}`,
        { method: 'DELETE', headers },
      );
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => '');
        let msg: string;
        try { msg = JSON.parse(text)?.errors?.[0]?.message ?? text; }
        catch { msg = text; }
        warnings.push(`relation ${r.collection}.${r.field}: HTTP ${res.status} — ${msg.slice(0, 120)}`);
      }
    }

    // ── 3. Delete the junction collection ──────────────────────────────────
    const collRes = await fetch(
      `${base}/collections/${encodeURIComponent(prod)}`,
      { method: 'DELETE', headers },
    );
    if (!collRes.ok && collRes.status !== 404) {
      const text = await collRes.text().catch(() => '');
      let msg: string;
      try { msg = JSON.parse(text)?.errors?.[0]?.message ?? text; }
      catch { msg = text; }
      throw new Error(`Failed to delete collection "${prod}": HTTP ${collRes.status} — ${msg.slice(0, 300)}`);
    }

    // ── 4. Remove any alias that covered this pair ──────────────────────────
    const aliases = loadAliases();
    const filtered = aliases.filter((a) => a.prod !== prod);
    if (filtered.length !== aliases.length) saveAliases(filtered);

    // ── 5. Bust diff cache ──────────────────────────────────────────────────
    bustCache();

    return new Response(
      JSON.stringify({
        ok: true,
        deletedRelations: relationsToDelete.length,
        warnings: warnings.length ? warnings : undefined,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

function json400(error: string) {
  return new Response(
    JSON.stringify({ ok: false, error }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}
