# 復華基金 / ETF 警訊系統 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建置一個在工作日 22:00（台灣時間）自動跑的 Netlify Scheduled Function，從 Google Sheet 讀取啟用的復華基金 / ETF，抓當日 NAV 後計算價格警訊與 TD9 訊號，最後透過 LINE 推播。

**Architecture:** 擴充既有的 `etf-notify` repo，不另開專案。純函式（parsers、indicators、formatters）與 I/O（fetch、Blobs、LINE）分離，每個檔案一個責任。狀態存 Netlify Blobs，去抖動用階梯比對 `last_tier`。

**Tech Stack:** Node.js CommonJS、Netlify Scheduled Functions、`@netlify/blobs`、`node-fetch`（既有）、`node:test` + `node:assert/strict` 為測試框架（零依賴）。

**Spec:** `docs/superpowers/specs/2026-04-18-fund-alert-design.md`

**Project root:** `/Users/KunYang/Claude/etf-notify/`

---

## File Structure

```
etf-notify/
├── netlify/functions/
│   ├── fund-alert.js                        [Create] scheduled function handler
│   └── line-webhook.js                      [Modify] 新增 /status 指令
├── netlify/functions/lib/
│   ├── sheet-reader.js                      [Create] CSV → fund config[]
│   ├── fuhwa-api.js                         [Create] fetch NAV w/ UA + Referer + chunking
│   ├── state-store.js                       [Create] Netlify Blobs wrapper
│   ├── alert-engine.js                      [Create] 組合所有 indicator + state → entries
│   ├── message-formatter.js                 [Create] entries → LINE 文字訊息
│   ├── line-push.js                         [Create] LINE Messaging API push
│   └── indicators/
│       ├── drawdown.js                      [Create] 窗口高/低 + 階梯 + 反彈
│       └── td9.js                           [Create] TD9 Sequential
├── tests/
│   ├── sheet-reader.test.js
│   ├── fuhwa-api.test.js
│   ├── state-store.test.js
│   ├── alert-engine.test.js
│   ├── message-formatter.test.js
│   └── indicators/
│       ├── drawdown.test.js
│       └── td9.test.js
├── netlify.toml                             [Modify] 加 schedule 設定
└── package.json                             [Modify] 加 @netlify/blobs + test script
```

Each file has one responsibility. Tests live at the project root under `tests/` mirroring the source tree.

---

## Task 0: Scaffolding — test infrastructure + deps

**Files:**
- Modify: `/Users/KunYang/Claude/etf-notify/package.json`
- Create: `/Users/KunYang/Claude/etf-notify/tests/smoke.test.js`

- [ ] **Step 1: Update package.json**

Edit `package.json` — add the test script and `@netlify/blobs` dep:

```json
{
  "name": "etf-notify",
  "version": "1.0.0",
  "description": "ETF subscription/redemption notifier via LINE Bot",
  "private": true,
  "dependencies": {
    "@netlify/blobs": "^8.1.0",
    "node-fetch": "^2.7.0"
  },
  "main": "index.js",
  "scripts": {
    "test": "node --test tests/**/*.test.js"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "commonjs",
  "devDependencies": {
    "xlsx": "^0.18.5"
  }
}
```

- [ ] **Step 2: Install deps**

Run: `cd /Users/KunYang/Claude/etf-notify && npm install`
Expected: `@netlify/blobs` installed, no errors.

- [ ] **Step 3: Write smoke test**

Create `tests/smoke.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');

test('smoke test: node:test works', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 4: Run smoke test**

Run: `cd /Users/KunYang/Claude/etf-notify && npm test`
Expected: one test passes (`smoke test: node:test works`).

- [ ] **Step 5: Commit**

```bash
cd /Users/KunYang/Claude/etf-notify
git add package.json package-lock.json tests/smoke.test.js
git commit -m "chore(fund-alert): scaffold test runner + @netlify/blobs dep"
```

---

## Task 1: Sheet reader — CSV parser + defaults

**Files:**
- Create: `netlify/functions/lib/sheet-reader.js`
- Create: `tests/sheet-reader.test.js`

### What it does

Fetches the CSV URL from `process.env.FUND_ALERT_SHEET_CSV_URL`, parses rows into fund configs with defaults:

```
FundConfig = {
  fundId: string,
  displayName: string,
  enabled: boolean,          // blank or non-"TRUE" → false
  dailyThreshold: number,    // blank → 3
  drawdownTiers: number[],   // blank → [5,10,20,30], sorted asc
  reboundThreshold: number,  // blank → 10
  clients: string[],         // blank → [], comma-separated
}
```

- [ ] **Step 1: Write failing tests**

Create `tests/sheet-reader.test.js`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/KunYang/Claude/etf-notify && npm test -- tests/sheet-reader.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parseSheetCsv` + `fetchSheet`**

Create `netlify/functions/lib/sheet-reader.js`:

