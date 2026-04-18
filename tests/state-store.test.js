const test = require('node:test');
const assert = require('node:assert/strict');
const { createStateStore, emptyState } = require('../lib/state-store');

function fakeBlobStore() {
  const blobs = new Map();
  return {
    async get(key, opts) {
      const v = blobs.get(key);
      if (v === undefined) return null;
      return opts && opts.type === 'json' ? v : JSON.stringify(v);
    },
    async set(key, value) {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      blobs.set(key, parsed);
    },
  };
}

test('emptyState returns default structure for a fundId', () => {
  const s = emptyState('03');
  assert.equal(s.fundId, '03');
  assert.equal(s.drawdown['20D'].lastTier, 0);
  assert.equal(s.td9.buyCompleteDate, null);
});

test('getState returns emptyState when blob missing', async () => {
  const store = createStateStore({ blobStore: fakeBlobStore() });
  const state = await store.getState('03');
  assert.equal(state.fundId, '03');
  assert.equal(state.drawdown['60D'].lastTier, 0);
});

test('setState then getState round-trips', async () => {
  const store = createStateStore({ blobStore: fakeBlobStore() });
  const mutated = emptyState('03');
  mutated.drawdown['20D'].lastTier = 10;
  mutated.td9.buyCompleteDate = '2026-04-15';
  await store.setState('03', mutated);
  const read = await store.getState('03');
  assert.equal(read.drawdown['20D'].lastTier, 10);
  assert.equal(read.td9.buyCompleteDate, '2026-04-15');
});

test('states for different funds do not collide', async () => {
  const store = createStateStore({ blobStore: fakeBlobStore() });
  const a = emptyState('03');
  a.drawdown['20D'].lastTier = 5;
  const b = emptyState('77');
  b.drawdown['20D'].lastTier = 20;
  await store.setState('03', a);
  await store.setState('77', b);
  const ra = await store.getState('03');
  const rb = await store.getState('77');
  assert.equal(ra.drawdown['20D'].lastTier, 5);
  assert.equal(rb.drawdown['20D'].lastTier, 20);
});
