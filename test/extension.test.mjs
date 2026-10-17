// The extension's copies of the web app must match web/. If this fails, run
// `npm run build:extension` and commit what it writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sidepanelHtml, COPIED, copied, iconPng, ICON_SIZES } from '../scripts/build-extension.mjs';

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const read = (p) => fs.readFileSync(path.join(EXT, p));

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
};

t('sidepanel.html is built from web/index.html', () => assert.equal(read('sidepanel.html').toString(), sidepanelHtml()));
for (const name of COPIED) t(`${name} matches web/`, () => assert.equal(read(name).toString(), copied(name)));
for (const s of ICON_SIZES) {
  t(`icons/icon-${s}.png is ${s}x${s}`, () => {
    const png = read(`icons/icon-${s}.png`);
    assert.equal(png.readUInt32BE(16), s);
    assert.equal(png.readUInt32BE(20), s);
    assert.ok(png.equals(iconPng(s)));
  });
}
t('every file the manifest names exists', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.manifest_version, 3);
  const files = [
    ...Object.values(m.icons),
    ...Object.values(m.action.default_icon),
    m.side_panel.default_path,
    m.background.service_worker,
  ];
  for (const f of files) assert.ok(fs.existsSync(path.join(EXT, f)), f);
});
t('the side panel loads config.js before app.js', () => {
  const html = read('sidepanel.html').toString();
  assert.ok(html.indexOf('config.js') < html.indexOf('src="app.js"'));
  assert.ok(!/<script>/.test(html), 'no inline scripts: extension CSP forbids them');
});

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`);
