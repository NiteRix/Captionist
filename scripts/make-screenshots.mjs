// Renders the real panel and photographs it. Needs playwright-core and a
// Chromium build:
//   npm i playwright-core
//   CHROMIUM_PATH=/path/to/chrome node scripts/make-screenshots.mjs
//
// Only the CEP bridge is stubbed. Everything visible in the shots - the cue
// list, the chunker's output, the caption preview, the in-place editing - is
// produced by the same files that ship in the extension, driven through
// window.__panel so the screenshots cannot drift from the code.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = path.join(REPO, 'docs/screenshots');
mkdirSync(OUT, { recursive: true });

const SEQUENCE = {
  ok: true, name: 'EP12 – Interview Master', sequenceID: '1a2b3c',
  fps: 29.97, duration: 42.0, videoTrackCount: 2, warnings: [],
  audioTracks: [{ index: 0, name: 'Dialogue', muted: false, clips: [{
    track: 0, index: 0, name: 'take.wav', start: 0, end: 42, inPoint: 0,
    outPoint: 42, speed: 1, disabled: false, mediaPath: '/fake/take.wav' }] }]
};

const stub = (sequence) => {
  window.__adobe_cep__ = {
    getExtensionId: () => 'com.niterix.captionist.panel',
    getSystemPath: () => '/Users/you/Library/Application Support/Adobe/CEP/extensions/com.niterix.captionist',
    getHostEnvironment: () => JSON.stringify({
      appName: 'PPRO', appVersion: '25.3.0',
      appSkinInfo: { panelBackgroundColor: { color: { red: 30, green: 31, blue: 34, alpha: 255 } } }
    }),
    evalScript: (script, cb) => {
      const fn = (script.match(/\$\.captionist\.(\w+)\(/) || [])[1];
      const answers = {
        ping: { ok: true, app: '25.3.0', hasSequence: true, scriptVersion: '0.1.2', log: [] },
        getSequenceInfo: { ...sequence, log: [] },
        importSubtitles: { ok: true, imported: true, attached: true, log: [] }
      };
      setTimeout(() => cb(JSON.stringify(answers[fn] || { ok: false, error: 'unknown', log: [] })), 20);
    }
  };
};

// Word timings shaped the way whisper emits them, so the chunker gets real
// gaps and punctuation to split on rather than an even metronome.
const fakeWords = (line, from, doubtful) => {
  let t = from;
  const low = (doubtful || '').split(/\s+/).filter(Boolean);
  return line.split(/\s+/).map((w) => {
    const dur = 0.16 + Math.min(0.42, w.length * 0.042);
    // Whisper is least certain exactly where it is wrong, which is the whole
    // reason the flag is worth showing.
    const shaky = low.indexOf(w.replace(/[^A-Za-z']/g, '')) !== -1;
    const rec = { text: w, start: t, end: t + dur, confidence: shaky ? 0.31 : 0.95 };
    t += dur + (/[.,]$/.test(w) ? 0.28 : 0.045);
    return rec;
  });
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--allow-file-access-from-files']
});
const page = await browser.newPage({ viewport: { width: 400, height: 820 }, deviceScaleFactor: 2 });
page.on('pageerror', e => console.log('  [error]', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('  [console]', m.text()); });

await page.addInitScript(stub, SEQUENCE);
await page.goto('file://' + path.join(REPO, 'extension/index.html'));
await page.waitForTimeout(700);

const load = (line, from = 0.6, doubtful = '') => page.evaluate(({ line, from, doubtful, src }) => {
  const words = new Function('line', 'from', 'doubtful', 'return (' + src + ')(line, from, doubtful)')(line, from, doubtful);
  window.__demoWords = words;
  const cues = window.Chunker.snapToFrames(window.Chunker.build(words, { preset: 'long' }), 29.97);
  window.__panel.load(words, cues, 'en');
  document.getElementById('status').textContent =
    'Transcribed ' + words.length + ' words into ' + cues.length + ' captions.';
  document.getElementById('status').className = 'status good';
  return cues.length;
}, { line, from, doubtful, src: fakeWords.toString() });

const shot = async (name, note) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, name) });
  console.log(name.padEnd(24), note ?? '');
};

// 1 - long form, the default rhythm.
const longCues = await load(
  'So the whole point of this plugin is that it runs on your own machine. ' +
  'Nothing gets uploaded anywhere, and it does not cost you a subscription. ' +
  'You pick the model you want and it just works.');
await shot('1-long-form.png', 'cues: ' + longCues);

// 2 - the same words through the short form preset. Driven by the real select,
// so this is the panel re-chunking, not the harness drawing a second list.
await page.selectOption('#style', 'short');
await page.waitForTimeout(500);
await shot('2-short-form.png',
  'cues: ' + await page.evaluate(() => window.__panel.cues().length));

// 3 - the review pass: what is left to check, which words to check, and
// correcting them in place before any of it is baked into a PNG.
await page.selectOption('#style', 'long');
await page.waitForTimeout(500);
await load('We shipped the beta on a Friday and then we all went home. ' +
           'Their was no plan for what came next, which in hindsight was the hole problem.',
           0.6, 'Their hole');
