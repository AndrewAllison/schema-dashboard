import type { APIRoute } from 'astro';
import { bustCache } from '../../lib/cache';
import { applyChange } from '../../lib/directus-client';

export const POST: APIRoute = async ({ request }) => {
  try {
    const payload = await request.json();
    await applyChange(payload);
    bustCache();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
