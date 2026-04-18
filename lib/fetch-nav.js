const fetch = require('node-fetch');
const { ETF_MAP } = require('./etf-config');

const PCF_API_URL = 'https://www.fhtrust.com.tw/api/ETFPcf';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Referer': 'https://www.fhtrust.com.tw/',
};

/**
 * Get date string in YYYY/MM/DD format (Taipei time).
 */
function getDateStr(daysAgo = 0) {
  const d = new Date();
  d.setHours(d.getHours() + 8); // UTC → Taipei
  d.setDate(d.getDate() - daysAgo);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

/**
 * Fetch 每現金申購/買回基數約當淨值 from /api/ETFPcf.
 * Uses the pVal field directly — the authoritative value shown on the website.
 */
async function fetchNavMultiplier(etfCode) {
  const config = ETF_MAP[etfCode];
  if (!config) throw new Error(`Unknown ETF: ${etfCode}`);

  // Try today, then previous days (PCF might not be published yet, or weekends)
  for (let daysAgo = 0; daysAgo <= 5; daysAgo++) {
    const dateStr = getDateStr(daysAgo);
    const url = `${PCF_API_URL}?fundID=${config.id}&pcfDate=${dateStr}`;
    try {
      const res = await fetch(url, { headers: HEADERS, timeout: 10000 });
      const data = await res.json();

      const result = data && data.result && data.result[0];
      if (result && result.pVal) {
        const navMultiplier = parseInt(String(result.pVal).replace(/,/g, ''), 10);
        if (navMultiplier > 0) {
          return {
            etfCode,
            name: config.name,
            navMultiplier,
            date: dateStr,
          };
        }
      }
    } catch (e) {
      // Try next date
    }
  }

  throw new Error(`Cannot find NAV for ${etfCode} (${config.id})`);
}

/**
 * Fetch NAV multipliers for all known ETFs.
 */
async function fetchAllNavMultipliers() {
  const results = {};
  const promises = Object.keys(ETF_MAP).map(async (code) => {
    try {
      results[code] = await fetchNavMultiplier(code);
    } catch (e) {
      results[code] = { etfCode: code, name: ETF_MAP[code].name, navMultiplier: null, error: e.message };
    }
  });
  await Promise.all(promises);
  return results;
}

module.exports = { fetchNavMultiplier, fetchAllNavMultipliers };
