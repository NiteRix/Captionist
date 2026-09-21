// Renders animation filmstrips by simulating Premiere's linear keyframe
// interpolation frame by frame - the only way to see what the curves do
// without opening Premiere.
//   npm i playwright-core
//   CHROMIUM_PATH=/path/to/chrome node scripts/make-animation-strip.mjs
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = path.join(REPO, 'docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--allow-file-access-from-files']
});
const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
page.on('pageerror', e => console.log('  [error]', e.message));
await page.goto('file://' + path.join(REPO, 'extension/index.html'));
await page.waitForTimeout(300);
await page.addScriptTag({ path: path.join(REPO, 'extension/js/renderer.js') });
await page.addScriptTag({ path: path.join(REPO, 'extension/js/animation.js') });

const result = await page.evaluate(() => {
  // Premiere interpolates linearly between keyframes by default, so that is
  // what the filmstrip has to simulate to be worth anything.
  function valueAt(keys, t) {
    if (!keys || !keys.length) return null;
    if (t <= keys[0].time) return keys[0].value;
    if (t >= keys[keys.length - 1].time) return keys[keys.length - 1].value;
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i].time) {
        const a = keys[i - 1], b = keys[i];
        const f = (t - a.time) / (b.time - a.time);
        if (Array.isArray(a.value)) {
          return [a.value[0] + (b.value[0] - a.value[0]) * f,
                  a.value[1] + (b.value[1] - a.value[1]) * f];
        }
        return a.value + (b.value - a.value) * f;
      }
    }
    return keys[keys.length - 1].value;
  }

  const fps = 30;
  const duration = 0.8;
  const frame = { width: 1080, height: 1080 };
  const cue = { text: 'POP', words: [{ text: 'POP' }] };
  const style = { preset: 'punch', sizePct: 14, position: 'middle', offsetPct: 0 };

  const presets = ['pop', 'rise', 'fade'];
  const strips = {};
  const traces = {};

  for (const preset of presets) {
    const keys = window.Animation.keyframesFor(duration, { preset, intensity: 1, fps });
    traces[preset] = JSON.parse(JSON.stringify(keys));

    const count = 10;
    const cell = 200;
    const strip = document.createElement('canvas');
    strip.width = cell * count;
    strip.height = cell + 26;
    const sctx = strip.getContext('2d');
    sctx.fillStyle = '#15181d';
    sctx.fillRect(0, 0, strip.width, strip.height);

    const layer = document.createElement('canvas');
    window.Renderer.draw(layer, cue, style, frame, -1);

    for (let i = 0; i < count; i++) {
      const t = (i / (count - 1)) * duration;
      const scale = (valueAt(keys.scale, t) ?? 100) / 100;
      const opacity = (valueAt(keys.opacity, t) ?? 100) / 100;
      const pos = valueAt(keys.position, t) || [0.5, 0.5];

      const x0 = i * cell;
      sctx.save();
      sctx.beginPath();
      sctx.rect(x0 + 2, 2, cell - 4, cell - 4);
      sctx.clip();
      sctx.fillStyle = '#39465e';
      sctx.fillRect(x0 + 2, 2, cell - 4, cell - 4);

      sctx.globalAlpha = opacity;
      const dw = (cell - 4) * scale, dh = (cell - 4) * scale;
      const cxp = x0 + 2 + (cell - 4) * pos[0];
      const cyp = 2 + (cell - 4) * pos[1];
      sctx.drawImage(layer, cxp - dw / 2, cyp - dh / 2, dw, dh);
      sctx.restore();

      sctx.fillStyle = '#8e9298';
      sctx.font = '15px monospace';
      sctx.textAlign = 'center';
      sctx.fillText(t.toFixed(2) + 's', x0 + cell / 2, cell + 19);
    }

    sctx.fillStyle = '#ff9f43';
    sctx.font = 'bold 17px sans-serif';
    sctx.textAlign = 'left';
    sctx.fillText(preset.toUpperCase(), 10, 24);

    strips[preset] = strip.toDataURL('image/png');
  }
  return { strips, traces };
});

for (const [name, url] of Object.entries(result.strips)) {
  const b64 = url.slice(url.indexOf(',') + 1);
  fs.writeFileSync(path.join(OUT, '5-animation-' + name + '.png'), Buffer.from(b64, 'base64'));
}
console.log('filmstrips:', Object.keys(result.strips).join(', '));
console.log('\npop keyframes (0.8s clip @30fps):');
for (const [prop, keys] of Object.entries(result.traces.pop)) {
  console.log('  ' + prop.padEnd(9), keys.map(k => `${k.time.toFixed(3)}s=${Array.isArray(k.value) ? '[' + k.value.map(v=>v.toFixed(2)).join(',') + ']' : k.value.toFixed(1)}`).join('  '));
}
await browser.close();
