/*
 * VENDORED from NiteRix/Silencer @ 7df6387 -- extension/js/lib/cep.js
 * Keep in step with upstream; scripts/sync-common.sh reports drift.
 */
/*
 * A small, dependency-free stand-in for Adobe's CSInterface.js.
 * Everything here is a thin wrapper over window.__adobe_cep__, which the CEP
 * runtime injects into the panel. Only the parts Silencer actually uses.
 */
(function (global) {
  'use strict';

  var cep = global.__adobe_cep__;

  var SystemPath = {
    USER_DATA: 'userData',
    COMMON_FILES: 'commonFiles',
    MY_DOCUMENTS: 'myDocuments',
    APPLICATION: 'application',
    EXTENSION: 'extension',
    HOST_APPLICATION: 'hostApplication'
  };

  function available() { return !!cep; }

  function evalScript(script) {
    return new Promise(function (resolve, reject) {
      if (!cep) { reject(new Error('This page is not running inside Premiere Pro.')); return; }
      try {
        cep.evalScript(script, function (result) { resolve(result); });
      } catch (err) { reject(err); }
    });
  }

  function getSystemPath(type) {
    if (!cep) { return ''; }
    try {
      var p = cep.getSystemPath(type);
      // CEP hands back a file:// URL on some hosts.
      if (p && p.indexOf('file://') === 0) {
        p = decodeURIComponent(p.replace(/^file:\/\/\/?/, ''));
        if (!/^[a-zA-Z]:/.test(p) && p.charAt(0) !== '/') { p = '/' + p; }
      }
      return p || '';
    } catch (e) { return ''; }
  }

  function hostEnvironment() {
    if (!cep) { return null; }
    try { return JSON.parse(cep.getHostEnvironment()); } catch (e) { return null; }
  }

  function extensionId() {
    if (!cep) { return ''; }
    try { return cep.getExtensionId(); } catch (e) { return ''; }
  }

  function openURL(url) {
    if (!cep) { global.open(url, '_blank'); return; }
    try { cep.invokeAsync ? cep.invokeAsync('openURLInDefaultBrowser', url) : cep.openURLInDefaultBrowser(url); }
    catch (e) {
      try { global.cep.util.openURLInDefaultBrowser(url); } catch (e2) {}
    }
  }

  function toCss(c) {
    if (!c) { return null; }
    return 'rgb(' + Math.round(c.red) + ',' + Math.round(c.green) + ',' + Math.round(c.blue) + ')';
  }

  /** Repaints the panel to match whichever Premiere UI brightness the user picked. */
  function applyHostTheme() {
    var env = hostEnvironment();
    if (!env || !env.appSkinInfo) { return; }
    var skin = env.appSkinInfo;
    var bg = skin.panelBackgroundColor && skin.panelBackgroundColor.color;
    if (!bg) { return; }
    var root = document.documentElement;
    var lum = (bg.red * 0.299 + bg.green * 0.587 + bg.blue * 0.114);
    root.style.setProperty('--host-bg', toCss(bg));
    root.style.setProperty('--host-panel', 'rgb(' +
      Math.round(Math.min(255, bg.red + (lum > 127 ? -8 : 10))) + ',' +
      Math.round(Math.min(255, bg.green + (lum > 127 ? -8 : 10))) + ',' +
      Math.round(Math.min(255, bg.blue + (lum > 127 ? -8 : 10))) + ')');
    root.setAttribute('data-host-theme', lum > 127 ? 'light' : 'dark');
  }

  global.CEP = {
    available: available,
    evalScript: evalScript,
    getSystemPath: getSystemPath,
    hostEnvironment: hostEnvironment,
    extensionId: extensionId,
    openURL: openURL,
    applyHostTheme: applyHostTheme,
    SystemPath: SystemPath
  };
}(window));
