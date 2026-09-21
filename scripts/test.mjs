/*
 * Tests the parts of Captionist that are pure arithmetic and text handling:
 * turning whisper's tokens into words, and words into captions.
 *
 * None of it needs Premiere, whisper or an audio file, so all of it runs on
 * every push. The chunker in particular decides how the captions actually
 * read, and it is the piece most likely to be tuned later.
 */
import { readFileSync, existsSync } from 'node:fs';
import fsMod from 'node:fs';
import osMod from 'node:os';
import pathMod from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok   ${name}`); passed++; }
  catch (err) { console.error(`FAIL ${name}\n     ${err.message}`); failed++; }
}

/* ---------------------------------------------------------------- harness */

function load(...files) {
  const sandbox = {
    Math, Number, String, Array, Object, JSON, Date, RegExp,
    Float32Array, Uint8Array, DataView, ArrayBuffer,
    isFinite, isNaN, parseFloat, parseInt, console, setTimeout, Promise,
    navigator: { platform: 'Linux' },
    localStorage: { getItem: () => null, setItem: () => {} },
    XMLHttpRequest: function () {},
    process: { env: process.env },
    // Fonts reads real files, so give it a real filesystem.
    Env: {
      hasNode: () => true,
      isWindows: false,
      node: () => ({ fs: fsMod, os: osMod, path: pathMod })
    }
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  for (const f of files) {
    vm.runInContext(readFileSync(f, 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

const { Chunker, Whisper, Subtitles, Animation, Fonts } = load(
  'extension/js/chunker.js',
  'extension/js/whisper.js',
  'extension/js/subtitles.js',
  'extension/js/animation.js',
  'extension/js/fonts.js'
);

// Values crossing a vm context keep that context's prototypes, so deepEqual
// would reject them on identity alone. Round-trip them into this realm first.
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Builds evenly spaced words, 0.3 s each, from a sentence. */
function say(text, startAt = 0, per = 0.3) {
  return text.split(/\s+/).filter(Boolean).map((w, i) => ({
    text: w,
    start: startAt + i * per,
    end: startAt + i * per + per * 0.9,
    confidence: 1
  }));
}

/* ------------------------------------------------- whisper token handling */

test('tokens reassemble into words, with punctuation attached', () => {
  const data = {
    result: { language: 'en' },
    transcription: [{
      offsets: { from: 0, to: 2000 },
      text: ' Hello there, friend',
      tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 }, id: 50363, p: 1 },
        { text: ' Hello',  offsets: { from: 0, to: 500 }, id: 1, p: 0.9 },
        { text: ' there',  offsets: { from: 500, to: 900 }, id: 2, p: 0.8 },
        { text: ',',       offsets: { from: 900, to: 950 }, id: 3, p: 0.7 },
        { text: ' fri',    offsets: { from: 1000, to: 1400 }, id: 4, p: 0.9 },
        { text: 'end',     offsets: { from: 1400, to: 1800 }, id: 5, p: 0.6 }
      ]
    }]
  };
  const { words, language } = Whisper.parse(data);
  assert.equal(language, 'en');
  assert.deepEqual(plain(words.map(w => w.text)), ['Hello', 'there,', 'friend']);
  assert.equal(words[0].start, 0);
  assert.equal(words[2].end, 1.8, 'a split word ends when its last piece does');
  assert.equal(words[2].confidence, 0.6, 'confidence is the weakest piece');
});

test('t_dtw is centiseconds while offsets are milliseconds', () => {
  // Getting this wrong shifts every caption by a factor of ten.
  const data = {
    transcription: [{
      offsets: { from: 0, to: 5000 },
      tokens: [
        { text: ' one', offsets: { from: 1000, to: 1400 }, t_dtw: 120, id: 1, p: 1 },
        { text: ' two', offsets: { from: 2000, to: 2400 }, t_dtw: 0,   id: 2, p: 1 }
      ]
    }]
  };
  const { words } = Whisper.parse(data);
  assert.equal(words[0].start, 1.20, 't_dtw 120 centiseconds is 1.2 s');
  assert.equal(words[1].start, 2.00, 'no t_dtw falls back to offsets in ms');
});

test('special tokens never become words', () => {
  const data = {
    transcription: [{
      offsets: { from: 0, to: 1000 },
      tokens: [
        { text: '<|notimestamps|>', offsets: { from: 0, to: 0 }, id: 50364, p: 1 },
        { text: '[_TT_450]', offsets: { from: 0, to: 0 }, id: 50900, p: 1 },
        { text: ' word', offsets: { from: 100, to: 500 }, id: 1, p: 1 }
      ]
    }]
  };
  assert.deepEqual(plain(Whisper.parse(data).words.map(w => w.text)), ['word']);
});

test('out-of-order and missing timings are repaired', () => {
  const data = {
    transcription: [{
      offsets: { from: 0, to: 3000 },
      tokens: [
        { text: ' a', offsets: { from: 1000, to: 1500 }, id: 1, p: 1 },
        { text: ' b', offsets: { from: 500, to: 400 }, id: 2, p: 1 },   // backwards
        { text: ' c', id: 3, p: 1 }                                      // no timing
      ]
    }]
  };
  const { words } = Whisper.parse(data);
  for (let i = 0; i < words.length; i++) {
    assert.ok(words[i].end > words[i].start, `word ${i} has a real duration`);
    if (i) { assert.ok(words[i].start >= words[i - 1].start, 'words stay in order'); }
  }
});

test('a segment with no tokens still yields a cue', () => {
  const data = { transcription: [{ offsets: { from: 500, to: 2500 }, text: ' no token detail ' }] };
  const { words } = Whisper.parse(data);
  assert.equal(words.length, 1);
  assert.equal(words[0].text, 'no token detail');
  assert.equal(words[0].start, 0.5);
});

/* ------------------------------------------------------------- chunker */

test('short form puts only a few words on screen', () => {
  const cues = Chunker.build(say('one two three four five six seven eight nine'), { preset: 'short' });
  assert.ok(cues.length >= 3, `expected several cues, got ${cues.length}`);
  for (const c of cues) {
    assert.ok(c.words.length <= 3, `cue has ${c.words.length} words, limit is 3`);
    assert.equal(c.lines.length, 1, 'short form is one line');
  }
});

test('long form packs more per cue than short form', () => {
  const words = say('the quick brown fox jumps over the lazy dog again and again today');
  const short = Chunker.build(words, { preset: 'short' });
  const long = Chunker.build(words, { preset: 'long' });
  assert.ok(long.length < short.length,
    `long form should use fewer cues (${long.length}) than short (${short.length})`);
  assert.ok(Chunker.stats(long).wordsPerCue > Chunker.stats(short).wordsPerCue);
});

test('a sentence ending breaks the cue', () => {
  const words = say('this is done. now something else entirely happens here');
  const cues = Chunker.build(words, { preset: 'long' });
  assert.ok(cues.length >= 2, 'the full stop should start a new cue');
  assert.ok(/done\.$/.test(cues[0].text), `first cue should end at the full stop, got "${cues[0].text}"`);
});

test('a long pause breaks the cue', () => {
  const a = say('before the pause', 0);
  const b = say('after the pause', 5);        // four-second gap
  const cues = Chunker.build(a.concat(b), { preset: 'long', splitOnPunctuation: false });
  assert.ok(cues.length >= 2, 'the gap should split the cues');
  assert.ok(cues[0].end <= cues[1].start, 'cues never overlap');
});

test('cues never overlap and never run backwards', () => {
  const cues = Chunker.build(say('a b c d e f g h i j k l m n o p'), { preset: 'short' });
  for (let i = 0; i < cues.length; i++) {
    assert.ok(cues[i].end > cues[i].start, `cue ${i} has a real duration`);
    if (i) { assert.ok(cues[i].start >= cues[i - 1].end, `cue ${i} starts after cue ${i - 1} ends`); }
  }
});

test('a very short word gets a readable minimum duration', () => {
  const cues = Chunker.build([{ text: 'hi', start: 0, end: 0.05, confidence: 1 }], { preset: 'long' });
  assert.equal(cues.length, 1);
  assert.ok(cues[0].end - cues[0].start >= 0.99, `held for ${(cues[0].end - cues[0].start).toFixed(2)}s`);
});

test('line limits are respected', () => {
  const cues = Chunker.build(say('alpha bravo charlie delta echo foxtrot golf hotel india'),
                             { preset: 'long', maxCharsPerLine: 20, maxLines: 2 });
  for (const c of cues) {
    assert.ok(c.lines.length <= 2, `cue wrapped to ${c.lines.length} lines`);
    for (const line of c.lines) {
      assert.ok(line.length <= 26, `line too long: "${line}"`);
    }
  }
});

test('widow control pulls a stranded short word back', () => {
  const words = say('keep these together ok', 0, 0.2);
  const withControl = Chunker.build(words, { preset: 'long', avoidWidows: true });
  const last = withControl[withControl.length - 1];
  assert.ok(last.words.length > 1 || withControl.length === 1,
    'a lone trailing short word should have been absorbed');
});

test('frame snapping lands every boundary on the grid', () => {
  const cues = Chunker.snapToFrames(Chunker.build(say('one two three four five six'), { preset: 'short' }), 30);
  for (const c of cues) {
    for (const t of [c.start, c.end]) {
      assert.ok(Math.abs(t * 30 - Math.round(t * 30)) < 1e-6, `${t} is not on a frame`);
    }
  }
});

test('no words means no cues, not a crash', () => {
  assert.deepEqual(plain(Chunker.build([], { preset: 'short' })), []);
  assert.deepEqual(plain(Chunker.build(null, { preset: 'long' })), []);
});

test('explicit settings override the preset', () => {
  const cues = Chunker.build(say('one two three four five six seven eight'),
                             { preset: 'long', maxWords: 2 });
  for (const c of cues) { assert.ok(c.words.length <= 2, `got ${c.words.length} words`); }
});

/* ------------------------------------------------------------ subtitles */

test('SRT timecodes use a comma and pad correctly', () => {
  assert.equal(Subtitles.stamp(0, ','), '00:00:00,000');
  assert.equal(Subtitles.stamp(61.5, ','), '00:01:01,500');
  assert.equal(Subtitles.stamp(3661.25, ','), '01:01:01,250');
});

test('SRT is numbered from one and blank-line separated', () => {
  const cues = Chunker.build(say('hello there world again'), { preset: 'short' });
  const srt = Subtitles.toSrt(cues);
  assert.ok(srt.startsWith('1\n'), 'first cue is numbered 1');
  assert.ok(srt.includes(' --> '), 'has a timecode arrow');
  const blocks = srt.trim().split('\n\n');
  assert.equal(blocks.length, cues.length, 'one block per cue');
});

test('VTT carries its header and uses a dot', () => {
  const vtt = Subtitles.toVtt(Chunker.build(say('one two'), { preset: 'short' }));
  assert.ok(vtt.startsWith('WEBVTT'), 'starts with the WEBVTT header');
  assert.ok(/\d\d:\d\d:\d\d\.\d\d\d/.test(vtt), 'uses a dot before milliseconds');
});

test('plain text splits into paragraphs on long gaps', () => {
  const cues = Chunker.build(say('first part here', 0).concat(say('second part here', 10)),
                             { preset: 'long' });
  const text = Subtitles.toText(cues, 1.5);
  assert.ok(text.includes('\n\n'), 'a ten-second gap should start a new paragraph');
});

/* ------------------------------------------------------- editing cues */

test('a spelling fix keeps every word timing untouched', () => {
  // The common case: same word count, so karaoke timing must not move at all.
  const cues = Chunker.build(say('their going to the shop'), { preset: 'long' });
  const before = cues[0].words.map(w => [w.start, w.end]);
  const after = Chunker.editText(cues[0], "they're going to the shop", { preset: 'long' });

  assert.equal(after.words.length, 5);
  assert.equal(after.words[0].text, "they're");
  assert.deepEqual(plain(after.words.map(w => [w.start, w.end])), plain(before),
    'timings should be carried across verbatim');
  assert.equal(after.edited, true);
  assert.equal(after.start, cues[0].start);
  assert.equal(after.end, cues[0].end);
});

test('adding or removing words redistributes across the same span', () => {
  const cues = Chunker.build(say('one two three'), { preset: 'long' });
  const cue = cues[0];
  const after = Chunker.editText(cue, 'one two three four five', { preset: 'long' });

  assert.equal(after.words.length, 5);
  assert.equal(after.start, cue.start, 'the cue still starts where it did');
  assert.equal(after.end, cue.end, 'and still ends where it did');
  assert.ok(after.words[0].start >= cue.start - 1e-9);
  assert.ok(after.words[4].end <= cue.end + 1e-9, 'no word runs past the cue');
  for (let i = 1; i < after.words.length; i++) {
    assert.ok(after.words[i].start >= after.words[i - 1].start, 'words stay in order');
  }
});

test('longer words get more of the span than shorter ones', () => {
  const cues = Chunker.build(say('a b'), { preset: 'long' });
  const after = Chunker.editText(cues[0], 'I extraordinarily', { preset: 'long' });
  const shortDur = after.words[0].end - after.words[0].start;
  const longDur = after.words[1].end - after.words[1].start;
  assert.ok(longDur > shortDur, 'the long word should hold the screen longer');
});

test('typed line breaks are respected, otherwise text is re-wrapped', () => {
  const cues = Chunker.build(say('alpha bravo charlie delta'), { preset: 'long' });
  const manual = Chunker.editText(cues[0], 'alpha bravo\ncharlie delta', { preset: 'long' });
  assert.deepEqual(plain(manual.lines), ['alpha bravo', 'charlie delta']);

  // Typing more than the shape allows wraps onto extra lines rather than
  // overflowing one line past the readable width.
  const auto = Chunker.editText(cues[0],
    'alpha bravo charlie delta echo foxtrot golf hotel', { preset: 'long', maxCharsPerLine: 20 });
  assert.ok(auto.lines.length >= 3, `expected to wrap past the 2-line preset, got ${auto.lines.length}`);
  for (const line of auto.lines) {
    assert.ok(line.length <= 22, `line too long after edit: "${line}"`);
  }
});

test('an edited cue still writes valid SRT', () => {
  const cues = Chunker.build(say('wun too three'), { preset: 'long' });
  cues[0] = Chunker.editText(cues[0], 'one two three', { preset: 'long' });
  const srt = Subtitles.toSrt(cues);
  assert.ok(srt.includes('one two three'), 'the correction should reach the file');
  assert.ok(!srt.includes('wun'), 'the original should not');
  assert.ok(srt.startsWith('1\n'));
});

test('editing to blank is refused by returning empty, not a broken cue', () => {
  const cues = Chunker.build(say('something here'), { preset: 'long' });
  const after = Chunker.editText(cues[0], '   ', { preset: 'long' });
  assert.equal(after.text, '');
  assert.deepEqual(plain(after.words), []);
  assert.equal(after.start, cues[0].start, 'timing is still intact for the caller to reject');
});

/* ------------------------------------------------------------ animation */

test('no animation means no keyframes', () => {
  assert.deepEqual(plain(Animation.keyframesFor(2, { preset: 'none' })), {});
  assert.deepEqual(plain(Animation.keyframesFor(2, { preset: 'pop', intensity: 0 })), {});
});

test('pop scales up, overshoots, then settles at rest', () => {
  const k = plain(Animation.keyframesFor(2, { preset: 'pop', intensity: 1 }));
  assert.ok(k.scale && k.scale.length >= 3, 'scale should be keyframed');
  assert.ok(k.scale[0].value < 100, 'starts small');
  assert.ok(Math.max(...k.scale.map(x => x.value)) > 100, 'overshoots past full size');
  assert.equal(k.scale[k.scale.length - 1].value, 100, 'settles at 100%');
  assert.equal(k.opacity[0].value, 0, 'fades up from nothing');
});

test('keyframe times never leave the clip', () => {
  for (const preset of Object.keys(Animation.PRESETS)) {
    for (const dur of [0.2, 0.5, 1, 6]) {
      const k = Animation.keyframesFor(dur, { preset });
      for (const prop of Object.keys(k)) {
        for (const key of k[prop]) {
          assert.ok(key.time >= 0, `${preset}/${prop} at ${dur}s has a negative time`);
          assert.ok(key.time <= dur + 1e-6, `${preset}/${prop} at ${dur}s runs past the clip`);
        }
      }
    }
  }
});

test('keyframe times run forwards', () => {
  for (const preset of Object.keys(Animation.PRESETS)) {
    const k = Animation.keyframesFor(3, { preset });
    for (const prop of Object.keys(k)) {
      for (let i = 1; i < k[prop].length; i++) {
        assert.ok(k[prop][i].time > k[prop][i - 1].time,
          `${preset}/${prop} key ${i} does not advance`);
      }
    }
  }
});

test('a very short caption still animates without eating its whole life', () => {
  // A third of a second is normal in short form; the entrance must not consume it.
  const k = Animation.keyframesFor(0.34, { preset: 'pop' });
  assert.ok(Object.keys(k).length > 0, 'should still animate');
  for (const prop of Object.keys(k)) {
    const last = k[prop][k[prop].length - 1];
    assert.ok(last.time <= 0.34 + 1e-6, `${prop} runs past the clip`);
  }
  const settle = k.scale[k.scale.length - 1].time;
  assert.ok(settle <= 0.34 * 0.6 + 1e-6, `scale settles at ${settle.toFixed(3)}s, too late in a 0.34s clip`);
});

test('intensity scales the deviation, not the rest value', () => {
  const full = plain(Animation.keyframesFor(2, { preset: 'pop', intensity: 1 }));
  const half = plain(Animation.keyframesFor(2, { preset: 'pop', intensity: 0.5 }));
  assert.ok(half.scale[0].value > full.scale[0].value,
    'a gentler pop starts closer to full size');
  assert.equal(half.scale[half.scale.length - 1].value, 100, 'still settles at rest');
  const fullDev = Math.abs(full.scale[0].value - 100);
  const halfDev = Math.abs(half.scale[0].value - 100);
  assert.ok(Math.abs(halfDev - fullDev / 2) < 0.001, 'deviation halves exactly');
});

test('rise moves position and lands centred', () => {
  const k = plain(Animation.keyframesFor(2, { preset: 'rise', intensity: 1 }));
  assert.ok(Array.isArray(k.position[0].value), 'position keys are [x, y] pairs');
  assert.ok(k.position[0].value[1] > 0.5, 'starts below centre');
  assert.deepEqual(k.position[k.position.length - 1].value, [0.5, 0.5], 'lands centred');
});

test('keyframes snap to the frame grid when a rate is given', () => {
  const k = Animation.keyframesFor(2, { preset: 'pop', fps: 30 });
  for (const prop of Object.keys(k)) {
    for (const key of k[prop]) {
      assert.ok(Math.abs(key.time * 30 - Math.round(key.time * 30)) < 1e-6,
        `${prop} key at ${key.time} is not on a frame`);
    }
  }
});

test('a lone keyframe is dropped rather than left doing nothing', () => {
  for (const preset of Object.keys(Animation.PRESETS)) {
    const k = Animation.keyframesFor(1, { preset });
    for (const prop of Object.keys(k)) {
      assert.ok(k[prop].length >= 2, `${preset}/${prop} has a single pointless keyframe`);
    }
  }
});

test('planFor keeps timings and attaches keys per clip', () => {
  const items = [
    { file: 'a.png', start: 0, end: 1.0, text: 'one' },
    { file: 'b.png', start: 1.0, end: 1.2, text: 'two' }
  ];
  const plan = plain(Animation.planFor(items, { preset: 'pop', intensity: 1, fps: 30 }));
  assert.equal(plan.length, 2);
  assert.equal(plan[0].start, 0);
  assert.equal(plan[1].end, 1.2);
  assert.ok(plan[0].keys, 'first clip has keyframes');
  for (const key of plan[1].keys.scale || []) {
    assert.ok(key.time <= 0.2 + 1e-6, 'the short clip keeps its keys inside its duration');
  }
});

/* ---------------------------------------------------------------- fonts */

// These parse real font files off this machine. Skipped where there are none,
// because a missing font directory is an environment fact, not a bug.
const FONT_DIR = ['/usr/share/fonts', '/System/Library/Fonts', 'C:\\Windows\\Fonts']
  .find(d => existsSync(d));

if (!FONT_DIR) {
  console.log('skip font tests (no system font directory on this machine)');
} else {
  const files = Fonts.collectFiles([FONT_DIR]);

  test('font folders yield font files', () => {
    assert.ok(files.length > 0, `no font files under ${FONT_DIR}`);
    for (const f of files) {
      assert.match(f, /\.(ttf|otf|ttc|otc)$/i, `${f} is not a font file`);
    }
  });

  test('a real font file parses into a family, weight and style', () => {
    let parsed = 0;
    for (const f of files.slice(0, 60)) {
      for (const face of Fonts.readFile(f)) {
        parsed++;
        assert.ok(face.family && face.family.length, `${f} produced an empty family`);
        assert.ok(face.weight >= 100 && face.weight <= 1000,
          `${f} has an implausible weight ${face.weight}`);
        assert.equal(typeof face.italic, 'boolean');
      }
    }
    assert.ok(parsed > 0, 'nothing parsed at all');
  });

  test('faces group into families with distinct styles', () => {
    const faces = [];
    for (const f of files) { for (const face of Fonts.readFile(f)) { faces.push(face); } }
    const families = Fonts.group(faces);
    assert.ok(families.length > 0, 'no families');

    for (const fam of families) {
      const seen = new Set();
      for (const st of fam.styles) {
        const key = st.weight + (st.italic ? 'i' : '');
        assert.ok(!seen.has(key), `${fam.family} lists ${key} twice`);
        seen.add(key);
      }
    }
    // Families sort case-insensitively so the picker reads properly.
    for (let i = 1; i < families.length; i++) {
      assert.ok(families[i - 1].family.toLowerCase() <= families[i].family.toLowerCase(),
        `${families[i - 1].family} sorts after ${families[i].family}`);
    }
  });

  test('a four-style family collapses to one entry with four styles', () => {
    const faces = [];
    for (const f of files) { for (const face of Fonts.readFile(f)) { faces.push(face); } }
    const families = Fonts.group(faces);
    const multi = families.find(f => f.styles.length >= 4);
    if (!multi) { return; }   // nothing with four styles installed here
    const upright = multi.styles.filter(s => !s.italic);
    const italic = multi.styles.filter(s => s.italic);
    assert.ok(upright.length >= 1 && italic.length >= 1,
      `${multi.family} should have both upright and italic styles`);
    // Uprights come before italics, light before heavy.
    let sawItalic = false;
    for (const st of multi.styles) {
      if (st.italic) { sawItalic = true; }
      else { assert.ok(!sawItalic, `${multi.family} interleaves italics with uprights`); }
    }
  });
}

test('style labels read like a font menu', () => {
  assert.equal(Fonts.styleLabel({ weight: 400, italic: false }), 'Regular');
  assert.equal(Fonts.styleLabel({ weight: 400, italic: true }), 'Italic');
  assert.equal(Fonts.styleLabel({ weight: 700, italic: false }), 'Bold');
  assert.equal(Fonts.styleLabel({ weight: 700, italic: true }), 'Bold Italic');
  assert.equal(Fonts.styleLabel({ weight: 900, italic: false }), 'Black');
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
