/**
 * Shared pure-logic module for Directus schema diffing.
 * Consumed by scripts/diff-directus-schema.js and schema-dashboard/.
 */

const DEFAULT_DEV_BASE        = 'https://directus-ct-shared.gpillar-dev.global.com';
const DEFAULT_PROD_BASE       = 'https://directus-ct-shared.gpillar-prod.global.com';
const DEFAULT_COLLECTION_PREFIX = 'adpower_redesign';
const SNAPSHOT_PATH           = 'scripts/.directus-dev-snapshot.json';

const NOISE_PATHS = new Set([
  'meta.sort', 'meta.display_template', 'meta.note', 'meta.validation_message',
  'meta.preview_url', 'meta.icon', 'meta.color', 'meta.collapse', 'meta.translations',
  'meta.width', 'meta.group', 'meta.hidden', 'meta.readonly', 'meta.required',
  'schema.foreign_key_table', 'schema.foreign_key_column', 'schema.constraint_name',
  'schema.on_update', 'schema.on_delete', 'schema.table', 'schema.column',
]);

const CHANGE_TIERS = [
  [/^schema\./,                                          'schema'],
  [/meta\.type$/,                                        'schema'],
  [/meta\.options\.choices/,                             'choices'],
  [/meta\.options\.extensions/,                          'choices'],
  [/meta\.one_allowed_collections/,                      'relations'],
  [/meta\.sort_field/,                                   'relations'],
  [/meta\.junction_field/,                               'relations'],
  [/meta\.many_collection|meta\.one_collection/,         'relations'],
  [/meta\.options/,                                      'options'],
  [/meta\.conditions/,                                   'options'],
  [/meta\.display$/,                                     'options'],
  [/meta\.display_options/,                              'options'],
  [/meta\.interface$/,                                   'options'],
  [/meta\.special/,                                      'options'],
  [/./,                                                  'admin'],
];

const TIER_META = {
  schema:    { icon: '🚨', label: 'Schema changes',          action: 'Requires field type / default update — do carefully', hidden: false },
  relations: { icon: '🔗', label: 'Relation config changes', action: 'Update allowed collections or sort field in Directus',  hidden: false },
  choices:   { icon: '🎨', label: 'Option / choice changes', action: 'Update field options in Directus admin',                hidden: false },
  options:   { icon: '⚙️ ', label: 'Field config changes',   action: 'Update field settings in Directus admin',              hidden: false },
  admin:     { icon: 'ℹ️ ', label: 'Admin UI only',           action: 'Low priority — run with --show-noise to see',         hidden: true  },
};

function classifyChange(path) {
  for (const [re, tier] of CHANGE_TIERS) {
    if (re.test(path)) return tier;
  }
  return 'admin';
}

function deepChanges(a, b, path = '', showNoise = false) {
  const changes = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const fullPath = path ? `${path}.${k}` : k;
    if (!showNoise && NOISE_PATHS.has(fullPath)) continue;
    const av = a?.[k];
    const bv = b?.[k];
    if (JSON.stringify(av) === JSON.stringify(bv)) continue;
    if (av && bv && typeof av === 'object' && typeof bv === 'object' && !Array.isArray(av)) {
      changes.push(...deepChanges(av, bv, fullPath, showNoise));
    } else {
      changes.push({ path: fullPath, tier: classifyChange(fullPath), lhs: av, rhs: bv });
    }
  }
  return changes;
}

function diffArray(devItems, prodItems, keyFn, showNoise) {
  const devMap  = new Map(devItems.map(i  => [keyFn(i),  i]));
  const prodMap = new Map(prodItems.map(i => [keyFn(i), i]));
  const creates = [], updates = [], deletes = [];
  for (const [key, devItem] of devMap) {
    if (!prodMap.has(key)) {
      creates.push(devItem);
    } else {
      const prodItem = prodMap.get(key);
      const changes = deepChanges(devItem, prodItem, '', showNoise);
      if (changes.length) updates.push({ item: devItem, changes });
    }
  }
  for (const [key, prodItem] of prodMap) {
    if (!devMap.has(key)) deletes.push(prodItem);
  }
  return { creates, updates, deletes };
}

