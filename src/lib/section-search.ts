/**
 * Fuzzy = ordered subsequence: query characters may appear with gaps
 * (e.g. "usr" matches "user_settings"). Space separates AND terms.
 */

export function searchTermsFromQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isSubsequenceIn(haystack: string, needle: string): boolean {
  if (!needle) return true;
  if (!haystack) return false;
  let j = 0;
  for (let i = 0; i < haystack.length && j < needle.length; i++) {
    if (haystack[i] === needle[j]) j++;
  }
  return j === needle.length;
}

/** All terms must match the full row/corpus (subsequence), AND across terms. */
export function rowMatchesSearch(preparedSearch: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const s = preparedSearch;
  return terms.every((t) => isSubsequenceIn(s, t));
}

/**
 * Return sorted unique indices in `text` (lower/upper aligned) for `term`
 * (subsequence) or null. Greedy from the left.
 */
function subsequenceIndicesIn(text: string, term: string): number[] | null {
  if (!term) return [];
  const lowerT = term.toLowerCase();
  if (!lowerT) return [];
  const lowerH = text.toLowerCase();
  const idx: number[] = [];
  let j = 0;
  for (let i = 0; i < text.length && j < lowerT.length; i++) {
    if (lowerH[i] === lowerT[j]) {
      idx.push(i);
      j++;
    }
  }
  return j === lowerT.length ? idx : null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Find where the first term matches in text (subsequence) and return a
 * window of characters centered on that match. Falls back to the start
 * of the text if no match is found (shouldn't happen in practice since
 * we only call this for fields that already passed rowMatchesSearch).
 */
export function extractMatchSnippet(text: string, terms: string[], halfWidth = 110): string {
  if (!text) return '';
  const totalWidth = halfWidth * 2;
  if (terms.length === 0 || text.length <= totalWidth) return text;

  const lower = text.toLowerCase();
  let anchorStart = -1;
  let anchorEnd   = -1;

  for (const term of terms) {
    if (!term) continue;
    const lowerTerm = term.toLowerCase();
    const indices: number[] = [];
    let j = 0;
    for (let i = 0; i < lower.length && j < lowerTerm.length; i++) {
      if (lower[i] === lowerTerm[j]) { indices.push(i); j++; }
    }
    if (j === lowerTerm.length && indices.length > 0 && (anchorStart === -1 || indices[0]! < anchorStart)) {
      anchorStart = indices[0]!;
      anchorEnd   = indices[indices.length - 1]!;
    }
  }

  if (anchorStart === -1) return text.slice(0, totalWidth) + '…';

  const mid  = Math.floor((anchorStart + anchorEnd) / 2);
  const from = Math.max(0, mid - halfWidth);
  const to   = Math.min(text.length, from + totalWidth);

  return (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '');
}

/**
 * For each space-separated term, if it matches as a subsequence in this
 * fragment, add highlights (later terms can add more marks; overlapping
 * is merged visually by nested or sequential marks).
 */
export function highlightFragmentForTerms(text: string, terms: string[]): string {
  if (!text) return '';
  if (terms.length === 0) return escapeHtml(text);
  // Sort terms by length desc so we prefer highlighting longer first - actually
  // apply in sequence, merging index sets for display: highlight any index
  // that appears in any term's subsequence if that term fully matches the fragment
  const hit = new Set<number>();
  for (const term of terms) {
    if (!term) continue;
    const ind = subsequenceIndicesIn(text, term);
    if (ind) ind.forEach((i) => hit.add(i));
  }
  if (hit.size === 0) return escapeHtml(text);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const esc = escapeHtml(ch);
    if (hit.has(i)) {
      out += `<mark class="search-hit">${esc}</mark>`;
    } else {
      out += esc;
    }
  }
  return out;
}
