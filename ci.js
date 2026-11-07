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
  return { from: event.inputs?.from || '', to: event.inputs?.to || '', send: true };
}

async function worker() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const input = options(event, process.env.GITHUB_EVENT_NAME);
  const args = ['gomamam-export.js', '--merchant', process.env.C || '', '--output-dir',
    path.join('work', 'task', `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`)];
  if (input.from || input.to) args.push('--from', input.from, '--to', input.to);
  if (input.send) args.push('--send-email');
  run(process.execPath, args, 'E05', { ...process.env,
    GOMAMAM_EMAIL: process.env.A, GOMAMAM_PASSWORD: process.env.B, GOMAMAM_MERCHANT: process.env.C });
}

async function main() {
  if (process.argv.includes('--worker')) return worker();
  const setupEnv = { ...process.env };
  for (const key of ['A', 'B', 'C', 'GOMAMAM_EMAIL', 'GOMAMAM_PASSWORD', 'GOMAMAM_MERCHANT', 'ACTIONS_RUNTIME_TOKEN']) delete setupEnv[key];
  run('npm', ['ci', '--no-fund', '--no-audit'], 'E01', setupEnv);
  run('npx', ['playwright', 'install', '--with-deps', 'chromium'], 'E02', setupEnv);
  run('npm', ['test'], 'E03', setupEnv);
  run(process.execPath, [__filename, '--worker'], 'E04');
  console.log('Task completed.');
}

module.exports = { run, options };
if (require.main === module) main().catch(error => {
  console.error(`Task failed (${/^E0[1-6]$/.test(error.message) ? error.message : 'E00'}).`);
  process.exitCode = 1;
});
