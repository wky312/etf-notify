const test = require('node:test');
const assert = require('node:assert/strict');
const {
  windowExtreme,
  pickTier,
  computeDrawdowns,
  computeRebound,
  computePeriodReturns,
  detectDrawdownAlert,
} = require('../../lib/indicators/drawdown');

const sample = [
  { date: '2026-03-01', value: 100 },
  { date: '2026-03-02', value: 110 }, // window high
  { date: '2026-03-03', value: 90 }, // window low
  { date: '2026-03-04', value: 95 },
  { date: '2026-03-05', value: 99 }, // "today"
];

test('windowExtreme: finds high in last 5 points', () => {
  assert.deepEqual(windowExtreme(sample, 5, 'high'), { date: '2026-03-02', value: 110 });
});

test('windowExtreme: finds low in last 5 points', () => {
  assert.deepEqual(windowExtreme(sample, 5, 'low'), { date: '2026-03-03', value: 90 });
});

test('windowExtreme: clamps window to array length', () => {
  assert.deepEqual(windowExtreme(sample, 100, 'high'), { date: '2026-03-02', value: 110 });
});

test('pickTier: returns largest tier ≤ pct', () => {
  assert.equal(pickTier(7, [5, 10, 20, 30]), 5);
  assert.equal(pickTier(12, [5, 10, 20, 30]), 10);
  assert.equal(pickTier(35, [5, 10, 20, 30]), 30);
  assert.equal(pickTier(3, [5, 10, 20, 30]), 0);
});

test('computeDrawdowns: returns one entry per window with enough data', () => {
  const drawdowns = computeDrawdowns(sample, [
    { label: '3D', days: 3 },
    { label: '5D', days: 5 },
    { label: '20D', days: 20 }, // not enough data
  ]);
  assert.equal(drawdowns.length, 3);
  assert.equal(drawdowns[0].label, '3D');
  assert.equal(drawdowns[1].label, '5D');
  // today=99 vs 5D high=110 → dd ≈ 10%
  assert.ok(Math.abs(drawdowns[1].dd - 10) < 0.5);
  assert.equal(drawdowns[1].high.date, '2026-03-02');
});

test('computeRebound: rb relative to window low', () => {
  const { rb, low } = computeRebound(sample, 5);
  // today=99 vs 5D low=90 → rb=10%
  assert.ok(Math.abs(rb - 10) < 0.01);
  assert.equal(low.date, '2026-03-03');
});

test('detectDrawdownAlert: fires when crossing a higher tier', () => {
  const r = detectDrawdownAlert(10, 12, 5); // currentTier=10, lastTier=5
  assert.equal(r.fire, true);
  assert.equal(r.newTier, 10);
  assert.equal(r.reset, false);
});

test('detectDrawdownAlert: no fire when staying at same tier', () => {
  const r = detectDrawdownAlert(5, 7, 5);
  assert.equal(r.fire, false);
});

test('detectDrawdownAlert: no fire when below lowest tier', () => {
  const r = detectDrawdownAlert(0, 3, 0);
  assert.equal(r.fire, false);
});

test('detectDrawdownAlert: reset when dd drops below 2%', () => {
  const r = detectDrawdownAlert(0, 1, 10);
  assert.equal(r.fire, false);
  assert.equal(r.reset, true);
});

test('computePeriodReturns: returns positive % when price rose over window', () => {
  const navs = [
    { date: '2026-03-01', value: 100 },
    { date: '2026-03-02', value: 105 },
    { date: '2026-03-03', value: 110 },
    { date: '2026-03-04', value: 120 }, // today
  ];
  const returns = computePeriodReturns(navs, [
    { label: '1D', days: 1 },
    { label: '3D', days: 3 },
  ]);
  assert.equal(returns.length, 2);
  // 1D: 120 vs 110 → +9.09%
  assert.ok(Math.abs(returns[0].ret - 9.09) < 0.1);
  assert.equal(returns[0].bars, 1);
  assert.equal(returns[0].from.date, '2026-03-03');
  // 3D: 120 vs 100 → +20%
  assert.ok(Math.abs(returns[1].ret - 20) < 0.01);
  assert.equal(returns[1].from.date, '2026-03-01');
});

test('computePeriodReturns: returns negative % when price fell over window', () => {
  const navs = [
    { date: '2026-03-01', value: 100 },
    { date: '2026-03-02', value: 80 },
  ];
  const [r] = computePeriodReturns(navs, [{ label: '1D', days: 1 }]);
  // 80 vs 100 → -20%
  assert.ok(Math.abs(r.ret - (-20)) < 0.01);
});

test('computePeriodReturns: clamps window to available bars', () => {
  const navs = [
    { date: '2026-03-01', value: 100 },
    { date: '2026-03-02', value: 120 },
  ];
  // Ask for 252D but only have 2 bars → compare to first bar (1 bar back)
  const [r] = computePeriodReturns(navs, [{ label: '252D', days: 252 }]);
  assert.equal(r.bars, 1);
  assert.ok(Math.abs(r.ret - 20) < 0.01);
});

test('computePeriodReturns: returns empty array when <2 bars', () => {
  assert.deepEqual(computePeriodReturns([], [{ label: '20D', days: 20 }]), []);
  assert.deepEqual(
    computePeriodReturns([{ date: '2026-03-01', value: 100 }], [{ label: '20D', days: 20 }]),
    []
  );
});
