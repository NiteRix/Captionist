// Needs playwright-core and a Chromium build:
//   npm i playwright-core
//   CHROMIUM_PATH=/path/to/chrome node scripts/make-screenshots.mjs
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
        ping: { ok: true, app: '25.3.0', hasSequence: true, scriptVersion: '0.1.0', log: [] },
        getSequenceInfo: { ...sequence, log: [] },
        importSubtitles: { ok: true, imported: true, attached: true, log: [] }
      };
      setTimeout(() => cb(JSON.stringify(answers[fn] || { ok: false, error: 'unknown', log: [] })), 20);
    }
  };
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

// Drive the real chunker with real word data, exactly as a transcription would.
await page.evaluate(() => {
  const line = 'So the whole point of this plugin is that it runs on your own machine. ' +
               'Nothing gets uploaded anywhere, and it does not cost you a subscription. ' +
               'You pick the model you want and it just works.';
  let t = 0.6;
  const words = line.split(/\s+/).map(w => {
    const dur = 0.16 + Math.min(0.42, w.length * 0.042);
    const rec = { text: w, start: t, end: t + dur, confidence: 0.95 };
    t += dur + (/[.,]$/.test(w) ? 0.28 : 0.045);
    return rec;
  });
  window.__demoWords = words;
  const cues = window.Chunker.snapToFrames(window.Chunker.build(words, { preset: 'long' }), 29.97);
  const s = window.Chunker.stats(cues);
  document.getElementById('results').classList.remove('hidden');
  document.getElementById('empty-hint').classList.add('hidden');
  document.getElementById('stat-cues').textContent = String(s.count);
  document.getElementById('stat-words').textContent = String(words.length);
  document.getElementById('stat-perCue').textContent = s.wordsPerCue.toFixed(1);
  document.getElementById('detected').textContent =
    'Detected EN · average ' + s.averageDuration.toFixed(2) + 's on screen · ' +
    Math.round(s.charsPerCue) + ' characters per caption';
  const host = document.getElementById('preview');
  host.innerHTML = '';
  cues.forEach(c => {
    const row = document.createElement('div'); row.className = 'cue';
    const time = document.createElement('span'); time.className = 'cue-time';
    time.textContent = window.Subtitles.stamp(c.start, '.').slice(3, 11);
    const text = document.createElement('span'); text.className = 'cue-text'; text.textContent = c.text;
    row.appendChild(time); row.appendChild(text); host.appendChild(row);
  });
  document.getElementById('import').disabled = false;
  document.getElementById('save').disabled = false;
  document.getElementById('status').textContent =
    'Transcribed ' + words.length + ' words into ' + cues.length + ' captions.';
  document.getElementById('status').className = 'status good';
  window.__cueCount = cues.length;
});
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(OUT, '1-long-form.png') });
console.log('1-long-form.png  cues:', await page.evaluate(() => window.__cueCount));

// Same words, short form - the whole point of having two modes.
await page.evaluate(() => {
  const cues = window.Chunker.snapToFrames(
    window.Chunker.build(window.__demoWords, { preset: 'short' }), 29.97);
  const s = window.Chunker.stats(cues);
  document.getElementById('style').value = 'short';
  document.getElementById('maxWords').value = 3;
  document.getElementById('maxWords-out').textContent = '3';
  document.getElementById('stat-cues').textContent = String(s.count);
  document.getElementById('stat-perCue').textContent = s.wordsPerCue.toFixed(1);
  document.getElementById('detected').textContent =
    'Detected EN · average ' + s.averageDuration.toFixed(2) + 's on screen · ' +
    Math.round(s.charsPerCue) + ' characters per caption';
  const host = document.getElementById('preview');
  host.innerHTML = '';
  cues.forEach(c => {
    const row = document.createElement('div'); row.className = 'cue';
    const time = document.createElement('span'); time.className = 'cue-time';
    time.textContent = window.Subtitles.stamp(c.start, '.').slice(3, 11);
    const text = document.createElement('span'); text.className = 'cue-text'; text.textContent = c.text;
    row.appendChild(time); row.appendChild(text); host.appendChild(row);
  });
  window.__cueCount = cues.length;
});
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(OUT, '2-short-form.png') });
console.log('2-short-form.png cues:', await page.evaluate(() => window.__cueCount));

// Models tab
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
      '<div class="model-meta">' + (have ? 'installed' : '~' + (m.approxMB >= 1000 ? (m.approxMB/1024).toFixed(1) + ' GB' : m.approxMB + ' MB')) +
      ' · ' + m.speed + ' · ' + m.quality + (m.multilingual ? '' : ' · English only') + '</div></div>' +
      '<div class="model-action"><button class="btn-tiny' + (have ? ' is-danger' : '') + '">' +
      (have ? 'Remove' : 'Download') + '</button></div>';
    host.appendChild(row);
  });
  document.getElementById('disk-usage').textContent =
    'Models on disk: 1.6 GB  ·  C:\\Users\\you\\AppData\\Roaming\\Captionist\\models';
});
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(OUT, '3-models.png') });
console.log('3-models.png');

await browser.close();