/** Dev + prod both have the same key and deepEqual after noise (no tracked differences). */
function matchedInBoth(devItems, prodItems, keyFn, showNoise) {
  const devMap  = new Map(devItems.map((i)  => [keyFn(i),  i]));
  const prodMap = new Map(prodItems.map((i) => [keyFn(i), i]));
  const matched = [];
  for (const [key, devItem] of devMap) {
    if (!prodMap.has(key)) continue;
    const prodItem = prodMap.get(key);
    const changes = deepChanges(devItem, prodItem, '', showNoise);
    if (changes.length === 0) matched.push(devItem);
  }
  return matched;
}

function listMatched(dev, prod, prefix, showNoise) {
  const devF  = filterSnapshot(dev,  prefix);
  const prodF = filterSnapshot(prod, prefix);
  return {
    collections: matchedInBoth(
      devF.collections,
      prodF.collections,
      (c) => c.collection,
      showNoise
    ),
    fields: matchedInBoth(
      devF.fields,
      prodF.fields,
      (f) => `${f.collection}.${f.field}`,
      showNoise
    ),
    relations: matchedInBoth(
      devF.relations,
      prodF.relations,
      (r) => `${r.collection}.${r.field}`,
      showNoise
    ),
  };
}

function filterSnapshot(snapshot, prefix) {
  if (!prefix) return snapshot;
  const keep = name => name.startsWith(prefix);
  return {
    ...snapshot,
    collections: (snapshot.collections ?? []).filter(c => keep(c.collection)),
    fields:      (snapshot.fields      ?? []).filter(f => keep(f.collection)),
    relations:   (snapshot.relations   ?? []).filter(r => keep(r.collection)),
  };
}

function diffSnapshots(dev, prod, prefix, showNoise) {
  const devF  = filterSnapshot(dev,  prefix);
  const prodF = filterSnapshot(prod, prefix);
  const collections = diffArray(devF.collections, prodF.collections, c => c.collection,               showNoise);
  const fields      = diffArray(devF.fields,      prodF.fields,      f => `${f.collection}.${f.field}`, showNoise);
  const relations   = diffArray(devF.relations,   prodF.relations,   r => `${r.collection}.${r.field}`, showNoise);
  return { collections, fields, relations };
}

