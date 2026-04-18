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

function createStateStore(opts = {}) {
  const blobStore = opts.blobStore || lazyNetlifyBlobStore();
  return {
    async getState(fundId) {
      const raw = await blobStore.get(`${fundId}.json`, { type: 'json' });
      if (!raw) return emptyState(fundId);
      return raw;
    },
    async setState(fundId, state) {
      await blobStore.set(`${fundId}.json`, JSON.stringify(state));
    },
  };
}

function lazyNetlifyBlobStore() {
  // Imported here so tests that inject a fake don't require network / Netlify context.
  // Use default (eventual) consistency — strong mode requires an uncachedEdgeURL
  // which connectLambda() doesn't provide. For our once-per-day schedule, eventual
  // consistency is more than sufficient (state writes settle long before next read).
  const { getStore } = require('@netlify/blobs');
  return getStore('fund-alert-state');
}

module.exports = { emptyState, createStateStore };
