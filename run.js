'use strict';
// Starts server.js and starts it again after an in-app update (exit code 75). Close this window to stop the app.
const { spawn } = require('child_process');
const path = require('path');

function start() {
  const p = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'inherit', env: { ...process.env, TTA_LAUNCHER: '1' } });
  p.on('exit', (code) => {
    if (code === 75) { console.log('\n  Update installed. Restarting…\n'); return start(); }
    process.exit(code == null ? 1 : code);
  });
}
start();
