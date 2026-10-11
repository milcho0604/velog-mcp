import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
await p.goto('file://' + process.cwd() + '/cuttoon/toon.html');
await p.evaluate(() => document.fonts.ready);
for (let i = 1; i <= 9; i++) await p.locator('#p' + i).screenshot({ path: `cuttoon/${String(i).padStart(2,'0')}.png` });
await b.close();
