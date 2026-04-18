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
