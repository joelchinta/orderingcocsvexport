require('node:child_process').spawnSync(process.execPath, [require('node:path').resolve(__dirname, '../../../ci.js')], { stdio: 'inherit' }).status === 0 || (process.exitCode = 1);
