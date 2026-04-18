// Cross-platform state store backed by Upstash Redis REST API.
//
// Why Upstash REST: works from any runtime (Vercel, Netlify, GitHub Actions,
// local) without SDK quirks. One HTTP call per op, 0 deps (uses native fetch).
//
// Requires env vars:
//   UPSTASH_REDIS_REST_URL    — e.g. https://xxxxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN  — the REST token
//
// Keys use the prefix "fund-alert:{fundId}" so the same Redis db can be
// shared with other projects without collision.

function emptyState(fundId) {
  return {
    fundId,
    lastCheckedDate: null,
    drawdown: {
      '20D': { lastTier: 0, lastAlertDate: null },
      '60D': { lastTier: 0, lastAlertDate: null },
      '252D': { lastTier: 0, lastAlertDate: null },
    },
    rebound: {
      '20D': { lastTier: 0, lastAlertDate: null },
    },
    td9: {
      buyCompleteDate: null,
      sellCompleteDate: null,
      lastNotifiedEventDate: null,
    },
  };
}

function keyFor(fundId) {
  return `fund-alert:${fundId}`;
}

async function upstashCall(command, opts = {}) {
  const url = opts.url || process.env.UPSTASH_REDIS_REST_URL;
  const token = opts.token || process.env.UPSTASH_REDIS_REST_TOKEN;
  const fetchImpl = opts.fetchImpl || fetch;
  if (!url) throw new Error('UPSTASH_REDIS_REST_URL not set');
  if (!token) throw new Error('UPSTASH_REDIS_REST_TOKEN not set');
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Upstash ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(`Upstash error: ${data.error}`);
  return data.result;
}

function createStateStore(opts = {}) {
  // For unit tests, callers can inject a Map-like fake via opts.blobStore that
  // implements { async get(key, {type}), async set(key, value) } — keeps the
  // existing test harness working while production uses Upstash.
  const legacyStore = opts.blobStore;
  if (legacyStore) {
    return {
      async getState(fundId) {
        const raw = await legacyStore.get(`${fundId}.json`, { type: 'json' });
        if (!raw) return emptyState(fundId);
        return raw;
      },
      async setState(fundId, state) {
        await legacyStore.set(`${fundId}.json`, JSON.stringify(state));
      },
    };
  }
  const upstashOpts = { url: opts.url, token: opts.token, fetchImpl: opts.fetchImpl };
  return {
    async getState(fundId) {
      const raw = await upstashCall(['GET', keyFor(fundId)], upstashOpts);
      if (!raw) return emptyState(fundId);
      return JSON.parse(raw);
    },
    async setState(fundId, state) {
      await upstashCall(['SET', keyFor(fundId), JSON.stringify(state)], upstashOpts);
    },
  };
}

module.exports = { emptyState, createStateStore, keyFor, upstashCall };
