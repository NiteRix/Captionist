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

const { Chunker, Whisper, Subtitles, Animation, Fonts, Speech, Guard, Vocab } = load(
  'extension/js/speech.js',
  'extension/js/guard.js',
  'extension/js/vocab.js',
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


/* ------------------------------------------------- reading speed & timing */

/** Words at a fixed rate, with no pauses, so timing maths is predictable. */
function evenWords(text, from = 0, each = 0.25) {
  return text.split(/\s+/).map((w, i) => ({
    text: w, start: from + i * each, end: from + i * each + each * 0.8, confidence: 0.95
  }));
}

test('a dense caption is held long enough to read', () => {
  // 12 words in 3 seconds is far above any sane reading rate.
  const words = evenWords('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima', 0, 0.25);
  const cues = Chunker.build(words, { preset: 'long', maxCps: 10, maxWords: 99, maxDuration: 60 });
  for (const c of cues) {
    const chars = c.text.replace(/\n/g, ' ').length;
    assert.ok(chars / (c.end - c.start) <= 10.01,
      `${chars} chars in ${(c.end - c.start).toFixed(2)}s is ${(chars / (c.end - c.start)).toFixed(1)} cps`);
  }
});

test('turning the reading-speed cap off stops it extending cues', () => {
  const words = evenWords('alpha bravo charlie delta', 0, 0.2);
  const capped = Chunker.build(words, { preset: 'long', maxCps: 6, maxWords: 99 });
  const off = Chunker.build(words, { preset: 'long', maxCps: 0, maxWords: 99 });
  assert.ok(capped[0].end > off[0].end, 'the capped cue should be held longer');
});

test('the cap never pushes a cue over the one after it', () => {
  const words = evenWords('alpha bravo charlie delta echo foxtrot', 0, 0.2);
  const cues = Chunker.build(words, { preset: 'short', maxCps: 4, maxWords: 2 });
  for (let i = 0; i < cues.length - 1; i++) {
    assert.ok(cues[i].end <= cues[i + 1].start + 1e-9,
      `cue ${i} ends at ${cues[i].end} but ${i + 1} starts at ${cues[i + 1].start}`);
  }
});

test('a cue that cannot be slowed down is flagged rather than hidden', () => {
  // Two cues back to back leave no room to extend the first one into.
  const words = [
    { text: 'extraordinarily', start: 0, end: 0.2, confidence: 0.9 },
    { text: 'incomprehensible', start: 0.21, end: 0.4, confidence: 0.9 },
    { text: 'next', start: 0.42, end: 0.6, confidence: 0.9 }
  ];
  const cues = Chunker.build(words, { preset: 'short', maxWords: 2, maxCps: 12, minDuration: 0.05, leadOut: 0 });
  assert.ok(cues.some(c => c.fast), 'something here is unreadably fast and should say so');
});

test('captions lead in and out around the words', () => {
  const words = [{ text: 'hello', start: 5, end: 5.4, confidence: 0.9 }];
  const cues = Chunker.build(words, { preset: 'long', leadIn: 0.1, leadOut: 0.2, minDuration: 0, maxCps: 0 });
  assert.ok(Math.abs(cues[0].start - 4.9) < 1e-6, `start ${cues[0].start}`);
  assert.ok(cues[0].end >= 5.6 - 1e-6, `end ${cues[0].end}`);
});

test('padding never reaches back over the previous caption', () => {
  const words = [
    { text: 'one', start: 0, end: 1.0, confidence: 0.9 },
    { text: 'two', start: 1.02, end: 2.0, confidence: 0.9 }
  ];
  const cues = Chunker.build(words, { preset: 'long', maxWords: 1, leadIn: 0.5, leadOut: 0, minDuration: 0, maxCps: 0 });
  assert.ok(cues[1].start >= cues[0].start, 'the second cue must not start before the first');
  assert.ok(cues[1].start >= 1.0 - 1e-9, `second cue reached back to ${cues[1].start}`);
});

test('a few frames between captions is closed, a real pause is not', () => {
  const tight = Chunker.build([
    { text: 'one', start: 0, end: 0.5, confidence: 0.9 },
    { text: 'two', start: 0.6, end: 1.1, confidence: 0.9 }
  ], { preset: 'long', maxWords: 1, bridgeGap: 0.3, leadIn: 0, leadOut: 0, minDuration: 0, maxCps: 0 });
  assert.equal(tight[0].end, tight[1].start, 'a 0.1s gap should be closed');

  const loose = Chunker.build([
    { text: 'one', start: 0, end: 0.5, confidence: 0.9 },
    { text: 'two', start: 3.0, end: 3.5, confidence: 0.9 }
  ], { preset: 'long', maxWords: 1, bridgeGap: 0.3, leadIn: 0, leadOut: 0, minDuration: 0, maxCps: 0 });
  assert.ok(loose[0].end < loose[1].start - 1, 'a 2.5s pause is a pause');
});

/* -------------------------------------------------------------- confidence */

test('a cue carries the score of its least certain word', () => {
  const cues = Chunker.build([
    { text: 'certain', start: 0, end: 0.5, confidence: 0.99 },
    { text: 'doubtful', start: 0.5, end: 1.0, confidence: 0.21 }
  ], { preset: 'long' });
  assert.ok(Math.abs(cues[0].confidence - 0.21) < 1e-9, `got ${cues[0].confidence}`);
});

test('stats count doubtful cues against the given bar', () => {
  const cues = Chunker.build([
    { text: 'sure', start: 0, end: 0.5, confidence: 0.95 },
    { text: 'unsure', start: 2.0, end: 2.5, confidence: 0.3 }
  ], { preset: 'long', maxWords: 1 });
  assert.equal(Chunker.stats(cues, { lowConfidence: 0.6 }).uncertainCues, 1);
  assert.equal(Chunker.stats(cues, { lowConfidence: 0.1 }).uncertainCues, 0);
});

test('correcting a caption clears its doubt', () => {
  const cue = Chunker.build([
    { text: 'Their', start: 0, end: 0.5, confidence: 0.2 },
    { text: 'here', start: 0.5, end: 1.0, confidence: 0.9 }
  ], { preset: 'long' })[0];
  const fixed = Chunker.editText(cue, "They're here", { preset: 'long' });
  assert.equal(fixed.confidence, 1);
  assert.ok(fixed.words.every(w => w.confidence === 1));
});

/* ------------------------------------------------------- hallucination guard */

test('a looping phrase collapses to one copy', () => {
  const words = [];
  let t = 0;
  for (let i = 0; i < 6; i++) {
    for (const w of ['and', 'then']) { words.push({ text: w, start: t, end: t + 0.2, confidence: 0.9 }); t += 0.25; }
  }
  const { words: kept, removed } = Guard.collapseLoops(words);
  assert.equal(kept.length, 2, `kept ${kept.map(w => w.text).join(' ')}`);
  assert.equal(removed.length, 5);
});

test('a repeated word three times over is left alone', () => {
  const words = ['no', 'no', 'no'].map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.2, confidence: 0.9 }));
  assert.equal(Guard.collapseLoops(words).words.length, 3);
});

