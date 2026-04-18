// Vercel serverless function — invoked both on the cron schedule (declared in
// vercel.json) and manually via HTTP. The cron invocation is GET; any caller
// can also POST or manually trigger.
//
// Thin wrapper: delegates to the pure run() function in lib/fund-alert-runner.
const { run } = require('../lib/fund-alert-runner');

module.exports = async (req, res) => {
  try {
    const result = await run();
    res.status(result.statusCode).send(result.body);
  } catch (e) {
    console.error('fund-alert fatal:', e);
    res.status(500).send(`fatal: ${e.message}`);
  }
};
