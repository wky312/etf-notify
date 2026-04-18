// Netlify wrapper around the platform-neutral LINE webhook handler.
const { handleWebhook } = require('../../lib/line-webhook-handler');

exports.handler = async (event) => {
  return handleWebhook({
    method: event.httpMethod,
    rawBody: event.body,
    signature: event.headers['x-line-signature'],
  });
};
