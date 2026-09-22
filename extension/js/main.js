/*
 * Panel controller: pick a model, transcribe the timeline, shape the captions,
 * put them back.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'captionist.settings.v1';
  var RANGES = ['maxWords', 'maxCharsPerLine', 'maxLines', 'maxDuration', 'gapSplit',
                'maxCps', 'leadOut', 'lowConfidence',
                'intensity', 'sizePct', 'offsetPct', 'letterSpacing', 'lineSpacing',
                'outlineWidth'];
  var CHECKS = ['splitOnPunctuation', 'avoidWidows', 'skipMutedTracks', 'translate', 'attach',
                'dropHallucinations', 'nativeFade', 'karaoke', 'uppercase', 'shadow'];

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
    maxCps: 17,
    leadOut: 0.16,
    lowConfidence: 0.6,
    dropHallucinations: true,
    splitOnPunctuation: true,
    avoidWidows: true,
    stylePreset: 'clean',
    animPreset: 'pop',
    nativeFade: true,
    intensity: 100,
    sizePct: 5,
    offsetPct: 12,
    position: 'bottom',
    highlight: '#ffd93d',
    karaoke: false,
    uppercase: false,
    shadow: true,
    fontFamily: '',        // empty means "don't change" - keep the preset's font
    fontStyleKey: '',
    letterSpacing: 0,
    lineSpacing: 1.18,
    fill: '#ffffff',
    outline: '#000000',
    outlineWidth: 0.16
  };

  var settings = {};
  var sequenceInfo = null;
  var words = null;
  var cues = null;
  var originalCues = {};      // index -> pre-edit cue, for Revert
  var droppedCount = 0;       // hallucinated cues thrown away this run
  var replacedCount = 0;      // words rewritten by the vocabulary list
  var uncertainCursor = 0;    // where "next to check" has got to
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
    if (key === 'gapSplit' || key === 'leadOut') { return Number(value).toFixed(2); }
    if (key === 'lowConfidence') { return Math.round(Number(value) * 100) + '%'; }
    if (key === 'maxCps') { return Number(value) > 0 ? String(Math.round(value)) : 'off'; }
    if (key === 'maxDuration' || key === 'sizePct') { return Number(value).toFixed(1); }
    if (key === 'lineSpacing' || key === 'outlineWidth') { return Number(value).toFixed(2); }
    if (key === 'letterSpacing') { return Number(value).toFixed(1); }
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
    $('fill').value = settings.fill;
    $('outline').value = settings.outline;
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
    settings.fill = $('fill').value.trim() || DEFAULTS.fill;
    settings.outline = $('outline').value.trim() || DEFAULTS.outline;
    settings.fontFamily = $('fontFamily').value;
    settings.fontStyleKey = $('fontStyle').value;
    saveSettings();
  }

  /**
   * The look settings, in the shape Renderer expects.
   *
   * Anything left blank is omitted rather than sent as an empty value, so the
   * chosen preset keeps its own answer - that is what "Don't change" means.
   */
  function styleSettings() {
    var out = {
      preset: settings.stylePreset,
      sizePct: settings.sizePct,
      offsetPct: settings.offsetPct,
      position: settings.position,
      fill: settings.fill,
      highlight: settings.highlight,
      outline: settings.outlineWidth > 0 ? settings.outline : 'none',
      outlineWidth: settings.outlineWidth,
      shadow: settings.shadow,
      letterSpacing: settings.letterSpacing,
      lineSpacing: settings.lineSpacing,
      uppercase: settings.uppercase,
      karaoke: settings.karaoke
    };

    if (settings.fontFamily) {
      out.fontFamily = settings.fontFamily;
      var style = chosenFontStyle();
      if (style) {
        out.fontWeight = style.weight;
        out.fontStyle = style.italic ? 'italic' : 'normal';
      }
    }
    return out;
  }

  /* ----------------------------------------------------------------- fonts */

  function chosenFontStyle() {
    if (!settings.fontFamily || !settings.fontStyleKey) { return null; }
    var fam = global.Fonts.family(settings.fontFamily);
    if (!fam) { return null; }
    for (var i = 0; i < fam.styles.length; i++) {
      if (styleKey(fam.styles[i]) === settings.fontStyleKey) { return fam.styles[i]; }
    }
    return null;
  }

  function styleKey(style) { return style.weight + (style.italic ? 'i' : ''); }

  function fillStylePicker() {
    var sel = $('fontStyle');
    var previous = settings.fontStyleKey;
    sel.innerHTML = '';

    var fam = settings.fontFamily ? global.Fonts.family(settings.fontFamily) : null;
    if (!fam) {
      var only = document.createElement('option');
      only.value = '';
      only.textContent = "Don't change";
      sel.appendChild(only);
      sel.disabled = !settings.fontFamily;
      return;
    }

    sel.disabled = false;
    fam.styles.forEach(function (st) {
      var o = document.createElement('option');
      o.value = styleKey(st);
      o.textContent = global.Fonts.styleLabel(st);
      sel.appendChild(o);
    });

    if (previous && sel.querySelector('option[value="' + previous + '"]')) {
      sel.value = previous;
    } else {
      // Prefer something close to the preset's weight rather than the lightest.
      var want = settings.stylePreset === 'punch' ? 900 : 700;
      var best = fam.styles[0], bestGap = Infinity;
      fam.styles.forEach(function (st) {
        var gap = Math.abs(st.weight - want) + (st.italic ? 1000 : 0);
        if (gap < bestGap) { bestGap = gap; best = st; }
      });
      sel.value = styleKey(best);
    }
    settings.fontStyleKey = sel.value;
  }

  function fillFontPicker(families) {
    var sel = $('fontFamily');
    var previous = settings.fontFamily;
    sel.innerHTML = '';

    var none = document.createElement('option');
    none.value = '';
    none.textContent = "Don't change";
    sel.appendChild(none);

    families.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.family;
      o.textContent = f.family + (f.styles.length > 1 ? '  (' + f.styles.length + ')' : '');
      sel.appendChild(o);
    });

    if (previous && sel.querySelector('option[value="' + previous + '"]')) {
      sel.value = previous;
    } else if (previous) {
      // The font was uninstalled since last time; say so rather than silently
      // rendering in something else.
      logLine('The font "' + previous + '" is no longer installed; keeping the preset font.');
      settings.fontFamily = '';
      sel.value = '';
    }

    $('font-hint').textContent = families.length
      ? families.length + ' font families found. "Don\u2019t change" keeps the look preset\u2019s own font.'
      : 'No fonts could be read from this machine; the preset fonts will be used.';
    fillStylePicker();
  }

  function loadFonts(force) {
    if (!global.Env.hasNode()) {
      $('font-hint').textContent = 'Fonts cannot be listed without Node.js.';
      return Promise.resolve([]);
    }
    if (force) { global.Fonts.clear(); }
    var have = global.Fonts.cached();
    if (have && !force) { fillFontPicker(have); return Promise.resolve(have); }

    $('font-hint').textContent = 'Looking for installed fonts\u2026';
    return global.Fonts.scan(function (f, found) {
      $('font-hint').textContent = 'Looking for installed fonts\u2026 ' +
        Math.round(f * 100) + '%  (' + found + ' found)';
    }).then(function (families) {
      logLine('Found ' + families.length + ' font families on this machine.');
      fillFontPicker(families);
      drawLookPreview();
      return families;
    }).catch(function (err) {
      $('font-hint').textContent = 'Could not read the font folders: ' + err.message;
      return [];
    });
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
      maxCps: settings.maxCps,
      // One control, two numbers: a caption that arrives a touch early and
      // leaves a touch late reads as being in time. Coming in as late as it
      // goes out does not.
      leadOut: settings.leadOut,
      leadIn: settings.leadOut / 2,
      lowConfidence: settings.lowConfidence,
      splitOnPunctuation: settings.splitOnPunctuation,
      avoidWidows: settings.avoidWidows
    };
  }

  function rechunk() {
    if (!words || !words.length) { return; }
    if (!confirmDiscardEdits()) { settingsToUi(); return; }
    originalCues = {};
    cues = global.Chunker.build(words, chunkSettings());
    if (sequenceInfo) { cues = global.Chunker.snapToFrames(cues, sequenceInfo.fps); }
    showResult();
  }

  function showResult() {
    var s = global.Chunker.stats(cues, { lowConfidence: settings.lowConfidence });
    $('results').classList.remove('hidden');
    $('empty-hint').classList.add('hidden');
    $('stat-cues').textContent = String(s.count);
    $('stat-words').textContent = String(words ? words.length : 0);
    $('stat-perCue').textContent = s.wordsPerCue.toFixed(1);
    $('detected').textContent =
      (detectedLanguage ? 'Detected ' + detectedLanguage.toUpperCase() + ' · ' : '') +
      'average ' + s.averageDuration.toFixed(2) + 's on screen · ' +
      Math.round(s.charsPerCue) + ' characters per caption';

    renderPreview();

    $('import').disabled = !cues.length;
    $('save').disabled = !cues.length;
    $('animate').disabled = !cues.length;
    drawLookPreview();
  }

  /**
   * The cue list, editable in place.
   *
   * The animated route bakes the text into an image, so a typo has to be
   * caught here - afterwards it means re-rendering everything. Corrections are
   * kept against the cue and survive anything that does not re-derive cues
   * from the transcript.
   */
  function renderPreview() {
    var list = $('preview');
    list.innerHTML = '';
    if (!cues) { updateEditBar(); $('quality').classList.add('hidden'); return; }

    var limit = Math.min(cues.length, 200);
    for (var i = 0; i < limit; i++) { list.appendChild(cueRow(cues[i], i)); }

    if (cues.length > limit) {
      var more = document.createElement('div');
      more.className = 'cue';
      more.innerHTML = '<span class="cue-time"></span><span class="cue-text">' +
                       (cues.length - limit) + ' more\u2026</span>';
      list.appendChild(more);
    }
    updateEditBar();
    updateQuality(global.Chunker.stats(cues, { lowConfidence: settings.lowConfidence }));
  }

  function cueField(index) {
    return $('preview').querySelector('.cue-text[data-index="' + index + '"]');
  }

  /**
   * What is left to look at, in one line.
   *
   * The point of the whole panel is that you should not have to read all 300
   * captions to trust them. This says how many are worth opening: the ones
   * with a doubtful word in them, and the ones still too fast to read.
   */
  function updateQuality(s) {
    var el = $('quality');
    if (!cues || !cues.length) { el.classList.add('hidden'); return; }

    var bits = [];
    if (s.uncertainCues) {
      bits.push('<button class="chip chip-warn" id="next-uncertain">' + s.uncertainCues +
                ' to check</button>');
    }
    if (s.fastCues) {
      bits.push('<span class="chip chip-fast" title="No room to hold these any longer">' +
                s.fastCues + ' still fast</span>');
    }
    if (droppedCount) {
      bits.push('<span class="chip" title="Listed in the log">' + droppedCount +
                ' dropped</span>');
    }
    if (replacedCount) {
      bits.push('<span class="chip" title="From your vocabulary list">' + replacedCount +
                ' corrected by vocabulary</span>');
    }
    if (!bits.length) {
      bits.push('<span class="chip chip-good">nothing flagged</span>');
    }
    bits.push('<span class="chip chip-quiet">' + s.averageCps.toFixed(0) + ' chars/sec</span>');

    el.innerHTML = bits.join('');
    el.classList.remove('hidden');

    var jump = $('next-uncertain');
    if (jump) { jump.addEventListener('click', focusNextUncertain); }
  }

  /** Walks the doubtful captions in order, so review is one button. */
  function focusNextUncertain() {
    if (!cues) { return; }
    var bar = settings.lowConfidence;
    var start = uncertainCursor;
    for (var n = 0; n < cues.length; n++) {
      var i = (start + n) % cues.length;
      if (typeof cues[i].confidence === 'number' && cues[i].confidence < bar) {
        uncertainCursor = i + 1;
        var el = cueField(i);
        if (el) {
          el.parentNode.scrollIntoView({ block: 'center' });
          el.focus();
        }
        return;
      }
    }
    status('No captions left below ' + Math.round(bar * 100) + '% confidence.');
  }

  /**
   * Fills a cue's editable span, one element per word, so the words whisper
   * was least sure of can be marked.
   *
   * layout() joins each line's words with single spaces, so the word count per
   * line is the line's space count plus one - which is how the flat word list
   * is mapped back onto the wrapped lines without storing it twice.
   */
  function paintWords(host, cue) {
    host.innerHTML = '';
    var words = cue.words || [];
    var lines = cue.lines || [cue.text];

    if (!words.length) { host.textContent = cue.text; return; }

    var at = 0;
    for (var l = 0; l < lines.length; l++) {
      if (l > 0) { host.appendChild(document.createElement('br')); }
      var count = lines[l] ? lines[l].split(' ').length : 0;
      for (var w = 0; w < count && at < words.length; w++, at++) {
        if (w > 0) { host.appendChild(document.createTextNode(' ')); }
        var word = words[at];
        var span = document.createElement('span');
        span.textContent = word.text;
        if (typeof word.confidence === 'number' && word.confidence < settings.lowConfidence) {
          span.className = 'w-low';
          span.title = 'Whisper scored this ' + Math.round(word.confidence * 100) + '%';
        }
        host.appendChild(span);
      }
    }
    // Any word the line map did not account for still has to be visible.
    for (; at < words.length; at++) {
      host.appendChild(document.createTextNode((at ? ' ' : '') + words[at].text));
    }
  }

  /** Rebuilds one row in place, keeping the rest of the list untouched. */
  function refreshRow(index) {
    var el = cueField(index);
    if (!el || !cues || !cues[index]) { return; }
    var row = el.parentNode;
    row.parentNode.replaceChild(cueRow(cues[index], index), row);
  }

  function cueRow(cue, index) {
    var row = document.createElement('div');
    row.className = 'cue' + (cue.edited ? ' is-edited' : '') + (cue.fast ? ' is-fast' : '');

    var time = document.createElement('span');
    time.className = 'cue-time';
    time.textContent = global.Subtitles.stamp(cue.start, '.').slice(3, 11);
    time.title = 'On screen ' + cue.start.toFixed(2) + 's to ' + cue.end.toFixed(2) + 's' +
                 (typeof cue.cps === 'number' ? ' · ' + cue.cps.toFixed(0) + ' chars/sec' : '') +
                 (cue.fast ? ' — too fast to read, and no gap to borrow from' : '');

    var text = document.createElement('span');
    text.className = 'cue-text';
    text.contentEditable = 'true';
    text.spellcheck = true;
    text.setAttribute('data-index', String(index));
    paintWords(text, cue);

    text.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); text.blur(); }
      else if (e.key === 'Escape') { text.blur(); refreshRow(index); }
      else if (e.key === 'Tab') {
        // Tab straight to the next caption; correcting a transcript is a
        // keyboard job, not a mousing one.
        e.preventDefault();
        var nextIndex = index + (e.shiftKey ? -1 : 1);
        text.blur();
        var next = cueField(nextIndex);
        if (next) { next.focus(); }
      }
    });
    text.addEventListener('blur', function () { commitEdit(index, text); });

    row.appendChild(time);
    row.appendChild(text);
    return row;
  }

  function commitEdit(index, el) {
    if (!cues || !cues[index]) { return; }
    // contenteditable hands back non-breaking spaces and stray blank lines.
    var typed = el.innerText.replace(/\u00a0/g, ' ').replace(/\n{2,}/g, '\n').trim();
    var cue = cues[index];
    if (typed === cue.text) { return; }

    if (!typed) {
      el.textContent = cue.text;
      status('A caption cannot be empty.', 'error');
      return;
    }

    if (!originalCues[index]) { originalCues[index] = cue; }
    var updated = global.Chunker.editText(cue, typed, chunkSettings());
    cues[index] = updated;

    refreshRow(index);
    updateEditBar();
    updateQuality(global.Chunker.stats(cues, { lowConfidence: settings.lowConfidence }));
    drawLookPreview();
    logLine('Caption ' + (index + 1) + ' corrected to "' + updated.text.replace(/\n/g, ' ') + '"');
  }

  function editedCount() {
    if (!cues) { return 0; }
    var n = 0;
    for (var i = 0; i < cues.length; i++) { if (cues[i].edited) { n++; } }
    return n;
  }

  function updateEditBar() {
    var n = editedCount();
    $('edit-count').textContent = n ? n + ' caption' + (n === 1 ? '' : 's') + ' corrected' : '';
    $('revert-edits').classList.toggle('hidden', n === 0);
  }

  function revertEdits() {
    if (!cues) { return; }
    var restored = 0, i;
    for (i = 0; i < cues.length; i++) {
      if (originalCues[i]) { cues[i] = originalCues[i]; restored++; }
    }
    originalCues = {};
    if (restored) {
      renderPreview();
      drawLookPreview();
      status('Reverted ' + restored + ' correction(s).');
    }
  }

  /**
   * Find and replace over every caption at once.
   *
   * Corrections tend to be systematic - a name misheard the same way forty
   * times - and forty identical edits is not a review, it is data entry.
   * Each changed cue goes through the same editText path as a typed
   * correction, so timings behave identically.
   */
  function replaceAll() {
    if (!cues || !cues.length) { return; }
    var find = $('find').value;
    if (!find) { status('Type what to find first.'); return; }

    var result = global.Vocab.replaceInCues(cues, find, $('replace').value, chunkSettings());
    if (!result.changed.length) {
      status('No caption contains "' + find + '".');
      return;
    }

    for (var i = 0; i < result.changed.length; i++) {
      var at = result.changed[i];
      if (!originalCues[at]) { originalCues[at] = cues[at]; }
    }
    cues = result.cues;
    renderPreview();
    drawLookPreview();
    status('Replaced in ' + result.changed.length + ' caption' +
           (result.changed.length === 1 ? '' : 's') + '.', 'good');
    logLine('Replaced "' + find + '" with "' + $('replace').value + '" in ' +
            result.changed.length + ' caption(s).');
  }

  /**
   * Re-shaping rebuilds cues from the transcript and cannot carry manual
   * corrections across, so it asks rather than quietly discarding them.
   */
  function confirmDiscardEdits() {
    var n = editedCount();
    if (!n) { return true; }
    return global.confirm(
      'Re-shaping rebuilds the captions from the transcript, which discards your ' +
      n + ' correction' + (n === 1 ? '' : 's') + '.\n\nContinue?');
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
    var speech = null;
    var vocab = global.Vocab.parse(settings.prompt);
    var isCancelled = function () { return cancelRequested; };
    droppedCount = 0;
    replacedCount = 0;
    uncertainCursor = 0;

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
      speech = audio.speech;
      audio.failures.forEach(function (f) {
        logLine('Could not decode ' + f.path.replace(/^.*[\\\/]/, '') + ': ' + f.error);
      });
      logLine('Audio ready: ' + fmtTime(audio.duration) + ' at ' + audio.rate + ' Hz.');
      if (speech) {
        logLine('Speech floor measured at ' + speech.threshold.toFixed(1) + ' dBFS.');
      }
      if (vocab.terms.length) {
        logLine('Vocabulary: ' + vocab.terms.length + ' term(s), ' +
                vocab.rules.length + ' rewrite rule(s).');
      }

      return global.Whisper.transcribe({
        whisper: tools.whisper,
        modelPath: modelPath,
        modelId: $('model').value,
        wavPath: wav,
        language: settings.language,
        translate: settings.translate,
        prompt: global.Vocab.prompt(vocab),
        isCancelled: isCancelled
      }, function (f, msg) { progress(0.25 + f * 0.75, msg); });
    }).then(function (result) {
      if (wav) { global.Env.remove(wav); wav = null; }
      detectedLanguage = result.language || '';
      var heard = result.words.length;

      /*
       * Clean the word stream before it is ever shaped into captions. Doing it
       * here rather than on the finished cues means a dropped hallucination
       * cannot leave a hole in the middle of a real sentence.
       */
      var guarded = global.Guard.clean(result.words,
        settings.dropHallucinations ? speech : null, {});
      words = guarded.words;
      droppedCount = guarded.removed.length;
      guarded.removed.forEach(function (r) {
        logLine('Dropped ' + fmtTime(r.start) + '–' + fmtTime(r.end) + ' "' +
                r.text + '" — ' + r.reason);
      });

      var fixed = global.Vocab.apply(words, vocab);
      words = fixed.words;
      replacedCount = fixed.replacements.length;
      fixed.replacements.forEach(function (r) {
        logLine('Vocabulary: "' + r.from + '" → "' + r.to + '" at ' + fmtTime(r.start));
      });

      if (!words.length) {
        throw new Error(droppedCount
          ? 'Everything Whisper returned looked like a hallucination over silence. ' +
            'Check the log, and turn the guard off in Accuracy if that is wrong.'
          : 'Whisper found no speech in this timeline.');
      }

      rechunk();
      hideProgress();

      var note = 'Transcribed ' + heard + ' words into ' + cues.length + ' captions.';
      if (droppedCount) { note += ' Dropped ' + droppedCount + ' with no speech under them.'; }
      if (replacedCount) { note += ' Applied ' + replacedCount + ' vocabulary fix(es).'; }
      status(note, 'good');
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
        animate: settings.animPreset !== 'none',
        fps: sequenceInfo ? sequenceInfo.fps : 30,
        dissolve: dissolveFor(settings.animPreset)
      }).then(function (res) {
        hideProgress();
        global.Host.drainLog().forEach(logLine);
        res.warnings.forEach(function (w) { logLine('Warning: ' + w); });
        var msg = 'Placed ' + res.placed + ' caption graphic(s) on V' + res.track;
        if (settings.animPreset === 'none') {
          msg += '.';
        } else if (res.dissolved >= res.placed && res.animated >= res.placed) {
          msg += ', faded with Premiere\u2019s own dissolve.';
        } else if (res.animated === res.placed) {
          msg += ', all animated.';
        } else if (res.animated === 0) {
          // Static is the deliberate fallback, not a failure: an animation
          // Premiere would not take leaves the captions visible instead.
          msg += ' \u2014 static, because Premiere would not keep the keyframes.';
        } else {
          msg += ', ' + res.animated + ' animated \u2014 see Details.';
        }
        status(msg, res.animated === 0 && settings.animPreset !== 'none' ? 'warn' : 'good');
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

  /**
   * The fade, handed to Premiere's own Cross Dissolve instead of keyframes.
   *
   * A transition lives on the clip edge, so unlike a keyframe there is no
   * clock to put it on the wrong side of. Only the presets that actually fade
   * get one - Punch has no opacity move and should not acquire one here.
   */
  function dissolveFor(presetName) {
    if (!settings.nativeFade || presetName === 'none') { return null; }
    var preset = global.Animation.PRESETS[presetName];
    if (!preset) { return null; }

    var head = (preset.in && preset.in.opacity) ? preset.inSeconds : 0;
    var tail = (preset.out && preset.out.opacity) ? preset.outSeconds : 0;
    if (!head && !tail) { return null; }
    return { inSeconds: head, outSeconds: tail };
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
    $('revert-edits').addEventListener('click', revertEdits);
    $('replace-all').addEventListener('click', replaceAll);
    $('replace').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); replaceAll(); }
    });
    $('find').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('replace').focus(); }
    });
    $('animate').addEventListener('click', addAnimatedCaptions);
    $('import').addEventListener('click', addToSequence);
    $('save').addEventListener('click', saveSrt);

    ['stylePreset', 'animPreset', 'position', 'highlight', 'fill', 'outline']
      .forEach(function (id) {
        $(id).addEventListener('change', function () { uiToSettings(); drawLookPreview(); });
      });

    $('fontFamily').addEventListener('change', function () {
      settings.fontFamily = $('fontFamily').value;
      settings.fontStyleKey = '';      // the old style may not exist in the new family
      fillStylePicker();
      uiToSettings();
      drawLookPreview();
    });
    $('fontStyle').addEventListener('change', function () { uiToSettings(); drawLookPreview(); });
    $('rescan-fonts').addEventListener('click', function () { loadFonts(true); });
    $('look-card').addEventListener('toggle', function () {
      if (!$('look-card').open) { return; }
      // Scanning is deferred until the section is actually opened, so opening
      // the panel stays instant on a machine with hundreds of fonts.
      loadFonts(false);
      drawLookPreview();
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

    var LOOK_ONLY = { intensity: 1, sizePct: 1, offsetPct: 1, letterSpacing: 1,
                      lineSpacing: 1, outlineWidth: 1 };
    // Which words are flagged is a reading of the same cues, not a re-shape,
    // so it must not discard corrections to change it.
    var DISPLAY_ONLY = { lowConfidence: 1 };
    RANGES.forEach(function (k) {
      $(k).addEventListener('input', function () {
        uiToSettings();
        if (LOOK_ONLY[k]) { drawLookPreview(); }
        else if (DISPLAY_ONLY[k]) { uncertainCursor = 0; renderPreview(); }
        else { rechunkSoon(); }
      });
    });
    var SHAPE = { splitOnPunctuation: 1, avoidWidows: 1 };
    CHECKS.forEach(function (k) {
      $(k).addEventListener('change', function () {
        uiToSettings();
        if (SHAPE[k]) { rechunkSoon(); }
        else if (k === 'karaoke' || k === 'uppercase' || k === 'shadow') { drawLookPreview(); }
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

  /**
   * A handle for the screenshot harness and the browser checks, so those run
   * the panel's real rendering and editing paths instead of copies of them.
   * Nothing in the panel reads it.
   */
  global.__panel = {
    load: function (w, c, language) {
      words = w;
      cues = c;
      originalCues = {};
      detectedLanguage = language || '';
      showResult();
    },
    cues: function () { return cues; },
    type: function (index, text) {
      var el = cueField(index);
      if (!el) { return null; }
      el.textContent = text;
      commitEdit(index, el);
      return cues[index];
    }
  };

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
