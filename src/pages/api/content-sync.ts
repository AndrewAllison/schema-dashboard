import type { APIRoute } from 'astro';
import { DEV_TOKEN, DEV_URL, PROD_TOKEN, PROD_URL } from '../../lib/env';
import { bustContentDiffCache } from './content-diff';
import { bustContentItemCache, bustAllContentItemCache } from './content-item';

// ── Interfaces ────────────────────────────────────────────────────────────────

type SyncDirection = 'dev->prod' | 'prod->dev';

interface FieldValue {
  field: string;
  value: unknown;
}

interface ContentSyncPayload {
  direction: SyncDirection;
  collection: string;
  /** Item ID in the SOURCE environment. */
  sourceId: number | string;
  /** Item ID in the TARGET environment. null = item does not exist, create it. */
  targetId: number | string | null;
  /** The field values to write (scalar fields selected by the user). */
  fields: FieldValue[];
  /** The match key for cache busting (e.g. "slug:home-page"). */
  matchKey?: string;
}

interface ContentSyncResponse {
  ok: boolean;
  targetId?: number | string;
  error?: string;
}

// ── API Route ─────────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  let payload: ContentSyncPayload;

  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { direction, collection, sourceId, targetId, fields, matchKey } = payload;

  if (!direction || !collection || sourceId == null || !fields?.length) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing required fields: direction, collection, sourceId, fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let targetBase: string;
  let targetToken: string;

  try {
    if (direction === 'dev->prod') {
      targetBase  = PROD_URL();
      targetToken = PROD_TOKEN();
    } else {
      targetBase  = DEV_URL();
      targetToken = DEV_TOKEN();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Build the field body — only include user-selected fields, never system fields
  const body: Record<string, unknown> = {};
  for (const { field, value } of fields) {
    body[field] = value;
  }

  let resultId: number | string;

  try {
    if (targetId === null) {
      // Create new item in target environment
      const res = await fetch(`${targetBase}/items/${collection}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${targetToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return new Response(JSON.stringify({ ok: false, error: `Create failed: HTTP ${res.status}: ${errText.slice(0, 300)}` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const json = await res.json();
      resultId = json.data?.id;
    } else {
      // Update existing item in target environment
      const res = await fetch(`${targetBase}/items/${collection}/${targetId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${targetToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return new Response(JSON.stringify({ ok: false, error: `Update failed: HTTP ${res.status}: ${errText.slice(0, 300)}` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      resultId = targetId;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Bust caches so the next page load reflects the change
  bustContentDiffCache();
  if (matchKey) {
    bustContentItemCache(collection, matchKey);
  } else {
    bustAllContentItemCache();
  }

  const response: ContentSyncResponse = { ok: true, targetId: resultId };
  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' },
  });
};
