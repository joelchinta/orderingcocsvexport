'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(command, args, code, env = process.env) {
  const result = spawnSync(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  // Captured output is deliberately neither printed nor uploaded, including failures.
  if (result.error || result.status !== 0) {
    const nested = /Task failed \((E0[0-6])\)\./.exec(String(result.stderr));
    throw new Error(nested ? nested[1] : code);
  }
}

function options(event, name) {
  const manual = name === 'workflow_dispatch';
  return { from: event.inputs?.from || '', to: event.inputs?.to || '',
    send: !manual || event.inputs?.send_email === true || event.inputs?.send_email === 'true' };
}

async function worker() {
  const cache = await import('@actions/cache');
  const receipts = 'work/gomamam/receipts';
  const key = `state-v1-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  try { await cache.restoreCache([receipts], key, ['state-v1-', 'gomamam-receipts-']); }
  catch { throw new Error('E04'); }
  // Preserve existing duplicate protection while removing identifying receipt metadata.
  if (fs.existsSync(receipts)) for (const file of fs.readdirSync(receipts)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) throw new Error('Unexpected state file');
    const target = path.join(receipts, file);
    const { status } = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!['pending', 'queued'].includes(status)) throw new Error('Unexpected state');
    fs.writeFileSync(target, JSON.stringify({ status }), { mode: 0o600 });
  }
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const input = options(event, process.env.GITHUB_EVENT_NAME);
  const args = ['gomamam-export.js', '--merchant', process.env.C || ''];
  if (input.from || input.to) args.push('--from', input.from, '--to', input.to);
  if (input.send) args.push('--send-email');
  let failure;
  try {
    run(process.execPath, args, 'E05', { ...process.env,
      GOMAMAM_EMAIL: process.env.A, GOMAMAM_PASSWORD: process.env.B, GOMAMAM_MERCHANT: process.env.C });
  } catch (error) { failure = error; }
  finally {
    if (fs.existsSync(receipts) && fs.readdirSync(receipts).length) {
      try { await cache.saveCache([receipts], key); }
      catch { throw new Error('E06'); }
    }
  }
  if (failure) throw failure;
}

async function main() {
  if (process.argv.includes('--worker')) return worker();
  run('npm', ['ci', '--no-fund', '--no-audit'], 'E01');
  run('npx', ['playwright', 'install', '--with-deps', 'chromium'], 'E02');
  run('npm', ['test'], 'E03');
  run(process.execPath, [__filename, '--worker'], 'E04');
  console.log('Task completed.');
}

module.exports = { run, options };
if (require.main === module) main().catch(error => {
  console.error(`Task failed (${/^E0[1-6]$/.test(error.message) ? error.message : 'E00'}).`);
  process.exitCode = 1;
});
