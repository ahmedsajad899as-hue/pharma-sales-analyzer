const fs = require('fs');
let c = fs.readFileSync('server/modules/monthly-plans/monthly-plans.controller.js', 'utf8');

// Fix deleteVisit
c = c.replace(
  `    const visit = await prisma.doctorVisit.findFirst({\r\n      where: { id: visitId, userId: req.user.id },\r\n    });\r\n    if (!visit) return res.status(404).json({ error: 'Visit not found' });\r\n    await prisma.doctorVisit.delete({ where: { id: visitId } });`,
  `    const visit = await prisma.doctorVisit.findUnique({ where: { id: visitId } });\r\n    if (!visit) return res.status(404).json({ error: 'Visit not found' });\r\n    await prisma.doctorVisit.delete({ where: { id: visitId } });`
);

// Fix patchVisitItem
c = c.replace(
  `    // التحقق من ملكية الزيارة\r\n    const visit = await prisma.doctorVisit.findFirst({\r\n      where: { id: visitId, userId: req.user.id },\r\n    });\r\n    if (!visit) return res.status(404).json({ error: 'Visit not found' });`,
  `    const visit = await prisma.doctorVisit.findUnique({ where: { id: visitId } });\r\n    if (!visit) return res.status(404).json({ error: 'Visit not found' });`
);

fs.writeFileSync('server/modules/monthly-plans/monthly-plans.controller.js', c, 'utf8');
console.log('Done');
