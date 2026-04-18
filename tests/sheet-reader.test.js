const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSheetCsv } = require('../netlify/functions/lib/sheet-reader');

test('parses a single fund row with all fields filled', () => {
  const csv =
    'fund_id,display_name,enabled,daily_threshold,drawdown_tiers,rebound_threshold,clients\n' +
    '03,高成長,TRUE,3,"5,10,20,30",10,\n';
  const rows = parseSheetCsv(csv);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    fundId: '03',
    displayName: '高成長',
    enabled: true,
    dailyThreshold: 3,
    drawdownTiers: [5, 10, 20, 30],
    reboundThreshold: 10,
    clients: [],
  });
});

test('applies defaults for blank threshold fields', () => {
  const csv =
    'fund_id,display_name,enabled,daily_threshold,drawdown_tiers,rebound_threshold,clients\n' +
    'ETF23,00991A,TRUE,,,,\n';
  const [row] = parseSheetCsv(csv);
  assert.equal(row.dailyThreshold, 3);
  assert.deepEqual(row.drawdownTiers, [5, 10, 20, 30]);
  assert.equal(row.reboundThreshold, 10);
});

test('treats empty or non-TRUE enabled as false', () => {
  const csv =
    'fund_id,display_name,enabled,daily_threshold,drawdown_tiers,rebound_threshold,clients\n' +
    '03,x,,,,,\n' +
    '04,y,false,,,,\n' +
    '05,z,yes,,,,\n';
  const rows = parseSheetCsv(csv);
  assert.equal(rows[0].enabled, false);
  assert.equal(rows[1].enabled, false);
  assert.equal(rows[2].enabled, false);
});

test('parses comma-separated clients and drawdown_tiers', () => {
  const csv =
    'fund_id,display_name,enabled,daily_threshold,drawdown_tiers,rebound_threshold,clients\n' +
    '03,x,TRUE,2,"3,5,10",8,"U1,U2,U3"\n';
  const [row] = parseSheetCsv(csv);
  assert.deepEqual(row.drawdownTiers, [3, 5, 10]);
  assert.deepEqual(row.clients, ['U1', 'U2', 'U3']);
});

test('sorts drawdown_tiers ascending', () => {
  const csv =
    'fund_id,display_name,enabled,daily_threshold,drawdown_tiers,rebound_threshold,clients\n' +
    '03,x,TRUE,3,"30,5,20,10",10,\n';
  const [row] = parseSheetCsv(csv);
  assert.deepEqual(row.drawdownTiers, [5, 10, 20, 30]);
});
