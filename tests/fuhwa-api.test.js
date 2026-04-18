const test = require('node:test');
const assert = require('node:assert/strict');
const { navReferer, parseNavResponse, fetchNav } = require('../lib/fuhwa-api');

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
