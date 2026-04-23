import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  vite: {
    resolve: {
      alias: {
        '@diff': fileURLToPath(new URL('./src/lib/directus-schema-diff.js', import.meta.url)),
      },
    },
  },
});
