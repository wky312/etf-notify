// Vercel wrapper around the platform-neutral LINE webhook handler.
//
// Disables Vercel's auto JSON body-parser because LINE's HMAC signature is
// computed over the raw body; we must hash the exact bytes we received.
const { handleWebhook } = require('../lib/line-webhook-handler');

module.exports = async (req, res) => {
  let rawBody = '';
  try {
    rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  } catch (e) {
    res.status(400).send(`read-body-failed: ${e.message}`);
    return;
  }

  const result = await handleWebhook({
    method: req.method,
    rawBody,
    signature: req.headers['x-line-signature'],
  });
  res.status(result.statusCode).send(result.body);
};

module.exports.config = {
  api: { bodyParser: false },
};
