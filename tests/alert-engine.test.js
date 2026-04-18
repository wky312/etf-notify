const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateFund } = require('../netlify/functions/lib/alert-engine');
const { emptyState } = require('../netlify/functions/lib/state-store');

const cfg = {
  fundId: '03',
  displayName: '高成長',
  enabled: true,
  dailyThreshold: 3,
  drawdownTiers: [5, 10, 20, 30],
  reboundThreshold: 10,
  clients: [],
};

function navSeries(closes, startDay = 1) {
  return closes.map((v, i) => ({
    date: `2026-04-${String(startDay + i).padStart(2, '0')}`,
    value: v,
  }));
}

test('no entry when nothing triggers', () => {
  const navs = navSeries([100, 101, 102, 101.5, 102.3]);
  const { entry } = evaluateFund(cfg, navs, emptyState('03'));
  assert.equal(entry, null);
});

test('drawdown crosses 5% tier → entry fires and state updates', () => {
  const navs = [
    { date: '2026-04-01', value: 100 },
    { date: '2026-04-02', value: 100 },
    { date: '2026-04-03', value: 94 }, // -6% from high
  ];
  const { entry, nextState } = evaluateFund(cfg, navs, emptyState('03'));
  assert.ok(entry);
  const dd = entry.drawdowns.find((d) => d.tier === 5);
  assert.ok(dd);
  assert.equal(dd.isNew, true);
  assert.equal(nextState.drawdown['20D'].lastTier, 5);
});

test('drawdown same tier as last → no entry', () => {
  // Daily move is tiny (-0.5%) so daily alert doesn't fire; drawdown is stuck at tier 5.
  const navs = [
    { date: '2026-04-01', value: 100 },
    { date: '2026-04-02', value: 95 },
    { date: '2026-04-03', value: 94.5 },
  ];
  const state = emptyState('03');
  state.drawdown['20D'].lastTier = 5;
  state.drawdown['60D'].lastTier = 5;
  state.drawdown['252D'].lastTier = 5;
  const { entry } = evaluateFund(cfg, navs, state);
  assert.equal(entry, null);
});

test('drawdown resets when price recovers to within 2% of high', () => {
  const navs = [
    { date: '2026-04-01', value: 100 },
    { date: '2026-04-02', value: 99.5 }, // dd = 0.5%
  ];
  const state = emptyState('03');
  state.drawdown['20D'].lastTier = 10;
  const { nextState } = evaluateFund(cfg, navs, state);
  assert.equal(nextState.drawdown['20D'].lastTier, 0);
});

test('rebound entry fires once then not again until reset', () => {
  const navs = [
    { date: '2026-04-01', value: 100 },
    { date: '2026-04-02', value: 80 }, // low
    { date: '2026-04-03', value: 90 }, // rb = 12.5%
  ];
  const state = emptyState('03');
  const { entry: e1, nextState: s1 } = evaluateFund(cfg, navs, state);
  assert.ok(e1.rebound);
  assert.equal(e1.rebound.isNew, true);
  assert.equal(s1.rebound['20D'].lastTier, 10);
  // Next day still 12% rebound → should not fire again
  const { entry: e2 } = evaluateFund(
    cfg,
    [...navs, { date: '2026-04-04', value: 90 }],
    s1
  );
  assert.equal(e2, null);
});

test('TD9 complete today produces isNewComplete=true', () => {
  // 13 descending bars
  const closes = Array.from({ length: 13 }, (_, i) => 100 - i);
  const navs = navSeries(closes);
  const { entry, nextState } = evaluateFund(cfg, navs, emptyState('03'));
  assert.ok(entry);
  assert.equal(entry.td9.completeSide, 'buy');
  assert.equal(entry.td9.isNewComplete, true);
  assert.equal(nextState.td9.buyCompleteDate, '2026-04-13');
  assert.equal(nextState.td9.lastNotifiedEventDate, '2026-04-13');
});

test('TD9 complete in the past (not today) persists lastNotifiedEventDate so next run is 延續中', () => {
  // Build a series where setup completed several bars ago, and today's bar is unrelated.
  // Completion at bar 13 (13 descending), then 3 equal bars so count freezes at 9 and
  // today isn't the completion day. Fresh state = first run. isNewComplete should be
  // true AND lastNotifiedEventDate should be set to the completion date so subsequent
  // runs see alreadyNotified=true.
  const descending = Array.from({ length: 13 }, (_, i) => 100 - i); // completes buy at day 13
  const tail = [descending[descending.length - 1], descending[descending.length - 1]]; // 2 flat days
  const navs = navSeries([...descending, ...tail]);
  const state = emptyState('03');
  const { entry, nextState } = evaluateFund(cfg, navs, state);
  assert.ok(entry);
  assert.equal(entry.td9.completeSide, 'buy');
  assert.equal(entry.td9.isNewComplete, true);
  assert.equal(nextState.td9.lastNotifiedEventDate, '2026-04-13');
  // Second run with persisted state → 延續中
  const { entry: e2 } = evaluateFund(cfg, navs, nextState);
  // Entry may still exist (other triggers) or be null; key check is isNewComplete=false
  if (e2) assert.equal(e2.td9.isNewComplete, false);
});

test('TD9 complete already notified → isNewComplete=false (延續中)', () => {
  const closes = Array.from({ length: 13 }, (_, i) => 100 - i);
  const navs = navSeries(closes);
  const state = emptyState('03');
  state.td9.buyCompleteDate = '2026-04-13';
  state.td9.lastNotifiedEventDate = '2026-04-13';
  state.drawdown['20D'].lastTier = 30; // also triggered so we get an entry
  // Force entry to exist by making daily trigger:
  const navsWithJump = [
    ...navs.slice(0, -1),
    { date: '2026-04-13', value: navs[navs.length - 1].value * 0.95 }, // -5% daily
  ];
  const { entry: e2 } = evaluateFund(cfg, navsWithJump, state);
  assert.ok(e2);
  assert.equal(e2.td9.completeSide, 'buy');
  assert.equal(e2.td9.isNewComplete, false); // 延續中
});

test('daily change exceeding threshold triggers', () => {
  const navs = [
    { date: '2026-04-01', value: 100 },
    { date: '2026-04-02', value: 100 },
    { date: '2026-04-03', value: 96 }, // -4%
  ];
  const { entry } = evaluateFund(cfg, navs, emptyState('03'));
  assert.ok(entry);
  assert.ok(entry.daily);
  assert.ok(Math.abs(entry.daily.pct - (-4)) < 0.1);
});
