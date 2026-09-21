/*
 * Renders the sequence's audio to a single 16 kHz mono WAV.
 *
 * Whisper wants one contiguous stream, and giving it the whole timeline rather
 * than clip-by-clip matters twice over: the model keeps context across cuts,
 * and every timestamp it returns is already a timeline timestamp, so nothing
 * downstream has to map anything back.
 *
 * Each source file is decoded once, only across the span the timeline actually
 * uses, then painted into a timeline-length buffer honouring in-point, speed
 * and overlap.
 */
(function (global) {
  'use strict';

  var RATE = 16000;                       // what whisper.cpp expects
  var MAX_SECONDS = 4 * 3600;             // ~920 MB of float; refuse beyond this

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** Standard 44-byte PCM header, then the samples. */
  function writeWav(filePath, samples, rate) {
    var node = global.Env.node();
    var n = samples.length;
    var view = new DataView(new ArrayBuffer(44 + n * 2));

    function str(off, s) {
      for (var i = 0; i < s.length; i++) { view.setUint8(off + i, s.charCodeAt(i)); }
    }
    str(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);          // PCM chunk size
    view.setUint16(20, 1, true);           // format = PCM
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);    // byte rate
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    str(36, 'data');
    view.setUint32(40, n * 2, true);

    for (var i = 0; i < n; i++) {
      var v = clamp(samples[i], -1, 1);
      view.setInt16(44 + i * 2, Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), true);
    }

    // writeFileSync takes a TypedArray directly, so this never copies.
    node.fs.writeFileSync(filePath, new Uint8Array(view.buffer));
    return filePath;
  }

  /**
   * info      - payload from Host.getSequenceInfo()
   * opts      - { ffmpeg, extensionRoot, skipMutedTracks, tracks, isCancelled }
   * onProgress(fraction, message)
   */
  function render(info, opts, onProgress) {
    var Env = global.Env;
    Env.requireNode();

    var duration = info.duration;
    if (!(duration > 0)) { return Promise.reject(new Error('This sequence looks empty.')); }
    if (duration > MAX_SECONDS) {
      return Promise.reject(new Error(
        'This sequence is ' + (duration / 3600).toFixed(1) + ' hours long. Transcribing more than ' +
        (MAX_SECONDS / 3600) + ' hours at once needs more memory than the panel has. ' +
        'Set an in/out range and do it in passes.'));
    }

    var ffmpeg = opts.ffmpeg;
    if (!ffmpeg) { return Promise.reject(new Error('ffmpeg is missing, so the audio cannot be read.')); }

    /* which clips matter */
    var jobs = [], skipped = 0, t, k, track, clip;
    for (t = 0; t < info.audioTracks.length; t++) {
      track = info.audioTracks[t];
      if (opts.tracks && opts.tracks !== 'all' && opts.tracks.indexOf(track.index) === -1) { continue; }
      if (opts.skipMutedTracks && track.muted) { continue; }
      for (k = 0; k < track.clips.length; k++) {
        clip = track.clips[k];
        if (clip.disabled) { continue; }
        if (!clip.mediaPath) { skipped++; continue; }
        jobs.push(clip);
      }
    }
    if (!jobs.length) {
      return Promise.reject(new Error('No usable audio clips were found on the selected tracks.'));
    }

    /* one decode per file, spanning only what the timeline touches */
    var uniquePaths = [], ranges = {}, i;
    for (i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      var from = job.inPoint;
      var to = job.inPoint + (job.end - job.start) * job.speed;
      if (!ranges[job.mediaPath]) {
        uniquePaths.push(job.mediaPath);
        ranges[job.mediaPath] = { start: from, end: to };
      } else {
        if (from < ranges[job.mediaPath].start) { ranges[job.mediaPath].start = from; }
        if (to > ranges[job.mediaPath].end) { ranges[job.mediaPath].end = to; }
      }
    }
    for (i = 0; i < uniquePaths.length; i++) {
      var r = ranges[uniquePaths[i]];
      r.start = Math.max(0, r.start - 0.25);
      r.duration = Math.max(0.5, (r.end + 0.25) - r.start);
    }

    var total = Math.ceil(duration * RATE) + RATE;
    var mix = new Float32Array(total);
    var decoded = {};
    var failures = [];
    var chain = Promise.resolve();
    var cancelled = function () { return opts.isCancelled && opts.isCancelled(); };

    uniquePaths.forEach(function (p, idx) {
      chain = chain.then(function () {
        if (cancelled()) { throw new Error('Cancelled.'); }
        var label = p.replace(/^.*[\\\/]/, '');
        var base = idx / uniquePaths.length;
        var slice = 1 / uniquePaths.length;
        if (onProgress) { onProgress(base, 'Reading ' + label); }

        return Env.decodeAudio(ffmpeg, p, RATE, {
          start: ranges[p].start,
          duration: ranges[p].duration,
          onProgress: function (f) {
            if (onProgress) {
              onProgress(base + slice * f, 'Reading ' + label + '  ' + Math.round(f * 100) + '%');
            }
          }
        }).then(function (samples) {
          decoded[p] = { samples: samples, offset: ranges[p].start };
        }).catch(function (err) {
          if (cancelled()) { throw new Error('Cancelled.'); }
          failures.push({ path: p, error: err.message || String(err) });
        });
      });
    });

    return chain.then(function () {
      if (cancelled()) { throw new Error('Cancelled.'); }
      if (onProgress) { onProgress(1, 'Mixing'); }

      var painted = 0, j;
      for (j = 0; j < jobs.length; j++) {
        var c = jobs[j];
        var src = decoded[c.mediaPath];
        if (!src) { continue; }
        painted++;

        var first = Math.max(0, Math.floor(c.start * RATE));
        var last = Math.min(total - 1, Math.ceil(c.end * RATE));
        for (var n = first; n <= last; n++) {
          var tlT = n / RATE;
          var srcT = c.inPoint + (tlT - c.start) * c.speed;
          var si = Math.round((srcT - src.offset) * RATE);
          if (si < 0 || si >= src.samples.length) { continue; }
          mix[n] += src.samples[si];          // sum, so overlapping clips add
        }
      }

      if (!painted) {
        throw new Error('None of the audio could be decoded.' +
                        (failures.length ? ' ' + failures[0].error : ''));
      }

      // Only normalise if summing actually clipped; whisper is happier with
      // untouched levels than with something squashed for no reason.
      var peak = 0;
      for (j = 0; j < mix.length; j++) { var a = mix[j] < 0 ? -mix[j] : mix[j]; if (a > peak) { peak = a; } }
      if (peak > 1) {
        var g = 1 / peak;
        for (j = 0; j < mix.length; j++) { mix[j] *= g; }
      }

      var wav = Env.tempFile('.wav');
      writeWav(wav, mix, RATE);
      return { path: wav, duration: duration, rate: RATE, skippedClips: skipped, failures: failures };
    });
  }

  global.TimelineAudio = { render: render, RATE: RATE, writeWav: writeWav };
}(window));
