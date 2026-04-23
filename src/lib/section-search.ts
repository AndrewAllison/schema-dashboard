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
