/*
 * Parses every script Silencer ships, so a typo cannot reach an installer.
 * ExtendScript is ES3, which Node parses happily as a subset of modern JS.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import vm from 'node:vm';

const roots = ['extension/js', 'extension/jsx'];
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full); }
    else if (['.js', '.jsx'].includes(extname(entry))) { files.push(full); }
  }
}
roots.forEach(walk);

let failed = 0;
for (const file of files) {
  try {
    new vm.Script(readFileSync(file, 'utf8'), { filename: file });
    console.log(`ok   ${file}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${file}\n     ${err.message}`);
  }
}

// The manifest must stay well-formed or Premiere silently ignores the panel.
const manifest = readFileSync('extension/CSXS/manifest.xml', 'utf8');
for (const needle of ['ExtensionBundleId="com.niterix.captionist"', '<MainPath>./index.html</MainPath>', '<ScriptPath>./jsx/Captionist.jsx</ScriptPath>']) {
  if (!manifest.includes(needle)) {
    failed++;
    console.error(`FAIL manifest.xml is missing ${needle}`);
  }
}

// Every script index.html pulls in must actually exist.
const html = readFileSync('extension/index.html', 'utf8');
for (const match of html.matchAll(/<script src="([^"]+)"/g)) {
  try { statSync(join('extension', match[1])); }
  catch { failed++; console.error(`FAIL index.html references missing ${match[1]}`); }
}

if (failed) { console.error(`\n${failed} problem(s).`); process.exit(1); }
console.log(`\n${files.length} script(s) parsed cleanly.`);