```javascript
const fetch = require('node-fetch');

const DEFAULTS = {
  dailyThreshold: 3,
  drawdownTiers: [5, 10, 20, 30],
  reboundThreshold: 10,
};

function parseCsvLine(line) {
  const cells = [];
  let inQuotes = false;
  let curr = '';
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) {
      cells.push(curr);
      curr = '';
    } else {
      curr += ch;
    }
  }
  cells.push(curr);
  return cells.map((s) => s.trim());
}

function parseSheetCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const raw = {};
    header.forEach((col, i) => {
      raw[col] = cells[i] ?? '';
    });
    const drawdownTiersStr = (raw.drawdown_tiers || '').trim();
    const drawdownTiers = drawdownTiersStr
      ? drawdownTiersStr
          .split(',')
          .map((n) => parseFloat(n.trim()))
          .filter((n) => !isNaN(n))
          .sort((a, b) => a - b)
      : DEFAULTS.drawdownTiers.slice();
    const clientsStr = (raw.clients || '').trim();
    const clients = clientsStr
      ? clientsStr
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
    return {
      fundId: (raw.fund_id || '').trim(),
      displayName: (raw.display_name || '').trim(),
      enabled: (raw.enabled || '').trim() === 'TRUE',
      dailyThreshold: parseFloat(raw.daily_threshold) || DEFAULTS.dailyThreshold,
      drawdownTiers,
      reboundThreshold: parseFloat(raw.rebound_threshold) || DEFAULTS.reboundThreshold,
      clients,
    };
  });
}

async function fetchSheet(url = process.env.FUND_ALERT_SHEET_CSV_URL) {
  if (!url) throw new Error('FUND_ALERT_SHEET_CSV_URL not set');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheet HTTP ${res.status}`);
  const text = await res.text();
  return parseSheetCsv(text);
}

module.exports = { parseSheetCsv, fetchSheet };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/sheet-reader.test.js`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/sheet-reader.js tests/sheet-reader.test.js
git commit -m "feat(fund-alert): sheet-reader module with CSV parser + defaults"
```

---

## Task 2: Fuhwa API client — NAV fetcher w/ chunking + anti-bot headers

**Files:**
- Create: `netlify/functions/lib/fuhwa-api.js`
- Create: `tests/fuhwa-api.test.js`

### What it does

Fetches up to 2 years of NAV history from `/api/fundNav`, chunked by 1-year windows because the API truncates multi-year requests. Uses correct User-Agent and per-fund Referer (`ETF23` → `/ETF/etf_detail/ETF23`, `03` → `/funds/funds_detail/03`). Dedups by date. Returns `[{ date: 'YYYY-MM-DD', value: number }]` sorted ascending.

- [ ] **Step 1: Write failing tests**

Create `tests/fuhwa-api.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { navReferer, parseNavResponse, fetchNav } = require('../netlify/functions/lib/fuhwa-api');

test('navReferer: fund ID uses funds_detail path', () => {
  assert.equal(navReferer('03'), 'https://www.fhtrust.com.tw/funds/funds_detail/03');
});

test('navReferer: ETF ID uses etf_detail path', () => {
  assert.equal(navReferer('ETF23'), 'https://www.fhtrust.com.tw/ETF/etf_detail/ETF23');
});

test('parseNavResponse: extracts date and value, skips invalid entries', () => {
  const data = {
    result: [
      { navDate: '2026/04/17', pnav: '14.64' },
      { navDate: '2026/04/16', pnav: '14.50' },
      { navDate: '2026/04/15', pnav: null },
      { navDate: '2026/04/14', pnav: '0' },
      { navDate: '2026/04/13', pnav: 'bad' },
    ],
  };
  const points = parseNavResponse(data);
  assert.deepEqual(points, [
    { date: '2026-04-16', value: 14.5 },
    { date: '2026-04-17', value: 14.64 },
  ]);
});

test('fetchNav: dedups across chunks and sorts ascending', async (t) => {
  // Fake two chunk responses with overlapping dates.
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            result: [
              { navDate: '2026/04/17', pnav: '14.64' },
              { navDate: '2026/04/16', pnav: '14.50' },
            ],
          });
        },
      };
    }
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          result: [
            { navDate: '2026/04/16', pnav: '14.50' }, // dup
            { navDate: '2025/04/20', pnav: '13.00' },
          ],
        });
      },
    };
  };
  const points = await fetchNav('ETF23', { fetchImpl: fakeFetch });
  assert.equal(points.length, 3);
  assert.deepEqual(
    points.map((p) => p.date),
    ['2025-04-20', '2026-04-16', '2026-04-17']
  );
  // Verify correct headers were sent
  assert.equal(
    calls[0].opts.headers.Referer,
    'https://www.fhtrust.com.tw/ETF/etf_detail/ETF23'
  );
  assert.match(calls[0].opts.headers['User-Agent'], /Mozilla/);
});

test('fetchNav: throws on non-OK response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => fetchNav('03', { fetchImpl: fakeFetch }), /503/);
});

test('fetchNav: throws on empty response body', async () => {
  const fakeFetch = async () => ({ ok: true, async text() { return ''; } });
  await assert.rejects(() => fetchNav('03', { fetchImpl: fakeFetch }), /empty/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/fuhwa-api.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `fuhwa-api.js`**

Create `netlify/functions/lib/fuhwa-api.js`:

```javascript
const realFetch = require('node-fetch');

const BASE = 'https://www.fhtrust.com.tw';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function navReferer(fundId) {
  if (fundId.startsWith('ETF')) return `${BASE}/ETF/etf_detail/${fundId}`;
  return `${BASE}/funds/funds_detail/${fundId}`;
}

function navHeaders(fundId) {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    Referer: navReferer(fundId),
  };
}

