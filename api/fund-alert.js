// Vercel serverless function — invoked on the cron schedule (declared in
// vercel.json). Requires `Authorization: Bearer <CRON_SECRET>`; Vercel Cron
// sends it automatically once CRON_SECRET is set on the project.
//
// Thin wrapper: delegates to the pure run() function in lib/fund-alert-runner.
const { run } = require('../lib/fund-alert-runner');
const { isAuthorized } = require('../lib/cron-auth');

module.exports = async (req, res) => {
  if (!isAuthorized(req.headers)) {
    res.status(401).send('Unauthorized');
    return;
  }
  try {
    const result = await run();
    res.status(result.statusCode).send(result.body);
  } catch (e) {
    console.error('fund-alert fatal:', e);
    res.status(500).send(`fatal: ${e.message}`);
  }
};
