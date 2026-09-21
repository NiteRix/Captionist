/*
 * Drives whisper.cpp and turns its JSON into a flat list of timed words.
 *
 * Word-level timing is the whole point: short-form captions put one to three
 * words on screen at a time, so segment-level timing is not enough. Passing
 * --dtw gives markedly better word boundaries than the default token offsets,
 * and every model tier has an alignment preset for it.
 */
(function (global) {
  'use strict';

  // --dtw wants the preset name, which is not always the file name.
  var DTW_PRESETS = {
    'tiny': 'tiny', 'tiny.en': 'tiny.en',
    'base': 'base', 'base.en': 'base.en',
    'small': 'small', 'small.en': 'small.en',
    'medium': 'medium', 'medium.en': 'medium.en',
    'large-v1': 'large.v1', 'large-v2': 'large.v2',
    'large-v3': 'large.v3', 'large-v3-turbo': 'large.v3.turbo'
  };

  function dtwPresetFor(modelId) {
    // Strip any quantisation suffix: large-v3-turbo-q5_0 -> large-v3-turbo
    var base = String(modelId).replace(/-q[458]_[01]$/, '');
    return DTW_PRESETS[base] || null;
  }

  function threadCount() {
    var n = 4;
    try { n = global.Env.node().os.cpus().length; } catch (e) {}
    // Leave a couple of cores for Premiere, which is usually still in use.
    return Math.max(1, Math.min(16, n - 2));
  }

  /**
   * opts = { whisper, modelPath, modelId, wavPath, language, translate,
   *          prompt, beamSize, threads, useDtw, isCancelled }
   * onProgress(fraction, message)
   */
  function transcribe(opts, onProgress) {
    var Env = global.Env;
    Env.requireNode();
    var node = Env.node();

    var outBase = Env.tempFile('');
    var args = [
      '-m', opts.modelPath,
      '-f', opts.wavPath,
      '-oj', '-ojf',                      // JSON, with per-token detail
      '-of', outBase,
      '-pp',                              // progress to stderr
      '-t', String(opts.threads || threadCount()),
      '-bs', String(opts.beamSize || 5)
    ];

    if (opts.language && opts.language !== 'auto') { args.push('-l', opts.language); }
    else { args.push('-l', 'auto'); }
    if (opts.translate) { args.push('-tr'); }
    if (opts.prompt) { args.push('--prompt', opts.prompt); }

    if (opts.useDtw !== false) {
      var preset = dtwPresetFor(opts.modelId);
      if (preset) { args.push('-dtw', preset); }
    }

    var lastPercent = -1;
    return Env.run(opts.whisper, args, {
      // Whisper can be quiet for a long time on a big model and a slow CPU;
      // it reports every 5%, so ten minutes of silence really is stuck.
      stallSeconds: 600,
      onLine: function (line) {
        var m = line.match(/progress\s*=\s*(\d+)\s*%/);
        if (m && onProgress) {
          var pct = Number(m[1]);
          if (pct !== lastPercent) {
            lastPercent = pct;
            onProgress(pct / 100, 'Transcribing  ' + pct + '%');
          }
        }
      }
    }).then(function () {
      if (opts.isCancelled && opts.isCancelled()) { throw new Error('Cancelled.'); }
      var jsonPath = outBase + '.json';
      var raw;
      try { raw = node.fs.readFileSync(jsonPath, 'utf8'); }
      catch (e) { throw new Error('whisper finished but wrote no JSON: ' + e.message); }
      Env.remove(jsonPath);

      var data;
      try { data = JSON.parse(raw); }
      catch (e) { throw new Error('whisper produced unreadable JSON: ' + e.message); }
      return parse(data);
    }).catch(function (err) {
      Env.remove(outBase + '.json');
      throw err;
    });
  }

  /** Special tokens look like [_BEG_] or <|notimestamps|>; they are not speech. */
  function isSpecial(text) {
    return /^\s*(\[_|<\|)/.test(text);
  }

  /**
   * whisper.cpp reports two clocks in the same object:
   *   offsets.from / offsets.to  are MILLISECONDS
   *   t_dtw                      is CENTISECONDS
   * Mixing them up shifts every caption by a factor of ten.
   */
  function tokenStart(tok) {
    if (tok && typeof tok.t_dtw === 'number' && tok.t_dtw > 0) { return tok.t_dtw / 100; }
    if (tok && tok.offsets && typeof tok.offsets.from === 'number') { return tok.offsets.from / 1000; }
    return null;
  }

  function tokenEnd(tok) {
    if (tok && tok.offsets && typeof tok.offsets.to === 'number') { return tok.offsets.to / 1000; }
    return null;
  }

  /**
   * Rebuilds words from subword tokens. Whisper marks a word boundary with a
   * leading space, so punctuation and word fragments attach to what precedes
   * them rather than becoming captions of their own.
   */
  function parse(data) {
    var words = [];
    var segments = (data && data.transcription) || [];
    var language = (data && data.result && data.result.language) || '';

    for (var s = 0; s < segments.length; s++) {
      var seg = segments[s];
      var toks = seg.tokens || [];

      if (!toks.length) {
        // No per-token detail; fall back to the segment as one block.
        var text = String(seg.text || '').trim();
        if (text && seg.offsets) {
          words.push({
            text: text,
            start: seg.offsets.from / 1000,
            end: seg.offsets.to / 1000,
            confidence: 1,
            segment: s
          });
        }
        continue;
      }

      var current = null;
      for (var i = 0; i < toks.length; i++) {
        var tok = toks[i];
        var raw = String(tok.text || '');
        if (!raw || isSpecial(raw)) { continue; }

        var startsWord = /^\s/.test(raw) || current === null;
        var piece = raw.replace(/^\s+/, '');
        if (!piece) { continue; }

        var tStart = tokenStart(tok);
        var tEnd = tokenEnd(tok);

        if (startsWord) {
          if (current) { words.push(current); }
          current = {
            text: piece,
            start: tStart,
            end: tEnd,
            confidence: typeof tok.p === 'number' ? tok.p : 1,
            segment: s
          };
        } else {
          current.text += piece;
          if (tEnd !== null) { current.end = tEnd; }
          if (typeof tok.p === 'number') {
            current.confidence = Math.min(current.confidence, tok.p);
          }
        }
      }
      if (current) { words.push(current); }
    }

    return { words: repair(words), language: language };
  }

  /**
   * Timings from the model are not guaranteed monotonic, and a token can carry
   * no timestamp at all. Fill the gaps and enforce order, because every rule in
   * the chunker assumes words arrive in time order with real durations.
   */
  function repair(words) {
    var out = [], i, w, prevEnd = 0;

    for (i = 0; i < words.length; i++) {
      w = words[i];
      if (w.start === null || isNaN(w.start)) { w.start = prevEnd; }
      if (w.start < prevEnd) { w.start = prevEnd; }
      if (w.end === null || isNaN(w.end) || w.end <= w.start) { w.end = w.start + 0.08; }
      prevEnd = w.end;
      out.push(w);
    }

    // A word cannot outlive the start of the next one.
    for (i = 0; i < out.length - 1; i++) {
      if (out[i].end > out[i + 1].start) { out[i].end = out[i + 1].start; }
      if (out[i].end <= out[i].start) { out[i].end = out[i].start + 0.02; }
    }
    return out;
  }

  global.Whisper = {
    transcribe: transcribe,
    parse: parse,
    dtwPresetFor: dtwPresetFor,
    threadCount: threadCount
  };
}(window));
