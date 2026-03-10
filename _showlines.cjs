const fs = require('fs');
const c = fs.readFileSync('server/modules/monthly-plans/monthly-plans.controller.js', 'utf8');
const lines = c.split('\n');
for (let i = 470; i < 510; i++) console.log(i+1, JSON.stringify(lines[i]));
