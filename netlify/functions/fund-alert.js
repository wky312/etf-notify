// Netlify wrapper around the platform-neutral fund-alert runner.
// Schedule declared in netlify.toml ([functions.fund-alert] schedule = "...").
const { run } = require('../../lib/fund-alert-runner');

exports.handler = async () => run();
exports.run = run;
