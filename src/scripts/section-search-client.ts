import {
  searchTermsFromQuery,
  rowMatchesSearch,
  highlightFragmentForTerms,
} from '../lib/section-search';

function initHlOrig(section: HTMLElement) {
  for (const el of section.querySelectorAll<HTMLElement>('.search-hl-target')) {
    if (!el.dataset.orig) {
      el.dataset.orig = el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    }
  }
}

function applyHighlights(section: HTMLElement, terms: string[]) {
  for (const el of section.querySelectorAll<HTMLElement>('.search-hl-target')) {
    const raw = el.dataset.orig ?? el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (terms.length === 0) {
      el.textContent = raw;
    } else {
      el.innerHTML = highlightFragmentForTerms(raw, terms);
    }
  }
}

function getFilterableRows(section: HTMLElement) {
  return [
    ...section.querySelectorAll<HTMLTableRowElement>('tbody tr'),
    ...section.querySelectorAll<HTMLElement>('[data-section-row]'),
  ];
}

function runSection(section: HTMLElement) {
  const input = section.querySelector<HTMLInputElement>('.section-search-input');
  if (!input) return;
  const terms = searchTermsFromQuery(input.value);
  const rows = getFilterableRows(section);
  let total = 0;
  let shown = 0;
  for (const tr of rows) {
    if (!tr.hasAttribute('data-search')) continue;
    total++;
    const blob = (tr.dataset.search ?? '').toLowerCase();
    if (rowMatchesSearch(blob, terms)) {
      shown++;
      tr.classList.remove('is-search-hidden');
    } else {
      tr.classList.add('is-search-hidden');
    }
  }
  const meta = section.querySelector<HTMLElement>('.section-search-count');
  if (meta) {
    meta.textContent = terms.length ? `Showing ${shown} of ${total}` : ``;
  }
  applyHighlights(section, terms);
}

export function initSectionSearch() {
  for (const section of document.querySelectorAll<HTMLElement>('[data-section-search]')) {
    initHlOrig(section);
    const input = section.querySelector<HTMLInputElement>('.section-search-input');
    if (input) {
      input.addEventListener('input', () => runSection(section));
    }
    runSection(section);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSectionSearch);
  } else {
    initSectionSearch();
  }
}