test('real speech is not treated as a loop', () => {
  const words = evenWords('the cat sat on the mat and the dog watched');
  assert.equal(Guard.collapseLoops(words).words.length, words.length);
});

test('text over silence is dropped, text over speech is kept', () => {
  // Two seconds of tone, then two of near-silence.
  const rate = 16000;
  const pcm = new Float32Array(rate * 4);
  for (let i = 0; i < rate * 2; i++) { pcm[i] = Math.sin(i * 0.05) * 0.5; }
  for (let i = rate * 2; i < pcm.length; i++) { pcm[i] = (i % 7 - 3) * 1e-5; }
  const map = Speech.map(pcm, rate);

  const words = [
    { text: 'real', start: 0.4, end: 0.9, confidence: 0.9 },
    { text: 'speech', start: 1.0, end: 1.5, confidence: 0.9 },
    { text: 'Thank', start: 2.6, end: 3.0, confidence: 0.4 },
    { text: 'you', start: 3.0, end: 3.4, confidence: 0.4 }
  ];
  const { words: kept, removed } = Guard.clean(words, map, {});
  assert.deepEqual(plain(kept.map(w => w.text)), ['real', 'speech']);
  assert.equal(removed.length, 1);
  assert.match(removed[0].reason, /quiet|speech/);
});

test('with no speech map nothing is dropped for silence', () => {
  const words = evenWords('thank you for watching');
  assert.equal(Guard.clean(words, null, {}).words.length, 4);
});

test('the envelope finds the loud part and the quiet part', () => {
  const rate = 16000;
  const pcm = new Float32Array(rate);
  for (let i = 0; i < rate / 2; i++) { pcm[i] = Math.sin(i * 0.05) * 0.5; }
  const map = Speech.map(pcm, rate);
  assert.ok(Speech.quietFraction(map, 0, 0.4) < 0.1, 'the first half is speech');
  assert.ok(Speech.quietFraction(map, 0.6, 0.95) > 0.9, 'the second half is silence');
});

/* ------------------------------------------------------------- vocabulary */

test('a vocabulary list parses terms and rules', () => {
  const v = Vocab.parse('NiteRix\n# a comment\nnite rix -> NiteRix\nyou tube => YouTube\n');
  assert.deepEqual(plain(v.rules).map(r => r.from.join(' ')), ['nite rix', 'you tube']);
  assert.ok(v.terms.indexOf('NiteRix') >= 0);
  assert.ok(v.terms.indexOf('YouTube') >= 0, 'a rule target is also worth prompting with');
});

