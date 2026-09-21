/*
 * Cue lists out to subtitle files.
 *
 * SRT is the lingua franca - Premiere imports it, every player reads it, and
 * it survives being handed to someone else. VTT is here because the web wants
 * it and it costs eight lines.
 */
(function (global) {
  'use strict';

  function pad(n, width) {
    var s = String(Math.floor(n));
    while (s.length < width) { s = '0' + s; }
    return s;
  }

  function stamp(seconds, msSeparator) {
    if (!(seconds > 0)) { seconds = 0; }
    var ms = Math.round(seconds * 1000);
    var h = Math.floor(ms / 3600000);
    var m = Math.floor(ms / 60000) % 60;
    var s = Math.floor(ms / 1000) % 60;
    var rem = ms % 1000;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + msSeparator + pad(rem, 3);
  }

  function toSrt(cues) {
    var out = [], i;
    for (i = 0; i < cues.length; i++) {
      out.push(String(i + 1));
      out.push(stamp(cues[i].start, ',') + ' --> ' + stamp(cues[i].end, ','));
      out.push(cues[i].text);
      out.push('');
    }
    return out.join('\n');
  }

  function toVtt(cues) {
    var out = ['WEBVTT', ''], i;
    for (i = 0; i < cues.length; i++) {
      out.push(stamp(cues[i].start, '.') + ' --> ' + stamp(cues[i].end, '.'));
      out.push(cues[i].text);
      out.push('');
    }
    return out.join('\n');
  }

  /** Plain transcript, one paragraph per run of cues without a long gap. */
  function toText(cues, paragraphGap) {
    var gap = paragraphGap || 1.5;
    var parts = [], run = [], i;
    for (i = 0; i < cues.length; i++) {
      run.push(cues[i].text.replace(/\n/g, ' '));
      if (i + 1 < cues.length && cues[i + 1].start - cues[i].end >= gap) {
        parts.push(run.join(' '));
        run = [];
      }
    }
    if (run.length) { parts.push(run.join(' ')); }
    return parts.join('\n\n');
  }

  function write(filePath, contents) {
    var node = global.Env.node();
    // BOM so Premiere and Windows tools read the accents correctly.
    node.fs.writeFileSync(filePath, '﻿' + contents, { encoding: 'utf8' });
    return filePath;
  }

  global.Subtitles = { toSrt: toSrt, toVtt: toVtt, toText: toText, write: write, stamp: stamp };
}(window));
