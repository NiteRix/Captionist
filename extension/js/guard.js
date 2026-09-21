/*
 * Throws away the things whisper says when it has not heard anything.
 *
 * Three failure modes, all common enough to matter on a real timeline:
 *
 *   Loops        - the same phrase repeated until the segment runs out.
 *   Stock lines  - "Thank you for watching", "Please subscribe", the Amara
 *                  credit. These come from the training data, not the audio.
 *   Silence fill - any text at all over a quiet stretch.
 *
 * Nothing here is deleted quietly. Every removal is returned with the reason
 * and the timecode, and the panel logs it, because a transcriber that throws
 * away real speech without saying so is worse than one that hallucinates.
 *
 * Pure function of its inputs - words in, words out.
 */
(function (global) {
  'use strict';

  /* Phrases whisper produces from nothing. Matched on normalised text, and
   * only ever acted on when the audio underneath is also quiet, so a video
   * that genuinely says "thanks for watching" keeps it. */
  var STOCK = [
    'thank you for watching',
    'thanks for watching',
    'thank you for watching this video',
    'thank you',
    'thanks',
    'please subscribe',
    'please subscribe to my channel',
    'subscribe to my channel',
    'do not forget to subscribe',
    'dont forget to subscribe',
    'see you in the next video',
    'i will see you in the next video',
    'see you next time',
    'bye',
    'bye bye',
    'you',
    'so',
    'subtitles by the amara org community',
    'subtitles by the amara.org community',
    'transcription by castingwords',
    'amara org',
    'the end'
  ];

  var stockSet = {};
  for (var s = 0; s < STOCK.length; s++) { stockSet[STOCK[s]] = true; }

  var DEFAULTS = {
    quietRatio: 0.85,     // share of an utterance below the speech threshold
    stockQuietRatio: 0.5, // stock lines get the benefit of less doubt
    utteranceGap: 0.6,    // seconds of silence that starts a new utterance
    loopRepeats: 3,       // repeats of a 2+ word phrase before it is a loop
    loopRepeatsSingle: 4, // a single word needs more, since "no no no" is real
    maxPhrase: 6,         // longest n-gram checked for looping
    trailingGap: 2.0      // a stock line this far after the last speech is fake
  };

  function normalise(text) {
    return String(text).toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/['"]/g, '')
      .replace(/[^a-z0-9. ]+/g, ' ')
      .replace(/\bcan't\b/g, 'cannot')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\.$/, '');
  }

  function phraseOf(words, from, count) {
    var parts = [], i;
    for (i = from; i < from + count && i < words.length; i++) { parts.push(normalise(words[i].text)); }
    return parts.join(' ');
  }

  /**
   * Collapses "and then and then and then ..." to one copy.
   *
   * Takes the SHORTEST repeating unit, not the longest. "and then" six times
   * over is also "and then and then" three times over, and collapsing to the
   * longer unit would leave two copies behind. A genuinely long looping
   * phrase has no shorter unit that matches, so it is found anyway.
   */
  function collapseLoops(words, opts, removed) {
    var out = [], i = 0;

    while (i < words.length) {
      var bestLen = 0, bestReps = 0, n;

      var longest = Math.min(opts.maxPhrase, words.length - i);
      for (n = 1; n <= longest; n++) {
        var head = phraseOf(words, i, n);
        if (!head) { continue; }
        var reps = 1;
        while (phraseOf(words, i + reps * n, n) === head && i + (reps + 1) * n <= words.length) { reps++; }
        var need = (n === 1) ? opts.loopRepeatsSingle : opts.loopRepeats;
        if (reps >= need) { bestLen = n; bestReps = reps; break; }
      }

      if (bestLen) {
        var k;
        for (k = 1; k < bestReps; k++) {
          var from = i + k * bestLen;
          removed.push({
            text: phraseOf(words, from, bestLen),
            start: words[from].start,
            end: words[Math.min(words.length - 1, from + bestLen - 1)].end,
            reason: 'repeated ' + bestReps + ' times'
          });
        }
        for (k = 0; k < bestLen; k++) { out.push(words[i + k]); }
        i += bestLen * bestReps;
      } else {
        out.push(words[i]);
        i++;
      }
    }
    return out;
  }

  /** Splits words into runs separated by a real pause. */
  function utterances(words, gap) {
    var runs = [], current = [], i;
    for (i = 0; i < words.length; i++) {
      if (current.length && words[i].start - current[current.length - 1].end >= gap) {
        runs.push(current);
        current = [];
      }
      current.push(words[i]);
    }
    if (current.length) { runs.push(current); }
    return runs;
  }

  /**
   * words  - [{ text, start, end, confidence }]
   * speech - a Speech.map(), or null to skip everything that needs audio
   * returns { words, removed: [{ text, start, end, reason }] }
   */
  function clean(words, speech, settings) {
    var opts = {}, k;
    for (k in DEFAULTS) { if (DEFAULTS.hasOwnProperty(k)) { opts[k] = DEFAULTS[k]; } }
    if (settings) {
      for (k in settings) {
        if (settings.hasOwnProperty(k) && settings[k] !== undefined && settings[k] !== null) { opts[k] = settings[k]; }
      }
    }

    var removed = [];
    if (!words || !words.length) { return { words: [], removed: removed }; }

    var kept = (opts.loops === false) ? words.slice() : collapseLoops(words, opts, removed);

    if (!speech || !global.Speech) { return { words: kept, removed: removed }; }

    var quietOf = function (run) {
      return global.Speech.quietFraction(speech, run[0].start, run[run.length - 1].end);
    };

    var runs = utterances(kept, opts.utteranceGap);
    var lastVoiced = 0, r;
    var out = [];

    for (r = 0; r < runs.length; r++) {
      var run = runs[r];
      var quiet = quietOf(run);
      var text = phraseOf(run, 0, run.length);
      var stock = stockSet[text] === true;
      var drop = null;

      if (quiet >= opts.quietRatio) {
        drop = 'no speech under it (' + Math.round(quiet * 100) + '% quiet)';
      } else if (stock && quiet >= opts.stockQuietRatio) {
        drop = 'stock phrase over near-silence';
      } else if (stock && run[0].start - lastVoiced >= opts.trailingGap) {
        drop = 'stock phrase ' + (run[0].start - lastVoiced).toFixed(1) + 's after the last speech';
      } else if (speech.duration && run[0].start >= speech.duration) {
        drop = 'starts past the end of the audio';
      }

      if (drop) {
        removed.push({
          text: run.map(function (w) { return w.text; }).join(' '),
          start: run[0].start,
          end: run[run.length - 1].end,
          reason: drop
        });
        continue;
      }

      lastVoiced = run[run.length - 1].end;
      for (var j = 0; j < run.length; j++) { out.push(run[j]); }
    }

    return { words: out, removed: removed };
  }

  global.Guard = {
    clean: clean,
    collapseLoops: function (words) {
      var removed = [];
      return { words: collapseLoops(words, DEFAULTS, removed), removed: removed };
    },
    utterances: utterances,
    normalise: normalise,
    STOCK: STOCK,
    DEFAULTS: DEFAULTS
  };
}(window));
