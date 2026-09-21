/*
 * Draws caption graphics.
 *
 * Premiere has no scriptable way to create a styled text layer, so Captionist
 * draws each caption itself and brings it in as an image. That costs
 * editability - the result is a picture, not text you can retype in Premiere -
 * and buys complete control of the look plus the ability to animate it without
 * anyone having to author a Motion Graphics Template first.
 *
 * Frames are drawn at full sequence resolution so placement is trivial: the
 * image covers the frame and needs no scaling or positioning to sit right.
 */
(function (global) {
  'use strict';

  var PRESETS = {
    clean: {
      name: 'Clean',
      fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
      fontWeight: 700,
      sizePct: 5.0,            // % of frame height
      uppercase: false,
      fill: '#ffffff',
      highlight: '#ffd93d',
      outline: '#000000',
      outlineWidth: 0.16,      // multiple of stroke unit, see strokeFor()
      shadow: true,
      shadowBlurPct: 0.6,
      box: false,
      boxColor: '#000000',
      boxOpacity: 0.55,
      boxRadiusPct: 0.8,
      boxPadPct: 1.2,
      widthPct: 80,
      position: 'bottom',
      offsetPct: 12,
      lineSpacing: 1.18
    },
    punch: {
      name: 'Punch',
      fontFamily: '"Arial Black", "Segoe UI Black", Impact, sans-serif',
      fontWeight: 900,
      sizePct: 7.5,
      uppercase: true,
      fill: '#ffffff',
      highlight: '#ffd93d',
      outline: '#000000',
      outlineWidth: 0.22,
      shadow: true,
      shadowBlurPct: 0.9,
      box: false,
      boxColor: '#000000',
      boxOpacity: 0.55,
      boxRadiusPct: 0.8,
      boxPadPct: 1.2,
      widthPct: 86,
      position: 'middle',
      offsetPct: 0,
      lineSpacing: 1.12
    },
    boxed: {
      name: 'Boxed',
      fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
      fontWeight: 700,
      sizePct: 4.4,
      uppercase: false,
      fill: '#ffffff',
      highlight: '#ffd93d',
      outline: 'none',
      outlineWidth: 0,
      shadow: false,
      shadowBlurPct: 0,
      box: true,
      boxColor: '#000000',
      boxOpacity: 0.68,
      boxRadiusPct: 0.7,
      boxPadPct: 1.4,
      widthPct: 78,
      position: 'bottom',
      offsetPct: 10,
      lineSpacing: 1.22
    }
  };

  function merged(style) {
    var base = PRESETS[(style && style.preset) || 'clean'] || PRESETS.clean;
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    if (style) {
      Object.keys(style).forEach(function (k) {
        if (k !== 'preset' && style[k] !== undefined && style[k] !== null && style[k] !== '') {
          out[k] = style[k];
        }
      });
    }
    return out;
  }

  function hexToRgba(hex, alpha) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
    var n = parseInt(h, 16);
    if (isNaN(n)) { return 'rgba(0,0,0,' + alpha + ')'; }
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function strokeFor(style, fontPx) { return fontPx * style.outlineWidth; }

  /** Greedy wrap that respects the caption's own line breaks first. */
  function wrap(ctx, text, maxWidth) {
    var out = [];
    var paragraphs = String(text).split('\n');
    for (var p = 0; p < paragraphs.length; p++) {
      var words = paragraphs[p].split(/\s+/).filter(Boolean);
      if (!words.length) { continue; }
      var line = words[0];
      for (var i = 1; i < words.length; i++) {
        var trial = line + ' ' + words[i];
        if (ctx.measureText(trial).width <= maxWidth) { line = trial; }
        else { out.push(line); line = words[i]; }
      }
      out.push(line);
    }
    return out.length ? out : [''];
  }

  function roundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  /**
   * Draws one caption onto a canvas the size of the sequence frame.
   *
   * cue          - { text, words }
   * frame        - { width, height }
   * activeWord   - index into cue.words to highlight, or -1 for none
   */
  function draw(canvas, cue, style, frame, activeWord) {
    var s = merged(style);
    canvas.width = frame.width;
    canvas.height = frame.height;

    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, frame.width, frame.height);

    var fontPx = Math.round(frame.height * (s.sizePct / 100));
    ctx.font = s.fontWeight + ' ' + fontPx + 'px ' + s.fontFamily;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    var text = s.uppercase ? String(cue.text).toUpperCase() : String(cue.text);
    var maxWidth = frame.width * (s.widthPct / 100);
    var lines = wrap(ctx, text, maxWidth);

    var lineHeight = fontPx * s.lineSpacing;
    var blockHeight = lineHeight * lines.length;

    var centreY;
    if (s.position === 'top') { centreY = frame.height * (s.offsetPct / 100) + blockHeight / 2; }
    else if (s.position === 'middle') { centreY = frame.height / 2 + frame.height * (s.offsetPct / 100); }
    else { centreY = frame.height - frame.height * (s.offsetPct / 100) - blockHeight / 2; }

    var firstBaseline = centreY - blockHeight / 2 + fontPx * 0.82;
    var cx = frame.width / 2;

    /* the plate behind the text, when there is one */
    if (s.box) {
      var pad = frame.height * (s.boxPadPct / 100);
      var widest = 0;
      for (var i = 0; i < lines.length; i++) {
        widest = Math.max(widest, ctx.measureText(lines[i]).width);
      }
      ctx.fillStyle = hexToRgba(s.boxColor, s.boxOpacity);
      roundRect(ctx,
        cx - widest / 2 - pad,
        centreY - blockHeight / 2 - pad * 0.6,
        widest + pad * 2,
        blockHeight + pad * 1.2,
        frame.height * (s.boxRadiusPct / 100));
      ctx.fill();
    }

    /* Which word is active, counted across the whole wrapped block. */
    var wordIndex = 0;
    var activeText = (activeWord >= 0 && cue.words && cue.words[activeWord])
      ? (s.uppercase ? cue.words[activeWord].text.toUpperCase() : cue.words[activeWord].text)
      : null;

    for (var l = 0; l < lines.length; l++) {
      var baseline = firstBaseline + l * lineHeight;
      var lineWords = lines[l].split(/\s+/).filter(Boolean);

      if (activeText === null) {
        paintRun(ctx, lines[l], cx, baseline, s, fontPx, s.fill);
        wordIndex += lineWords.length;
        continue;
      }

      // Highlighting needs per-word placement, so lay the line out by hand.
      var spaceW = ctx.measureText(' ').width;
      var lineW = 0, w;
      for (w = 0; w < lineWords.length; w++) {
        lineW += ctx.measureText(lineWords[w]).width;
        if (w < lineWords.length - 1) { lineW += spaceW; }
      }

      var x = cx - lineW / 2;
      ctx.textAlign = 'left';
      for (w = 0; w < lineWords.length; w++) {
        var isActive = (wordIndex === activeWord);
        paintRun(ctx, lineWords[w], x, baseline, s, fontPx, isActive ? s.highlight : s.fill);
        x += ctx.measureText(lineWords[w]).width + spaceW;
        wordIndex++;
      }
      ctx.textAlign = 'center';
    }

    return canvas;
  }

  /** Outline under fill, with the shadow applied only to the outline pass. */
  function paintRun(ctx, text, x, y, s, fontPx, fillColour) {
    if (s.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.75)';
      ctx.shadowBlur = fontPx * (s.shadowBlurPct / 10);
      ctx.shadowOffsetY = fontPx * 0.04;
    }
    if (s.outline && s.outline !== 'none' && s.outlineWidth > 0) {
      ctx.lineWidth = strokeFor(s, fontPx);
      ctx.strokeStyle = s.outline;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeText(text, x, y);
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = fillColour;
    ctx.fillText(text, x, y);
  }

  /**
   * Renders every caption to a PNG.
   *
   * With karaoke on, a cue of several words becomes one image per word, each
   * starting when that word is spoken. With it off, one image per cue.
   *
   * Returns [{ file, start, end, cue, word }].
   */
  function renderAll(cues, style, frame, outDir, onProgress, isCancelled) {
    var Env = global.Env;
    Env.requireNode();
    var node = Env.node();
    Env.ensureDir(outDir);

    var canvas = document.createElement('canvas');
    var items = [];
    var karaoke = !!(style && style.karaoke);

    for (var i = 0; i < cues.length; i++) {
      if (isCancelled && isCancelled()) { throw new Error('Cancelled.'); }
      var cue = cues[i];
      var shots = [];

      if (karaoke && cue.words && cue.words.length > 1) {
        for (var w = 0; w < cue.words.length; w++) {
          var from = (w === 0) ? cue.start : Math.max(cue.start, cue.words[w].start);
          var to = (w === cue.words.length - 1) ? cue.end
                                                : Math.max(from, cue.words[w + 1].start);
          if (to - from < 0.02) { continue; }
          shots.push({ activeWord: w, start: from, end: to });
        }
      }
      if (!shots.length) { shots.push({ activeWord: -1, start: cue.start, end: cue.end }); }

      for (var k = 0; k < shots.length; k++) {
        draw(canvas, cue, style, frame, shots[k].activeWord);
        var name = 'cap_' + pad(i, 4) + (shots.length > 1 ? '_' + pad(k, 2) : '') + '.png';
        var file = node.path.join(outDir, name);
        writePng(canvas, file);
        items.push({
          file: file,
          start: shots[k].start,
          end: shots[k].end,
          text: cue.text,
          word: shots[k].activeWord
        });
      }

      if (onProgress) { onProgress((i + 1) / cues.length, 'Drawing caption ' + (i + 1) + ' of ' + cues.length); }
    }
    return items;
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) { s = '0' + s; }
    return s;
  }

  function writePng(canvas, filePath) {
    var node = global.Env.node();
    var url = canvas.toDataURL('image/png');
    var b64 = url.slice(url.indexOf(',') + 1);
    node.fs.writeFileSync(filePath, b64, 'base64');
    return filePath;
  }

  global.Renderer = {
    draw: draw,
    renderAll: renderAll,
    writePng: writePng,
    PRESETS: PRESETS,
    merged: merged
  };
}(window));
