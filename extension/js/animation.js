/*
 * Caption animation.
 *
 * Each caption graphic gets keyframes on Premiere's own Motion and Opacity
 * properties rather than being rendered as a frame sequence: a few keyframes
 * per clip instead of thirty images per second, and the result stays tweakable
 * in Premiere afterwards.
 *
 * The maths lives here, in plain JavaScript, so it can be tested. The host
 * side only applies what this produces.
 */
(function (global) {
  'use strict';

  /*
   * Values are Premiere's own: scale and opacity are percentages, position is
   * normalised to the frame with [0.5, 0.5] at centre.
   *
   * `t` runs 0..1 across the in or out phase, not seconds, so the same shape
   * works whether a caption is on screen for a third of a second or six.
   */
  var PRESETS = {
    none: {
      name: 'None',
      inSeconds: 0, outSeconds: 0, in: {}, out: {}
    },
    fade: {
      name: 'Fade',
      inSeconds: 0.14, outSeconds: 0.10,
      in:  { opacity: [{ t: 0, v: 0 }, { t: 1, v: 100 }] },
      out: { opacity: [{ t: 0, v: 100 }, { t: 1, v: 0 }] }
    },
    pop: {
      name: 'Pop',
      inSeconds: 0.20, outSeconds: 0.08,
      // Overshoots past full size and settles back - the bounce that reads as
      // "snappy" rather than "slow".
      in:  {
        scale: [{ t: 0, v: 62 }, { t: 0.62, v: 110 }, { t: 1, v: 100 }],
        opacity: [{ t: 0, v: 0 }, { t: 0.45, v: 100 }]
      },
      out: { opacity: [{ t: 0, v: 100 }, { t: 1, v: 0 }] }
    },
    punch: {
      name: 'Punch',
      inSeconds: 0.12, outSeconds: 0,
      in: { scale: [{ t: 0, v: 132 }, { t: 1, v: 100 }] },
      out: {}
    },
    rise: {
      name: 'Rise',
      inSeconds: 0.24, outSeconds: 0.10,
      in: {
        position: [{ t: 0, v: [0.5, 0.56] }, { t: 1, v: [0.5, 0.5] }],
        opacity: [{ t: 0, v: 0 }, { t: 0.6, v: 100 }]
      },
      out: { opacity: [{ t: 0, v: 100 }, { t: 1, v: 0 }] }
    }
  };

  var REST = { scale: 100, opacity: 100, position: [0.5, 0.5] };

  /** Pull a value toward its resting state. 0 = no animation, 1 = as authored. */
  function scaleToward(prop, value, amount) {
    if (prop === 'position') {
      return [
        REST.position[0] + (value[0] - REST.position[0]) * amount,
        REST.position[1] + (value[1] - REST.position[1]) * amount
      ];
    }
    return REST[prop] + (value - REST[prop]) * amount;
  }

  function snap(seconds, fps) {
    if (!(fps > 0)) { return seconds; }
    return Math.round(seconds * fps) / fps;
  }

  /**
   * Keyframes for one caption clip, in seconds from the clip's own start.
   *
   * duration  - how long the clip is on screen
   * opts      - { preset, intensity (0..2), fps }
   *
   * Returns { scale: [{time, value}], opacity: [...], position: [...] }, only
   * including properties the preset actually touches.
   */
  function keyframesFor(duration, opts) {
    opts = opts || {};
    var preset = PRESETS[opts.preset || 'none'] || PRESETS.none;
    var intensity = (opts.intensity === undefined || opts.intensity === null) ? 1 : Number(opts.intensity);
    var fps = opts.fps || 0;
    var out = {};

    if (!(duration > 0) || preset === PRESETS.none || intensity <= 0) { return out; }

    // Never let the two phases eat the whole clip, or a short caption would
    // spend its entire life mid-animation and never sit still.
    var budget = duration * 0.8;
    var inSec = Math.min(preset.inSeconds, budget * 0.6);
    var outSec = Math.min(preset.outSeconds, budget * 0.4);

    function add(prop, time, value) {
      if (!out[prop]) { out[prop] = []; }
      var t = snap(Math.max(0, Math.min(duration, time)), fps);
      var last = out[prop][out[prop].length - 1];
      if (last && Math.abs(last.time - t) < 1e-6) { last.value = value; return; }
      out[prop].push({ time: t, value: value });
    }

    var prop, keys, i;

    if (inSec > 0) {
      for (prop in preset.in) {
        if (!preset.in.hasOwnProperty(prop)) { continue; }
        keys = preset.in[prop];
        for (i = 0; i < keys.length; i++) {
          add(prop, keys[i].t * inSec, scaleToward(prop, keys[i].v, intensity));
        }
        // Hold the resting value once the entrance is done.
        var lastIn = keys[keys.length - 1];
        if (lastIn.t < 1) { add(prop, inSec, REST[prop]); }
      }
    }

    if (outSec > 0) {
      for (prop in preset.out) {
        if (!preset.out.hasOwnProperty(prop)) { continue; }
        keys = preset.out[prop];
        var startOut = duration - outSec;
        // Make sure the property is at rest going into the exit.
        if (!out[prop] || !out[prop].length) { add(prop, Math.max(0, startOut), REST[prop]); }
        else if (out[prop][out[prop].length - 1].time < startOut - 1e-6) {
          add(prop, startOut, REST[prop]);
        }
        for (i = 0; i < keys.length; i++) {
          add(prop, startOut + keys[i].t * outSec, scaleToward(prop, keys[i].v, intensity));
        }
      }
    }

    // A single keyframe animates nothing; drop it rather than leave Premiere
    // with a pointless keyframe on the clip.
    for (prop in out) {
      if (out.hasOwnProperty(prop) && out[prop].length < 2) { delete out[prop]; }
    }
    return out;
  }

  /** Attaches keyframes to every rendered item, ready for the host side. */
  /**
   * Pulls each caption's end back so no two of them touch.
   *
   * Premiere's Cross Dissolve at a shared edit point is a cross fade between
   * the two clips - both captions on screen, blended into each other. It only
   * fades from nothing when there is nothing on the other side of the cut, so
   * the dissolve route needs a gap to fade against.
   *
   * This runs on the placed clips rather than on the cues, so the preview, the
   * .srt and any corrections typed into them keep the real speech timing. A
   * caption is never shortened past `floor`, since a gap is not worth losing
   * the caption for.
   */
  function space(items, gap, floor) {
    var least = (floor === undefined) ? 0.24 : floor;
    var out = [], i;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      var copy = {};
      for (var k in it) { if (it.hasOwnProperty(k)) { copy[k] = it[k]; } }

      var next = items[i + 1];
      if (gap > 0 && next) {
        var latest = next.start - gap;
        if (copy.end > latest) { copy.end = Math.max(copy.start + least, latest); }
        // Still overlapping means the captions are tighter than the gap asks
        // for; keep them apart rather than keep them long.
        if (copy.end > next.start) { copy.end = next.start; }
      }
      out.push(copy);
    }
    return out;
  }

  function planFor(items, opts) {
    var out = [], i;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      var plan = {
        file: it.file,
        start: it.start,
        end: it.end,
        text: it.text
      };
      var keys = keyframesFor(it.end - it.start, opts);
      if (Object.keys(keys).length) { plan.keys = keys; }
      out.push(plan);
    }
    return out;
  }

  global.Animation = {
    PRESETS: PRESETS,
    keyframesFor: keyframesFor,
    planFor: planFor,
    space: space,
    REST: REST
  };
}(window));
