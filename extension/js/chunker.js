/*
 * Turns timed words into caption cues.
 *
 * This is the difference between short form and long form. Short form wants
 * one to three words on screen at a time, cut hard on the beat of speech.
 * Long form wants readable lines that sit for a couple of seconds. Both come
 * out of the same routine with different limits.
 *
 * Pure function of its inputs, so it is fully testable without Premiere,
 * whisper or an audio file.
 */
(function (global) {
  'use strict';

  var PRESETS = {
    short: {
      name: 'Short form',
      maxWords: 3,
      maxCharsPerLine: 16,
      maxLines: 1,
      minDuration: 0.30,
      maxDuration: 1.20,
      gapSplit: 0.25,
      minGap: 0.02,
      maxCps: 20,
      leadIn: 0.04,
      leadOut: 0.08,
      bridgeGap: 0.12,
      splitOnPunctuation: true,
      avoidWidows: true
    },
    long: {
      name: 'Long form',
      maxWords: 12,
      maxCharsPerLine: 42,
      maxLines: 2,
      minDuration: 1.00,
      maxDuration: 6.00,
      gapSplit: 0.40,
      minGap: 0.04,
      maxCps: 17,
      leadIn: 0.08,
      leadOut: 0.16,
      bridgeGap: 0.24,
      splitOnPunctuation: true,
      avoidWidows: true
    }
  };

  var SENTENCE_END = /[.!?…]["')\]]?$/;
  var CLAUSE_END = /[,;:—-]["')\]]?$/;

  function charCount(words) {
    var n = 0;
    for (var i = 0; i < words.length; i++) { n += words[i].text.length; }
    return n + Math.max(0, words.length - 1);        // spaces between words
  }

  /**
   * How willing we are to end a cue after this word. Higher wins.
   * A full stop is a better place to cut than a comma, which is better than
   * a pause, which is better than simply running out of room.
   */
  function breakScore(word, nextWord, opts) {
    var score = 0;
    var text = word.text;
    if (opts.splitOnPunctuation && SENTENCE_END.test(text)) { score += 100; }
    else if (opts.splitOnPunctuation && CLAUSE_END.test(text)) { score += 40; }
    if (nextWord) {
      var gap = nextWord.start - word.end;
      if (gap >= opts.gapSplit) { score += 30 + Math.min(30, gap * 20); }
      else if (gap > 0) { score += gap * 10; }
    }
    return score;
  }

  /** Would adding this word break a hard limit? */
  function exceeds(words, candidate, opts) {
    var all = words.concat([candidate]);
    if (all.length > opts.maxWords) { return true; }
    if (candidate.end - all[0].start > opts.maxDuration) { return true; }
    if (charCount(all) > opts.maxCharsPerLine * opts.maxLines) { return true; }
    return false;
  }

  /** Greedy wrap into at most maxLines, balancing the last two. */
  function layout(words, opts) {
    var lines = [], line = [], i;
    for (i = 0; i < words.length; i++) {
      var trial = line.concat([words[i]]);
      if (line.length && charCount(trial) > opts.maxCharsPerLine && lines.length < opts.maxLines - 1) {
        lines.push(line);
        line = [words[i]];
      } else {
        line = trial;
      }
    }
    if (line.length) { lines.push(line); }

    var text = [];
    for (i = 0; i < lines.length; i++) {
      var parts = [];
      for (var j = 0; j < lines[i].length; j++) { parts.push(lines[i][j].text); }
      text.push(parts.join(' '));
    }
    return text;
  }

  /**
   * words - [{ text, start, end, confidence }]
   * settings - a preset, optionally overridden
   */
  function build(words, settings) {
    var opts = {};
    var preset = PRESETS[(settings && settings.preset) || 'long'] || PRESETS.long;
    Object.keys(preset).forEach(function (k) { opts[k] = preset[k]; });
    if (settings) {
      Object.keys(settings).forEach(function (k) {
        if (k !== 'preset' && settings[k] !== undefined && settings[k] !== null) { opts[k] = settings[k]; }
      });
    }

    if (!words || !words.length) { return []; }

    var cues = [], current = [], i;

    for (i = 0; i < words.length; i++) {
      var w = words[i];
      var next = words[i + 1];

      if (current.length && exceeds(current, w, opts)) {
        cues.push(current);
        current = [w];
      } else {
        current.push(w);
      }

      if (!current.length) { continue; }

      // A strong natural break ends the cue even with room to spare, as long
      // as the cue is not so short it would flash past.
      var score = breakScore(w, next, opts);
      var spanned = w.end - current[0].start;
      if (next && score >= 30 && spanned >= opts.minDuration * 0.6) {
        cues.push(current);
        current = [];
      }
    }
    if (current.length) { cues.push(current); }

    if (opts.avoidWidows) { cues = unwidow(cues, opts); }
    return finish(cues, opts);
  }

  /**
   * A cue holding a single short word, next to a cue with room for it, reads
   * as a stutter. Pull it back where that is possible without breaking limits.
   */
  function unwidow(cues, opts) {
    var out = [], i;
    for (i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var prev = out[out.length - 1];
      var lone = cue.length === 1 && cue[0].text.replace(/\W/g, '').length <= 3;
      if (lone && prev && !exceeds(prev, cue[0], opts)) {
        var gap = cue[0].start - prev[prev.length - 1].end;
        if (gap < opts.gapSplit) { prev.push(cue[0]); continue; }
      }
      out.push(cue);
    }
    return out;
  }

  /** Lowest confidence in a cue - the word most likely to be wrong. */
  function weakest(words) {
    var low = 1, i;
    for (i = 0; i < words.length; i++) {
      var c = words[i].confidence;
      if (typeof c === 'number' && c < low) { low = c; }
    }
    return low;
  }

  /** Characters on screen per second. The number people actually read at. */
  function cpsOf(cue) {
    var span = cue.end - cue.start;
    if (!(span > 0)) { return 0; }
    return cue.text.replace(/\n/g, ' ').length / span;
  }

  /**
   * Turn runs of words into finished cues.
   *
   * Timing goes through four passes, in this order, because each one can undo
   * the one before it if they are run the other way round:
   *
   *   1. Pad. Subtitles conventionally appear a frame or two before the word
   *      and leave a little after it, which reads as being in time rather than
   *      late. Padding never reaches back past the previous cue's last word.
   *   2. Hold. A cue shorter than minDuration, or too dense to read at
   *      maxCps, is extended. maxCps is the one that matters: three lines
   *      flashing past in a second are technically present and practically
   *      invisible.
   *   3. Trim. Holding can now collide with the next cue, so pull back.
   *   4. Bridge. A gap of a few frames between two cues reads as a flicker,
   *      not as a pause. Close anything under bridgeGap exactly.
   */
  function finish(cues, opts) {
    var out = [], i;
    var prevWordEnd = -Infinity;

    for (i = 0; i < cues.length; i++) {
      var words = cues[i];
      if (!words.length) { continue; }

      var rawStart = words[0].start;
      var rawEnd = words[words.length - 1].end;

      // 1. pad
      var start = Math.max(0, rawStart - (opts.leadIn || 0));
      if (start < prevWordEnd) { start = Math.min(rawStart, prevWordEnd); }
      var end = rawEnd + (opts.leadOut || 0);
      prevWordEnd = rawEnd;

      // 2. hold
      if (end - start < opts.minDuration) { end = start + opts.minDuration; }

      var lines = layout(words, opts);
      var text = lines.join('\n');
      if (opts.maxCps > 0) {
        var needed = text.replace(/\n/g, ' ').length / opts.maxCps;
        if (end - start < needed) { end = start + needed; }
      }

      out.push({
        start: start,
        end: end,
        words: words,
        lines: lines,
        text: text,
        confidence: weakest(words)
      });
    }

    // 3. trim
    for (i = 0; i < out.length - 1; i++) {
      var maxEnd = out[i + 1].start - opts.minGap;
      if (out[i].end > maxEnd) { out[i].end = Math.max(out[i].start + 0.05, maxEnd); }
    }

    // 4. bridge
    if (opts.bridgeGap > 0) {
      for (i = 0; i < out.length - 1; i++) {
        var gap = out[i + 1].start - out[i].end;
        if (gap > 0 && gap <= opts.bridgeGap &&
            (out[i + 1].start - out[i].start) <= opts.maxDuration) {
          out[i].end = out[i + 1].start;
        }
      }
    }

    // Report what could not be slowed down, rather than hiding it.
    for (i = 0; i < out.length; i++) {
      out[i].cps = cpsOf(out[i]);
      out[i].fast = opts.maxCps > 0 && out[i].cps > opts.maxCps + 0.5;
    }
    return out;
  }

  /** Snap every boundary to the frame grid so Premiere never sees a part frame. */
  function snapToFrames(cues, fps) {
    if (!(fps > 0)) { return cues; }
    var out = [], i;
    for (i = 0; i < cues.length; i++) {
      var c = cues[i];
      var start = Math.round(c.start * fps) / fps;
      var end = Math.round(c.end * fps) / fps;
      if (end <= start) { end = start + 1 / fps; }
      out.push({ start: start, end: end, words: c.words, lines: c.lines, text: c.text,
                 confidence: c.confidence, edited: c.edited });
    }
    for (i = 0; i < out.length - 1; i++) {
      if (out[i].end > out[i + 1].start) { out[i].end = out[i + 1].start; }
    }
    // Snapping moves boundaries by up to half a frame, so reading speed has to
    // be measured again against the timing Premiere will actually get.
    for (i = 0; i < out.length; i++) {
      out[i].cps = cpsOf(out[i]);
      out[i].fast = cues[i] ? cues[i].fast : false;
    }
    return out;
  }

  /**
   * opts.lowConfidence - the bar under which a word counts as doubtful.
   * Nearly every whisper word scores a little under 1, so the count is only
   * meaningful against an explicit bar.
   */
  function stats(cues, opts) {
    if (!cues.length) {
      return { count: 0, wordsPerCue: 0, averageDuration: 0, charsPerCue: 0,
               averageCps: 0, fastCues: 0, editedCues: 0, uncertainCues: 0 };
    }
    var w = 0, d = 0, ch = 0, i;
    for (i = 0; i < cues.length; i++) {
      w += cues[i].words.length;
      d += cues[i].end - cues[i].start;
      ch += cues[i].text.replace(/\n/g, ' ').length;
    }
    var bar = (opts && typeof opts.lowConfidence === 'number') ? opts.lowConfidence : 0.6;
    var fast = 0, low = 0, edited = 0, cps = 0;
    for (i = 0; i < cues.length; i++) {
      if (cues[i].fast) { fast++; }
      if (cues[i].edited) { edited++; }
      if (typeof cues[i].cps === 'number') { cps += cues[i].cps; }
      if (typeof cues[i].confidence === 'number' && cues[i].confidence < bar) { low++; }
    }

    return {
      count: cues.length,
      wordsPerCue: w / cues.length,
      averageDuration: d / cues.length,
      charsPerCue: ch / cues.length,
      averageCps: cps / cues.length,
      fastCues: fast,
      editedCues: edited,
      uncertainCues: low
    };
  }

  /**
   * Replaces a cue's text, keeping its place on the timeline.
   *
   * Per-word timings have to survive, because karaoke highlighting is built
   * from them. When the word count is unchanged the original timings are kept
   * outright - the usual case, since most corrections are spelling. Otherwise
   * the cue's span is redistributed across the new words in proportion to
   * their length, which is closer to speech than splitting it evenly.
   */
  function editText(cue, newText, opts) {
    opts = opts || {};
    var text = String(newText).replace(/\r/g, '');
    var tokens = text.split(/\s+/).filter(Boolean);

    var edited = {
      start: cue.start,
      end: cue.end,
      text: text.replace(/[ \t]*\n[ \t]*/g, '\n').trim(),
      edited: true,
      words: []
    };

    if (!tokens.length) {
      edited.text = '';
      edited.lines = [''];
      edited.confidence = 1;
      edited.cps = 0;
      edited.fast = false;
      return edited;
    }

    if (cue.words && cue.words.length === tokens.length) {
      for (var i = 0; i < tokens.length; i++) {
        edited.words.push({
          text: tokens[i],
          start: cue.words[i].start,
          end: cue.words[i].end,
          // A person has now read this word, so it is no longer in doubt.
          confidence: 1
        });
      }
    } else {
      var total = 0, j;
      for (j = 0; j < tokens.length; j++) { total += Math.max(1, tokens[j].length); }
      var span = Math.max(0.05, cue.end - cue.start);
      var at = cue.start;
      for (j = 0; j < tokens.length; j++) {
        var share = span * (Math.max(1, tokens[j].length) / total);
        edited.words.push({
          text: tokens[j],
          start: at,
          end: Math.min(cue.end, at + share),
          confidence: 1
        });
        at += share;
      }
    }

    // Respect any line breaks typed in; otherwise re-wrap to the caption shape.
    if (edited.text.indexOf('\n') >= 0) {
      edited.lines = edited.text.split('\n');
    } else {
      var shape = {};
      var preset = PRESETS[opts.preset || 'long'] || PRESETS.long;
      Object.keys(preset).forEach(function (k) { shape[k] = preset[k]; });
      Object.keys(opts).forEach(function (k) {
        if (k !== 'preset' && opts[k] !== undefined && opts[k] !== null) { shape[k] = opts[k]; }
      });
      // An editor can type more than the shape allows. Wrapping onto an extra
      // line is visible and fixable; overflowing one line past the readable
      // width is not, so the line cap is lifted here rather than the width.
      shape.maxLines = 99;
      edited.lines = layout(edited.words, shape);
      edited.text = edited.lines.join('\n');
    }

    edited.confidence = 1;
    edited.cps = cpsOf(edited);
    edited.fast = opts.maxCps > 0 && edited.cps > opts.maxCps + 0.5;
    return edited;
  }

  global.Chunker = {
    build: build,
    snapToFrames: snapToFrames,
    stats: stats,
    editText: editText,
    PRESETS: PRESETS
  };
}(window));