test('the prompt is a sentence, not a list', () => {
  const v = Vocab.parse('NiteRix\nCaptionist');
  assert.equal(Vocab.prompt(v), 'NiteRix, Captionist.');
  assert.equal(Vocab.prompt(Vocab.parse('')), '');
});

test('a two-word mistake becomes one word, keeping the span', () => {
  const words = [
    { text: 'on', start: 0, end: 0.3, confidence: 0.9 },
    { text: 'nite', start: 0.3, end: 0.6, confidence: 0.5 },
    { text: 'rix', start: 0.6, end: 1.0, confidence: 0.5 },
    { text: 'today', start: 1.0, end: 1.4, confidence: 0.9 }
  ];
  const { words: fixed, replacements } = Vocab.apply(words, Vocab.parse('nite rix -> NiteRix'));
  assert.deepEqual(plain(fixed.map(w => w.text)), ['on', 'NiteRix', 'today']);
  assert.equal(replacements.length, 1);
  assert.equal(fixed[1].start, 0.3);
  assert.equal(fixed[1].end, 1.0);
});

test('replacement keeps the punctuation the transcript had', () => {
  const words = [
    { text: 'nite', start: 0, end: 0.3, confidence: 0.5 },
    { text: 'rix,', start: 0.3, end: 0.6, confidence: 0.5 }
  ];
  const { words: fixed } = Vocab.apply(words, Vocab.parse('nite rix -> NiteRix'));
  assert.deepEqual(plain(fixed.map(w => w.text)), ['NiteRix,']);
});

test('matching ignores case and punctuation, and prefers the longer rule', () => {
  const words = evenWords('we went to new york city yesterday');
  const v = Vocab.parse('new york -> NY\nnew york city -> NYC');
  const { words: fixed } = Vocab.apply(words, v);
  assert.ok(fixed.map(w => w.text).indexOf('NYC') >= 0, fixed.map(w => w.text).join(' '));
});

test('find and replace rewrites every caption that matches', () => {
  const cues = Chunker.build(evenWords('kubernetes is fine but kubernetes is slow'),
    { preset: 'short', maxWords: 3 });
  const { cues: out, changed } = Vocab.replaceInCues(cues, 'kubernetes', 'K8s', { preset: 'short' });
  assert.ok(changed.length >= 2, `changed ${changed.length}`);
  assert.ok(out.every(c => c.text.indexOf('kubernetes') < 0));
  assert.equal(out[0].start, cues[0].start, 'timings must not move');
});

/* ------------------------------------------------- spacing for the dissolve */

test('placed captions are pulled apart so a dissolve has room', () => {
  // Touching clips are what makes a Cross Dissolve blend two captions.
  const items = [
    { file: 'a.png', start: 0, end: 2.0, text: 'a' },
    { file: 'b.png', start: 2.0, end: 4.0, text: 'b' },
    { file: 'c.png', start: 4.0, end: 6.0, text: 'c' }
  ];
  const out = Animation.space(items, 0.12);
  for (let i = 0; i < out.length - 1; i++) {
    assert.ok(out[i + 1].start - out[i].end >= 0.12 - 1e-9,
      `clip ${i} ends at ${out[i].end}, ${i + 1} starts at ${out[i + 1].start}`);
  }
  assert.equal(out[out.length - 1].end, 6.0, 'the last caption keeps its end');
});

test('spacing never shortens a caption to nothing', () => {
  const items = [
    { file: 'a.png', start: 0, end: 0.30, text: 'a' },
    { file: 'b.png', start: 0.30, end: 0.60, text: 'b' }
  ];
  const out = Animation.space(items, 0.5, 0.24);
  assert.ok(out[0].end - out[0].start >= 0.24 - 1e-9, `kept only ${out[0].end - out[0].start}s`);
  assert.ok(out[0].end <= out[1].start + 1e-9, 'but it still must not overlap');
});

test('spacing leaves already separated captions alone', () => {
  const items = [
    { file: 'a.png', start: 0, end: 1.0, text: 'a' },
    { file: 'b.png', start: 3.0, end: 4.0, text: 'b' }
  ];
  const out = Animation.space(items, 0.12);
  assert.equal(out[0].end, 1.0);
});

test('spacing does not touch the cues it was given', () => {
  const items = [
    { file: 'a.png', start: 0, end: 2.0, text: 'a' },
    { file: 'b.png', start: 2.0, end: 4.0, text: 'b' }
  ];
  Animation.space(items, 0.2);
  assert.equal(items[0].end, 2.0, 'the original timing has to survive for the .srt and preview');
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
