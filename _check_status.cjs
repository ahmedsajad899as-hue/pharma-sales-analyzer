const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Get PM2 status
try {
  const out = execSync('node.exe C:\\Users\\Marhaba\\AppData\\Roaming\\npm\\node_modules\\pm2\\bin\\pm2 jlist', { encoding: 'utf8', timeout: 10000 });
  const procs = JSON.parse(out);
  const lines = ['=== PM2 STATUS ==='];
  procs.forEach(p => {
    lines.push(`${p.name}: ${p.pm2_env.status} | restarts: ${p.pm2_env.restart_time} | mem: ${Math.round(p.monit.memory/1024/1024)}MB`);
  });
  fs.writeFileSync(path.join(__dirname, '_status.txt'), lines.join('\n'));
} catch (e) {
  fs.writeFileSync(path.join(__dirname, '_status.txt'), 'ERROR: ' + e.message);
}
