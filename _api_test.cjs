const http = require('http');
const fs = require('fs');
const OUT = 'd:/my code/marketing/pharma-sales-analyzer/_api_test.txt';

function write(msg) { fs.writeFileSync(OUT, msg); }

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port: 8080, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    });
    req.on('response', (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => reject(new Error('TIMEOUT')));
    req.write(data);
    req.end();
  });
}

function httpGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: 'localhost', port: 8080, path,
      headers: { 'Authorization': 'Bearer ' + token }
    });
    req.on('response', (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => reject(new Error('TIMEOUT')));
  });
}

(async () => {
  const results = [];
  try {
    // Test 1: SA Login
    const login = await httpPost('/api/super-admin/login', { username: 'master', password: '1231234a' });
    const loginData = JSON.parse(login.body);
    results.push('LOGIN: ' + login.status + ' success=' + loginData.success);

    if (!loginData.token) {
      results.push('NO TOKEN - cannot continue');
      write(results.join('\n'));
      process.exit(1);
    }

    const token = loginData.token;

    // Test 2: Org chart for company 1
    const org1 = await httpGet('/api/sa/companies/1/org', token);
    results.push('ORG1: status=' + org1.status + ' body=' + org1.body.substring(0, 300));

    // Test 3: Org chart for company 2
    const org2 = await httpGet('/api/sa/companies/2/org', token);
    results.push('ORG2: status=' + org2.status + ' body=' + org2.body.substring(0, 300));

  } catch (e) {
    results.push('ERROR: ' + e.message);
  }

  write(results.join('\n\n'));
  process.exit(0);
})();
