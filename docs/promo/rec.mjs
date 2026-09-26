import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const [mode, arg] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto('file://' + process.cwd() + '/ad.html');
await p.evaluate(() => document.fonts.ready);
if (mode === 'preview') {
  for (const t of arg.split(',')) { await p.evaluate(t => render(+t), t); await p.screenshot({ path: `prev_${t}.png` }); }
} else {
  const FPS = 30, dur = await p.evaluate(() => DUR);
  const ff = spawn(process.env.FF, ['-y','-f','image2pipe','-framerate',String(FPS),'-c:v','png','-i','-','-c:v','libx264','-pix_fmt','yuv420p','-crf','18','-preset','slow','-movflags','+faststart', arg], { stdio: ['pipe','inherit','inherit'] });
  for (let i = 0; i < dur * FPS; i++) {
    await p.evaluate(t => render(t), i / FPS);
    const buf = await p.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r));
}
await b.close();
