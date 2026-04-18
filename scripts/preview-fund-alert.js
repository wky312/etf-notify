#!/usr/bin/env node
/**
 * One-off preview script for fund alert message format.
 * Reads the configured Google Sheet, fetches NAV for each enabled fund,
 * applies the alert logic as if starting fresh (no state memory),
 * and pushes a preview message to LINE.
 *
 * Run: node scripts/preview-fund-alert.js
 */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// Load .env manually (no dotenv dependency)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach((line) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = process.env[m[1]] || m[2];
  });
}

const SHEET_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vR8zfB4ZxJ8FI0FJkyXgN-ha1aHU9NbqtmtkIdhbI_zW-2MFXhCcGNYfOFWTuK8XmecjaZPcGXs7cnY/pub?output=csv';
const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const FUHWA_BASE = 'https://www.fhtrust.com.tw';

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

async function readSheet() {
  const res = await fetch(SHEET_URL);
  if (!res.ok) throw new Error(`Sheet ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const row = parseCsvLine(line);
    const obj = {};
    header.forEach((col, i) => {
      obj[col] = row[i] ?? '';
    });
    return obj;
  });
}

function fmtApiDate(d) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function navReferer(fundId) {
  if (fundId.startsWith('ETF')) return `${FUHWA_BASE}/ETF/etf_detail/${fundId}`;
  return `${FUHWA_BASE}/funds/funds_detail/${fundId}`;
}

const NAV_HEADERS = (fundId) => ({
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
  Referer: navReferer(fundId),
});

async function fetchNav(fundId) {
  // API chokes on multi-year ranges; fetch in 1-year chunks.
  const today = new Date();
  const seen = new Set();
  const all = [];
  for (let i = 0; i < 2; i++) {
    const end = new Date(today);
    end.setFullYear(today.getFullYear() - i);
    const start = new Date(end);
    start.setFullYear(end.getFullYear() - 1);
    const url = `${FUHWA_BASE}/api/fundNav?fundID=${fundId}&sDate=${fmtApiDate(
      start
    )}&eDate=${fmtApiDate(end)}`;
    const res = await fetch(url, { headers: NAV_HEADERS(fundId) });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const text = await res.text();
    if (!text || text.trim().length === 0) throw new Error('empty response');
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`json parse (len=${text.length}, head="${text.slice(0, 80)}...")`);
    }
    for (const r of data.result || []) {
      if (!r.pnav || parseFloat(r.pnav) <= 0) continue;
      const date = r.navDate.replace(/\//g, '-');
      if (seen.has(date)) continue;
      seen.add(date);
      all.push({ date, value: parseFloat(r.pnav) });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  all.sort((a, b) => a.date.localeCompare(b.date));
  return all;
}

function pickTier(dd, tiers) {
  let picked = 0;
  for (const t of tiers) if (dd >= t) picked = t;
  return picked;
}

function windowExtreme(navs, days, type) {
  const slice = navs.slice(-days);
  if (type === 'high') return slice.reduce((m, p) => (p.value > m.value ? p : m), slice[0]);
  return slice.reduce((m, p) => (p.value < m.value ? p : m), slice[0]);
}

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
  }
  return { buy, sell, buyCompleteDate, sellCompleteDate, events };
}

function processFund(row, navs) {
  const id = row.fund_id;
  const name = row.display_name;
  const dailyThresh = parseFloat(row.daily_threshold) || 3;
  const tiers = (row.drawdown_tiers || '5,10,20,30')
    .split(',')
    .map((n) => parseFloat(n.trim()))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);
  const reboundThresh = parseFloat(row.rebound_threshold) || 10;

  if (navs.length < 21) return { id, name, error: `NAV 資料不足（僅 ${navs.length} 筆）` };

  const today = navs[navs.length - 1];
  const yesterday = navs[navs.length - 2];
  const dailyPct = ((today.value - yesterday.value) / yesterday.value) * 100;

  const drawdowns = [];
  for (const w of [
    { label: '20D', days: 20 },
    { label: '60D', days: 60 },
    { label: '252D', days: 252 },
  ]) {
    if (navs.length < Math.min(w.days + 1, 21)) continue;
    const high = windowExtreme(navs, w.days, 'high');
    const dd = ((high.value - today.value) / high.value) * 100;
    const tier = dd > 0 ? pickTier(dd, tiers) : 0;
    drawdowns.push({ label: w.label, dd, tier, high });
  }

  let rebound20 = null;
  {
    const low = windowExtreme(navs, 20, 'low');
    const rb = ((today.value - low.value) / low.value) * 100;
    rebound20 = { rb, low };
  }

  const td9 = computeTd9(navs);

  return {
    id,
    name,
    today,
    dailyPct,
    dailyThresh,
    drawdowns,
    rebound20,
    reboundThresh,
    td9,
  };
}

function hasAlert(f) {
  if (f.error) return true;
  if (Math.abs(f.dailyPct) >= f.dailyThresh) return true;
  if (f.drawdowns.some((d) => d.tier > 0)) return true;
  if (f.rebound20 && f.rebound20.rb >= f.reboundThresh) return true;
  if (f.td9.buy >= 6 || f.td9.sell >= 6) return true;
  const latest = f.today.date;
  if (f.td9.events.some((e) => e.date === latest)) return true;
  return false;
}

function fmtDate(iso) {
  return iso.replace(/-/g, '/');
}

function formatEntry(f) {
  const lines = ['━━━━━━━━━━', `${f.name}（${f.id}）`];
  if (f.error) {
    lines.push(`⚠️ ${f.error}`);
    return lines.join('\n');
  }
  lines.push(`NAV: ${f.today.value} (${fmtDate(f.today.date)})`);

  const triggered = f.drawdowns.filter((d) => d.tier > 0);
  if (triggered.length > 0) {
    lines.push('⚠️ 跌幅');
    for (const d of triggered) {
      lines.push(
        `• ${d.label}: -${d.dd.toFixed(1)}% [觸發 ${d.tier}%]（高點 ${fmtDate(d.high.date)}）← NEW`
      );
    }
    const untriggered = f.drawdowns.filter((d) => d.tier === 0 && d.dd > 0);
    for (const d of untriggered) {
      lines.push(`• ${d.label}: -${d.dd.toFixed(1)}%（高點 ${fmtDate(d.high.date)}，未觸發）`);
    }
  }

  if (f.rebound20 && f.rebound20.rb >= f.reboundThresh) {
    lines.push('📈 反彈');
    lines.push(
      `• 20D: +${f.rebound20.rb.toFixed(1)}% [觸發 ${f.reboundThresh}%]（低點 ${fmtDate(f.rebound20.low.date)}）← NEW`
    );
  }

  const latest = f.today.date;
  const td9Today = f.td9.events.filter((e) => e.date === latest);
  const td9TodayTypes = new Set(td9Today.map((e) => e.type));
  for (const e of td9Today) {
    if (e.type === 'buy_reset')
      lines.push(`📉 TD9: Buy Setup 在第 ${e.prev} 天被反轉重置`);
    else if (e.type === 'sell_reset')
      lines.push(`📈 TD9: Sell Setup 在第 ${e.prev} 天被反轉重置`);
  }
  if (f.td9.buy === 9 && f.td9.buyCompleteDate) {
    const suffix = td9TodayTypes.has('buy_complete') ? ' ← NEW' : '（延續中）';
    lines.push(`📈 TD9: Buy Setup 9 完成於 ${fmtDate(f.td9.buyCompleteDate)}${suffix}`);
  } else if (f.td9.buy >= 6) {
    lines.push(`📈 TD9: Buy Setup ${f.td9.buy}/9 進行中`);
  }
  if (f.td9.sell === 9 && f.td9.sellCompleteDate) {
    const suffix = td9TodayTypes.has('sell_complete') ? ' ← NEW' : '（延續中）';
    lines.push(`📉 TD9: Sell Setup 9 完成於 ${fmtDate(f.td9.sellCompleteDate)}${suffix}`);
  } else if (f.td9.sell >= 6) {
    lines.push(`📉 TD9: Sell Setup ${f.td9.sell}/9 進行中`);
  }

  if (Math.abs(f.dailyPct) >= f.dailyThresh) {
    lines.push(`💬 單日: ${f.dailyPct >= 0 ? '+' : ''}${f.dailyPct.toFixed(1)}%`);
  }

  return lines.join('\n');
}

async function pushToLine(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const userId = process.env.LINE_USER_ID;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN missing');
  if (!userId) throw new Error('LINE_USER_ID missing');
  const res = await fetch(LINE_PUSH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) throw new Error(`LINE ${res.status}: ${await res.text()}`);
}

async function main() {
  console.log('📖 Reading Sheet...');
  const rows = await readSheet();
  const enabled = rows.filter((r) => r.enabled === 'TRUE');
  console.log(`   ${enabled.length} enabled funds\n`);

  const results = [];
  for (const row of enabled) {
    process.stdout.write(`📥 ${row.fund_id} (${row.display_name})... `);
    try {
      const navs = await fetchNav(row.fund_id);
      const latest = navs[navs.length - 1];
      console.log(`✓ ${navs.length} bars, latest ${latest?.date} @ ${latest?.value}`);
      results.push(processFund(row, navs));
    } catch (e) {
      console.log(`✗ ${e.message}`);
      results.push({ id: row.fund_id, name: row.display_name, error: `抓取失敗: ${e.message}` });
    }
  }

  const latestDate =
    results
      .map((r) => r.today?.date)
      .filter(Boolean)
      .sort()
      .pop() || new Date().toISOString().slice(0, 10);
  const triggered = results.filter(hasAlert);

  let msg;
  const header = `📊 [PREVIEW] ${latestDate.replace(/-/g, '/')} 警訊摘要（${results.length} 檔監控中，${triggered.length} 檔觸發）`;
  if (triggered.length === 0) {
    msg = `${header}\n\n（今日無任何警訊觸發）`;
  } else {
    msg = [header, '', ...triggered.map(formatEntry)].join('\n\n');
  }

  console.log('\n===== Message =====');
  console.log(msg);
  console.log('===================\n');

  if (process.argv.includes('--no-line')) {
    console.log('Skipped LINE push (--no-line flag)');
    return;
  }

  try {
    await pushToLine(msg);
    console.log('✓ Pushed to LINE');
  } catch (e) {
    console.error(`✗ LINE push: ${e.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
