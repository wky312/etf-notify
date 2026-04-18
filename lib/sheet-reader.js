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
