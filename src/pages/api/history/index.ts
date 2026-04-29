import type { APIRoute } from 'astro';
import { listSnapshots } from '../../../lib/schema-history';

export const GET: APIRoute = async () => {
  const snapshots = listSnapshots();
  return new Response(JSON.stringify(snapshots), {
    headers: { 'Content-Type': 'application/json' },
  });
};
