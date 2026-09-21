/*
 * VENDORED from NiteRix/Silencer @ 7df6387 -- extension/js/host.js
 * Keep in step with upstream; scripts/sync-common.sh reports drift.
 */
/*
 * Typed calls into the ExtendScript side. Every host function returns a JSON
 * string; this unwraps it and turns { ok:false } into a rejected promise so the
 * UI only ever deals with real results or real errors.
 */
(function (global) {
  'use strict';

  /** ASCII-safe JS string literal - the CEP bridge is not reliable with raw unicode. */
  function literal(str) {
    var out = '"', i, c, cc, hex;
    str = String(str);
    for (i = 0; i < str.length; i++) {
      c = str.charAt(i);
      cc = str.charCodeAt(i);
      if (c === '"') { out += '\\"'; }
      else if (c === '\\') { out += '\\\\'; }
      else if (cc < 0x20 || cc > 0x7e) {
        hex = cc.toString(16);
        while (hex.length < 4) { hex = '0' + hex; }
        out += '\\u' + hex;
      } else { out += c; }
    }
    return out + '"';
  }

  var hostLog = [];

  function call(fn, payload) {
    var args = (payload === undefined) ? '' : literal(JSON.stringify(payload));
    var script = '$.captionist && $.captionist.' + fn + ' ? $.captionist.' + fn + '(' + args + ') : "__NO_HOST__"';

    return global.CEP.evalScript(script).then(function (raw) {
      if (raw === '__NO_HOST__' || raw === undefined || raw === '') {
        throw new Error('Captionist’s host script did not load. Close and reopen the panel; if that fails, reinstall.');
      }
      if (raw === 'EvalScript error.') {
        throw new Error('Premiere rejected the script call (' + fn + '). See the ExtendScript console for details.');
      }
      var data;
      try { data = JSON.parse(raw); }
      catch (e) { throw new Error('Unreadable reply from Premiere: ' + String(raw).slice(0, 300)); }

      if (data && data.log && data.log.length) {
        hostLog = hostLog.concat(data.log);
      }
      if (data && data.ok === false) {
        var err = new Error(data.error || 'Unknown host error.');
        err.data = data;
        throw err;
      }
      return data;
    });
  }

  global.Host = {
    ping: function () { return call('ping'); },
    getSequenceInfo: function () { return call('getSequenceInfo'); },
    importSubtitles: function (opts) { return call('importSubtitles', opts); },
    drainLog: function () { var l = hostLog; hostLog = []; return l; }
  };
}(window));
