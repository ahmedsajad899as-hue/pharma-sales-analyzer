const http = require('http');
const fs = require('fs');
const path = require('path');
const out = 'd:/my code/marketing/pharma-sales-analyzer/_test_output.txt';
const lines = [];
const log = (s) => lines.push(s);

function post(p, body) {
  return new Promise((ok, no) => {
    const d = JSON.stringify(body);
    const r = http.request({ hostname: 'localhost', port: 8080, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { ok(JSON.parse(b)); } catch { ok({ raw: b }); } });
    }); r.on('error', e => no(e)); r.write(d); r.end();
  });
}

function get(p, token) {
  return new Promise((ok, no) => {
    const r = http.request({ hostname: 'localhost', port: 8080, path: p, method: 'GET', headers: { 'Authorization': 'Bearer ' + token } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { ok(JSON.parse(b)); } catch { ok({ raw: b }); } });
    }); r.on('error', e => no(e)); r.end();
  });
}

(async () => {
  try {
    const login = await post('/api/super-admin/login', { username: 'master', password: 'master123' });
    log('LOGIN: ' + (login.success ? 'OK' : 'FAIL ' + (login.error || JSON.stringify(login))));
    if (!login.token) { log('NO TOKEN'); fs.writeFileSync(out, lines.join('\n')); return; }
    const tk = login.token;
    log('TOKEN OK');

    const org1 = await get('/api/sa/companies/1/org', tk);
    log('ORG1 success=' + org1.success);
    if (org1.error) log('ORG1 error: ' + org1.error.substring(0, 300));
    if (org1.data) log('ORG1 company=' + (org1.data.company && org1.data.company.name) + ' users=' + (org1.data.users && org1.data.users.length));

    const org2 = await get('/api/sa/companies/2/org', tk);
    log('ORG2 success=' + org2.success);
    if (org2.error) log('ORG2 error: ' + org2.error.substring(0, 300));
    if (org2.data) log('ORG2 company=' + (org2.data.company && org2.data.company.name) + ' users=' + (org2.data.users && org2.data.users.length));

    log('DONE');
  } catch (e) {
    log('EXCEPTION: ' + e.message);
  }
  fs.writeFileSync(out, lines.join('\n'));
})();
