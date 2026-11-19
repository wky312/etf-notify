// Netlify wrapper around the platform-neutral fund-alert runner.
// Manual-invoke fallback only; requires `Authorization: Bearer <CRON_SECRET>`.
const { run } = require('../../lib/fund-alert-runner');
const { isAuthorized } = require('../../lib/cron-auth');

exports.handler = async (event) => {
  if (!isAuthorized(event && event.headers)) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  return run();
};
exports.run = run;
