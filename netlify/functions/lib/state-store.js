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
  const { getStore } = require('@netlify/blobs');
  return getStore({ name: 'fund-alert-state', consistency: 'strong' });
}

module.exports = { emptyState, createStateStore };
