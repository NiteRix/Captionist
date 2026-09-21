/*
 * Names, brands and jargon - the words whisper has never seen.
 *
 * Two jobs from one list:
 *
 *   1. Seed whisper's initial prompt. The model biases toward spellings it has
 *      just been shown, so listing the terms up front prevents some of the
 *      mistakes rather than repairing them.
 *   2. Repair the rest afterwards. Prompting is a nudge, not a guarantee, so
 *      anything that still comes out wrong is rewritten in the word stream
 *      before the chunker ever sees it.
 *
 * The list is written as plain lines:
 *
 *   Niterix                 a term to bias toward
 *   nite rix -> Niterix     also rewrite this when it appears
 *   kubernetes => K8s       either arrow works
 *
 * A rule may span several words on either side, so "you tube -> YouTube"
 * merges two words into one and "K8s -> Kubernetes" splits one into one.
 * Timings are preserved: the replaced run keeps its exact span, redistributed
 * across the new words in proportion to their length.
 *
 * Pure function of its inputs.
 */
(function (global) {
  'use strict';

  var ARROW = /\s*(?:->|=>|→)\s*/;

  function tokenise(text) {
    return String(text).split(/\s+/).filter(function (t) { return t.length > 0; });
  }

  /** Lowercase, strip punctuation that a transcript might or might not have. */
  function key(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9']+/g, '');
  }

  /**
   * text - the raw textarea contents
   * returns { terms: [String], rules: [{ from: [String], to: [String] }] }
   */
  function parse(text) {
    var terms = [], rules = [];
    var lines = String(text || '').split(/[\r\n]+/);

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') { continue; }

      if (ARROW.test(line)) {
        var halves = line.split(ARROW);
        var from = tokenise(halves[0]);
        var to = tokenise(halves.slice(1).join(' '));
        if (!from.length || !to.length) { continue; }
        rules.push({ from: from, to: to });
        terms.push(halves.slice(1).join(' ').trim());
      } else {
        terms.push(line);
      }
    }
    return { terms: terms, rules: rules };
  }

  /**
   * The initial prompt. Whisper takes a run of text, not a list, so the terms
   * are joined as a sentence fragment - which is also how they appear in the
   * training data it is being biased against.
   */
  function prompt(parsed, extra) {
    var list = (parsed && parsed.terms) ? parsed.terms.slice() : [];
    var head = String(extra || '').trim();
    if (!list.length) { return head; }
    var joined = list.join(', ') + '.';
    return head ? head.replace(/\s*$/, ' ') + joined : joined;
  }

  /** Does the run of words at `at` match this rule's left side? */
  function matches(words, at, from) {
    if (at + from.length > words.length) { return false; }
    for (var i = 0; i < from.length; i++) {
      if (key(words[at + i].text) !== key(from[i])) { return false; }
    }
    return true;
  }

  /**
   * Keeps the punctuation the transcript had. "nite rix," becomes "Niterix,"
   * rather than losing the comma that the chunker splits on.
   */
  function trailingPunctuation(text) {
    var m = String(text).match(/[^A-Za-z0-9'’]+$/);
    return m ? m[0] : '';
  }

  /** Spreads one run's span across the replacement words, by word length. */
  function respan(run, to) {
    var start = run[0].start;
    var end = run[run.length - 1].end;
    var span = Math.max(0.01, end - start);
    var total = 0, i;
    for (i = 0; i < to.length; i++) { total += Math.max(1, to[i].length); }

    var out = [], at = start;
    for (i = 0; i < to.length; i++) {
      var share = span * (Math.max(1, to[i].length) / total);
      out.push({
        text: to[i],
        start: at,
        end: (i === to.length - 1) ? end : Math.min(end, at + share),
        confidence: 1,
        corrected: true
      });
      at += share;
    }
    return out;
  }

  /**
   * words  - [{ text, start, end, confidence }]
   * parsed - the output of parse()
   * returns { words, replacements: [{ from, to, start }] }
   */
  function apply(words, parsed) {
    var replacements = [];
    if (!words || !words.length || !parsed || !parsed.rules || !parsed.rules.length) {
      return { words: words || [], replacements: replacements };
    }

    // Longest left side first, so "new york city" wins over "new york".
    var rules = parsed.rules.slice().sort(function (a, b) { return b.from.length - a.from.length; });

    var out = [], i = 0;
    while (i < words.length) {
      var hit = null, r;
      for (r = 0; r < rules.length; r++) {
        if (matches(words, i, rules[r].from)) { hit = rules[r]; break; }
      }

      if (!hit) { out.push(words[i]); i++; continue; }

      var run = words.slice(i, i + hit.from.length);
      var to = hit.to.slice();
      var tail = trailingPunctuation(run[run.length - 1].text);
      if (tail) { to[to.length - 1] = to[to.length - 1] + tail; }

      var made = respan(run, to);
      for (r = 0; r < made.length; r++) { out.push(made[r]); }

      replacements.push({
        from: run.map(function (w) { return w.text; }).join(' '),
        to: to.join(' '),
        start: run[0].start
      });
      i += hit.from.length;
    }

    return { words: out, replacements: replacements };
  }

  /**
   * Find and replace straight over built cues, for the corrections that only
   * become obvious once the captions are on screen. Returns the new cues and
   * how many changed; timings are handled by Chunker.editText.
   */
  function replaceInCues(cues, find, into, opts) {
    var changed = [], out = [], i;
    if (!cues || !find) { return { cues: cues || [], changed: changed }; }

    var flags = (opts && opts.matchCase) ? 'g' : 'gi';
    var escaped = String(find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var pattern = (opts && opts.wholeWord) ? '\\b' + escaped + '\\b' : escaped;

    for (i = 0; i < cues.length; i++) {
      var re = new RegExp(pattern, flags);
      var next = cues[i].text.replace(re, String(into));
      if (next === cues[i].text) { out.push(cues[i]); continue; }
      out.push(global.Chunker.editText(cues[i], next, opts));
      changed.push(i);
    }
    return { cues: out, changed: changed };
  }

  global.Vocab = {
    parse: parse,
    prompt: prompt,
    apply: apply,
    replaceInCues: replaceInCues
  };
}(window));
