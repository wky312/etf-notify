const test = require('node:test');
const assert = require('node:assert/strict');
const { isAuthorized } = require('../lib/cron-auth');

test('denies everything when CRON_SECRET is unset (fail closed)', () => {
  assert.equal(isAuthorized({ authorization: 'Bearer ' }, ''), false);
  assert.equal(isAuthorized({}, undefined), false);
});

test('accepts matching bearer token', () => {
  assert.equal(isAuthorized({ authorization: 'Bearer s3cret' }, 's3cret'), true);
  assert.equal(isAuthorized({ Authorization: 'Bearer s3cret' }, 's3cret'), true);
});

test('rejects missing or wrong token', () => {
  assert.equal(isAuthorized({}, 's3cret'), false);
  assert.equal(isAuthorized(undefined, 's3cret'), false);
  assert.equal(isAuthorized({ authorization: 'Bearer wrong!' }, 's3cret'), false);
  assert.equal(isAuthorized({ authorization: 's3cret' }, 's3cret'), false);
});

test('Vercel and Netlify wrappers return 401 without the secret', async () => {
  delete process.env.CRON_SECRET;
  const netlifyFA = require('../netlify/functions/fund-alert');
  const netlifyAN = require('../netlify/functions/auto-notify');
  assert.equal((await netlifyFA.handler({ headers: {} })).statusCode, 401);
  assert.equal((await netlifyAN.handler({ headers: {} })).statusCode, 401);

  for (const mod of ['../api/fund-alert', '../api/auto-notify']) {
    let status;
    const res = { status(c) { status = c; return this; }, send() { return this; } };
    await require(mod)({ headers: {} }, res);
    assert.equal(status, 401, mod);
  }
});
