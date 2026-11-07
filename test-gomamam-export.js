const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { lastWeek, dateOnly, businessDay, decodeFlight, listSettlements, queueExport, discoverAction, selectedMerchant } = require('./gomamam-export');
const range = { from: '2026-10-26', to: '2026-11-01' };

test('private CI wrapper keeps email defaults and suppresses subprocess details', () => {
  const { run, options } = require('./ci');
  assert.equal(options({}, 'repository_dispatch').send, true);
  assert.equal(options({ inputs: { send_email: 'true' } }, 'workflow_dispatch').send, true);
  assert.equal(options({ inputs: { send_email: 'false' } }, 'workflow_dispatch').send, true);
  assert.throws(() => run(process.execPath, ['-e', 'console.log("PRIVATE-DATA"); console.error("PRIVATE-DATA"); process.exit(1)'], 'E01'), error => error.message === 'E01');
});

test('fresh sessions follow recovery before filling login credentials', async () => {
  const { authenticate } = require('./gomamam-export');
  let url = 'https://vendor.gomamam.com/reload';
  let signedIn = false;
  const actions = [];
  const page = {
    goto: async () => { url = signedIn ? 'https://vendor.gomamam.com/dashboard/settlements' : 'https://vendor.gomamam.com/reload'; },
    url: () => url,
    waitForLoadState: async () => {},
    on: () => {}, off: () => {},
    locator: () => ({ first: () => ({ waitFor: async () => {} }), waitFor: async () => {}, evaluate: async () => 'Test merchant' }),
    getByRole: (role, options) => ({
      waitFor: async () => {},
      fill: async value => actions.push(['email', value]),
      click: async () => {
        actions.push(['click', options.name]);
        if (options.name === 'Sign in again') url = 'https://auth.gomamam.com/login';
        if (options.name === 'Login') { signedIn = true; url = 'https://vendor.gomamam.com/dashboard'; }
      }
    }),
    getByLabel: () => ({ fill: async value => actions.push(['password', value]) }),
    waitForURL: async predicate => assert.equal(predicate(new URL(url)), true)
  };
  assert.equal(await authenticate(page, { merchant: 'Test merchant' }, {
    GOMAMAM_EMAIL: 'test@example.invalid', GOMAMAM_PASSWORD: 'synthetic-password'
  }), 'Test merchant');
  assert.deepEqual(actions, [['click', 'Sign in again'], ['email', 'test@example.invalid'],
    ['password', 'synthetic-password'], ['click', 'Login']]);
});

test('reads React Select merchant label in a real browser', async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div><div><span title="Test merchant">Test merchant</span></div><div><input id="merchant-switcher" value=""></div></div>');
    assert.equal(await page.locator('#merchant-switcher').evaluate(selectedMerchant), 'Test merchant');
    await page.setContent('<select id="merchant-switcher"><option selected>Test merchant</option></select>');
    assert.equal(await page.locator('#merchant-switcher').evaluate(selectedMerchant), 'Test merchant');
  } finally { await browser.close(); }
});

test('business timestamps use Brunei date rather than truncating UTC', () => {
  assert.equal(businessDay('2026-11-05T16:00:00.000Z'), '2026-11-06');
  assert.equal(businessDay('2026-11-06'), '2026-11-06');
  assert.throws(() => businessDay('2026-11-05T16:00:00'));
});

test('previous complete Monday–Sunday across Brunei midnight and year boundaries', () => {
  for (let day = 2; day <= 8; day++) {
    assert.deepEqual(lastWeek(new Date(`2026-11-${String(day).padStart(2, '0')}T04:00:00Z`)), range);
  }
  assert.deepEqual(lastWeek(new Date('2026-11-01T16:00:00Z')), range);
  assert.deepEqual(lastWeek(new Date('2026-01-01T00:00:00Z')), { from: '2025-12-22', to: '2025-12-28' });
  assert.throws(() => dateOnly('2026-02-30'));
});
test('Flight lookup decoding rejects login pages and changed response shapes', () => {
  const data = { data: [], next_cursor: null };
  assert.deepEqual(decodeFlight(`0:{"a":"$@1"}\n1:${JSON.stringify({ status: 1, data })}\n`), data);
  for (const text of ['<html>Login</html>', '{"status":0,"data":null}', '{"status":1,"data":{"data":[]}}']) {
    assert.throws(() => decodeFlight(text));
  }
});
test('pagination follows cursors, deduplicates IDs and keeps both boundaries', async () => {
  const calls = [];
  const result = await listSettlements(async filters => {
    calls.push(filters);
    return filters.cursor ? { data: [{ id: 2, business_date: range.to }], next_cursor: null } :
      { data: [{ id: 1, business_date: range.from }, { id: 2, business_date: range.to }], next_cursor: 'next' };
  }, range);
  assert.deepEqual(result.map(batch => batch.id), [1, 2]);
  assert.deepEqual(calls[1], { dateFrom: range.from, dateTo: range.to, cursor: 'next' });
});
test('repeated cursor and out-of-range batch fail closed', async () => {
  await assert.rejects(listSettlements(async () => ({ data: [], next_cursor: 'loop' }), range), /cursor/);
  await assert.rejects(listSettlements(async () => ({ data: [{ id: 1, business_date: '2026-11-02' }], next_cursor: null }), range), /outside/);
});
test('lookup action is discovered from the current bundle', async () => {
  const page = { locator: () => ({ evaluateAll: async () => ['https://vendor.gomamam.com/_next/static/chunks/app.js'] }) };
  const request = { get: async () => ({ ok: () => true,
    text: async () => '(0,i.createServerReference)("401002b284a0902d1dcc119a04597de01743db6437",i.callServer,void 0,i.findSourceMapURL,"getCanonicalSettlements");' }) };
  assert.equal(await discoverAction(page, request), '401002b284a0902d1dcc119a04597de01743db6437');
});
for (const success of [true, false]) {
  test(`email receipt prevents retries after ${success ? 'success' : 'timeout'}`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gomamam-test-'));
    t.after(() => fs.rm(dir, { recursive: true }));
    const receipt = path.join(dir, 'receipt.json');
    let calls = 0;
    const request = { post: async (url, options) => {
      calls++;
      assert.equal(new URL(url).searchParams.get('batch_ids'), '24');
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.maxRetries, 0);
      if (!success) throw new Error('timeout');
      return { ok: () => true, headers: () => ({ 'content-type': 'application/json' }), json: async () => ({ status: 1 }) };
    } };
    const args = [request, [{ id: 24 }], receipt, 'Test merchant', range];
    if (success) await queueExport(...args);
    else await assert.rejects(queueExport(...args), /uncertain/);
    assert.equal(JSON.parse(await fs.readFile(receipt)).status, success ? 'queued' : 'pending');
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(receipt))), ['status']);
    if (success) assert.deepEqual(await queueExport(...args), { alreadyQueued: true });
    else await assert.rejects(queueExport(...args), /uncertain/);
    assert.equal(calls, 1);
    assert.equal((await fs.stat(receipt)).mode & 0o777, 0o600);
  });
}
