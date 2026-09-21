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

  /** Apply minimum duration, keep cues from overlapping, lay out the text. */
  function finish(cues, opts) {
    var out = [], i;
    for (i = 0; i < cues.length; i++) {
      var words = cues[i];
      if (!words.length) { continue; }
      var start = words[0].start;
      var end = words[words.length - 1].end;

      if (end - start < opts.minDuration) { end = start + opts.minDuration; }

      out.push({
        start: start,
        end: end,
        words: words,
        lines: layout(words, opts),
        text: layout(words, opts).join('\n')
      });
    }

    // Held cues can now collide with the next one; trim rather than reorder.
    for (i = 0; i < out.length - 1; i++) {
      var maxEnd = out[i + 1].start - opts.minGap;
      if (out[i].end > maxEnd) { out[i].end = Math.max(out[i].start + 0.05, maxEnd); }
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
      out.push({ start: start, end: end, words: c.words, lines: c.lines, text: c.text });
    }
    for (i = 0; i < out.length - 1; i++) {
      if (out[i].end > out[i + 1].start) { out[i].end = out[i + 1].start; }
    }
    return out;
  }

  function stats(cues) {
    if (!cues.length) { return { count: 0, wordsPerCue: 0, averageDuration: 0, charsPerCue: 0 }; }
    var w = 0, d = 0, ch = 0, i;
    for (i = 0; i < cues.length; i++) {
      w += cues[i].words.length;
      d += cues[i].end - cues[i].start;
      ch += cues[i].text.replace(/\n/g, ' ').length;
    }
    return {
      count: cues.length,
      wordsPerCue: w / cues.length,
      averageDuration: d / cues.length,
      charsPerCue: ch / cues.length
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
      return edited;
    }

    if (cue.words && cue.words.length === tokens.length) {
      for (var i = 0; i < tokens.length; i++) {
        edited.words.push({
          text: tokens[i],
          start: cue.words[i].start,
          end: cue.words[i].end,
          confidence: cue.words[i].confidence
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
