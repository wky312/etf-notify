const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatMessage,
  formatStatus,
  fmtDisplayDate,
} = require('../lib/message-formatter');

test('fmtDisplayDate: YYYY-MM-DD → YYYY/MM/DD', () => {
  assert.equal(fmtDisplayDate('2026-04-17'), '2026/04/17');
});

test('formatMessage: empty entries list produces no-alerts preamble only', () => {
  const out = formatMessage([], { monitoredCount: 5, latestDate: '2026-04-17' });
  assert.ok(out.startsWith('📊 2026/04/17 警訊摘要'));
  assert.match(out, /5 檔監控中，0 檔觸發/);
});

test('formatMessage: drawdown entry with dates and NEW marker', () => {
  const entry = {
    fundId: '03',
    displayName: '高成長',
    today: { date: '2026-04-17', value: 352.74 },
    drawdowns: [
      { label: '20D', dd: 7.2, tier: 5, high: { date: '2026-03-15', value: 380 }, isNew: true },
      { label: '60D', dd: 12.8, tier: 10, high: { date: '2026-02-14', value: 400 }, isNew: true },
    ],
    drawdownsUntriggered: [],
    rebound: null,
    td9: { completeSide: null, progressSide: null, resetEvent: null, isNewComplete: false },
    daily: { pct: -1.1, threshold: 3 },
  };
  const out = formatMessage([entry], { monitoredCount: 5, latestDate: '2026-04-17' });
  assert.match(out, /高成長（03）/);
  assert.match(out, /NAV: 352\.74 \(2026\/04\/17\)/);
  assert.match(out, /20D: -7\.2% \[觸發 5%\]（高點 2026\/03\/15）← NEW/);
  assert.match(out, /60D: -12\.8% \[觸發 10%\]（高點 2026\/02\/14）← NEW/);
});

test('formatMessage: rebound entry with low date', () => {
  const entry = {
    fundId: 'ETF23',
    displayName: '00991A',
    today: { date: '2026-04-17', value: 14.64 },
    drawdowns: [],
    drawdownsUntriggered: [],
    rebound: { rb: 24.9, low: { date: '2026-03-31', value: 11.72 }, threshold: 10, isNew: true },
    td9: { completeSide: null, progressSide: null, resetEvent: null, isNewComplete: false },
    daily: null,
  };
  const out = formatMessage([entry], { monitoredCount: 1, latestDate: '2026-04-17' });
  assert.match(out, /📈 反彈/);
  assert.match(out, /20D: \+24\.9% \[觸發 10%\]（低點 2026\/03\/31）← NEW/);
});

test('formatMessage: TD9 complete new vs continuing', () => {
  const entryNew = {
    fundId: '03',
    displayName: '高成長',
    today: { date: '2026-04-17', value: 100 },
    drawdowns: [], drawdownsUntriggered: [], rebound: null, daily: null,
    td9: { completeSide: 'buy', completeDate: '2026-04-17', isNewComplete: true, progressSide: null, progressCount: null, resetEvent: null },
  };
  const outNew = formatMessage([entryNew], { monitoredCount: 1, latestDate: '2026-04-17' });
  assert.match(outNew, /TD9: Buy Setup 9 完成於 2026\/04\/17 ← NEW/);

  const entryCont = {
    ...entryNew,
    td9: { ...entryNew.td9, completeDate: '2026-04-15', isNewComplete: false },
  };
  const outCont = formatMessage([entryCont], { monitoredCount: 1, latestDate: '2026-04-17' });
  assert.match(outCont, /TD9: Buy Setup 9 完成於 2026\/04\/15（延續中）/);
  assert.doesNotMatch(outCont, /← NEW/);
});

test('formatMessage: TD9 progress and reset', () => {
  const entryProgress = {
    fundId: '03',
    displayName: '高成長',
    today: { date: '2026-04-17', value: 100 },
    drawdowns: [], drawdownsUntriggered: [], rebound: null, daily: { pct: -3.5, threshold: 3 },
    td9: { completeSide: null, progressSide: 'buy', progressCount: 7, resetEvent: null, isNewComplete: false },
  };
  assert.match(
    formatMessage([entryProgress], { monitoredCount: 1, latestDate: '2026-04-17' }),
    /TD9: Buy Setup 7\/9 進行中/
  );

  const entryReset = {
    ...entryProgress,
    td9: { completeSide: null, progressSide: null, resetEvent: { side: 'sell', prev: 7 }, isNewComplete: false },
  };
  assert.match(
    formatMessage([entryReset], { monitoredCount: 1, latestDate: '2026-04-17' }),
    /TD9: Sell Setup 在第 7 天被反轉重置/
  );
});

