// Platform-neutral LINE webhook handler.
const crypto = require('crypto');
const fetch = require('node-fetch');
const { fetchAllNavMultipliers } = require('./fetch-nav');
const { formatMessage: formatTradeMessage } = require('./calculate');
const { ETF_MAP } = require('./etf-config');
const { fetchSheet } = require('./sheet-reader');
const { fetchNav } = require('./fuhwa-api');
const { computePeriodReturns } = require('./indicators/drawdown');
const { computeTd9 } = require('./indicators/td9');
const { formatStatus } = require('./message-formatter');
const { WINDOWS } = require('./alert-engine');

function verifySignature(body, signature, secret) {
  const hash = crypto.createHmac('SHA256', secret).update(body).digest('base64');
  return hash === signature;
}

function parseTrades(text) {
  const trades = {};
  const knownCodes = Object.keys(ETF_MAP);
  const pairPattern = /(00\d{3}[A-Z])\s*[:\s]\s*([+-]?\d+)/gi;
  let match;
  while ((match = pairPattern.exec(text)) !== null) {
    const code = match[1].toUpperCase();
    if (ETF_MAP[code]) trades[code] = parseInt(match[2], 10);
  }
  if (Object.keys(trades).length > 0) return trades;
  const numbers = text.match(/[+-]?\d+/g);
  if (numbers) {
    numbers.forEach((n, i) => {
      if (i < knownCodes.length) trades[knownCodes[i]] = parseInt(n, 10);
    });
  }
  return trades;
}

async function replyMessage(replyToken, text, token) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
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
      const returns = computePeriodReturns(navs, WINDOWS);
      const td9 = computeTd9(navs);
      summaries.push({
        fundId: cfg.fundId,
        displayName: cfg.displayName,
        latest,
        returns,
        td9,
      });
    } catch (e) {
      summaries.push({
        fundId: cfg.fundId,
        displayName: cfg.displayName,
        latest: null,
        returns: [],
        td9: { buy: 0, sell: 0 },
        error: e.message,
      });
    }
  }
  return formatStatus(summaries, {
    latestDate: latestDate || new Date().toISOString().slice(0, 10),
  });
}

async function handleWebhook({ method, rawBody, signature }) {
  if (method === 'GET') return { statusCode: 200, body: 'OK' };
  if (method !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const secret = process.env.LINE_CHANNEL_SECRET;
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!secret || !token) {
    console.error('LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN missing');
    return { statusCode: 500, body: 'misconfigured' };
  }

  if (!verifySignature(rawBody, signature, secret)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const body = JSON.parse(rawBody);
  const events = body.events || [];
  let botUserId = null;

  for (const evt of events) {
    if (evt.type !== 'message' || evt.message.type !== 'text') continue;
    const isGroup = evt.source.type === 'group' || evt.source.type === 'room';
    if (isGroup) {
      const mentionees = evt.message.mention && evt.message.mention.mentionees;
      if (!mentionees || mentionees.length === 0) continue;
      if (!botUserId) {
        try {
          const botRes = await fetch('https://api.line.me/v2/bot/info', {
            headers: { Authorization: `Bearer ${token}` },
          });
          const botInfo = await botRes.json();
          botUserId = botInfo.userId;
        } catch (_) {
          continue;
        }
      }
      const botMentioned = mentionees.some((m) => m.userId === botUserId);
      if (!botMentioned) continue;
    }

    let text = evt.message.text.trim();
    text = text.replace(/@\S+/g, '').trim();

    if (text === '?' || text === 'help' || text === '') {
      await replyMessage(
        evt.replyToken,
        '輸入 ETF 代號和基數，例如：\n@Bot 00991A -28, 00986D -17\n\n或只輸入數字（順序：00991A, 00986D, 00998A, 00409A）：\n@Bot -28 -17\n\n/status 查看基金監控狀態',
        token
      );
      continue;
    }

    if (text === '/status') {
      try {
        const reply = await handleStatusCommand();
        await replyMessage(evt.replyToken, reply, token);
      } catch (e) {
        await replyMessage(evt.replyToken, `狀態查詢失敗: ${e.message}`, token);
      }
      continue;
    }

    const trades = parseTrades(text);
    if (Object.keys(trades).length === 0) {
      await replyMessage(
        evt.replyToken,
        '無法解析，請輸入如：\n00991A -28, 00986D -17\n\n輸入 ? 查看說明',
        token
      );
      continue;
    }
    try {
      const navData = await fetchAllNavMultipliers();
      const message = formatTradeMessage(trades, navData);
      await replyMessage(evt.replyToken, message, token);
    } catch (e) {
      await replyMessage(evt.replyToken, `錯誤: ${e.message}`, token);
    }
  }

  return { statusCode: 200, body: 'OK' };
}

module.exports = { handleWebhook, handleStatusCommand, parseTrades, verifySignature };
