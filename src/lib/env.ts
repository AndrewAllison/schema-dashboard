// Astro/Vite loads .env.local into import.meta.env, not process.env
function get(name: string): string | undefined {
  return (import.meta.env as Record<string, string | undefined>)[name];
}

function required(name: string): string {
  const val = get(name);
  if (!val) throw new Error(
    `Missing required env var: ${name}\n` +
    `Copy schema-dashboard/.env.local.example to schema-dashboard/.env.local and fill in the values.`
  );
  return val;
}

export const DEV_TOKEN  = () => required('DIRECTUS_DEV_TOKEN');
export const PROD_TOKEN = () => required('DIRECTUS_PROD_TOKEN');
export const DEV_URL    = () => get('DIRECTUS_DEV_URL')  ?? 'https://directus-ct-shared.gpillar-dev.global.com';
export const PROD_URL   = () => get('DIRECTUS_PROD_URL') ?? 'https://directus-ct-shared.gpillar-prod.global.com';
export const COLLECTION_PREFIX = () => get('DIRECTUS_COLLECTION_PREFIX') ?? 'adpower_redesign';
