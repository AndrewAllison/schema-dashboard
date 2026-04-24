import type { APIRoute } from 'astro';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PROD_TOKEN, PROD_URL, COLLECTION_PREFIX } from '../../lib/env';
import { fetchSnapshot, filterSnapshot } from '@diff';

const MGA_FRONTEND_ROOT = path.join(
  typeof process !== 'undefined' ? (process.env.HOME ?? '') : '',
  'workspace',
  'mga-frontend',
);

const REDESIGN_BLOCKS_DIR = path.join(
  MGA_FRONTEND_ROOT,
  'src', 'components', 'cms', 'blocks', '_redesign', 'blocks',
);

const REDESIGN_TYPES_FILE = path.join(
  MGA_FRONTEND_ROOT,
  'src', 'components', 'cms', 'blocks', '_redesign', 'types.ts',
);

/** Convert PascalCase component name → prefix_snake_case collection name */
function componentToCollection(name: string, prefix: string): string {
  const snake = name
    .replace(/([A-Z])/g, (m, p1, offset) => (offset > 0 ? '_' : '') + p1.toLowerCase())
    .replace(/^_/, '');
  return `${prefix}_${snake}`;
}

/** Extract string literal values from a TypeScript union type alias */
function extractUnionValues(src: string, typeName: string): string[] {
  // Match:  export type BackgroundColor = \n  | 'foo'\n  | 'bar';
  const re = new RegExp(`(?:export\\s+)?type\\s+${typeName}\\s*=([\\s\\S]*?);`, 'm');
  const match = src.match(re);
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

export const GET: APIRoute = async ({ url }) => {
  const forceRefresh = url.searchParams.get('refresh') === 'true';
  void forceRefresh; // cache busting handled by caller re-fetching

  try {
    const token  = PROD_TOKEN();
    const base   = PROD_URL();
    const prefix = COLLECTION_PREFIX();

    // --- 1. List redesign block component directories ---
    let componentDirs: string[] = [];
    let blocksError: string | null = null;
    try {
      const entries = await readdir(REDESIGN_BLOCKS_DIR, { withFileTypes: true });
      componentDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch (err) {
      blocksError = `Cannot read ${REDESIGN_BLOCKS_DIR}: ${String(err)}`;
    }

    // --- 2. Read frontend type definitions ---
    let frontendBgColors: string[] = [];
    let typesError: string | null = null;
    try {
      const src = await readFile(REDESIGN_TYPES_FILE, 'utf-8');
      frontendBgColors = extractUnionValues(src, 'BackgroundColor');
    } catch (err) {
      typesError = `Cannot read ${REDESIGN_TYPES_FILE}: ${String(err)}`;
    }

    // --- 3. Fetch Directus schema ---
    const snapshot = await fetchSnapshot(base, token);
    const filtered = filterSnapshot(snapshot, prefix);

    const directusCollectionNames = new Set<string>(
      (filtered.collections ?? []).map((c: any) => c.collection as string),
    );

    // Build choice index: collection → field → values[]
    const choicesByCollection = new Map<string, Record<string, string[]>>();
    for (const f of (filtered.fields ?? [])) {
      const choices: Array<{ value: unknown }> = f.meta?.options?.choices ?? [];
      if (choices.length === 0) continue;
      if (!choicesByCollection.has(f.collection)) choicesByCollection.set(f.collection, {});
      choicesByCollection.get(f.collection)![f.field as string] = choices.map((c) => String(c.value));
    }

    // --- 4. Build component comparison data ---
    const components = componentDirs.map((name) => {
      const collectionName  = componentToCollection(name, prefix);
      const existsInDirectus = directusCollectionNames.has(collectionName);
      const directusChoices  = choicesByCollection.get(collectionName) ?? {};

      // Determine bg-color field name (could be background_color or background_colour)
      const bgField = 'background_color' in directusChoices
        ? 'background_color'
        : 'background_colour' in directusChoices
          ? 'background_colour'
          : null;

      const directusBgColors: string[] = bgField ? directusChoices[bgField] : [];
      const hasBgColorField = directusBgColors.length > 0;

      // Discrepancy analysis (only meaningful when both have data)
      const missingFromDirectus = (hasBgColorField && frontendBgColors.length > 0)
        ? frontendBgColors.filter((c) => !directusBgColors.includes(c))
        : [];
      const extraInDirectus = (hasBgColorField && frontendBgColors.length > 0)
        ? directusBgColors.filter((c) => !frontendBgColors.includes(c))
        : [];

      // Other choice fields (excluding bg color)
      const otherChoiceFields = Object.entries(directusChoices)
        .filter(([field]) => field !== bgField)
        .map(([field, choices]) => ({ field, choices }));

      return {
        name,
        collectionName,
        existsInDirectus,
        hasBgColorField,
        bgField,
        directusBgColors,
        missingFromDirectus,
        extraInDirectus,
        otherChoiceFields,
      };
    });

    // Sort: issues first, missing from directus next, then alphabetical
    components.sort((a, b) => {
      const aIssue = !a.existsInDirectus || a.missingFromDirectus.length > 0;
      const bIssue = !b.existsInDirectus || b.missingFromDirectus.length > 0;
      if (aIssue !== bIssue) return aIssue ? -1 : 1;
      const aMissing = !a.existsInDirectus;
      const bMissing = !b.existsInDirectus;
      if (aMissing !== bMissing) return aMissing ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Orphaned Directus block collections (exist in Directus, no frontend component)
    const componentCollections = new Set(components.map((c) => c.collectionName));
    const orphanedCollections = [...directusCollectionNames]
      .filter((name) => {
        // Only care about block-type collections (not page collections)
        const stripped = name.replace(new RegExp(`^${prefix}_`), '');
        return (
          stripped.startsWith('block_') ||
          stripped.includes('_banner') ||
          stripped.includes('_hero') ||
          stripped.includes('_card') ||
          stripped.includes('_carousel') ||
          stripped.includes('carousel_') ||
          stripped.includes('_grid') ||
          stripped.includes('_stats') ||
          stripped.includes('_text') ||
          stripped.includes('_media') ||
          stripped.includes('_image') ||
          stripped.includes('_video') ||
          stripped.includes('_quote') ||
          stripped.includes('accordion') ||
          stripped.includes('_split')
        ) && !componentCollections.has(name);
      })
      .sort();

    return new Response(
      JSON.stringify({
        mgaFrontendRoot:    MGA_FRONTEND_ROOT,
        blocksDir:          REDESIGN_BLOCKS_DIR,
        blocksError,
        typesError,
        componentCount:     components.length,
        frontendBgColors,
        components,
        orphanedCollections,
        fetchedAt: Date.now(),
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