function fmtApiDate(d) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function parseNavResponse(data) {
  const out = [];
  for (const r of data.result || []) {
    if (!r.pnav) continue;
    const v = parseFloat(r.pnav);
    if (isNaN(v) || v <= 0) continue;
    if (!r.navDate) continue;
    out.push({ date: r.navDate.replace(/\//g, '-'), value: v });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

async function fetchNav(fundId, opts = {}) {
  const fetchImpl = opts.fetchImpl || realFetch;
  const delayMs = opts.delayMs ?? 500;
  const chunkYears = opts.chunks ?? 2;
  const today = opts.today || new Date();

  const seen = new Set();
  const all = [];
  for (let i = 0; i < chunkYears; i++) {
    const end = new Date(today);
    end.setFullYear(today.getFullYear() - i);
    const start = new Date(end);
    start.setFullYear(end.getFullYear() - 1);
    const url = `${BASE}/api/fundNav?fundID=${fundId}&sDate=${fmtApiDate(start)}&eDate=${fmtApiDate(
      end
    )}`;
    const res = await fetchImpl(url, { headers: navHeaders(fundId) });
    if (!res.ok) throw new Error(`Fuhwa API HTTP ${res.status} for ${fundId}`);
    const text = await res.text();
    if (!text || text.trim().length === 0) throw new Error(`Fuhwa API empty body for ${fundId}`);
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Fuhwa API bad JSON for ${fundId} (len=${text.length})`);
    }
    for (const p of parseNavResponse(data)) {
      if (seen.has(p.date)) continue;
      seen.add(p.date);
      all.push(p);
    }
    if (i < chunkYears - 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  all.sort((a, b) => a.date.localeCompare(b.date));
  return all;
}

module.exports = { navReferer, navHeaders, parseNavResponse, fetchNav };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/fuhwa-api.test.js`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/fuhwa-api.js tests/fuhwa-api.test.js
git commit -m "feat(fund-alert): fuhwa-api NAV client with chunking + anti-bot headers"
```

---

## Task 3: Drawdown indicator — window extremes + tier picker + rebound

**Files:**
- Create: `netlify/functions/lib/indicators/drawdown.js`
- Create: `tests/indicators/drawdown.test.js`

### What it does

Pure functions operating on NAV array.

- `windowExtreme(navs, days, 'high'|'low')` → `{ date, value }` — the extreme point within the last `days` points (or all if array shorter).
- `pickTier(pct, tiers)` → integer — the largest tier ≤ pct (0 if none).
- `computeDrawdowns(navs, windows)` → `[{ label, days, dd, high }]` for each window that has enough data.
- `computeRebound(navs, days)` → `{ rb, low }`.
- `detectDrawdownAlert(currentTier, currentDdPct, lastTier)` → `{ fire: bool, newTier, reset: bool }`.

- [ ] **Step 1: Write failing tests**

Create `tests/indicators/drawdown.test.js`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/indicators/drawdown.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement drawdown indicator**

Create `netlify/functions/lib/indicators/drawdown.js`:

```javascript
const RESET_THRESHOLD_PCT = 2;

function windowExtreme(navs, days, type) {
  const n = Math.min(days, navs.length);
  const slice = navs.slice(-n);
  let best = slice[0];
  for (const p of slice) {
    if (type === 'high' ? p.value > best.value : p.value < best.value) best = p;
  }
  return best;
}

function pickTier(pct, tiers) {
  let picked = 0;
  for (const t of tiers) if (pct >= t) picked = t;
  return picked;
}

function computeDrawdowns(navs, windows) {
  if (navs.length === 0) return [];
  const today = navs[navs.length - 1];
  const out = [];
  for (const w of windows) {
    if (navs.length < 2) continue;
    const high = windowExtreme(navs, w.days, 'high');
    const dd = ((high.value - today.value) / high.value) * 100;
    out.push({ label: w.label, days: w.days, dd, high });
  }
  return out;
}

function computeRebound(navs, days) {
  if (navs.length < 2) return null;
  const today = navs[navs.length - 1];
  const low = windowExtreme(navs, days, 'low');
  const rb = ((today.value - low.value) / low.value) * 100;
  return { rb, low };
}

function detectDrawdownAlert(currentTier, currentDdPct, lastTier) {
  if (currentDdPct < RESET_THRESHOLD_PCT) {
    return { fire: false, newTier: 0, reset: true };
  }
  if (currentTier > lastTier) {
    return { fire: true, newTier: currentTier, reset: false };
  }
  return { fire: false, newTier: lastTier, reset: false };
}

function detectReboundAlert(currentPct, threshold, lastTier) {
  if (currentPct < RESET_THRESHOLD_PCT) {
    return { fire: false, newTier: 0, reset: true };
  }
  if (currentPct >= threshold && lastTier === 0) {
    return { fire: true, newTier: threshold, reset: false };
  }
  return { fire: false, newTier: lastTier, reset: false };
}

module.exports = {
  windowExtreme,
  pickTier,
  computeDrawdowns,
  computeRebound,
  detectDrawdownAlert,
  detectReboundAlert,
  RESET_THRESHOLD_PCT,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/indicators/drawdown.test.js`
Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/indicators/drawdown.js tests/indicators/drawdown.test.js
git commit -m "feat(fund-alert): drawdown + rebound indicators with tier-debounce logic"
```

---

## Task 4: TD9 indicator — Sequential setup counter

**Files:**
- Create: `netlify/functions/lib/indicators/td9.js`
- Create: `tests/indicators/td9.test.js`

### What it does

Pure function. Given sorted NAV array, returns final state of the TD9 setup counters + event log:

```
{
  buy: number,               // 0–9
  sell: number,              // 0–9
  buyCompleteDate: string|null,  // YYYY-MM-DD when count hit 9
  sellCompleteDate: string|null,
  events: [{ date, type, prev? }]  // buy_complete, sell_complete, buy_reset (from≥6), sell_reset
}
```

Rules (see spec §5.4):
- `today_close < close_4_days_ago` → sell counter resets (emit reset if was ≥6), buy counter +1 unless already 9. If buy hits 9 → emit complete + record date.
- Symmetric for `>`.
- Equal closes suspend (no change).
- Reset events only emitted when pre-reset count ≥ 6.

- [ ] **Step 1: Write failing tests**

Create `tests/indicators/td9.test.js`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/indicators/td9.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement TD9**

Create `netlify/functions/lib/indicators/td9.js`:

```javascript
function computeTd9(navs) {
  let buy = 0;
  let sell = 0;
  let buyCompleteDate = null;
  let sellCompleteDate = null;
  const events = [];
  for (let i = 4; i < navs.length; i++) {
    const today = navs[i].value;
    const prev = navs[i - 4].value;
    if (today < prev) {
      if (sell >= 6) events.push({ date: navs[i].date, type: 'sell_reset', prev: sell });
      sell = 0;
      sellCompleteDate = null;
      if (buy < 9) {
        buy += 1;
        if (buy === 9) {
          buyCompleteDate = navs[i].date;
          events.push({ date: navs[i].date, type: 'buy_complete' });
        }
      }
    } else if (today > prev) {
      if (buy >= 6) events.push({ date: navs[i].date, type: 'buy_reset', prev: buy });
      buy = 0;
      buyCompleteDate = null;
      if (sell < 9) {
        sell += 1;
        if (sell === 9) {
          sellCompleteDate = navs[i].date;
          events.push({ date: navs[i].date, type: 'sell_complete' });
        }
      }
    }
    // equal → no change
  }
  return { buy, sell, buyCompleteDate, sellCompleteDate, events };
}

module.exports = { computeTd9 };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/indicators/td9.test.js`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/indicators/td9.js tests/indicators/td9.test.js
git commit -m "feat(fund-alert): TD9 Sequential indicator with completion date + reset events"
```

---

## Task 5: State store — Netlify Blobs wrapper

**Files:**
- Create: `netlify/functions/lib/state-store.js`
- Create: `tests/state-store.test.js`

### What it does

Thin wrapper around `@netlify/blobs` so callers can `getState(fundId)` / `setState(fundId, state)` without knowing the Blob API. Uses store name `fund-alert-state`. The test uses an injected fake store to avoid real Netlify.

State shape (per spec §8):

```javascript
{
  fundId: '03',
  lastCheckedDate: '2026-04-18',
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
}
```

- [ ] **Step 1: Write failing tests**

Create `tests/state-store.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStateStore, emptyState } = require('../netlify/functions/lib/state-store');

function fakeBlobStore() {
  const blobs = new Map();
  return {
    async get(key, opts) {
      const v = blobs.get(key);
      if (v === undefined) return null;
      return opts && opts.type === 'json' ? v : JSON.stringify(v);
    },
    async set(key, value) {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      blobs.set(key, parsed);
    },
  };
}

test('emptyState returns default structure for a fundId', () => {
  const s = emptyState('03');
  assert.equal(s.fundId, '03');
  assert.equal(s.drawdown['20D'].lastTier, 0);
  assert.equal(s.td9.buyCompleteDate, null);
});

test('getState returns emptyState when blob missing', async () => {
  const store = createStateStore({ blobStore: fakeBlobStore() });
  const state = await store.getState('03');
  assert.equal(state.fundId, '03');
  assert.equal(state.drawdown['60D'].lastTier, 0);
});

test('setState then getState round-trips', async () => {
  const store = createStateStore({ blobStore: fakeBlobStore() });
  const mutated = emptyState('03');
  mutated.drawdown['20D'].lastTier = 10;
  mutated.td9.buyCompleteDate = '2026-04-15';
  await store.setState('03', mutated);
  const read = await store.getState('03');
  assert.equal(read.drawdown['20D'].lastTier, 10);
  assert.equal(read.td9.buyCompleteDate, '2026-04-15');
});

test('states for different funds do not collide', async () => {
  const store = createStateStore({ blobStore: fakeBlobStore() });
  const a = emptyState('03');
  a.drawdown['20D'].lastTier = 5;
  const b = emptyState('77');
  b.drawdown['20D'].lastTier = 20;
  await store.setState('03', a);
  await store.setState('77', b);
  const ra = await store.getState('03');
  const rb = await store.getState('77');
  assert.equal(ra.drawdown['20D'].lastTier, 5);
  assert.equal(rb.drawdown['20D'].lastTier, 20);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/state-store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement state store**

Create `netlify/functions/lib/state-store.js`:

```javascript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/state-store.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/state-store.js tests/state-store.test.js
git commit -m "feat(fund-alert): state-store wrapper around Netlify Blobs"
```

---

## Task 6: Alert engine — orchestrator combining indicators + state

**Files:**
- Create: `netlify/functions/lib/alert-engine.js`
- Create: `tests/alert-engine.test.js`

### What it does

Takes a single fund (config + NAV series + previous state) and returns:
1. `entry` — null if no alert worth sending, else a structured object of what fired
2. `nextState` — the updated state to persist

This is the file that encodes the business logic of "what counts as new / worth alerting".

Entry shape (consumed by message-formatter):

```javascript
{
  fundId, displayName, today: { date, value },
  drawdowns: [ { label, dd, tier, high, isNew } ],  // only triggered ones
  drawdownsUntriggered: [ { label, dd, high } ],    // for context, only when at least one triggered
  rebound: { rb, low, threshold, isNew } | null,
  td9: {
    completeSide: 'buy'|'sell'|null,  // filled only when count===9
    completeDate: 'YYYY-MM-DD'|null,
    isNewComplete: bool,
    progressSide: 'buy'|'sell'|null,  // filled only when 6≤count<9
    progressCount: number|null,
    resetEvent: { side, prev } | null,  // fired today only
  },
  daily: { pct, threshold } | null,  // filled only when |pct| ≥ threshold
}
```

- [ ] **Step 1: Write failing tests**

Create `tests/alert-engine.test.js`:

```javascript
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
  const navs = [
    { date: '2026-04-01', value: 100 },
    { date: '2026-04-02', value: 94 },
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

test('TD9 complete already notified → isNewComplete=false (延續中)', () => {
  const closes = Array.from({ length: 13 }, (_, i) => 100 - i);
  const navs = navSeries(closes);
  const state = emptyState('03');
  state.td9.buyCompleteDate = '2026-04-13';
  state.td9.lastNotifiedEventDate = '2026-04-13';
  state.drawdown['20D'].lastTier = 30; // also triggered so we get an entry
  const { entry } = evaluateFund(cfg, navs, state);
  // With all drawdowns already notified at tier 30, there's nothing new
  // unless entry is triggered by something else. Let's verify the isNewComplete bit:
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/alert-engine.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement alert engine**

Create `netlify/functions/lib/alert-engine.js`:

```javascript
const {
  windowExtreme,
  pickTier,
  computeDrawdowns,
  computeRebound,
  detectDrawdownAlert,
  detectReboundAlert,
  RESET_THRESHOLD_PCT,
} = require('./indicators/drawdown');
const { computeTd9 } = require('./indicators/td9');

const WINDOWS = [
  { label: '20D', days: 20 },
  { label: '60D', days: 60 },
  { label: '252D', days: 252 },
];

function evaluateFund(cfg, navs, state) {
  if (!navs || navs.length < 2) {
    return { entry: null, nextState: state };
  }

  const today = navs[navs.length - 1];
  const yesterday = navs[navs.length - 2];
  const dailyPct = ((today.value - yesterday.value) / yesterday.value) * 100;

  const drawdowns = computeDrawdowns(navs, WINDOWS);
  const nextState = JSON.parse(JSON.stringify(state));
  nextState.lastCheckedDate = today.date;

  const ddTriggered = [];
  const ddUntriggered = [];
  for (const d of drawdowns) {
    const currentTier = d.dd > 0 ? pickTier(d.dd, cfg.drawdownTiers) : 0;
    const ws = nextState.drawdown[d.label] || (nextState.drawdown[d.label] = { lastTier: 0, lastAlertDate: null });
    const alert = detectDrawdownAlert(currentTier, d.dd, ws.lastTier);
    if (alert.reset) ws.lastTier = 0;
    if (alert.fire) {
      ws.lastTier = alert.newTier;
      ws.lastAlertDate = today.date;
      ddTriggered.push({ label: d.label, dd: d.dd, tier: alert.newTier, high: d.high, isNew: true });
    } else if (currentTier > 0) {
      // untriggered-but-positive for context display
      ddUntriggered.push({ label: d.label, dd: d.dd, high: d.high });
    }
  }

  let reboundEntry = null;
  const rb = computeRebound(navs, 20);
  if (rb) {
    const rs = nextState.rebound['20D'] || (nextState.rebound['20D'] = { lastTier: 0, lastAlertDate: null });
    const alert = detectReboundAlert(rb.rb, cfg.reboundThreshold, rs.lastTier);
    if (alert.reset) rs.lastTier = 0;
    if (alert.fire) {
      rs.lastTier = alert.newTier;
      rs.lastAlertDate = today.date;
      reboundEntry = {
        rb: rb.rb,
        low: rb.low,
        threshold: cfg.reboundThreshold,
        isNew: true,
      };
    }
  }

  const td9 = computeTd9(navs);
  nextState.td9.buyCompleteDate = td9.buyCompleteDate;
  nextState.td9.sellCompleteDate = td9.sellCompleteDate;

  const td9Entry = {
    completeSide: null,
    completeDate: null,
    isNewComplete: false,
    progressSide: null,
    progressCount: null,
    resetEvent: null,
  };

  const todaysEvents = td9.events.filter((e) => e.date === today.date);
  const todayReset = todaysEvents.find((e) => e.type === 'buy_reset' || e.type === 'sell_reset');
  if (todayReset) {
    td9Entry.resetEvent = {
      side: todayReset.type === 'buy_reset' ? 'buy' : 'sell',
      prev: todayReset.prev,
    };
    nextState.td9.lastNotifiedEventDate = today.date;
  }

  if (td9.buy === 9 && td9.buyCompleteDate) {
    td9Entry.completeSide = 'buy';
    td9Entry.completeDate = td9.buyCompleteDate;
    const alreadyNotified = state.td9.lastNotifiedEventDate === td9.buyCompleteDate;
    td9Entry.isNewComplete = !alreadyNotified;
    if (!alreadyNotified && td9.buyCompleteDate === today.date) {
      nextState.td9.lastNotifiedEventDate = today.date;
    }
  } else if (td9.sell === 9 && td9.sellCompleteDate) {
    td9Entry.completeSide = 'sell';
    td9Entry.completeDate = td9.sellCompleteDate;
    const alreadyNotified = state.td9.lastNotifiedEventDate === td9.sellCompleteDate;
    td9Entry.isNewComplete = !alreadyNotified;
    if (!alreadyNotified && td9.sellCompleteDate === today.date) {
      nextState.td9.lastNotifiedEventDate = today.date;
    }
  } else if (td9.buy >= 6) {
    td9Entry.progressSide = 'buy';
    td9Entry.progressCount = td9.buy;
  } else if (td9.sell >= 6) {
    td9Entry.progressSide = 'sell';
    td9Entry.progressCount = td9.sell;
  }

  const daily =
    Math.abs(dailyPct) >= cfg.dailyThreshold
      ? { pct: dailyPct, threshold: cfg.dailyThreshold }
      : null;

  const hasAny =
    ddTriggered.length > 0 ||
    reboundEntry !== null ||
    td9Entry.resetEvent !== null ||
    td9Entry.isNewComplete ||
    td9Entry.progressSide !== null ||
    daily !== null;

  if (!hasAny) {
    return { entry: null, nextState };
  }

  const entry = {
    fundId: cfg.fundId,
    displayName: cfg.displayName,
    today,
    drawdowns: ddTriggered,
    drawdownsUntriggered: ddTriggered.length > 0 ? ddUntriggered : [],
    rebound: reboundEntry,
    td9: td9Entry,
    daily,
  };

  return { entry, nextState };
}

module.exports = { evaluateFund, WINDOWS };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/alert-engine.test.js`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/alert-engine.js tests/alert-engine.test.js
git commit -m "feat(fund-alert): alert-engine composing indicators + state de-dupe"
```

---

## Task 7: Message formatter — entries → LINE text

**Files:**
- Create: `netlify/functions/lib/message-formatter.js`
- Create: `tests/message-formatter.test.js`

### What it does

Pure function taking `entries[]` (from alert-engine) + metadata, returns the final LINE message string matching spec §6 exactly. Also exports `formatStatus(summaries)` for the `/status` LINE command (Task 10).

- [ ] **Step 1: Write failing tests**

Create `tests/message-formatter.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatMessage,
  fmtDisplayDate,
} = require('../netlify/functions/lib/message-formatter');

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/message-formatter.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement message formatter**

Create `netlify/functions/lib/message-formatter.js`:

```javascript
function fmtDisplayDate(iso) {
  if (!iso) return '';
  return iso.replace(/-/g, '/');
}

function formatSign(n) {
  return n >= 0 ? `+${n.toFixed(1)}%` : `${n.toFixed(1)}%`;
}

function formatEntry(f) {
  const lines = ['━━━━━━━━━━', `${f.displayName}（${f.fundId}）`];
  lines.push(`NAV: ${f.today.value} (${fmtDisplayDate(f.today.date)})`);

  if (f.drawdowns.length > 0) {
    lines.push('⚠️ 跌幅');
    for (const d of f.drawdowns) {
      const tag = d.isNew ? ' ← NEW' : '';
      lines.push(
        `• ${d.label}: -${d.dd.toFixed(1)}% [觸發 ${d.tier}%]（高點 ${fmtDisplayDate(d.high.date)}）${tag}`.trimEnd()
      );
    }
    for (const d of f.drawdownsUntriggered) {
      lines.push(
        `• ${d.label}: -${d.dd.toFixed(1)}%（高點 ${fmtDisplayDate(d.high.date)}，未觸發）`
      );
    }
  }

  if (f.rebound) {
    const tag = f.rebound.isNew ? ' ← NEW' : '';
    lines.push('📈 反彈');
    lines.push(
      `• 20D: +${f.rebound.rb.toFixed(1)}% [觸發 ${f.rebound.threshold}%]（低點 ${fmtDisplayDate(
        f.rebound.low.date
      )}）${tag}`.trimEnd()
    );
  }

  const t = f.td9;
  if (t.resetEvent) {
    const label = t.resetEvent.side === 'buy' ? 'Buy' : 'Sell';
    const emoji = t.resetEvent.side === 'buy' ? '📉' : '📈';
    lines.push(`${emoji} TD9: ${label} Setup 在第 ${t.resetEvent.prev} 天被反轉重置`);
  }
  if (t.completeSide) {
    const label = t.completeSide === 'buy' ? 'Buy' : 'Sell';
    const emoji = t.completeSide === 'buy' ? '📈' : '📉';
    const suffix = t.isNewComplete ? ' ← NEW' : '（延續中）';
    lines.push(`${emoji} TD9: ${label} Setup 9 完成於 ${fmtDisplayDate(t.completeDate)}${suffix}`);
  } else if (t.progressSide) {
    const label = t.progressSide === 'buy' ? 'Buy' : 'Sell';
    const emoji = t.progressSide === 'buy' ? '📈' : '📉';
    lines.push(`${emoji} TD9: ${label} Setup ${t.progressCount}/9 進行中`);
  }

  if (f.daily) {
    lines.push(`💬 單日: ${formatSign(f.daily.pct)}`);
  }

  return lines.join('\n');
}

function formatMessage(entries, meta) {
  const header = `📊 ${fmtDisplayDate(meta.latestDate)} 警訊摘要（${meta.monitoredCount} 檔監控中，${entries.length} 檔觸發）`;
  if (entries.length === 0) {
    return header;
  }
  return [header, '', ...entries.map(formatEntry)].join('\n\n');
}

function formatStatus(summaries, meta) {
  const header = `📊 ${fmtDisplayDate(meta.latestDate)} 狀態`;
  const blocks = summaries.map((s) => {
    const ddLine = s.drawdowns
      .map((d) => `${d.label}: ${d.dd >= 0 ? '+' : ''}${(-d.dd).toFixed(1)}%`)
      .join(' | ');
    const td9Line =
      s.td9.buy >= 6
        ? `TD9: Buy Setup ${s.td9.buy}/9`
        : s.td9.sell >= 6
        ? `TD9: Sell Setup ${s.td9.sell}/9`
        : 'TD9: 無';
    return [`${s.displayName}（${s.fundId}）`, `  ${ddLine}`, `  ${td9Line}`].join('\n');
  });
  return [header, '', ...blocks].join('\n\n');
}

module.exports = { formatMessage, formatStatus, formatEntry, fmtDisplayDate };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/message-formatter.test.js`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/lib/message-formatter.js tests/message-formatter.test.js
git commit -m "feat(fund-alert): message-formatter producing LINE text per spec"
```

---

## Task 8: LINE push — Messaging API wrapper

**Files:**
- Create: `netlify/functions/lib/line-push.js`

No test file — it's a 20-line wrapper over fetch; we don't unit-test HTTP envelope construction. Integration coverage comes from Task 9.

- [ ] **Step 1: Implement**

Create `netlify/functions/lib/line-push.js`:

```javascript
const fetch = require('node-fetch');

const PUSH_URL = 'https://api.line.me/v2/bot/message/push';

async function pushText(text, opts = {}) {
  const token = opts.token || process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const userId = opts.userId || process.env.LINE_USER_ID;
  const fetchImpl = opts.fetchImpl || fetch;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN missing');
  if (!userId) throw new Error('LINE_USER_ID missing');
  const res = await fetchImpl(PUSH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LINE push ${res.status}: ${body}`);
  }
}

module.exports = { pushText };
```

- [ ] **Step 2: Commit**

```bash
git add netlify/functions/lib/line-push.js
git commit -m "feat(fund-alert): LINE push wrapper"
```

---

## Task 9: Scheduled handler — fund-alert.js

**Files:**
- Create: `netlify/functions/fund-alert.js`

Orchestrates the whole flow: read sheet → for each enabled fund fetch NAV → evaluate → update state → push merged message. Implements the error-handling rules from spec §7.

- [ ] **Step 1: Implement**

Create `netlify/functions/fund-alert.js`:

```javascript
const { schedule } = require('@netlify/functions');
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
      // Stale-check: warn if the freshest NAV is ≥ 2 business days old.
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

  // If nothing to show but we have warnings only — still push warnings.
  if (entries.length === 0) {
    // formatMessage already produced a "0 檔觸發" header; append warnings.
  }

  try {
    await pushText(message);
  } catch (e) {
    console.error('LINE push failed:', e);
    return { statusCode: 500, body: 'line-push-failed' };
  }

  return { statusCode: 200, body: 'ok' };
}

// Schedule: Mon–Fri 22:00 Asia/Taipei = 14:00 UTC
exports.handler = schedule('0 14 * * 1-5', async () => run());
exports.run = run; // exported for manual invocation / tests
```

- [ ] **Step 2: Smoke-test handler loads without errors**

Run:
```bash
cd /Users/KunYang/Claude/etf-notify
node -e "require('./netlify/functions/fund-alert.js'); console.log('ok');"
```
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/fund-alert.js
git commit -m "feat(fund-alert): scheduled handler orchestrating full alert flow"
```

---

## Task 10: Wire the schedule in netlify.toml + add /status to LINE webhook

**Files:**
- Modify: `netlify.toml`
- Modify: `netlify/functions/line-webhook.js`

- [ ] **Step 1: Update netlify.toml**

Current `netlify.toml`:
```toml
[build]
  publish = "public"

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"
```

Edit so the file becomes exactly:
```toml
[build]
  publish = "public"

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"

[functions.fund-alert]
  schedule = "0 14 * * 1-5"
```

Note: the function-level `schedule` directive is the canonical way to declare a Netlify scheduled function. The `schedule()` wrapper inside the handler is defensive but optional.

- [ ] **Step 2: Add /status handler to line-webhook.js**

Open `netlify/functions/line-webhook.js`. Find the switch/case (or whatever handles incoming text messages). Add a new branch that handles text equal to `/status`:

```javascript
// Near the top, alongside other requires:
const { fetchSheet } = require('./lib/sheet-reader');
const { fetchNav } = require('./lib/fuhwa-api');
const { computeDrawdowns } = require('./lib/indicators/drawdown');
const { computeTd9 } = require('./lib/indicators/td9');
const { formatStatus } = require('./lib/message-formatter');
const { WINDOWS } = require('./lib/alert-engine');
```

```javascript
// In the text-message dispatcher, add:
async function handleStatusCommand() {
  const funds = await fetchSheet();
  const enabled = funds.filter((f) => f.enabled);
  const summaries = [];
  let latestDate = null;
  for (const cfg of enabled) {
    try {
      const navs = await fetchNav(cfg.fundId);
      if (navs.length === 0) continue;
      const latest = navs[navs.length - 1];
      if (!latestDate || latest.date > latestDate) latestDate = latest.date;
      const drawdowns = computeDrawdowns(navs, WINDOWS);
      const td9 = computeTd9(navs);
      summaries.push({
        fundId: cfg.fundId,
        displayName: cfg.displayName,
        drawdowns,
        td9,
      });
    } catch (e) {
      summaries.push({
        fundId: cfg.fundId,
        displayName: cfg.displayName,
        drawdowns: [],
        td9: { buy: 0, sell: 0 },
        error: e.message,
      });
    }
  }
  return formatStatus(summaries, { latestDate: latestDate || new Date().toISOString().slice(0, 10) });
}
```

Then wire it to the message dispatcher where LINE events arrive:

```javascript
if (event.type === 'message' && event.message.type === 'text') {
  const text = event.message.text.trim();
  if (text === '/status') {
    const reply = await handleStatusCommand();
    // use existing reply mechanism in this file to respond with `reply`
    // (keep the pattern matching other commands in the file)
  }
  // ...existing command handling
}
```

**Note for executor:** read the existing `line-webhook.js` before editing to match its exact pattern for handling replies and its command-dispatch style. Don't assume a specific shape; splice into the existing structure.

- [ ] **Step 3: Smoke-test webhook loads**

Run:
```bash
node -e "require('./netlify/functions/line-webhook.js'); console.log('ok');"
```
Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add netlify.toml netlify/functions/line-webhook.js
git commit -m "feat(fund-alert): schedule cron 0 14 * * 1-5 + /status LINE command"
```

---

## Task 11: Deploy + live verification

**Files:** none (deploy step)

- [ ] **Step 1: Set Netlify env var for the sheet URL**

Run:
```bash
netlify env:set FUND_ALERT_SHEET_CSV_URL "https://docs.google.com/spreadsheets/d/e/2PACX-1vR8zfB4ZxJ8FI0FJkyXgN-ha1aHU9NbqtmtkIdhbI_zW-2MFXhCcGNYfOFWTuK8XmecjaZPcGXs7cnY/pub?output=csv"
```
Expected: `Set environment variable FUND_ALERT_SHEET_CSV_URL`.

- [ ] **Step 2: Deploy to production**

Run:
```bash
git push
```
Netlify auto-deploys on push. Watch the deploy log in Netlify dashboard or via:
```bash
netlify watch
```

- [ ] **Step 3: Manually invoke the scheduled function to verify LINE delivery**

From the Netlify dashboard: Functions → `fund-alert` → **Trigger a test invocation**.

Expected:
- Function returns 200
- LINE message arrives with current warning summary (should look like the preview script output, minus the `[PREVIEW]` tag)
- Netlify Blobs `fund-alert-state` store now has 5 entries (one per enabled fund)

- [ ] **Step 4: Re-invoke immediately to verify de-dupe**

Trigger the function again within a minute.

Expected:
- Function returns 200
- **No LINE message** (because `prev.lastCheckedDate === latest.date` short-circuits per-fund processing, producing an empty entries list)

- [ ] **Step 5: Verify `/status` works by sending it from LINE**

Send `/status` in LINE chat to the bot.

Expected: a compact status summary listing all enabled funds with their window drawdowns and TD9 count.

- [ ] **Step 6: Remove the preview script if desired**

The preview script (`scripts/preview-fund-alert.js`) was committed earlier. Decide:
- **Keep as local debugging tool** — no action
- **Remove** — `git rm scripts/preview-fund-alert.js && git commit -m "chore: remove preview script"`

Either is fine. Recommend keeping it — it's handy for testing locally without touching Netlify state.

---

## Self-Review

**Spec coverage check:**

| Spec section | Task |
|---|---|
| §3.1 Sheet schema + defaults | Task 1 |
| §3.2 Fuhwa API + chunking + headers | Task 2 |
| §4.1–4.3 Architecture, structure, schedule | Tasks 9, 10 |
| §4.4 Data flow | Task 9 |
| §5.1 Drawdown tiers + reset | Tasks 3, 6 |
| §5.2 Rebound (20D only) | Tasks 3, 6 |
| §5.3 Daily change | Task 6 |
| §5.4 TD9 + completion date + 延續中 | Tasks 4, 6, 7 |
| §5.5 Merged message per fund | Tasks 6, 7 |
| §6 Message format (YYYY/MM/DD, NAV line, 分隔線…) | Task 7 |
| §7 Error handling (sheet fail, fund fail, stale NAV, blobs fail, LINE fail) | Task 9 |
| §8 State shape | Task 5 |
| §9 /status command | Task 10 |

All spec sections have a task. ✓

**Placeholder scan:** no "TBD", no "add appropriate error handling", every code step has complete code.

**Type consistency:** `fundId` (not `fund_id`) used consistently in JS; CSV headers stay snake-case. State shape defined once in `state-store.js` and referenced in `alert-engine.js`. `evaluateFund` / `formatMessage` signatures match across producer and consumer tests.

One minor note for the executor: the line-webhook.js edit in Task 10 is necessarily a bit hand-wavy (splice-into-existing-file). The executor should read that file first and match its existing dispatch pattern — the code snippets show *what* to add, not a literal replacement block.
