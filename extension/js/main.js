/*
 * Panel controller: pick a model, transcribe the timeline, shape the captions,
 * put them back.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'captionist.settings.v1';
  var RANGES = ['maxWords', 'maxCharsPerLine', 'maxLines', 'maxDuration', 'gapSplit',
                'intensity', 'sizePct', 'offsetPct'];
  var CHECKS = ['splitOnPunctuation', 'avoidWidows', 'skipMutedTracks', 'translate', 'attach',
                'karaoke', 'uppercase'];

  var DEFAULTS = {
    model: '',
    language: 'auto',
    style: 'long',
    prompt: '',
    binName: 'Captions',
    attach: true,
    skipMutedTracks: true,
    translate: false,
    maxWords: 12,
    maxCharsPerLine: 42,
    maxLines: 2,
    maxDuration: 6,
    gapSplit: 0.4,
    splitOnPunctuation: true,
    avoidWidows: true,
    stylePreset: 'clean',
    animPreset: 'pop',
    intensity: 100,
    sizePct: 5,
    offsetPct: 12,
    position: 'bottom',
    highlight: '#ffd93d',
    karaoke: false,
    uppercase: false
  };

  var settings = {};
  var sequenceInfo = null;
  var words = null;
  var cues = null;
  var detectedLanguage = '';
  var busy = false;
  var cancelRequested = false;
  var extensionRoot = '';
  var tools = { ffmpeg: null, whisper: null };
  var rechunkTimer = null;

  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------- utils */

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) { sec = 0; }
    if (sec < 60) { return sec.toFixed(1) + 's'; }
    var m = Math.floor(sec / 60), s = Math.round(sec - m * 60);
    if (s === 60) { m += 1; s = 0; }
    if (m < 60) { return m + 'm ' + s + 's'; }
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function fmtBytes(n) {
    if (!(n > 0)) { return '0 MB'; }
    if (n < 1048576) { return Math.round(n / 1024) + ' KB'; }
    if (n < 1073741824) { return Math.round(n / 1048576) + ' MB'; }
    return (n / 1073741824).toFixed(1) + ' GB';
  }

  function logLine(msg) {
    var el = $('log'), t = new Date();
    var stamp = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) +
                ':' + ('0' + t.getSeconds()).slice(-2);
    el.textContent += '[' + stamp + '] ' + msg + '\n';
    el.scrollTop = el.scrollHeight;
  }

  function status(msg, kind) {
    var el = $('status');
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
    if (msg) { logLine(msg); }
  }

  function setBusy(on) {
    busy = on;
    $('transcribe').disabled = on || !sequenceInfo || !currentModelPath();
    $('import').disabled = on || !cues || !cues.length;
    $('save').disabled = on || !cues || !cues.length;
    $('animate').disabled = on || !cues || !cues.length;
    $('refresh').disabled = on;
  }

  function progress(fraction, text) {
    $('progress').classList.remove('hidden');
    $('progress-bar').style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%';
    $('progress-text').textContent = text || '';
  }

  function hideProgress() { $('progress').classList.add('hidden'); }

  /* ------------------------------------------------------------- settings */

  function loadSettings() {
    settings = {};
    var stored = {};
    try { stored = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) {}
    Object.keys(DEFAULTS).forEach(function (k) {
      settings[k] = (stored && stored[k] !== undefined) ? stored[k] : DEFAULTS[k];
    });
  }

  function saveSettings() {
    try { global.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function readout(key, value) {
    if (key === 'gapSplit') { return Number(value).toFixed(2); }
    if (key === 'maxDuration' || key === 'sizePct') { return Number(value).toFixed(1); }
    return String(value);
  }

  function settingsToUi() {
    RANGES.forEach(function (k) {
      $(k).value = settings[k];
      $(k + '-out').textContent = readout(k, settings[k]);
    });
    CHECKS.forEach(function (k) { $(k).checked = !!settings[k]; });
    $('language').value = settings.language;
    $('style').value = settings.style;
    $('prompt').value = settings.prompt;
    $('binName').value = settings.binName;
    $('stylePreset').value = settings.stylePreset;
    $('animPreset').value = settings.animPreset;
    $('position').value = settings.position;
    $('highlight').value = settings.highlight;
  }

  function uiToSettings() {
    RANGES.forEach(function (k) {
      settings[k] = Number($(k).value);
      $(k + '-out').textContent = readout(k, settings[k]);
    });
    CHECKS.forEach(function (k) { settings[k] = $(k).checked; });
    settings.language = $('language').value;
    settings.style = $('style').value;
    settings.prompt = $('prompt').value.trim();
    settings.binName = $('binName').value.trim() || DEFAULTS.binName;
    settings.model = $('model').value;
    settings.stylePreset = $('stylePreset').value;
    settings.animPreset = $('animPreset').value;
    settings.position = $('position').value;
    settings.highlight = $('highlight').value.trim() || DEFAULTS.highlight;
    saveSettings();
  }

  /** The look settings, in the shape Renderer expects. */
  function styleSettings() {
    return {
      preset: settings.stylePreset,
      sizePct: settings.sizePct,
      offsetPct: settings.offsetPct,
      position: settings.position,
      highlight: settings.highlight,
      uppercase: settings.uppercase,
      karaoke: settings.karaoke
    };
  }

  function frameSize() {
    return {
      width: (sequenceInfo && sequenceInfo.frameWidth) || 1920,
      height: (sequenceInfo && sequenceInfo.frameHeight) || 1080
    };
  }

  /**
   * Draws a sample caption at panel scale so the look can be judged without
   * rendering the whole timeline first.
   */
  function drawLookPreview() {
    var canvas = $('look-preview');
    if (!canvas || !global.Renderer) { return; }

    var frame = frameSize();
    var cssW = canvas.clientWidth || 340;
    var cssH = canvas.clientHeight || 132;
    var dpr = global.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    var ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Letterbox the sequence's aspect into the preview strip.
    var scale = Math.min(canvas.width / frame.width, canvas.height / frame.height);
    var w = frame.width * scale, h = frame.height * scale;
    var ox = (canvas.width - w) / 2, oy = (canvas.height - h) / 2;

    var g = ctx.createLinearGradient(ox, oy, ox + w, oy + h);
    g.addColorStop(0, '#39465e'); g.addColorStop(1, '#222b38');
    ctx.fillStyle = g;
    ctx.fillRect(ox, oy, w, h);

    var sample = cues && cues.length
      ? cues[Math.min(1, cues.length - 1)]
      : { text: 'This is how your captions will look',
          words: 'This is how your captions will look'.split(' ').map(function (t) { return { text: t }; }) };

    var layer = document.createElement('canvas');
    global.Renderer.draw(layer, sample, styleSettings(), frame,
                         settings.karaoke && sample.words && sample.words.length > 1 ? 1 : -1);
    ctx.drawImage(layer, ox, oy, w, h);
  }

  /** Switching preset resets the shape sliders to that preset's numbers. */
  function applyPreset(name) {
    var p = global.Chunker.PRESETS[name];
    if (!p) { return; }
    RANGES.forEach(function (k) { if (p[k] !== undefined) { settings[k] = p[k]; } });
    ['splitOnPunctuation', 'avoidWidows'].forEach(function (k) {
      if (p[k] !== undefined) { settings[k] = p[k]; }
    });
    settingsToUi();
    saveSettings();
  }

  /* --------------------------------------------------------------- models */

  function currentModelPath() {
    var custom = $('customModel') ? $('customModel').value.trim() : '';
    if (custom) { return custom; }
    var id = $('model').value;
    if (!id) { return null; }
    try { return global.Models.isInstalled(id) ? global.Models.pathFor(id) : null; }
    catch (e) { return null; }
  }

  function refreshModelPicker() {
    var sel = $('model');
    var previous = settings.model || sel.value;
    sel.innerHTML = '';

    var ready = [];
    try { ready = global.Models.installed().filter(function (m) { return m.valid; }); } catch (e) {}

    if (!ready.length) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No model yet — see the Models tab';
      sel.appendChild(opt);
      $('model-hint').textContent = 'Captionist needs one Whisper model before it can transcribe.';
    } else {
      ready.forEach(function (m) {
        var cat = global.Models.byId(m.id);
        var o = document.createElement('option');
        o.value = m.id;
        o.textContent = (cat ? cat.label : m.id) + '  ·  ' + fmtBytes(m.size);
        sel.appendChild(o);
      });
      if (previous && sel.querySelector('option[value="' + previous + '"]')) { sel.value = previous; }
      var chosen = global.Models.byId(sel.value);
      $('model-hint').textContent = chosen
        ? chosen.speed + ' · ' + chosen.quality + (chosen.multilingual ? ' · multilingual' : ' · English only')
        : '';
    }
    setBusy(busy);
  }

  function approxSize(mb) {
    return mb >= 1000 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
  }

  function renderModelList() {
    var host = $('model-list');
    host.innerHTML = '';

    global.Models.CATALOG.forEach(function (m) {
      var have = false;
      try { have = global.Models.isInstalled(m.id); } catch (e) {}

      var row = document.createElement('div');
      row.className = 'model' + (have ? ' is-ready' : '');

      var main = document.createElement('div');
      main.className = 'model-main';
      var name = document.createElement('div');
      name.className = 'model-name';
      name.textContent = m.label;
      if (m.recommended) {
        var pill = document.createElement('span');
        pill.className = 'pill';
        pill.textContent = 'recommended';
        name.appendChild(pill);
      }
      var meta = document.createElement('div');
      meta.className = 'model-meta';
      meta.textContent = (have ? 'installed' : '~' + approxSize(m.approxMB)) +
                         ' · ' + m.speed + ' · ' + m.quality +
                         (m.multilingual ? '' : ' · English only');
      main.appendChild(name);
      main.appendChild(meta);

      var action = document.createElement('div');
      action.className = 'model-action';
      var btn = document.createElement('button');
      btn.className = 'btn-tiny' + (have ? ' is-danger' : '');
      btn.textContent = have ? 'Remove' : 'Download';
      btn.addEventListener('click', function () {
        if (have) { removeModel(m, btn); } else { downloadModel(m, btn, meta); }
      });
      action.appendChild(btn);

      row.appendChild(main);
      row.appendChild(action);
      host.appendChild(row);
    });

    try { $('disk-usage').textContent = 'Models on disk: ' + fmtBytes(global.Models.diskUsage()) +
      '  ·  ' + global.Models.modelsDir(); } catch (e) {}
  }

  function downloadModel(m, btn, meta) {
    btn.disabled = true;
    btn.textContent = 'Starting…';
    status('Downloading ' + m.label + '…');

    global.Models.download(m.id, function (f, received, total) {
      btn.textContent = Math.round(f * 100) + '%';
      meta.textContent = fmtBytes(received) + ' of ' + fmtBytes(total);
    }).then(function (res) {
      status(m.label + ' is ready (' + fmtBytes(res.size) + ').', 'good');
      renderModelList();
      refreshModelPicker();
    }).catch(function (err) {
      status(err.message || String(err), 'error');
      btn.disabled = false;
      btn.textContent = 'Download';
      renderModelList();
    });
  }

  function removeModel(m, btn) {
    if (!global.confirm('Remove ' + m.label + '? You can download it again later.')) { return; }
    btn.disabled = true;
    try {
      global.Models.remove(m.id);
      status(m.label + ' removed.');
    } catch (e) { status(e.message || String(e), 'error'); }
    renderModelList();
    refreshModelPicker();
  }

  /* ------------------------------------------------------------- sequence */

  function invalidateResult() {
    words = null;
    cues = null;
    $('results').classList.add('hidden');
    $('empty-hint').classList.remove('hidden');
    $('import').disabled = true;
    $('save').disabled = true;
    $('animate').disabled = true;
  }

  function refreshSequence(quiet) {
    return global.Host.getSequenceInfo().then(function (info) {
      sequenceInfo = info;
      $('sequence-name').textContent = info.name;
      $('sequence-name').title = info.name + ' — ' + fmtTime(info.duration) +
                                 ' @ ' + info.fps.toFixed(2) + ' fps';
      info.warnings.forEach(function (w) { logLine('Note: ' + w); });
      if (!quiet) {
        status('Ready. ' + fmtTime(info.duration) + ' of timeline, ' +
               info.audioTracks.length + ' audio track(s).');
      }
      setBusy(busy);
      return info;
    }).catch(function (err) {
      sequenceInfo = null;
      $('sequence-name').textContent = '—';
      invalidateResult();
      setBusy(busy);
      status(err.message, 'error');
    });
  }

  /* ---------------------------------------------------------- transcribe */

  function chunkSettings() {
    return {
      preset: settings.style,
      maxWords: settings.maxWords,
      maxCharsPerLine: settings.maxCharsPerLine,
      maxLines: settings.maxLines,
      maxDuration: settings.maxDuration,
      gapSplit: settings.gapSplit,
      splitOnPunctuation: settings.splitOnPunctuation,
      avoidWidows: settings.avoidWidows
    };
  }

  function rechunk() {
    if (!words || !words.length) { return; }
    cues = global.Chunker.build(words, chunkSettings());
    if (sequenceInfo) { cues = global.Chunker.snapToFrames(cues, sequenceInfo.fps); }
    showResult();
  }

  function showResult() {
    var s = global.Chunker.stats(cues);
    $('results').classList.remove('hidden');
    $('empty-hint').classList.add('hidden');
    $('stat-cues').textContent = String(s.count);
    $('stat-words').textContent = String(words ? words.length : 0);
    $('stat-perCue').textContent = s.wordsPerCue.toFixed(1);
    $('detected').textContent =
      (detectedLanguage ? 'Detected ' + detectedLanguage.toUpperCase() + ' · ' : '') +
      'average ' + s.averageDuration.toFixed(2) + 's on screen · ' +
      Math.round(s.charsPerCue) + ' characters per caption';

    var host = $('preview');
    host.innerHTML = '';
    var limit = Math.min(cues.length, 120);
    for (var i = 0; i < limit; i++) {
      var row = document.createElement('div');
      row.className = 'cue';
      var time = document.createElement('span');
      time.className = 'cue-time';
      time.textContent = global.Subtitles.stamp(cues[i].start, '.').slice(3, 11);
      var text = document.createElement('span');
      text.className = 'cue-text';
      text.textContent = cues[i].text;
      row.appendChild(time);
      row.appendChild(text);
      host.appendChild(row);
    }
    if (cues.length > limit) {
      var more = document.createElement('div');
      more.className = 'cue';
      more.innerHTML = '<span class="cue-time"></span><span class="cue-text">' +
                       (cues.length - limit) + ' more…</span>';
      host.appendChild(more);
    }

    $('import').disabled = !cues.length;
    $('save').disabled = !cues.length;
    $('animate').disabled = !cues.length;
    drawLookPreview();
  }

  function transcribe() {
    if (busy) { return; }
    var modelPath = currentModelPath();
    if (!modelPath) {
      status('Pick a model first — the Models tab has them.', 'error');
      return;
    }
    if (!tools.whisper) {
      status('whisper-cli is missing from this install. Reinstall Captionist.', 'error');
      return;
    }

    cancelRequested = false;
    setBusy(true);
    invalidateResult();
    status('Reading the timeline…');

    var wav = null;
    var isCancelled = function () { return cancelRequested; };

    refreshSequence(true).then(function (info) {
      if (!info) { throw new Error('No sequence to transcribe.'); }
      return global.TimelineAudio.render(info, {
        ffmpeg: tools.ffmpeg,
        skipMutedTracks: settings.skipMutedTracks,
        tracks: 'all',
        isCancelled: isCancelled
      }, function (f, msg) { progress(f * 0.25, msg); });
    }).then(function (audio) {
      wav = audio.path;
      audio.failures.forEach(function (f) {
        logLine('Could not decode ' + f.path.replace(/^.*[\\\/]/, '') + ': ' + f.error);
      });
      logLine('Audio ready: ' + fmtTime(audio.duration) + ' at ' + audio.rate + ' Hz.');

      return global.Whisper.transcribe({
        whisper: tools.whisper,
        modelPath: modelPath,
        modelId: $('model').value,
        wavPath: wav,
        language: settings.language,
        translate: settings.translate,
        prompt: settings.prompt,
        isCancelled: isCancelled
      }, function (f, msg) { progress(0.25 + f * 0.75, msg); });
    }).then(function (result) {
      if (wav) { global.Env.remove(wav); wav = null; }
      words = result.words;
      detectedLanguage = result.language || '';
      if (!words.length) { throw new Error('Whisper found no speech in this timeline.'); }

      rechunk();
      hideProgress();
      status('Transcribed ' + words.length + ' words into ' + cues.length + ' captions.', 'good');
    }).catch(function (err) {
      if (wav) { global.Env.remove(wav); }
      hideProgress();
      invalidateResult();
      if (cancelRequested || /cancel/i.test(err.message || '')) {
        status('Stopped. Nothing was changed.');
      } else {
        status(err.message || String(err), 'error');
        $('log-card').open = true;
      }
    }).then(function () {
      cancelRequested = false;
      setBusy(false);
    });
  }

  /* -------------------------------------------------------------- output */

  function writeSrtToTemp() {
    var node = global.Env.node();
    var safe = (sequenceInfo ? sequenceInfo.name : 'captions').replace(/[^\w.-]+/g, '_');
    var file = node.path.join(global.Env.dataDir(), safe + '.srt');
    global.Subtitles.write(file, global.Subtitles.toSrt(cues));
    return file;
  }

  function addToSequence() {
    if (!cues || !cues.length || busy) { return; }
    setBusy(true);
    status('Importing…');
    var file;
    try { file = writeSrtToTemp(); }
    catch (e) { setBusy(false); status('Could not write the subtitle file: ' + e.message, 'error'); return; }

    global.Host.importSubtitles({
      path: file,
      binName: settings.binName,
      attach: settings.attach
    }).then(function (res) {
      global.Host.drainLog().forEach(logLine);
      if (res.attached) {
        status('Captions imported and attached to the sequence.', 'good');
      } else {
        status('Captions imported into "' + settings.binName +
               '". Drag them onto the timeline — see Details for why they were not attached.', 'good');
      }
    }).catch(function (err) {
      global.Host.drainLog().forEach(logLine);
      status(err.message || String(err), 'error');
      $('log-card').open = true;
    }).then(function () { setBusy(false); });
  }

  /**
   * Draws every caption, places them on a video track and animates them.
   *
   * The graphics are images, so this is the route that gives motion and a
   * styled look at the cost of the text no longer being editable in Premiere.
   * The caption-track route above is still there for when that matters.
   */
  function addAnimatedCaptions() {
    if (!cues || !cues.length || busy) { return; }

    var frame = frameSize();
    var karaoke = settings.karaoke;
    var estimate = karaoke
      ? cues.reduce(function (n, c) { return n + Math.max(1, c.words.length); }, 0)
      : cues.length;

    var question = 'Draw ' + estimate + ' caption graphic' + (estimate === 1 ? '' : 's') +
      ' at ' + frame.width + '\u00d7' + frame.height + ' and place them on the top video track?' +
      '\n\nThey are images, so the text will not be editable in Premiere afterwards.' +
      '\nUse "Add as caption track" instead if you need editable text.';
    if (!global.confirm(question)) { return; }

    cancelRequested = false;
    setBusy(true);
    status('Drawing captions\u2026');

    var node, outDir;
    try {
      node = global.Env.node();
      outDir = node.path.join(global.Env.dataDir(), 'graphics',
        (sequenceInfo ? sequenceInfo.name : 'sequence').replace(/[^\w.-]+/g, '_'));
      global.Env.ensureDir(outDir);
    } catch (e) {
      setBusy(false);
      status('Could not prepare a folder for the graphics: ' + e.message, 'error');
      return;
    }

    // Drawing blocks the panel, so yield first to let the progress bar paint.
    progress(0, 'Drawing caption 1 of ' + cues.length);
    setTimeout(function () {
      var items;
      try {
        items = global.Renderer.renderAll(
          cues, styleSettings(), frame, outDir,
          function (f, msg) { progress(f * 0.8, msg); },
          function () { return cancelRequested; });
      } catch (err) {
        hideProgress();
        setBusy(false);
        cancelRequested = false;
        if (/cancel/i.test(err.message || '')) { status('Stopped. Nothing was changed.'); }
        else { status('Could not draw the captions: ' + err.message, 'error'); }
        return;
      }

      logLine('Drew ' + items.length + ' caption graphic(s) into ' + outDir);
      progress(0.85, 'Placing them on the timeline');

      var plan = global.Animation.planFor(items, {
        preset: settings.animPreset,
        intensity: settings.intensity / 100,
        fps: sequenceInfo ? sequenceInfo.fps : 30
      });

      global.Host.insertGraphics({
        items: plan,
        binName: settings.binName,
        animate: settings.animPreset !== 'none'
      }).then(function (res) {
        hideProgress();
        global.Host.drainLog().forEach(logLine);
        res.warnings.forEach(function (w) { logLine('Warning: ' + w); });
        var msg = 'Placed ' + res.placed + ' caption graphic(s) on V' + res.track;
        if (settings.animPreset !== 'none') {
          msg += res.animated === res.placed
            ? ', all animated.'
            : ', ' + res.animated + ' animated \u2014 see Details.';
        } else {
          msg += '.';
        }
        status(msg, 'good');
        if (res.warnings.length) { $('log-card').open = true; }
      }).catch(function (err) {
        hideProgress();
        global.Host.drainLog().forEach(logLine);
        status(err.message || String(err), 'error');
        $('log-card').open = true;
      }).then(function () {
        cancelRequested = false;
        setBusy(false);
      });
    }, 60);
  }

  function saveSrt() {
    if (!cues || !cues.length) { return; }
    try {
      var file = writeSrtToTemp();
      logLine('Saved ' + file);
      status('Saved to ' + file, 'good');
    } catch (e) {
      status('Could not save: ' + e.message, 'error');
    }
  }

  /* ----------------------------------------------------------------- init */

  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
      tab.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
          t.classList.toggle('is-active', t === tab);
        });
        ['transcribe', 'models'].forEach(function (name) {
          $('tab-' + name).classList.toggle('hidden', name !== tab.dataset.tab);
        });
        if (tab.dataset.tab === 'models') { renderModelList(); }
      });
    });

    $('refresh').addEventListener('click', function () {
      invalidateResult();
      refreshModelPicker();
      refreshSequence();
    });

    $('transcribe').addEventListener('click', transcribe);
    $('animate').addEventListener('click', addAnimatedCaptions);
    $('import').addEventListener('click', addToSequence);
    $('save').addEventListener('click', saveSrt);

    ['stylePreset', 'animPreset', 'position', 'highlight'].forEach(function (id) {
      $(id).addEventListener('change', function () { uiToSettings(); drawLookPreview(); });
    });
    $('look-card').addEventListener('toggle', function () {
      if ($('look-card').open) { drawLookPreview(); }
    });

    $('cancel').addEventListener('click', function () {
      cancelRequested = true;
      try { global.Env.killAll(); } catch (e) {}
      try { global.Models.abortAll(); } catch (e2) {}
      $('progress-text').textContent = 'Stopping…';
    });

    $('style').addEventListener('change', function () {
      settings.style = $('style').value;
      applyPreset(settings.style);
      rechunkSoon();
    });

    var LOOK_ONLY = { intensity: 1, sizePct: 1, offsetPct: 1 };
    RANGES.forEach(function (k) {
      $(k).addEventListener('input', function () {
        uiToSettings();
        if (LOOK_ONLY[k]) { drawLookPreview(); } else { rechunkSoon(); }
      });
    });
    var SHAPE = { splitOnPunctuation: 1, avoidWidows: 1 };
    CHECKS.forEach(function (k) {
      $(k).addEventListener('change', function () {
        uiToSettings();
        if (SHAPE[k]) { rechunkSoon(); }
        else if (k === 'karaoke' || k === 'uppercase') { drawLookPreview(); }
      });
    });
    $('language').addEventListener('change', uiToSettings);
    $('prompt').addEventListener('change', uiToSettings);
    $('binName').addEventListener('change', uiToSettings);
    $('model').addEventListener('change', function () { uiToSettings(); refreshModelPicker(); });
    $('customModel').addEventListener('change', function () { setBusy(busy); });
    $('reset-settings').addEventListener('click', function () {
      applyPreset(settings.style);
      rechunkSoon();
    });

    global.addEventListener('focus', function () { if (!busy) { refreshSequence(true); } });
  }

  function rechunkSoon() {
    if (!words) { return; }
    if (rechunkTimer) { clearTimeout(rechunkTimer); }
    rechunkTimer = setTimeout(function () { rechunkTimer = null; rechunk(); }, 150);
  }

  function reportEnvironment() {
    if (!global.Env.hasNode()) {
      logLine('Node.js is not available in this panel; Captionist cannot run its tools.');
      return;
    }
    tools.ffmpeg = global.Env.findBinary('ffmpeg', { extensionRoot: extensionRoot, versionArgs: ['-version'] });
    tools.whisper = global.Env.findBinary('whisper-cli', { extensionRoot: extensionRoot, versionArgs: ['--help'] });
    logLine(tools.ffmpeg ? 'ffmpeg: ' + tools.ffmpeg : 'ffmpeg NOT FOUND — audio cannot be read.');
    logLine(tools.whisper ? 'whisper-cli: ' + tools.whisper : 'whisper-cli NOT FOUND — reinstall Captionist.');
    try { logLine('Models folder: ' + global.Models.modelsDir()); } catch (e) {}
  }

  function init() {
    loadSettings();
    settingsToUi();
    wire();

    if (!global.CEP.available()) {
      status('This panel only runs inside Premiere Pro.', 'error');
      $('transcribe').disabled = true;
      return;
    }

    global.CEP.applyHostTheme();
    extensionRoot = global.CEP.getSystemPath(global.CEP.SystemPath.EXTENSION);

    global.Host.ping().then(function (info) {
      logLine('Premiere Pro ' + info.app + ' · Captionist ' + info.scriptVersion);
      reportEnvironment();
      refreshModelPicker();
      return refreshSequence();
    }).catch(function (err) {
      status(err.message || String(err), 'error');
      $('log-card').open = true;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}(window));
