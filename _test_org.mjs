import http from 'http';
import fs from 'fs';
const log = (msg) => { console.log(msg); fs.appendFileSync('_test_result.txt', msg + '\n'); };
fs.writeFileSync('_test_result.txt', '');

function post(path, body) {
  return new Promise((ok, no) => {
    const d = JSON.stringify(body);
    const r = http.request({ hostname: 'localhost', port: 8080, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { ok(JSON.parse(b)) } catch { ok(b) } });
    }); r.on('error', no); r.write(d); r.end();
  });
}

function get(path, token) {
  return new Promise((ok, no) => {
    const r = http.request({ hostname: 'localhost', port: 8080, path, method: 'GET', headers: { 'Authorization': `Bearer ${token}` } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { ok(JSON.parse(b)) } catch { ok(b) } });
    }); r.on('error', no); r.end();
  });
}

const login = await post('/api/super-admin/login', { username: 'master', password: 'master123' });
log('LOGIN: ' + (login.success ? 'OK' : 'FAIL') + ' ' + (login.error || ''));
if (!login.token) { log('No token, stopping'); process.exit(1); }

const tk = login.token;

const org1 = await get('/api/sa/companies/1/org', tk);
log('\nORG /1 success: ' + org1.success);
if (org1.error) log('ORG /1 error: ' + org1.error);
if (org1.data) log('ORG /1 company: ' + org1.data.company?.name + ' | users: ' + org1.data.users?.length);

const org2 = await get('/api/sa/companies/2/org', tk);
log('\nORG /2 success: ' + org2.success);
if (org2.error) log('ORG /2 error: ' + org2.error);
if (org2.data) log('ORG /2 company: ' + org2.data.company?.name + ' | users: ' + org2.data.users?.length);
log('\nDONE');
