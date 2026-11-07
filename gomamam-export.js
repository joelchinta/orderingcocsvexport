#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const ORIGIN = 'https://vendor.gomamam.com';
const SETTLEMENTS = `${ORIGIN}/dashboard/settlements`;

function dateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error('Dates must be valid YYYY-MM-DD values');
  }
  return value;
}

function lastWeek(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Brunei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const part = type => parts.find(p => p.type === type).value;
  const today = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`);
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7) - 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

function businessDay(value) {
  if (typeof value !== 'string') throw new Error('Invalid settlement business date');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dateOnly(value);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('Settlement timestamp must include its timezone');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid settlement timestamp');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Brunei',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = type => parts.find(p => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function decodeFlight(text) {
  // Next server actions return newline-delimited Flight records, not plain JSON.
  const candidates = [];
  try { candidates.push(JSON.parse(text)); } catch {}
  for (const line of text.split('\n')) {
    const match = /^[0-9a-f]+:(\{.*\})$/.exec(line);
    if (match) {
      try { candidates.push(JSON.parse(match[1])); } catch {}
    }
  }
  const result = candidates.find(value => value?.status !== undefined && value?.data !== undefined);
  if (!result || result.status !== 1 || !Array.isArray(result.data?.data) ||
      !Object.hasOwn(result.data, 'next_cursor')) {
    throw new Error('Unexpected settlement response; authentication or portal contract may have changed');
  }
  return result.data;
}

async function listSettlements(fetchPage, range) {
  const batches = new Map();
  const cursors = new Set();
  let cursor;
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    const page = await fetchPage({ dateFrom: range.from, dateTo: range.to, ...(cursor ? { cursor } : {}) });
    for (const batch of page.data) {
      const id = Number(batch.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid settlement batch ID');
      // The settlement UI labels this business_date, rather than order delivery date.
      const businessDate = businessDay(batch.business_date);
      if (businessDate < range.from || businessDate > range.to) {
        throw new Error('Portal returned a batch outside the requested business-date range');
      }
      if (batches.has(id) && batches.get(id).businessDate !== businessDate) {
        throw new Error('Conflicting duplicate settlement batch');
      }
      batches.set(id, { id, businessDate });
    }
    if (page.next_cursor === null || page.next_cursor === '') {
      return [...batches.values()].sort((a, b) => a.id - b.id);
    }
    if (typeof page.next_cursor !== 'string' || cursors.has(page.next_cursor)) {
      throw new Error('Invalid or repeated settlement pagination cursor');
    }
    cursor = page.next_cursor;
    cursors.add(cursor);
  }
  throw new Error('Settlement pagination exceeded its safety limit');
}

async function privateJSON(filename, value, exclusive = false) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.writeFile(filename, JSON.stringify(value, null, 2), { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
  await fs.chmod(filename, 0o600);
}

async function discoverAction(page, request) {
  const urls = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.src));
  const actionIds = new Set();
  for (const url of new Set(urls)) {
    if (new URL(url).origin !== ORIGIN || !new URL(url).pathname.startsWith('/_next/static/')) continue;
    const response = await request.get(url, { maxRedirects: 0, timeout: 15000 });
    if (!response.ok()) continue;
    const source = await response.text();
    for (const match of source.matchAll(/createServerReference\)\("([a-f0-9]+)"[^;]{0,250}?"getCanonicalSettlements"/g)) {
      actionIds.add(match[1]);
    }
    if (actionIds.size === 1) return [...actionIds][0];
  }
  if (actionIds.size !== 1) throw new Error('Could not identify the current settlement lookup action; portal changed');
  return [...actionIds][0];
}

async function authenticate(page, options, env) {
  await page.goto(SETTLEMENTS, { waitUntil: 'domcontentloaded' });
  await page.locator('h1, input[type="password"]').first().waitFor();
  if (new URL(page.url()).origin === ORIGIN && new URL(page.url()).pathname === '/reload') {
    const signIn = page.getByRole('link', { name: 'Sign in again', exact: true });
    await signIn.click();
    await page.locator('input[type="password"]').waitFor();
  }
  const onPortal = () => new URL(page.url()).origin === ORIGIN && new URL(page.url()).pathname === '/dashboard/settlements';
  if (!onPortal()) {
    if (!['auth.gomamam.com', 'vendor.gomamam.com'].includes(new URL(page.url()).hostname)) {
      throw new Error('Unexpected sign-in destination');
    }
    if (options.login) {
      console.log('Complete sign-in in the opened browser. Waiting up to five minutes.');
      await page.waitForURL(url => url.origin === ORIGIN && url.pathname.startsWith('/dashboard'), { timeout: 300000 });
      await page.goto(SETTLEMENTS, { waitUntil: 'domcontentloaded' });
    } else {
      if (!env.GOMAMAM_EMAIL || !env.GOMAMAM_PASSWORD) {
        throw new Error('Sign-in required: use --login locally, or configure GOMAMAM_EMAIL and GOMAMAM_PASSWORD securely');
      }
      // The server-rendered form can appear before its client-side submit handler is ready.
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      let loginStatus = null;
      const observeLogin = response => {
        if (new URL(response.url()).hostname === 'auth.gomamam.com' && response.request().method() === 'POST') loginStatus = response.status();
      };
      page.on('response', observeLogin);
      await page.getByRole('textbox', { name: /Email address/i }).fill(env.GOMAMAM_EMAIL);
      await page.getByLabel(/^Password/i).fill(env.GOMAMAM_PASSWORD);
      await page.getByRole('button', { name: 'Login', exact: true }).click();
      try {
        await page.waitForURL(url => url.origin === ORIGIN && url.pathname.startsWith('/dashboard'), { timeout: 60000 });
        await page.goto(SETTLEMENTS, { waitUntil: 'domcontentloaded' });
      }
      catch {
        const current = new URL(page.url());
        const text = (await page.locator('body').innerText()).toLowerCase();
        let reason = 'login did not reach the merchant dashboard';
        if (/incorrect|invalid credentials|invalid email|invalid password|credentials do not match|no matching user|user not found/.test(text)) reason = 'login credentials were rejected';
        else if (/captcha|verify you are human|checking your browser/.test(text)) reason = 'human verification is required';
        else if (/verification code|one.time password|enter.*otp/.test(text)) reason = 'a verification code is required';
        else if (current.pathname === '/reload') reason = 'merchant access was not restored after login';
        // Only an allowlisted origin/path and a fixed diagnosis are logged, never page text or URL query strings.
        const location = ['auth.gomamam.com', 'vendor.gomamam.com'].includes(current.hostname)
          ? `${current.hostname}${current.pathname.replace(/[^a-zA-Z0-9/_-]/g, '').slice(0, 80)}` : 'another sign-in destination';
        const invalidFields = await page.locator('input:invalid').count();
        throw new Error(`Sign-in stopped at ${location}: ${reason}; authentication response ${loginStatus ?? 'not observed'}; invalid fields ${invalidFields}`);
      }
      finally { page.off('response', observeLogin); }
    }
  }
  await page.getByRole('heading', { name: 'Settlements', exact: true }).waitFor();
  const merchant = await page.locator('#merchant-switcher').evaluate(selectedMerchant);
  if (merchant !== options.merchant) throw new Error('Selected merchant differs from --merchant; select the intended merchant in interactive login first');
  return merchant;
}

function selectedMerchant(element) {
  if (element.tagName === 'SELECT') return element.selectedOptions[0]?.textContent?.trim();
  // React Select's combobox input is empty; the selected label is its sibling.
  if (element.tagName === 'INPUT') {
    return element.parentElement?.parentElement?.querySelector('span[title]')?.getAttribute('title')?.trim();
  }
  return element.textContent?.trim();
}

async function queueExport(request, batches, receiptFile, merchant, range) {
  // Reserve before sending. A timeout may still mean the email was queued; never retry automatically.
  try {
    await privateJSON(receiptFile, { status: 'pending' }, true);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    if (previous.status === 'queued') return { alreadyQueued: true };
    throw new Error('Email queue result is uncertain. Existing pending receipt requires review before retrying');
  }
  const url = new URL('/api/settlements/export', ORIGIN);
  url.searchParams.set('batch_ids', batches.map(batch => batch.id).join(','));
  try {
    const response = await request.post(url.href, {
      headers: { Origin: ORIGIN, Referer: SETTLEMENTS, Accept: 'application/json' },
      maxRedirects: 0, timeout: 60000, maxRetries: 0
    });
    if (!response.ok() || !(response.headers()['content-type'] || '').includes('application/json')) {
      throw new Error('Export request was not confirmed');
    }
    const result = await response.json();
    if (result.status !== 1) throw new Error('Export request was not confirmed');
    await privateJSON(receiptFile, { status: 'queued' });
    return { alreadyQueued: false };
  } catch {
    throw new Error('Email queue result is uncertain. Check the portal/inbox before removing the pending receipt and retrying');
  }
}

async function main() {
  process.umask(0o077);
  const { values: options } = parseArgs({ options: {
    from: { type: 'string' }, to: { type: 'string' }, merchant: { type: 'string' },
    login: { type: 'boolean', default: false }, 'save-session': { type: 'boolean', default: false },
    'send-email': { type: 'boolean', default: false },
    channel: { type: 'string' },
    'state-file': { type: 'string', default: 'playwright/.auth/gomamam.json' },
    'output-dir': { type: 'string', default: 'work/gomamam' }
  }});
  if (!options.merchant) throw new Error('--merchant is required to prevent exports from the wrong account');
  if (options['save-session'] && !options.login) throw new Error('--save-session requires interactive --login');
  if (Boolean(options.from) !== Boolean(options.to)) throw new Error('Supply both --from and --to');
  const range = options.from ? { from: dateOnly(options.from), to: dateOnly(options.to) } : lastWeek();
  if (range.from > range.to) throw new Error('--from must be on or before --to');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: !options.login, ...(options.channel ? { channel: options.channel } : {}) });
  try {
    let state;
    try { state = JSON.parse(await fs.readFile(options['state-file'], 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read saved session state'); }
    const context = await browser.newContext({ ...(state ? { storageState: state } : {}), timezoneId: 'Asia/Brunei' });
    const page = await context.newPage();
    const merchant = await authenticate(page, options, process.env);
    console.log('Signed in to the expected merchant. Discovering the settlement lookup.');
    // Persist only when explicitly requested; headless credentials stay in memory.
    if (options['save-session']) await privateJSON(options['state-file'], await context.storageState());
    const action = await discoverAction(page, context.request);
    console.log('Reading settlement batches for the requested business dates.');
    let pagesRead = 0;
    const batches = await listSettlements(async filters => {
      const response = await context.request.post(SETTLEMENTS, {
        headers: { 'Next-Action': action, 'Content-Type': 'text/plain;charset=UTF-8',
          Accept: 'text/x-component', Origin: ORIGIN, Referer: SETTLEMENTS },
        data: JSON.stringify([filters]), maxRedirects: 0, timeout: 60000, maxRetries: 0
      });
      if (!response.ok()) throw new Error('Settlement lookup failed; session may have expired');
      const result = decodeFlight(await response.text());
      pagesRead++;
      return result;
    }, range);
    const plan = { merchant, range, dateBasis: 'settlement business date', pagesRead, batches,
      emailRequested: options['send-email'] };
    await privateJSON(path.join(options['output-dir'], 'plan.json'), plan);
    console.log(`${range.from} to ${range.to}: ${batches.length} settlement batches across ${pagesRead} pages`);
    if (!options['send-email']) { console.log('Preview only. No report email requested.'); return; }
    if (!batches.length) throw new Error('No matching batches; a report email could not be requested');
    const key = crypto.createHash('sha256').update(JSON.stringify({ merchant, range, batches })).digest('hex');
    const queued = await queueExport(context.request, batches, path.join(options['output-dir'], 'receipts', `${key}.json`), merchant, range);
    if (queued.alreadyQueued) { console.log('This report was already queued. No duplicate email requested.'); return; }
    console.log('Report email queued. This is not confirmation of email delivery or workbook import.');
  } finally { await browser.close(); }
}

module.exports = { lastWeek, dateOnly, businessDay, decodeFlight, listSettlements, queueExport, discoverAction, selectedMerchant, authenticate };
if (require.main === module) main().catch(error => {
  // Never print request bodies, cookies, page HTML, passwords or login error traces.
  console.error(error.message.startsWith('page.') || error.message.includes('Call log:') ? 'Browser operation failed; check sign-in and portal availability' : error.message);
  process.exitCode = 1;
});
