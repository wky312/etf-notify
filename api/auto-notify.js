// Vercel wrapper for the existing auto-notify logic (Pushover → OCR → LINE).
// Delegates to the legacy handler in netlify/functions/auto-notify.js — both
// platforms share the same implementation via shim since auto-notify is
// already stateless and event-agnostic.
const legacy = require('../netlify/functions/auto-notify');

module.exports = async (req, res) => {
  // Synthesise a Netlify-style event for the legacy handler. auto-notify
  // does not inspect event fields beyond running, so an empty event is fine.
  const result = await legacy.handler({});
  res.status(result.statusCode);
  if (typeof result.body === 'string') res.send(result.body);
  else res.send(JSON.stringify(result.body));
};
