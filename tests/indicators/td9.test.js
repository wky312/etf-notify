const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTd9 } = require('../../netlify/functions/lib/indicators/td9');

function navSeries(closes) {
  return closes.map((v, i) => ({
    date: `2026-04-${String(i + 1).padStart(2, '0')}`,
    value: v,
  }));
}

test('empty on too-short series', () => {
  const r = computeTd9(navSeries([100, 101, 102, 103]));
  assert.equal(r.buy, 0);
  assert.equal(r.sell, 0);
  assert.equal(r.events.length, 0);
});

test('buy setup 9 completes when 9 consecutive closes < close 4 bars ago', () => {
  // Need ≥ 13 bars so that bar 5..13 each has close < close 4 bars prior.
  // Use strictly descending prices.
  const closes = Array.from({ length: 13 }, (_, i) => 100 - i);
  const r = computeTd9(navSeries(closes));
  assert.equal(r.buy, 9);
  assert.equal(r.sell, 0);
  assert.equal(r.buyCompleteDate, '2026-04-13');
  assert.ok(r.events.some((e) => e.type === 'buy_complete' && e.date === '2026-04-13'));
});

test('sell setup 9 completes when 9 consecutive closes > close 4 bars ago', () => {
  const closes = Array.from({ length: 13 }, (_, i) => 100 + i);
  const r = computeTd9(navSeries(closes));
  assert.equal(r.sell, 9);
  assert.equal(r.buy, 0);
  assert.equal(r.sellCompleteDate, '2026-04-13');
});

test('count freezes at 9 after complete', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
  const r = computeTd9(navSeries(closes));
  assert.equal(r.buy, 9);
  // Exactly one buy_complete event
  assert.equal(r.events.filter((e) => e.type === 'buy_complete').length, 1);
});

test('buy_reset event emitted when buy count ≥6 is reversed', () => {
  // 8 descending closes then a reversing up-tick
  const closes = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 95];
  const r = computeTd9(navSeries(closes));
  const reset = r.events.find((e) => e.type === 'buy_reset');
  assert.ok(reset, 'expected buy_reset event');
  assert.ok(reset.prev >= 6);
  assert.equal(r.buy, 0);
  assert.equal(r.sell, 1);
});

test('no reset event when count < 6 is reversed', () => {
  const closes = [100, 99, 98, 97, 96, 95, 100];
  const r = computeTd9(navSeries(closes));
  assert.equal(r.events.filter((e) => e.type === 'buy_reset').length, 0);
});

test('equal closes suspend (no change to counters)', () => {
  // Build a small descending series, then an equal close
  const closes = [100, 99, 98, 97, 96, 95];
  const r1 = computeTd9(navSeries(closes));
  const r2 = computeTd9(navSeries([...closes, 96])); // equal to bar i-4
  // close[6] = 96, close[2] = 98; 96 < 98 → still counts as buy setup bar.
  // Construct an actual equal case: close[6] needs to equal close[2].
  const closes2 = [100, 99, 98, 97, 96, 95, 98];
  const r3 = computeTd9(navSeries(closes2));
  // close[6]=98, close[2]=98 → equal, suspend. buy stays at 2.
  assert.equal(r3.buy, 2);
});

test('buyCompleteDate resets when reversed', () => {
  const descending = Array.from({ length: 13 }, (_, i) => 100 - i); // completes buy at bar 13
  const withReversal = [...descending, 999];
  const r = computeTd9(navSeries(withReversal));
  assert.equal(r.buy, 0);
  assert.equal(r.buyCompleteDate, null);
});
