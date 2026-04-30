import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findParentFkField,
  getBlockInfoByPage,
  getPageCollections,
} from '../src/lib/content-sync-graph.ts';

function makeSnapshot() {
  return {
    collections: [
      { collection: 'adpower_redesign_pages' },
      { collection: 'adpower_redesign_articles' },
      { collection: 'adpower_redesign_pages_blocks_link' },
      { collection: 'adpower_redesign_blocks_cta' },
    ],
    fields: [
      { collection: 'adpower_redesign_pages', field: 'id', type: 'integer' },
      { collection: 'adpower_redesign_pages', field: 'status', type: 'string' },
      { collection: 'adpower_redesign_pages', field: 'permalink', type: 'string' },
      { collection: 'adpower_redesign_articles', field: 'id', type: 'integer' },
      { collection: 'adpower_redesign_articles', field: 'status', type: 'string' },
      { collection: 'adpower_redesign_pages_blocks_link', field: 'id', type: 'integer' },
      { collection: 'adpower_redesign_pages_blocks_link', field: 'page_id', type: 'integer' },
      { collection: 'adpower_redesign_pages_blocks_link', field: 'item', type: 'integer' },
    ],
    relations: [
      {
        collection: 'adpower_redesign_pages_blocks_link',
        field: 'item',
        related_collection: null,
        meta: { one_allowed_collections: ['adpower_redesign_blocks_cta'] },
      },
      {
        collection: 'adpower_redesign_pages_blocks_link',
        field: 'page_id',
        related_collection: 'adpower_redesign_pages',
        meta: { one_collection: 'adpower_redesign_pages' },
      },
    ],
  };
}

test('getPageCollections detects page-like collections with status field', () => {
  const snap = makeSnapshot();
  const result = getPageCollections(snap, 'adpower_redesign');
  assert.deepEqual(
    result.names.sort(),
    ['adpower_redesign_articles', 'adpower_redesign_pages'],
  );
});

test('getBlockInfoByPage finds block junction even when name differs', () => {
  const snap = makeSnapshot();
  const pages = getPageCollections(snap, 'adpower_redesign').names;
  const info = getBlockInfoByPage(snap, 'adpower_redesign', pages);
  const pageInfo = info.get('adpower_redesign_pages');
  assert.ok(pageInfo);
  assert.equal(pageInfo?.junctionCollection, 'adpower_redesign_pages_blocks_link');
  assert.deepEqual(pageInfo?.allowedBlockTypes, ['adpower_redesign_blocks_cta']);
});

test('findParentFkField resolves parent foreign key for custom junction names', () => {
  const snap = makeSnapshot();
  const fk = findParentFkField(
    'adpower_redesign_pages_blocks_link',
    'adpower_redesign_pages',
    snap,
    'adpower_redesign',
  );
  assert.equal(fk, 'page_id');
});