const edits = await page.evaluate(() => {
  const fix = (from, to) => {
    const cues = window.__panel.cues();
    for (let i = 0; i < cues.length; i++) {
      if (cues[i].text.indexOf(from) !== -1) {
        return window.__panel.type(i, cues[i].text.split(from).join(to)).text;
      }
    }
    return null;
  };
  // Only the first is corrected. The second stays flagged, which is what the
  // panel actually looks like mid-review: one row fixed, one still to look at.
  return [fix('Their was', 'There was')];
});
await page.evaluate(() => {
  const el = document.querySelector('.cue.is-edited .cue-text');
  if (el) { el.focus(); }
});
await shot('3-review.png', edits.filter(Boolean).length + ' corrections: ' + JSON.stringify(edits));
await page.evaluate(() => document.activeElement.blur());

// 4 - look and motion, with the live preview drawn by the real renderer.
await page.evaluate(() => {
  document.querySelector('.tab[data-tab="transcribe"]').click();
  const card = document.getElementById('look-card');
  card.open = true;
  document.getElementById('settings-card').open = false;
  document.getElementById('stylePreset').value = 'punch';
  document.getElementById('animPreset').value = 'pop';
  document.getElementById('sizePct').value = 7.5;
  document.getElementById('sizePct-out').textContent = '7.5';
  document.getElementById('position').value = 'middle';
  document.getElementById('karaoke').checked = true;
  document.getElementById('uppercase').checked = true;
  // Outside CEP there is no Node, so fill the picker the way a real scan would.
  // Families that genuinely exist on the machine taking the screenshot, so the
  // preview below is really rendered in the selected font.
  const fams = [
    ['DejaVu Sans', 2], ['DejaVu Sans Mono', 4], ['DejaVu Serif', 2],
    ['FreeSans', 4], ['FreeSerif', 4], ['Liberation Mono', 4],
    ['Liberation Sans', 4], ['Liberation Serif', 4]
  ];
  const fsel = document.getElementById('fontFamily');
  fsel.innerHTML = '<option value="">Don\u2019t change</option>';
  fams.forEach(([name, n]) => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name + (n > 1 ? '  (' + n + ')' : '');
    fsel.appendChild(o);
  });
  fsel.value = 'Liberation Sans';
  const ssel = document.getElementById('fontStyle');
  ssel.innerHTML = '';
  ['Regular', 'Bold', 'Italic', 'Bold Italic'].forEach(label => {
    const o = document.createElement('option');
    o.value = label; o.textContent = label; ssel.appendChild(o);
  });
  ssel.value = 'Bold';
  ssel.disabled = false;
  document.getElementById('stylePreset').dispatchEvent(new Event('change'));
  ['animate', 'import', 'save'].forEach(id => { document.getElementById(id).disabled = false; });
  // Collapse what is above so the look section lands in frame.
  document.getElementById('results').classList.add('hidden');
  card.scrollIntoView({ block: 'start' });
});
await page.waitForTimeout(400);
await page.evaluate(() => {
  document.getElementById('font-hint').textContent =
    '8 font families found. \u201cDon\u2019t change\u201d keeps the look preset\u2019s own font.';
  const style = window.Renderer.merged({
    preset: 'punch', sizePct: 7.5, position: 'middle', offsetPct: 0,
    fontFamily: 'Liberation Sans', fontWeight: 700, fontStyle: 'normal', uppercase: true
  });
  const canvas = document.getElementById('look-preview');
  const frame = { width: 1920, height: 1080 };
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  const ctx = canvas.getContext('2d');
  const scale = Math.min(canvas.width / frame.width, canvas.height / frame.height);
  const w = frame.width * scale, h = frame.height * scale;
  const ox = (canvas.width - w) / 2, oy = (canvas.height - h) / 2;
  const g = ctx.createLinearGradient(ox, oy, ox + w, oy + h);
  g.addColorStop(0, '#39465e'); g.addColorStop(1, '#222b38');
  ctx.fillStyle = g; ctx.fillRect(ox, oy, w, h);
  const layer = document.createElement('canvas');
  const cue = { text: 'This is how your captions will look',
                words: 'This is how your captions will look'.split(' ').map(t => ({ text: t })) };
  window.Renderer.draw(layer, cue, style, frame, 1);
  ctx.drawImage(layer, ox, oy, w, h);
});
await page.waitForTimeout(150);
await shot('4-look-and-motion.png');
await page.evaluate(() => { document.getElementById('look-card').open = false; window.scrollTo(0, 0); });

// 6 - the model picker. (5 is the animation strip, from make-animation-strip.mjs.)
await page.evaluate(() => {
  document.querySelector('.tab[data-tab="models"]').click();
  // Node is absent outside CEP, so paint the catalogue the way it will look.
  const host = document.getElementById('model-list');
  host.innerHTML = '';
  window.Models.CATALOG.forEach((m, i) => {
    const have = i === 8;
    const row = document.createElement('div');
    row.className = 'model' + (have ? ' is-ready' : '');
    row.innerHTML =
      '<div class="model-main"><div class="model-name">' + m.label +
      (m.recommended ? '<span class="pill">recommended</span>' : '') + '</div>' +
      '<div class="model-meta">' + (have ? 'installed' : '~' + (m.approxMB >= 1000 ? (m.approxMB / 1024).toFixed(1) + ' GB' : m.approxMB + ' MB')) +
      ' · ' + m.speed + ' · ' + m.quality + (m.multilingual ? '' : ' · English only') + '</div></div>' +
      '<div class="model-action"><button class="btn-tiny' + (have ? ' is-danger' : '') + '">' +
      (have ? 'Remove' : 'Download') + '</button></div>';
    host.appendChild(row);
  });
  document.getElementById('disk-usage').textContent =
    'Models on disk: 1.6 GB  ·  C:\\Users\\you\\AppData\\Roaming\\Captionist\\models';
});
await shot('6-models.png');

await browser.close();
