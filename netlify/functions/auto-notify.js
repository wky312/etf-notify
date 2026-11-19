const fetch = require('node-fetch');
const { fetchAllNavMultipliers } = require('../../lib/fetch-nav');
const { formatMessage } = require('../../lib/calculate');
const { ETF_MAP } = require('../../lib/etf-config');

const PUSHOVER_API_TOKEN = process.env.PUSHOVER_API_TOKEN;
const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;

/**
 * Fetch the latest Pushover message with an attachment (the ETF screenshot).
 * Returns the image as a base64 string.
 */
async function fetchPushoverImage() {
  // Get messages from Pushover Open Client API
  const res = await fetch(
    `https://api.pushover.net/1/messages.json?secret=${PUSHOVER_API_TOKEN}`,
    { headers: { 'User-Agent': 'etf-notify/1.0' } }
  );

  if (!res.ok) {
    // Fallback: use Pushover glances or check if there's a different endpoint
    throw new Error(`Pushover API returned ${res.status}`);
  }

  const data = await res.json();
  const messages = data.messages || [];

  // Find most recent message with an attachment (today)
  const today = new Date().toISOString().slice(0, 10);
  const recent = messages
    .filter((m) => m.attachment && m.date && new Date(m.date * 1000).toISOString().startsWith(today))
    .sort((a, b) => b.date - a.date);

  if (recent.length === 0) {
    throw new Error('No Pushover message with attachment found today');
  }

  // Download the attachment image
  const attachmentUrl = recent[0].attachment_url || recent[0].attachment;
  if (!attachmentUrl) {
    throw new Error('Pushover message has no attachment URL');
  }

  const imgRes = await fetch(attachmentUrl);
  const buffer = await imgRes.buffer();
  return buffer.toString('base64');
}

/**
 * Use Gemini Vision API to extract ETF trades from screenshot.
 */
async function ocrScreenshot(imageBase64) {
  const knownCodes = Object.keys(ETF_MAP).join(', ');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: imageBase64,
              },
            },
            {
              text: `This is an ETF transaction table screenshot. Extract the (C)淨交易基數 column value for each 證券代號.
Known ETF codes: ${knownCodes}.
Return ONLY a JSON object like: {"00991A": -28, "00986D": -17}
If a code is not in the table, omit it. Return only the JSON, no other text.`,
            },
          ],
        },
      ],
    }),
  });

  const data = await res.json();

  if (!data.candidates || !data.candidates[0]) {
    throw new Error(`Gemini API error: ${JSON.stringify(data)}`);
  }

  const text = data.candidates[0].content.parts[0].text.trim();

  // Parse JSON from response (handle possible markdown wrapping)
  const jsonMatch = text.match(/\{[^}]+\}/);
  if (!jsonMatch) throw new Error(`OCR failed to extract trades: ${text}`);

  const trades = JSON.parse(jsonMatch[0]);

  // Validate and convert to numbers
  const result = {};
  for (const [code, value] of Object.entries(trades)) {
    if (ETF_MAP[code]) {
      result[code] = parseInt(value, 10);
    }
  }

  if (Object.keys(result).length === 0) {
    throw new Error('OCR found no valid ETF trades');
  }

  return result;
}

/**
 * Push a message to LINE user.
 */
async function pushLineMessage(text) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: LINE_USER_ID,
      messages: [{ type: 'text', text }],
    }),
  });
}

/**
 * Main flow: Pushover screenshot → Claude OCR → fetch NAV → calculate → LINE push
 */
async function run() {
  try {
    // Step 1: Get screenshot from Pushover
    console.log('Fetching Pushover image...');
    const imageBase64 = await fetchPushoverImage();
    console.log('Image fetched, size:', Math.round(imageBase64.length / 1024), 'KB');

    // Step 2: OCR with Claude Vision
    console.log('Running OCR...');
    const trades = await ocrScreenshot(imageBase64);
    console.log('Trades extracted:', trades);

    // Step 3: Fetch NAV multipliers
    console.log('Fetching NAV...');
    const navData = await fetchAllNavMultipliers();

    // Step 4: Calculate and format message
    const message = formatMessage(trades, navData);
    console.log('Message:', message);

    // Step 5: Push to LINE
    await pushLineMessage(message);
    console.log('LINE message sent');

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message, trades }),
    };
  } catch (e) {
    console.error('Error:', e.message);

    // Notify user about the error via LINE
    try {
      await pushLineMessage(`ETF通知錯誤: ${e.message}`);
    } catch (_) {
      // Ignore LINE push failure
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
    };
  }
}

const { isAuthorized } = require('../../lib/cron-auth');

/**
 * Netlify handler — manual invoke only; requires `Authorization: Bearer <CRON_SECRET>`.
 */
exports.handler = async (event) => {
  if (!isAuthorized(event && event.headers)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  return run();
};
exports.run = run;
