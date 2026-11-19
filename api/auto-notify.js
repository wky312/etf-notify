// Vercel wrapper for the existing auto-notify logic (Pushover → OCR → LINE).
// Delegates to the legacy implementation in netlify/functions/auto-notify.js.
// Requires `Authorization: Bearer <CRON_SECRET>`.
const legacy = require('../netlify/functions/auto-notify');
const { isAuthorized } = require('../lib/cron-auth');

module.exports = async (req, res) => {
  if (!isAuthorized(req.headers)) {
    res.status(401).send('Unauthorized');
    return;
  }
  const result = await legacy.run();
  res.status(result.statusCode);
  if (typeof result.body === 'string') res.send(result.body);
  else res.send(JSON.stringify(result.body));
};
