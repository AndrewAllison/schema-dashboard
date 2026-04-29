import type { APIRoute } from 'astro';
import { saveSnapshot } from '../../../lib/schema-history';

export const POST: APIRoute = async ({ request }) => {
  try {
    let label: string | undefined;
    try {
      const body = await request.json();
      if (typeof body?.label === 'string' && body.label.trim()) {
        label = body.label.trim();
      }
    } catch { /* no body or non-JSON — label stays undefined */ }

    const snapshot = await saveSnapshot(label);
    return new Response(JSON.stringify({ ok: true, snapshot }), {
      status: 201,
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
