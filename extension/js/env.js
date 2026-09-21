/*
 * Node-side plumbing: locating the bundled tools and running them.
 *
 * Descended from Silencer's extension/js/env.js, deliberately generalised:
 * Captionist drives two binaries (ffmpeg and whisper-cli) rather than one, so
 * discovery and spawning are generic here. sync-common.sh does not track this
 * file - the divergence is intentional.
 */
(function (global) {
  'use strict';

  var nodeRequire = null;
  if (typeof require === 'function') { nodeRequire = require; }
  else if (global.cep_node && typeof global.cep_node.require === 'function') { nodeRequire = global.cep_node.require; }

  var fs = null, path = null, os = null, cp = null, https = null;
  if (nodeRequire) {
    try {
      fs = nodeRequire('fs');
      path = nodeRequire('path');
      os = nodeRequire('os');
      cp = nodeRequire('child_process');
      https = nodeRequire('https');
    } catch (e) { nodeRequire = null; }
  }

  var isWindows = !!(os && os.platform && os.platform() === 'win32') ||
                  /win/i.test(global.navigator.platform);

  function hasNode() { return !!(fs && cp); }
  function requireNode() {
    if (!hasNode()) {
      throw new Error('This panel needs Node.js, which CEP did not enable. Reinstall Captionist.');
    }
  }

  function exists(p) { try { return !!p && fs.existsSync(p); } catch (e) { return false; } }
  function fileSize(p) { try { return fs.statSync(p).size; } catch (e) { return -1; } }
  function remove(p) { try { fs.unlinkSync(p); } catch (e) {} }

  function ensureDir(p) {
    try { fs.mkdirSync(p, { recursive: true }); return true; }
    catch (e) { return exists(p); }
  }

  function tempFile(suffix) {
    return path.join(os.tmpdir(),
      'captionist-' + Date.now() + '-' + Math.floor(Math.random() * 1e9) + (suffix || ''));
  }

  /**
   * Where models and other large downloads live.
   *
   * Deliberately NOT inside the extension folder: the installer deletes that
   * folder wholesale on every update, which would take a multi-gigabyte model
   * with it.
   */
  function dataDir() {
    requireNode();
    var base;
    if (isWindows) {
      base = (global.process && global.process.env && global.process.env.APPDATA) ||
             path.join(os.homedir(), 'AppData', 'Roaming');
    } else {
      base = path.join(os.homedir(), 'Library', 'Application Support');
    }
    var dir = path.join(base, 'Captionist');
    ensureDir(dir);
    return dir;
  }

  /* ------------------------------------------------------------ binaries */

  var binaryCache = {};

  function exeName(name) { return isWindows ? name + '.exe' : name; }

  function verify(candidate, versionArgs) {
    if (!candidate || !cp) { return false; }
    try {
      cp.execFileSync(candidate, versionArgs || ['-version'],
                      { timeout: 8000, stdio: 'ignore', windowsHide: true });
      return true;
    } catch (e) { return false; }
  }

  /**
   * Finds a tool, preferring the copy that shipped with the panel.
   * `opts.versionArgs` is whatever makes the tool exit 0 cheaply.
   */
  function findBinary(name, opts) {
    opts = opts || {};
    var key = name + '|' + (opts.extensionRoot || '');
    if (binaryCache[key] !== undefined) { return binaryCache[key]; }
    binaryCache[key] = null;
    if (!hasNode()) { return null; }

    var list = [];
    var override = '';
    try { override = global.localStorage.getItem('captionist.path.' + name) || ''; } catch (e) {}
    if (override) { list.push(override); }
    if (opts.extensionRoot) { list.push(path.join(opts.extensionRoot, 'bin', exeName(name))); }
    list.push(exeName(name));                       // PATH
    if (isWindows) {
      var la = (global.process && global.process.env) ? global.process.env.LOCALAPPDATA : '';
      if (la) { list.push(path.join(la, 'Microsoft', 'WinGet', 'Links', exeName(name))); }
      list.push('C:\\' + name + '\\bin\\' + exeName(name));
    } else {
      list.push('/opt/homebrew/bin/' + name);
      list.push('/usr/local/bin/' + name);
      list.push('/usr/bin/' + name);
    }

    for (var i = 0; i < list.length; i++) {
      if (verify(list[i], opts.versionArgs)) { binaryCache[key] = list[i]; break; }
    }
    return binaryCache[key];
  }

  function setBinaryPath(name, p) {
    try { global.localStorage.setItem('captionist.path.' + name, p || ''); } catch (e) {}
    binaryCache = {};
  }

  /* ------------------------------------------------------------ spawning */

  var liveChildren = [];

  function killAll() {
    for (var i = 0; i < liveChildren.length; i++) {
      try { liveChildren[i].kill(); } catch (e) {}
    }
    liveChildren = [];
  }

  function forget(child) {
    var i = liveChildren.indexOf(child);
    if (i >= 0) { liveChildren.splice(i, 1); }
  }

  /**
   * Runs a tool to completion, line by line.
   *
   * opts.onLine(text, stream)  every stdout/stderr line, for progress parsing
   * opts.stallSeconds          give up after this long with no output at all
   *
   * Every long-running job in this panel goes through here, so a single
   * killAll() from the Cancel button stops all of them.
   */
  function run(binary, args, opts) {
    opts = opts || {};
    var stallMs = (opts.stallSeconds || 120) * 1000;

    return new Promise(function (resolve, reject) {
      var child, settled = false, stallTimer = null;
      var tail = '';
      var buffers = { stdout: '', stderr: '' };

      function cleanup() {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        if (child) { forget(child); }
      }

      function fail(err) {
        if (settled) { return; }
        settled = true;
        cleanup();
        reject(err);
      }

      function touch() {
        if (stallTimer) { clearTimeout(stallTimer); }
        stallTimer = setTimeout(function () {
          try { if (child) { child.kill(); } } catch (e) {}
          fail(new Error(binary.replace(/^.*[\\\/]/, '') + ' stopped responding after ' +
                         (stallMs / 1000) + 's with no output.'));
        }, stallMs);
      }

      function feed(stream, chunk) {
        touch();
        buffers[stream] += String(chunk);
        if (stream === 'stderr') { tail = (tail + String(chunk)).slice(-4000); }
        var lines = buffers[stream].split(/\r?\n/);
        buffers[stream] = lines.pop();
        if (!opts.onLine) { return; }
        for (var i = 0; i < lines.length; i++) { opts.onLine(lines[i], stream); }
      }

      try { child = cp.spawn(binary, args, { windowsHide: true }); }
      catch (e) { reject(e); return; }

      liveChildren.push(child);
      touch();

      child.stdout.on('data', function (d) { feed('stdout', d); });
      child.stderr.on('data', function (d) { feed('stderr', d); });
      child.on('error', fail);
      child.on('close', function (code) {
        if (settled) { return; }
        settled = true;
        cleanup();
        if (code !== 0) {
          reject(new Error(binary.replace(/^.*[\\\/]/, '') + ' failed (' + code + '): ' + tail.slice(-400)));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Decodes one audio stream to mono float samples at `rate` Hz.
   * opts.start / opts.duration limit the work to the slice actually needed.
   */
  function decodeAudio(ffmpeg, mediaPath, rate, opts) {
    opts = opts || {};
    var out = tempFile('.f32');
    var args = ['-hide_banner', '-nostdin', '-v', 'error'];
    if (opts.start > 0) { args.push('-ss', String(opts.start)); }
    args.push('-i', mediaPath);
    if (opts.duration > 0) { args.push('-t', String(opts.duration)); }
    args = args.concat(['-vn', '-sn', '-dn', '-map', '0:a:0', '-ac', '1',
                        '-ar', String(rate), '-f', 'f32le', '-nostats',
                        '-progress', 'pipe:1', '-y', out]);

    return run(ffmpeg, args, {
      stallSeconds: opts.stallSeconds || 90,
      onLine: function (line, stream) {
        if (stream !== 'stdout' || !opts.onProgress || !(opts.duration > 0)) { return; }
        // out_time_us is microseconds; out_time_ms is too, despite the name.
        var m = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m) { opts.onProgress(Math.min(1, (Number(m[1]) / 1e6) / opts.duration)); }
      }
    }).then(function () {
      var buf = fs.readFileSync(out);
      remove(out);
      return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }).catch(function (err) { remove(out); throw err; });
  }

  global.Env = {
    hasNode: hasNode,
    requireNode: requireNode,
    isWindows: isWindows,
    exists: exists,
    fileSize: fileSize,
    ensureDir: ensureDir,
    remove: remove,
    tempFile: tempFile,
    dataDir: dataDir,
    findBinary: findBinary,
    setBinaryPath: setBinaryPath,
    run: run,
    decodeAudio: decodeAudio,
    killAll: killAll,
    node: function () { requireNode(); return { fs: fs, path: path, os: os, cp: cp, https: https }; }
  };
}(window));
