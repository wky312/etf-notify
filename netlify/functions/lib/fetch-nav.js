const fetch = require('node-fetch');
const { ETF_MAP, BASE_UNITS } = require('./etf-config');

const API_URL = 'https://www.fhtrust.com.tw/api/assets';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Referer': 'https://www.fhtrust.com.tw/',
};

/**
 * Get today's date string in YYYYMMDD format (Taipei time).
 * If called before PCF is published, try previous business day.
 */
function getDateStr(daysAgo = 0) {
  const d = new Date();
  d.setHours(d.getHours() + 8); // UTC → Taipei
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Fetch 每現金申購/買回基數約當淨值 from fhtrust JSON API.
 * Formula: (pcf_FundNav / pcf_FundQissue) × BASE_UNITS
 */
async function fetchNavMultiplier(etfCode) {
  const config = ETF_MAP[etfCode];
  if (!config) throw new Error(`Unknown ETF: ${etfCode}`);

  // Try today, then yesterday (PCF might not be published yet)
  for (let daysAgo = 0; daysAgo <= 3; daysAgo++) {
    const dateStr = getDateStr(daysAgo);
    const url = `${API_URL}?fundID=${config.id}&qDate=${dateStr}`;
    try {
      const res = await fetch(url, { headers: HEADERS, timeout: 10000 });
      const data = await res.json();

      if (data && data.result && data.result.length > 0) {
        const result = data.result[0];
        const fundNav = parseFloat(String(result.pcf_FundNav).replace(/,/g, ''));
        const fundQissue = parseFloat(String(result.pcf_FundQissue).replace(/,/g, ''));

        if (fundNav > 0 && fundQissue > 0) {
          const navMultiplier = Math.round((fundNav / fundQissue) * BASE_UNITS);
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
