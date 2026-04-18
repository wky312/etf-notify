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

// --- Upstash REST backend tests (inject fake fetch) ---

function fakeUpstash() {
  const data = new Map();
  return async (url, { body }) => {
    const cmd = JSON.parse(body);
    const [op, key, value] = cmd;
    if (op === 'GET') {
      return {
        ok: true,
        async json() {
          return { result: data.has(key) ? data.get(key) : null };
        },
      };
    }
    if (op === 'SET') {
      data.set(key, value);
      return { ok: true, async json() { return { result: 'OK' }; } };
    }
    return {
      ok: false,
      status: 400,
      async text() { return `unsupported op ${op}`; },
    };
  };
}

const UPSTASH_OPTS = {
  url: 'https://fake.upstash.io',
  token: 'fake-token',
};

test('Upstash: getState returns emptyState when key missing', async () => {
  const store = createStateStore({ ...UPSTASH_OPTS, fetchImpl: fakeUpstash() });
  const state = await store.getState('03');
  assert.equal(state.fundId, '03');
  assert.equal(state.drawdown['20D'].lastTier, 0);
});

test('Upstash: setState then getState round-trips', async () => {
  const store = createStateStore({ ...UPSTASH_OPTS, fetchImpl: fakeUpstash() });
  const mutated = emptyState('03');
  mutated.drawdown['60D'].lastTier = 20;
  mutated.td9.sellCompleteDate = '2026-04-15';
  await store.setState('03', mutated);
  const read = await store.getState('03');
  assert.equal(read.drawdown['60D'].lastTier, 20);
  assert.equal(read.td9.sellCompleteDate, '2026-04-15');
});

test('Upstash: keys are prefixed so multiple fundIds do not collide', async () => {
  const fetchImpl = fakeUpstash();
  const store = createStateStore({ ...UPSTASH_OPTS, fetchImpl });
  const a = emptyState('03');
  a.rebound['20D'].lastTier = 10;
  const b = emptyState('ETF23');
  b.rebound['20D'].lastTier = 0;
  await store.setState('03', a);
  await store.setState('ETF23', b);
  assert.equal((await store.getState('03')).rebound['20D'].lastTier, 10);
  assert.equal((await store.getState('ETF23')).rebound['20D'].lastTier, 0);
});

test('Upstash: missing URL env var throws with helpful message', async () => {
  const store = createStateStore({ token: 'x', fetchImpl: fakeUpstash() });
  await assert.rejects(
    () => store.getState('03'),
    /UPSTASH_REDIS_REST_URL/
  );
});
