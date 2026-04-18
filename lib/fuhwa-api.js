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
