// Shared-secret guard for endpoints that trigger LINE pushes.
//
// Vercel Cron automatically sends `Authorization: Bearer <CRON_SECRET>` when
// the CRON_SECRET env var is set on the project. Manual callers must send the
// same header. Fails closed: if CRON_SECRET is unset, every request is denied,
// so a misconfigured deploy can't be abused to spam the LINE group.
const crypto = require('crypto');

function isAuthorized(headers, secret = process.env.CRON_SECRET) {
  if (!secret) return false;
  const h = headers || {};
  const auth = h.authorization || h.Authorization || '';
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(String(auth));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { isAuthorized };
