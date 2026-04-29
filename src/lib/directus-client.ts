import { DEV_TOKEN, DEV_URL, PROD_TOKEN, PROD_URL } from './env';

interface ApplyPayload {
  action: 'create' | 'update';
  entity: 'collection' | 'field' | 'relation';
  item: Record<string, unknown>;
  changes?: Array<{ path: string; lhs: unknown; rhs: unknown }>;
  collection?: string;
  target?: 'prod' | 'dev';
}

export async function applyChange(payload: ApplyPayload): Promise<void> {
  const targetEnv = payload.target ?? 'prod';
  const token = targetEnv === 'dev' ? DEV_TOKEN() : PROD_TOKEN();
  const base  = targetEnv === 'dev' ? DEV_URL()   : PROD_URL();
  const { action, entity, changes, collection } = payload;
  // For dev target on updates, apply prod (rhs) values back onto the item
  const item = (action === 'update' && targetEnv === 'dev')
    ? applyRhsToItem(payload.item, changes)
    : payload.item;

  let url: string;
  let body: Record<string, unknown>;

  if (action === 'create') {
    if (entity === 'collection') {
      url  = `${base}/collections`;
      body = item;
    } else if (entity === 'field') {
      const coll = (item['collection'] as string) ?? collection;
      url  = `${base}/fields/${coll}`;
      body = item;
    } else {
      url  = `${base}/relations`;
      body = item;
    }
  } else {
    // update — apply only changed paths
    if (entity === 'collection') {
      const coll = item['collection'] as string;
      url  = `${base}/collections/${coll}`;
      body = buildUpdateBody(item, changes);
    } else if (entity === 'field') {
      const coll  = item['collection'] as string;
      const field = item['field'] as string;
      url  = `${base}/fields/${coll}/${field}`;
      body = buildUpdateBody(item, changes);
    } else {
      const coll  = item['collection'] as string;
      const field = item['field'] as string;
      url  = `${base}/relations/${coll}/${field}`;
      body = buildUpdateBody(item, changes);
    }
  }

  const method = action === 'create' ? 'POST' : 'PATCH';
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // 409 = already exists → treat as success
  if (res.status === 409) return;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message: string;
    try { message = JSON.parse(text)?.errors?.[0]?.message ?? text; }
    catch { message = text; }
    throw new Error(`HTTP ${res.status}: ${message}`);
  }
}

/** Build a PATCH body containing only the top-level keys that appear in changes. */
function buildUpdateBody(
  item: Record<string, unknown>,
  changes?: Array<{ path: string; lhs: unknown }>
): Record<string, unknown> {
  if (!changes?.length) return item;
  // Group changed paths by top-level key
  const topKeys = new Set(changes.map(c => c.path.split('.')[0] ?? c.path));
  const body: Record<string, unknown> = {};
  for (const k of topKeys) {
    if (k && k in item) body[k] = item[k as keyof typeof item];
  }
  return body;
}

/**
 * Deep-clone item and overwrite each changed path with its rhs (prod) value,
 * so the result can be PATCH'd onto dev to pull prod's values down.
 */
function applyRhsToItem(
  item: Record<string, unknown>,
  changes?: Array<{ path: string; rhs: unknown }>
): Record<string, unknown> {
  if (!changes?.length) return item;
  const clone = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
  for (const c of changes) {
    setAtPath(clone, c.path, c.rhs);
  }
  return clone;
}

function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
