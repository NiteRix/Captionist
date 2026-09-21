/*
 * Where there is speech, and where there is not.
 *
 * Whisper invents text over silence - stock phrases like "Thank you for
 * watching", or the previous line repeated forever. It has no way to say "I
 * heard nothing", so it says something. The cheapest defence is to know,
 * independently of the model, which parts of the timeline are actually quiet
 * and throw away anything the model claims to have heard there.
 *
 * The envelope and the auto-threshold are Silencer's, and for the same reason:
 * room tone sits well above digital silence, so a fixed dB floor is wrong on
 * every real recording. Measuring the loud end of the material and working
 * down from it is not.
 *
 * Pure arithmetic over a Float32Array, so it is fully testable without audio.
 */
(function (global) {
  'use strict';

  var HOP = 0.01;            // 10 ms resolution, same as Silencer
  var FLOOR_DB = -90;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** RMS in dBFS every HOP seconds, measured over a 20 ms window. */
  function envelope(samples, rate) {
    var hopSamples = Math.max(1, Math.round(rate * HOP));
    var window = hopSamples * 2;
    var count = Math.max(1, Math.ceil(samples.length / hopSamples));
    var db = new Float32Array(count);
    var i, j, start, end, sum, v, rms;

    for (i = 0; i < count; i++) {
      start = i * hopSamples - (window - hopSamples) / 2;
      end = start + window;
      if (start < 0) { start = 0; }
      if (end > samples.length) { end = samples.length; }
      sum = 0;
      for (j = start; j < end; j++) { v = samples[j]; sum += v * v; }
      rms = (end > start) ? Math.sqrt(sum / (end - start)) : 0;
      db[i] = rms > 1e-9 ? clamp(20 * Math.log10(rms), FLOOR_DB, 0) : FLOOR_DB;
    }
    return db;
  }

  function percentile(values, p) {
    if (!values.length) { return FLOOR_DB; }
    var sorted = Array.prototype.slice.call(values).sort(function (a, b) { return a - b; });
    return sorted[clamp(Math.floor(p * (sorted.length - 1)), 0, sorted.length - 1)];
  }

  /**
   * 26 dB below the loud end of the material. Speech has a wide dynamic range
   * and room tone does not, so the gap between them is reliably larger than
   * the gap between a quiet word and a loud one.
   */
  function autoThreshold(db) {
    var voiced = [], i;
    for (i = 0; i < db.length; i++) {
      if (db[i] > FLOOR_DB + 1) { voiced.push(db[i]); }
    }
    if (voiced.length < 10) { return -35; }
    return clamp(percentile(voiced, 0.95) - 26, -60, -18);
  }

  /**
   * samples - Float32Array of the mixed timeline
   * returns { db, hop, threshold, duration }
   */
  function map(samples, rate, thresholdDb) {
    var db = envelope(samples, rate);
    var threshold = (typeof thresholdDb === 'number') ? thresholdDb : autoThreshold(db);
    return {
      db: db,
      hop: HOP,
      threshold: threshold,
      duration: samples.length / rate
    };
  }

  /**
   * The share of a span, 0..1, that sits below the speech threshold.
   *
   * A span reaching past the end of the analysed audio counts the missing part
   * as quiet: whisper sometimes emits words past the end of the material, and
   * those are exactly the ones worth doubting.
   */
  function quietFraction(m, start, end) {
    if (!m || !m.db || !m.db.length) { return 0; }
    if (!(end > start)) { return 0; }

    var first = Math.floor(start / m.hop);
    var last = Math.ceil(end / m.hop);
    if (last <= first) { last = first + 1; }

    var quiet = 0, total = 0, i;
    for (i = first; i < last; i++) {
      total++;
      if (i < 0 || i >= m.db.length || m.db[i] < m.threshold) { quiet++; }
    }
    return total ? quiet / total : 0;
  }

  /** Loudest hop in a span, for reporting rather than deciding. */
  function peakDb(m, start, end) {
    if (!m || !m.db || !m.db.length) { return FLOOR_DB; }
    var first = Math.max(0, Math.floor(start / m.hop));
    var last = Math.min(m.db.length, Math.ceil(end / m.hop));
    var peak = FLOOR_DB, i;
    for (i = first; i < last; i++) { if (m.db[i] > peak) { peak = m.db[i]; } }
    return peak;
  }

  global.Speech = {
    map: map,
    envelope: envelope,
    autoThreshold: autoThreshold,
    quietFraction: quietFraction,
    peakDb: peakDb,
    HOP: HOP,
    FLOOR_DB: FLOOR_DB
  };
}(window));
