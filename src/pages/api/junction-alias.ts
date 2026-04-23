import type { APIRoute } from 'astro';
import { addAlias, removeAlias } from '../../lib/junction-aliases';
import { bustCache } from '../../lib/cache';

/** POST /api/junction-alias  body: { dev, prod, note? }  → adds alias and busts diff cache */
export const POST: APIRoute = async ({ request }) => {
  try {
    const { dev, prod, note } = await request.json();
    if (!dev || !prod) {
      return new Response(JSON.stringify({ ok: false, error: 'dev and prod are required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    const aliases = addAlias(dev, prod, note);
    bustCache();
    return new Response(JSON.stringify({ ok: true, aliases }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

/** DELETE /api/junction-alias  body: { dev, prod }  → removes alias and busts diff cache */
export const DELETE: APIRoute = async ({ request }) => {
  try {
    const { dev, prod } = await request.json();
    if (!dev || !prod) {
      return new Response(JSON.stringify({ ok: false, error: 'dev and prod are required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    const aliases = removeAlias(dev, prod);
    bustCache();
    return new Response(JSON.stringify({ ok: true, aliases }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};
