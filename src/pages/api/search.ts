import type { APIRoute } from 'astro';
import { buildContentIndex, bustContentIndex } from '../../lib/content-index';
import {
  searchTermsFromQuery,
  rowMatchesSearch,
  highlightFragmentForTerms,
  extractMatchSnippet,
} from '../../lib/section-search';

export interface SearchHit {
  env: 'dev' | 'prod';
  collection: string;
  label: string;
  id: string | number;
  title: string;
  permalink: string | null;
  matchedFields: { field: string; highlighted: string }[];
}

export interface SearchResponse {
  query: string;
  env: string;
  hits: SearchHit[];
  totalIndexed: number;
  collectionCount: number;
  fetchedAt: number;
  buildMs: number;
  fetchErrors: string[];
  devSnapshotError?: string;
  prodSnapshotError?: string;
}

export const GET: APIRoute = async ({ url }) => {
  const q         = (url.searchParams.get('q') ?? '').trim();
  const envFilter = url.searchParams.get('env') ?? 'both';
  const rebuild   = url.searchParams.get('rebuild') === 'true';

  if (rebuild) bustContentIndex();

  const t0 = Date.now();
  let index;
  try {
    index = await buildContentIndex();
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const buildMs = Date.now() - t0;

  const terms = searchTermsFromQuery(q);

  const hits: SearchHit[] = [];

  for (const entry of index.entries) {
    if (envFilter !== 'both' && entry.env !== envFilter) continue;
    if (terms.length > 0 && !rowMatchesSearch(entry.searchCorpus, terms)) continue;

    const matchedFields = Object.entries(entry.fieldValues)
      .filter(([, val]) => terms.length === 0 || rowMatchesSearch(val.toLowerCase(), terms))
      .map(([field, val]) => {
        const snippet = extractMatchSnippet(val, terms);
        return {
          field,
          highlighted: highlightFragmentForTerms(snippet, terms),
        };
      });

    if (terms.length > 0 && matchedFields.length === 0) continue;

    hits.push({
      env:           entry.env,
      collection:    entry.collection,
      label:         entry.label,
      id:            entry.id,
      title:         entry.title,
      permalink:     entry.permalink,
      matchedFields: terms.length > 0 ? matchedFields : [],
    });
  }

  const response: SearchResponse = {
    query:           q,
    env:             envFilter,
    hits,
    totalIndexed:    index.entries.length,
    collectionCount: index.collectionCount,
    fetchedAt:       index.fetchedAt,
    buildMs,
    fetchErrors:       index.fetchErrors,
    devSnapshotError:  index.devSnapshotError,
    prodSnapshotError: index.prodSnapshotError,
  };

  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' },
  });
};
