const crypto = require('crypto');
const fetch = require('node-fetch');
const { fetchAllNavMultipliers } = require('./lib/fetch-nav');
const { formatMessage } = require('./lib/calculate');
const { ETF_MAP } = require('./lib/etf-config');
const { fetchSheet } = require('./lib/sheet-reader');
const { fetchNav } = require('./lib/fuhwa-api');
const { computeDrawdowns } = require('./lib/indicators/drawdown');
const { computeTd9 } = require('./lib/indicators/td9');
const { formatStatus } = require('./lib/message-formatter');
const { WINDOWS } = require('./lib/alert-engine');

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

function verifySignature(body, signature) {
  const hash = crypto
    .createHmac('SHA256', CHANNEL_SECRET)
    .update(body)
    .digest('base64');
  return hash === signature;
}

/**
 * Parse user message to extract ETF trades.
 * Accepts formats like:
 *   "00991A -28, 00986D -17"
 *   "00991A:-28 00986D:-17"
 *   "-28 -17" (assumes order: 00991A, 00986D, 00998A)
 */
function parseTrades(text) {
  const trades = {};
  const knownCodes = Object.keys(ETF_MAP);

  // Try: code + number pairs
  const pairPattern = /(009\d{2}[A-Z])\s*[:\s]\s*([+-]?\d+)/gi;
  let match;
  while ((match = pairPattern.exec(text)) !== null) {
    const code = match[1].toUpperCase();
    if (ETF_MAP[code]) {
      trades[code] = parseInt(match[2], 10);
    }
  }

  if (Object.keys(trades).length > 0) return trades;

  // Fallback: just numbers in order (00991A, 00986D, 00998A)
  const numbers = text.match(/[+-]?\d+/g);
  if (numbers) {
    numbers.forEach((n, i) => {
      if (i < knownCodes.length) {
        trades[knownCodes[i]] = parseInt(n, 10);
      }
    });
  }

  return trades;
}

async function replyMessage(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  });
}

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
  return formatStatus(summaries, {
    latestDate: latestDate || new Date().toISOString().slice(0, 10),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'OK' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Verify LINE signature
  const signature = event.headers['x-line-signature'];
  if (!verifySignature(event.body, signature)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const body = JSON.parse(event.body);
  const events = body.events || [];

  // Get bot's own user ID (for mention detection in groups)
  let botUserId = null;

  for (const evt of events) {
    if (evt.type !== 'message' || evt.message.type !== 'text') continue;

    const isGroup = evt.source.type === 'group' || evt.source.type === 'room';

    // In groups: only respond when bot is mentioned
    if (isGroup) {
      const mentionees = evt.message.mention && evt.message.mention.mentionees;
      if (!mentionees || mentionees.length === 0) continue;

      // Fetch bot user ID once per request
      if (!botUserId) {
        try {
          const botRes = await fetch('https://api.line.me/v2/bot/info', {
            headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
          });
          const botInfo = await botRes.json();
          botUserId = botInfo.userId;
        } catch (e) {
          // Can't verify, skip
          continue;
        }
      }

      const botMentioned = mentionees.some((m) => m.userId === botUserId);
      if (!botMentioned) continue;
    }

    // Strip bot mention (@BotName) from text before parsing
    let text = evt.message.text.trim();
    text = text.replace(/@\S+/g, '').trim();

    // Help command
    if (text === '?' || text === 'help' || text === '') {
      await replyMessage(evt.replyToken,
        '輸入 ETF 代號和基數，例如：\n@Bot 00991A -28, 00986D -17\n\n或只輸入數字（順序：00991A, 00986D, 00998A）：\n@Bot -28 -17'
      );
      continue;
    }

    // Fund alert status query
    if (text === '/status') {
      try {
        const reply = await handleStatusCommand();
        await replyMessage(evt.replyToken, reply);
      } catch (e) {
        await replyMessage(evt.replyToken, `狀態查詢失敗: ${e.message}`);
      }
      continue;
    }

    const trades = parseTrades(text);

    if (Object.keys(trades).length === 0) {
      await replyMessage(evt.replyToken,
        '無法解析，請輸入如：\n00991A -28, 00986D -17\n\n輸入 ? 查看說明'
      );
      continue;
    }

    try {
      const navData = await fetchAllNavMultipliers();
      const message = formatMessage(trades, navData);
      await replyMessage(evt.replyToken, message);
    } catch (e) {
      await replyMessage(evt.replyToken, `錯誤: ${e.message}`);
    }
  }

  return { statusCode: 200, body: 'OK' };
};
