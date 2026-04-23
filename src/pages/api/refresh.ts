import type { APIRoute } from 'astro';
import { bustCache } from '../../lib/cache';

export const POST: APIRoute = async ({ url }) => {
  bustCache();
  const diffUrl = new URL('/api/diff?forceRefresh=true', url);
  const res  = await fetch(diffUrl);
  const data = await res.json();
  return new Response(JSON.stringify(data), {
    status: res.ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  });
};
