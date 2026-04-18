const { connectLambda } = require('@netlify/blobs');
const { fetchSheet } = require('./lib/sheet-reader');
const { fetchNav } = require('./lib/fuhwa-api');
const { createStateStore } = require('./lib/state-store');
const { evaluateFund } = require('./lib/alert-engine');
const { formatMessage } = require('./lib/message-formatter');
const { pushText } = require('./lib/line-push');

async function run() {
  let funds;
  try {
    funds = await fetchSheet();
  } catch (e) {
    console.error('Sheet read failed:', e);
    try {
      await pushText('⚠️ 警訊系統今日無法讀取 Sheet：' + e.message);
    } catch (_) {}
    return { statusCode: 500, body: 'sheet-read-failed' };
  }

  const enabled = funds.filter((f) => f.enabled);
  if (enabled.length === 0) {
    console.log('No enabled funds');
    return { statusCode: 200, body: 'no-enabled-funds' };
  }

  const store = createStateStore();
  const entries = [];
  const failed = [];
  const stale = [];
  let latestDate = null;

  for (const cfg of enabled) {
    try {
      const navs = await fetchNav(cfg.fundId);
      if (navs.length === 0) {
        failed.push(cfg.fundId);
        continue;
      }
      const latest = navs[navs.length - 1];
      if (!latestDate || latest.date > latestDate) latestDate = latest.date;
      const prev = await store.getState(cfg.fundId);

      // Stale-check: if we already processed this date, skip to avoid double-alerts.
      if (prev.lastCheckedDate === latest.date) {
        console.log(`${cfg.fundId}: already processed ${latest.date}`);
        continue;
      }
      // Stale-check: warn if the freshest NAV is >= 2 business days old.
      const today = new Date();
      const latestAsDate = new Date(latest.date);
      const daysBehind = Math.floor((today - latestAsDate) / (24 * 60 * 60 * 1000));
      if (daysBehind >= 2) stale.push(`${cfg.fundId}(${latest.date})`);

      const { entry, nextState } = evaluateFund(cfg, navs, prev);
      await store.setState(cfg.fundId, nextState);
      if (entry) entries.push(entry);
    } catch (e) {
      console.error(`${cfg.fundId} failed:`, e);
      failed.push(cfg.fundId);
    }
  }

  if (entries.length === 0 && failed.length === 0 && stale.length === 0) {
    console.log('Nothing to push');
    return { statusCode: 200, body: 'no-alerts' };
  }

  let message = formatMessage(entries, {
    monitoredCount: enabled.length,
    latestDate: latestDate || new Date().toISOString().slice(0, 10),
  });

  if (failed.length > 0) {
    message += `\n\n⚠️ 未成功取得：${failed.join(', ')}`;
  }
  if (stale.length > 0) {
    message += `\n⚠️ NAV 延遲：${stale.join(', ')}`;
  }

  try {
    await pushText(message);
  } catch (e) {
    console.error('LINE push failed:', e);
    return { statusCode: 500, body: 'line-push-failed' };
  }

  return { statusCode: 200, body: 'ok' };
}

// Schedule declared in netlify.toml ([functions.fund-alert] schedule = "...")
exports.handler = async (event) => {
  // Lambda compatibility: initialise Blobs env from the event before any getStore call.
  if (event) connectLambda(event);
  return run();
};
exports.run = run; // exported for manual invocation / tests
