/*
 * Finds the fonts installed on this machine.
 *
 * The browser cannot enumerate system fonts (queryLocalFonts is gated behind a
 * permission prompt CEP never shows), so Captionist reads the font files
 * itself: walk the font folders, parse each file's `name` and `OS/2` tables,
 * and group the results into families with their real styles and weights.
 *
 * Only a few kilobytes of each file are read - the header, the table directory
 * and the name table - so scanning several hundred fonts stays quick.
 */
(function (global) {
  'use strict';

  var cache = null;

  function dirsFor() {
    var Env = global.Env, node = Env.node();
    var env = (global.process && global.process.env) || {};
    var home = '';
    try { home = node.os.homedir(); } catch (e) {}

    if (Env.isWindows) {
      var win = env.SystemRoot || env.windir || 'C:\\Windows';
      var local = env.LOCALAPPDATA || (home ? node.path.join(home, 'AppData', 'Local') : '');
      var list = [node.path.join(win, 'Fonts')];
      // Per-user installs, which is where most downloaded fonts land.
      if (local) { list.push(node.path.join(local, 'Microsoft', 'Windows', 'Fonts')); }
      return list;
    }
    return [
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Library/Fonts',
      home ? node.path.join(home, 'Library', 'Fonts') : '',
      '/usr/share/fonts',
      '/usr/local/share/fonts',
      home ? node.path.join(home, '.fonts') : ''
    ].filter(Boolean);
  }

  function collectFiles(dirs) {
    var node = global.Env.node();
    var out = [];
    var seen = {};

    function walk(dir, depth) {
      if (depth > 4) { return; }
      var names;
      try { names = node.fs.readdirSync(dir); } catch (e) { return; }
      for (var i = 0; i < names.length; i++) {
        var full = node.path.join(dir, names[i]);
        var stat;
        try { stat = node.fs.statSync(full); } catch (e2) { continue; }
        if (stat.isDirectory()) { walk(full, depth + 1); continue; }
        if (!/\.(ttf|otf|ttc|otc)$/i.test(names[i])) { continue; }
        var key = full.toLowerCase();
        if (seen[key]) { continue; }
        seen[key] = true;
        out.push(full);
      }
    }

    for (var d = 0; d < dirs.length; d++) { walk(dirs[d], 0); }
    return out;
  }

  /* ------------------------------------------------------- sfnt parsing */

  function u16(buf, at) { return (buf[at] << 8) | buf[at + 1]; }
  function u32(buf, at) {
    return ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
  }
  function tag(buf, at) {
    return String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
  }

  function readAt(fd, offset, length) {
    var node = global.Env.node();
    var buf = new Uint8Array(length);
    var got = node.fs.readSync(fd, buf, 0, length, offset);
    return got < length ? buf.subarray(0, Math.max(0, got)) : buf;
  }

  function decodeName(bytes, platformID) {
    var s = '', i;
    if (platformID === 3 || platformID === 0) {          // UTF-16BE
      for (i = 0; i + 1 < bytes.length; i += 2) {
        var code = (bytes[i] << 8) | bytes[i + 1];
        if (code) { s += String.fromCharCode(code); }
      }
    } else {                                             // MacRoman, near enough
      for (i = 0; i < bytes.length; i++) {
        if (bytes[i]) { s += String.fromCharCode(bytes[i]); }
      }
    }
    return s.replace(/\u0000/g, '').trim();
  }

  /** Reads one font's tables. `base` is where its sfnt header starts. */
  function readFont(fd, base) {
    var head = readAt(fd, base, 12);
    if (head.length < 12) { return null; }

    var numTables = u16(head, 4);
    if (!numTables || numTables > 512) { return null; }

    var dir = readAt(fd, base + 12, numTables * 16);
    var tables = {};
    for (var i = 0; i < numTables; i++) {
      var at = i * 16;
      if (at + 16 > dir.length) { break; }
      tables[tag(dir, at)] = { offset: u32(dir, at + 8), length: u32(dir, at + 12) };
    }

    var nameTable = tables['name'];
    if (!nameTable || !nameTable.length || nameTable.length > 1024 * 512) { return null; }

    var nb = readAt(fd, nameTable.offset, nameTable.length);
    if (nb.length < 6) { return null; }
    var count = u16(nb, 2);
    var stringOffset = u16(nb, 4);

    // nameID 16/17 are the typographic family and style, which is what a font
    // menu should show; 1/2 are the legacy four-style grouping.
    var best = {};
    for (var r = 0; r < count; r++) {
      var rec = 6 + r * 12;
      if (rec + 12 > nb.length) { break; }
      var platformID = u16(nb, rec);
      var nameID = u16(nb, rec + 6);
      if (nameID !== 1 && nameID !== 2 && nameID !== 16 && nameID !== 17) { continue; }
      var len = u16(nb, rec + 8);
      var off = stringOffset + u16(nb, rec + 10);
      if (off + len > nb.length) { continue; }
      var value = decodeName(nb.subarray(off, off + len), platformID);
      if (!value) { continue; }
      // Prefer the Windows records; they are the ones Chromium matches on.
      if (!best[nameID] || platformID === 3) { best[nameID] = value; }
    }

    var family = best[16] || best[1];
    if (!family) { return null; }
    var style = best[17] || best[2] || 'Regular';

    var weight = 400, italic = false;
    var os2 = tables['OS/2'];
    if (os2 && os2.length >= 64) {
      var ob = readAt(fd, os2.offset, 64);
      if (ob.length >= 64) {
        var w = u16(ob, 4);                 // usWeightClass
        if (w >= 1 && w <= 1000) { weight = w < 100 ? w * 100 : w; }
        var fsSelection = u16(ob, 62);
        italic = !!(fsSelection & 0x01);
        if (fsSelection & 0x20 && weight < 600) { weight = 700; }   // bold bit
      }
    }
    if (!italic && /italic|oblique/i.test(style)) { italic = true; }

    return { family: family, style: style, weight: weight, italic: italic };
  }

  function readFile(file) {
    var node = global.Env.node();
    var fd = null;
    var faces = [];
    try {
      fd = node.fs.openSync(file, 'r');
      var head = readAt(fd, 0, 12);
      if (head.length < 12) { return faces; }

      if (tag(head, 0) === 'ttcf') {
        var numFonts = Math.min(u32(head, 8), 128);
        var offsets = readAt(fd, 12, numFonts * 4);
        for (var i = 0; i < numFonts; i++) {
          if (i * 4 + 4 > offsets.length) { break; }
          var face = readFont(fd, u32(offsets, i * 4));
          if (face) { face.file = file; faces.push(face); }
        }
      } else {
        var one = readFont(fd, 0);
        if (one) { one.file = file; faces.push(one); }
      }
    } catch (e) {
      // An unreadable font is not worth failing a scan over.
    } finally {
      if (fd !== null) { try { node.fs.closeSync(fd); } catch (e2) {} }
    }
    return faces;
  }

  /* ---------------------------------------------------------- the scan */

  function group(faces) {
    var byFamily = {};
    for (var i = 0; i < faces.length; i++) {
      var f = faces[i];
      if (!byFamily[f.family]) { byFamily[f.family] = { family: f.family, styles: [] }; }
      var styles = byFamily[f.family].styles;
      var duplicate = false;
      for (var s = 0; s < styles.length; s++) {
        if (styles[s].weight === f.weight && styles[s].italic === f.italic) { duplicate = true; break; }
      }
      if (!duplicate) {
        styles.push({ style: f.style, weight: f.weight, italic: f.italic, file: f.file });
      }
    }

    var out = Object.keys(byFamily).map(function (k) { return byFamily[k]; });
    out.sort(function (a, b) { return a.family.toLowerCase() < b.family.toLowerCase() ? -1 : 1; });
    for (var j = 0; j < out.length; j++) {
      out[j].styles.sort(function (a, b) {
        if (a.italic !== b.italic) { return a.italic ? 1 : -1; }
        return a.weight - b.weight;
      });
    }
    return out;
  }

  /**
   * Scans in slices so the panel keeps painting while it works.
   * onProgress(fraction, found)
   */
  function scan(onProgress) {
    var Env = global.Env;
    if (!Env.hasNode()) { return Promise.resolve([]); }

    return new Promise(function (resolve, reject) {
      var files;
      try { files = collectFiles(dirsFor()); }
      catch (e) { reject(e); return; }

      if (!files.length) { cache = []; resolve([]); return; }

      var faces = [];
      var at = 0;
      var SLICE = 40;

      function step() {
        var end = Math.min(files.length, at + SLICE);
        for (; at < end; at++) {
          var got = readFile(files[at]);
          for (var i = 0; i < got.length; i++) { faces.push(got[i]); }
        }
        if (onProgress) { onProgress(at / files.length, faces.length); }
        if (at < files.length) { setTimeout(step, 0); return; }
        cache = group(faces);
        resolve(cache);
      }
      step();
    });
  }

  function cached() { return cache; }
  function clear() { cache = null; }

  function family(name) {
    if (!cache) { return null; }
    for (var i = 0; i < cache.length; i++) {
      if (cache[i].family === name) { return cache[i]; }
    }
    return null;
  }

  /** A readable label for a style, since name tables are inconsistent. */
  function styleLabel(style) {
    var names = {
      100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium',
      600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black'
    };
    var base = names[style.weight] || ('Weight ' + style.weight);
    if (style.italic) { base += base === 'Regular' ? ' Italic' : ' Italic'; }
    return base === 'Regular Italic' ? 'Italic' : base;
  }

  global.Fonts = {
    scan: scan,
    cached: cached,
    clear: clear,
    family: family,
    styleLabel: styleLabel,
    readFile: readFile,
    group: group,
    dirsFor: dirsFor,
    collectFiles: collectFiles
  };
}(window));
