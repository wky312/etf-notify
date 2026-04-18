const test = require('node:test');
const assert = require('node:assert/strict');
const {
  windowExtreme,
  pickTier,
  computeDrawdowns,
  computeRebound,
  detectDrawdownAlert,
} = require('../../netlify/functions/lib/indicators/drawdown');

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