test('formatMessage: daily change line only when triggered', () => {
  const entry = {
    fundId: '03',
    displayName: 'x',
    today: { date: '2026-04-17', value: 100 },
    drawdowns: [], drawdownsUntriggered: [], rebound: null,
    td9: { completeSide: null, progressSide: null, resetEvent: null, isNewComplete: false },
    daily: { pct: 3.2, threshold: 3 },
  };
  assert.match(
    formatMessage([entry], { monitoredCount: 1, latestDate: '2026-04-17' }),
    /💬 單日: \+3\.2%/
  );
});

// --- formatStatus tests (for /status LINE command) ---

test('formatStatus: shows period returns (negative when price fell)', () => {
  const summaries = [
    {
      fundId: '03',
      displayName: '高成長',
      latest: { date: '2026-04-17', value: 100 },
      returns: [
        { label: '20D', ret: -7.2, from: { date: '2026-03-20', value: 107.76 } },
        { label: '60D', ret: -12.8, from: { date: '2026-02-18', value: 114.68 } },
      ],
      td9: { buy: 0, sell: 0 },
    },
  ];
  const out = formatStatus(summaries, { latestDate: '2026-04-17' });
  assert.match(out, /20D: -7\.2%/);
  assert.match(out, /60D: -12\.8%/);
  assert.doesNotMatch(out, /\+-/);
});

test('formatStatus: shows positive % when price rose over the window', () => {
  const summaries = [
    {
      fundId: '03',
      displayName: '高成長',
      latest: { date: '2026-04-17', value: 120 },
      returns: [{ label: '20D', ret: 20.0, from: { date: '2026-03-20', value: 100 } }],
      td9: { buy: 0, sell: 0 },
    },
  ];
  const out = formatStatus(summaries, { latestDate: '2026-04-17' });
  assert.match(out, /20D: \+20\.0%/);
});

test('formatStatus: includes NAV line with value and date', () => {
  const summaries = [
    {
      fundId: '03',
      displayName: '高成長',
      latest: { date: '2026-04-17', value: 352.74 },
      returns: [{ label: '20D', ret: 5, from: { date: '2026-03-20', value: 336 } }],
      td9: { buy: 0, sell: 0 },
    },
  ];
  const out = formatStatus(summaries, { latestDate: '2026-04-17' });
  assert.match(out, /NAV: 352\.74 \(2026\/04\/17\)/);
});

test('formatStatus: TD9 line shows buy/sell progress when count ≥ 6', () => {
  const base = {
    fundId: '03',
    displayName: 'x',
    latest: { date: '2026-04-17', value: 100 },
    returns: [{ label: '20D', ret: 0, from: { date: '2026-03-20', value: 100 } }],
  };
  assert.match(
    formatStatus([{ ...base, td9: { buy: 7, sell: 0 } }], { latestDate: '2026-04-17' }),
    /TD9: Buy Setup 7\/9/
  );
  assert.match(
    formatStatus([{ ...base, td9: { buy: 0, sell: 8 } }], { latestDate: '2026-04-17' }),
    /TD9: Sell Setup 8\/9/
  );
  assert.match(
    formatStatus([{ ...base, td9: { buy: 3, sell: 0 } }], { latestDate: '2026-04-17' }),
    /TD9: 無/
  );
});

test('formatStatus: fundId with fetch error shows 抓取失敗 instead of NAV', () => {
  const summaries = [
    {
      fundId: '99',
      displayName: '壞基金',
      latest: null,
      returns: [],
      td9: { buy: 0, sell: 0 },
      error: 'HTTP 503',
    },
  ];
  const out = formatStatus(summaries, { latestDate: '2026-04-17' });
  assert.match(out, /⚠️ 抓取失敗/);
});

test('formatStatus: header uses YYYY/MM/DD date format', () => {
  const out = formatStatus([], { latestDate: '2026-04-17' });
  assert.match(out, /📊 2026\/04\/17 狀態/);
});
