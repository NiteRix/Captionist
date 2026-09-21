/*
 * Whisper model catalogue, downloads and storage.
 *
 * Models are not shipped. They range from tens of megabytes to a few gigabytes
 * and which one you want depends entirely on your machine and your patience,
 * so the panel fetches whichever you pick.
 *
 * They are stored under Env.dataDir(), NOT inside the extension folder. The
 * installer deletes the extension folder wholesale on every update, which
 * would otherwise throw away a multi-gigabyte download each time.
 */
(function (global) {
  'use strict';

  var HOST = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
  var GGML_MAGIC = 0x67676d6c;    // "ggml", the first four bytes of every model

  /*
   * approxMB is a hint for the picker only. The real size comes from the
   * server before anything is written to disk.
   */
  var CATALOG = [
    { id: 'tiny.en',            label: 'Tiny (English)',        approxMB: 75,   multilingual: false, speed: 'fastest',  quality: 'rough' },
    { id: 'tiny',               label: 'Tiny',                  approxMB: 75,   multilingual: true,  speed: 'fastest',  quality: 'rough' },
    { id: 'base.en',            label: 'Base (English)',        approxMB: 142,  multilingual: false, speed: 'very fast', quality: 'usable' },
    { id: 'base',               label: 'Base',                  approxMB: 142,  multilingual: true,  speed: 'very fast', quality: 'usable' },
    { id: 'small.en',           label: 'Small (English)',       approxMB: 466,  multilingual: false, speed: 'fast',     quality: 'good' },
    { id: 'small',              label: 'Small',                 approxMB: 466,  multilingual: true,  speed: 'fast',     quality: 'good' },
    { id: 'medium.en',          label: 'Medium (English)',      approxMB: 1500, multilingual: false, speed: 'slow',     quality: 'very good' },
    { id: 'medium',             label: 'Medium',                approxMB: 1500, multilingual: true,  speed: 'slow',     quality: 'very good' },
    { id: 'large-v3-turbo',     label: 'Large v3 Turbo',        approxMB: 1600, multilingual: true,  speed: 'fast',     quality: 'best value', recommended: true },
    { id: 'large-v3-turbo-q5_0', label: 'Large v3 Turbo (compressed)', approxMB: 550, multilingual: true, speed: 'fast', quality: 'near-best' },
    { id: 'large-v3',           label: 'Large v3',              approxMB: 2900, multilingual: true,  speed: 'slowest',  quality: 'best' },
    { id: 'large-v3-q5_0',      label: 'Large v3 (compressed)', approxMB: 1100, multilingual: true,  speed: 'slow',     quality: 'best' }
  ];

  function byId(id) {
    for (var i = 0; i < CATALOG.length; i++) { if (CATALOG[i].id === id) { return CATALOG[i]; } }
    return null;
  }

  function modelsDir() {
    var Env = global.Env, node = Env.node();
    var dir = node.path.join(Env.dataDir(), 'models');
    Env.ensureDir(dir);
    return dir;
  }

  function fileName(id) { return 'ggml-' + id + '.bin'; }

  function pathFor(id) {
    return global.Env.node().path.join(modelsDir(), fileName(id));
  }

  function urlFor(id) { return HOST + fileName(id); }

  /** A file is only a model if it starts with the ggml magic. */
  function looksValid(filePath) {
    var node = global.Env.node();
    var fd = null;
    try {
      fd = node.fs.openSync(filePath, 'r');
      var head = new Uint8Array(4);
      node.fs.readSync(fd, head, 0, 4, 0);
      var magic = (head[3] << 24) | (head[2] << 16) | (head[1] << 8) | head[0];
      return (magic >>> 0) === GGML_MAGIC;
    } catch (e) {
      return false;
    } finally {
      if (fd !== null) { try { node.fs.closeSync(fd); } catch (e2) {} }
    }
  }

  function installed() {
    var Env = global.Env;
    if (!Env.hasNode()) { return []; }
    var node = Env.node();
    var out = [];
    try {
      var names = node.fs.readdirSync(modelsDir());
      for (var i = 0; i < names.length; i++) {
        var m = names[i].match(/^ggml-(.+)\.bin$/);
        if (!m) { continue; }
        var full = node.path.join(modelsDir(), names[i]);
        out.push({ id: m[1], path: full, size: Env.fileSize(full), valid: looksValid(full) });
      }
    } catch (e) {}
    return out;
  }

  function isInstalled(id) {
    var p = pathFor(id);
    return global.Env.exists(p) && looksValid(p);
  }

  function diskUsage() {
    var list = installed(), total = 0;
    for (var i = 0; i < list.length; i++) { total += Math.max(0, list[i].size); }
    return total;
  }

  function remove(id) {
    global.Env.remove(pathFor(id));
    return !global.Env.exists(pathFor(id));
  }

  /* ------------------------------------------------------------ download */

  var activeRequests = [];

  function abortAll() {
    for (var i = 0; i < activeRequests.length; i++) {
      try { activeRequests[i].destroy(); } catch (e) {}
    }
    activeRequests = [];
  }

  /**
   * Downloads a model, resuming a partial file if one is there.
   *
   * onProgress(fraction, receivedBytes, totalBytes)
   */
  function download(id, onProgress) {
    var Env = global.Env;
    Env.requireNode();
    var node = Env.node();
    var https = node.https;
    if (!https) { return Promise.reject(new Error('Node https is unavailable in this panel.')); }

    var dest = pathFor(id);
    var part = dest + '.part';

    return new Promise(function (resolve, reject) {
      var existing = 0;
      try { existing = Env.exists(part) ? node.fs.statSync(part).size : 0; } catch (e) { existing = 0; }

      function request(url, redirects) {
        if (redirects > 8) { reject(new Error('Too many redirects fetching the model.')); return; }

        var headers = { 'User-Agent': 'Captionist' };
        if (existing > 0) { headers.Range = 'bytes=' + existing + '-'; }

        var req = https.get(url, { headers: headers }, function (res) {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            request(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode === 416) {
            // Already have the whole thing.
            res.resume();
            finish();
            return;
          }
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            res.resume();
            reject(new Error('Download failed with HTTP ' + res.statusCode +
                             '. The model host may be unreachable from this network.'));
            return;
          }
          if (res.statusCode === 200) { existing = 0; }   // server ignored the range

          var declared = Number(res.headers['content-length'] || 0);
          var total = declared + existing;
          var received = existing;

          var stream = node.fs.createWriteStream(part, { flags: existing > 0 ? 'a' : 'w' });
          res.on('data', function (chunk) {
            received += chunk.length;
            if (onProgress && total > 0) { onProgress(Math.min(1, received / total), received, total); }
          });
          res.on('error', function (e) { stream.close(); reject(e); });
          stream.on('error', function (e) { reject(e); });
          res.pipe(stream);
          stream.on('finish', function () { stream.close(finish); });
        });

        req.on('error', function (e) {
          reject(new Error('Could not reach the model host: ' + e.message));
        });
        req.setTimeout(60000, function () {
          req.destroy(new Error('The model host stopped responding.'));
        });
        activeRequests.push(req);
      }

      function finish() {
        if (!looksValid(part)) {
          Env.remove(part);
          reject(new Error('The downloaded file is not a Whisper model. It may have been ' +
                           'truncated, or a proxy returned an error page instead.'));
          return;
        }
        try {
          if (Env.exists(dest)) { Env.remove(dest); }
          node.fs.renameSync(part, dest);
        } catch (e) { reject(e); return; }
        resolve({ id: id, path: dest, size: Env.fileSize(dest) });
      }

      request(urlFor(id), 0);
    });
  }

  global.Models = {
    CATALOG: CATALOG,
    byId: byId,
    modelsDir: modelsDir,
    pathFor: pathFor,
    urlFor: urlFor,
    installed: installed,
    isInstalled: isInstalled,
    diskUsage: diskUsage,
    remove: remove,
    download: download,
    abortAll: abortAll,
    looksValid: looksValid
  };
}(window));