async function fetchSnapshot(baseUrl, token) {
  const res = await fetch(`${baseUrl}/schema/snapshot`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} fetching snapshot from ${baseUrl}\n${body.slice(0, 300)}`);
  }
  const { data } = await res.json();
  return data;
}

async function resolveToken(baseUrl, staticToken, label) {
  if (staticToken) return staticToken;
  throw new Error(
    `No token found for ${label} (${baseUrl}).\n\n` +
    `Add to .env.local:\n` +
    `  DIRECTUS_${label}_TOKEN="<token>"\n\n` +
    `Get it: ${baseUrl}/admin → avatar → My Profile → Token → Generate → Save`
  );
}

function formatArrayDiff(lhs, rhs) {
  const key = v => (typeof v === 'object' && v !== null) ? (v.value ?? v.text ?? JSON.stringify(v)) : String(v);
  const lhsKeys = (lhs ?? []).map(key);
  const rhsKeys = (rhs ?? []).map(key);
  const toAdd    = lhsKeys.filter(k => !rhsKeys.includes(k));
  const toRemove = rhsKeys.filter(k => !lhsKeys.includes(k));
  if (!toAdd.length && !toRemove.length) return null;
  return { toAdd, toRemove };
}

function summarise(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return `"${v}"`;
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (typeof v[0] === 'object') return `[${v.length} items — e.g. ${JSON.stringify(v[0]).slice(0, 60)}...]`;
    return JSON.stringify(v).slice(0, 100);
  }
  const str = JSON.stringify(v);
  return str.length > 100 ? str.slice(0, 97) + '...' : str;
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function similarity(a, b) {
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

function guessRenameHint(dev, prod) {
  let i = 0;
  while (i < dev.length && i < prod.length && dev[i] === prod[i]) i++;
  const devSuffix  = dev.slice(i);
  const prodSuffix = prod.slice(i);
  if (!devSuffix && !prodSuffix) return 'identical';
  if (devSuffix.replace(/_/g, '') === prodSuffix.replace(/_/g, ''))
    return 'underscore difference';
  if (Math.abs(devSuffix.length - prodSuffix.length) === 1)
    return 'possible typo (missing/extra letter)';
  if (devSuffix.split('').sort().join('') === prodSuffix.split('').sort().join(''))
    return 'possible typo (transposed letters)';
  return `suffix differs: dev="${devSuffix}" prod="${prodSuffix}"`;
}

function findPossibleRenames(devOnlyCollections, prodOnlyCollections) {
  const results = [];
  for (const devItem of devOnlyCollections) {
    for (const prodItem of prodOnlyCollections) {
      const sim = similarity(devItem.collection, prodItem.collection);
      if (sim >= 0.85 && sim < 1) {
        results.push({
          dev:  devItem.collection,
          prod: prodItem.collection,
          similarity: Math.round(sim * 100),
          hint: guessRenameHint(devItem.collection, prodItem.collection),
        });
      }
    }
  }
  const seen = new Map();
  for (const r of results) {
    if (!seen.has(r.dev) || seen.get(r.dev).similarity < r.similarity)
      seen.set(r.dev, r);
  }
  return [...seen.values()].sort((a, b) => b.similarity - a.similarity);
}

/**
 * Detect auto-generated junction table name conflicts.
 * These occur when Directus generates a junction table name that already exists
 * in prod, so it appends _1, _2, etc. — resulting in dev and prod having
 * the same logical table under different names.
 *
 * devOnlyCollections  = diff.collections.creates
 * prodOnlyCollections = diff.collections.deletes
 */
function findJunctionConflicts(devOnlyCollections, prodOnlyCollections) {
  const stripSuffix = s => s.replace(/_\d+$/, '');
  const results = [];
  for (const devItem of devOnlyCollections) {
    const devBase = stripSuffix(devItem.collection);
    for (const prodItem of prodOnlyCollections) {
      const prodBase = stripSuffix(prodItem.collection);
      if (devBase === prodBase && devItem.collection !== prodItem.collection) {
        results.push({
          dev:        devItem.collection,
          prod:       prodItem.collection,
          similarity: Math.round(similarity(devItem.collection, prodItem.collection) * 100),
          hint:       `auto-generated junction table — same base "${devBase}", numeric suffix differs`,
        });
      }
    }
  }
  return results;
}

/**
 * Remove aliased junction table pairs from the diff so they no longer show up
 * in dev-only / prod-only lists.  Aliases are [{dev, prod}] objects.
 */
function applyJunctionAliases(diff, aliases) {
  if (!aliases || aliases.length === 0) return diff;
  const aliasedDev  = new Set(aliases.map(a => a.dev));
  const aliasedProd = new Set(aliases.map(a => a.prod));
  return {
    collections: {
      creates: diff.collections.creates.filter(c => !aliasedDev.has(c.collection)),
      updates: diff.collections.updates,
      deletes: diff.collections.deletes.filter(c => !aliasedProd.has(c.collection)),
    },
    fields: {
      creates: diff.fields.creates.filter(f => !aliasedDev.has(f.collection)),
      updates: diff.fields.updates,
      deletes: diff.fields.deletes.filter(f => !aliasedProd.has(f.collection)),
    },
    relations: {
      creates: diff.relations.creates.filter(r => !aliasedDev.has(r.collection)),
      updates: diff.relations.updates,
      deletes: diff.relations.deletes.filter(r => !aliasedProd.has(r.collection)),
    },
  };
}

export {
  DEFAULT_DEV_BASE, DEFAULT_PROD_BASE, DEFAULT_COLLECTION_PREFIX, SNAPSHOT_PATH,
  NOISE_PATHS, CHANGE_TIERS, TIER_META,
  classifyChange, deepChanges, diffArray, matchedInBoth, filterSnapshot, diffSnapshots, listMatched,
  fetchSnapshot, resolveToken, formatArrayDiff, summarise, groupBy,
  editDistance, similarity, guessRenameHint, findPossibleRenames,
  findJunctionConflicts, applyJunctionAliases,
};
