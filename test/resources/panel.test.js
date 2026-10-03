// test/resources/panel.test.js — the two faces of the preload UI (public/js/ui/resourcePanel.js, docs/ASSETS.md
// 「Preload」): the numbers both render, and the wiring that puts the launcher in the title screen's bottom-right corner
// (the settings modal is only reachable inside a match, so the home screen needs its own entry).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { byteText, detailText, percent } from '../../public/js/ui/resourcePanel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The state public/js/resources/index.js publishes, with the counters its store filled in. */
const state = (over = {}) => ({
  enabled: true, phase: 'download', supported: true, reason: '', done: 0, total: 0, wanted: 0,
  tier1Done: 0, tier1Total: 0, tier2Done: 0, tier2Total: 0, bytes: 0, totalBytes: null, sized: 0, sizedTotal: 0,
  skipped: 0, failed: 0, complete: false, message: '', error: false, worker: '', version: '', ...over,
});

describe('preload numbers', () => {
  test('byteText: only when the server could size the files', () => {
    assert.equal(byteText(state()), '', 'nothing known yet');
    assert.equal(byteText(state({ totalBytes: null })), '');
    assert.equal(byteText(state({ totalBytes: 0 })), '');
    assert.equal(byteText(state({ totalBytes: 2 * 1024 * 1024, sizedTotal: 0 })), '2.0 MiB', 'sizes unknown ⇒ the total only');
    assert.equal(byteText(state({ totalBytes: 2 * 1024 * 1024, sizedTotal: 3, bytes: 1024 * 1024 })), '1.0 MiB / 2.0 MiB');
  });

  test('detailText: the two tiers, the file count and the bytes', () => {
    assert.equal(detailText(state()), '', 'no manifest yet');
    assert.equal(detailText(state({ total: 3966, wanted: 3960, done: 812, tier1Total: 456, tier1Done: 456, tier2Total: 3510, tier2Done: 356 })), '必需 456/456 · 全部 812/3966');
    const withBytes = state({ total: 3966, wanted: 3966, done: 812, tier1Total: 456, tier1Done: 456, totalBytes: 259726913, sizedTotal: 3966, bytes: 50000000 });
    assert.equal(detailText(withBytes), '必需 456/456 · 全部 812/3966 · 47.7 MiB / 248 MiB');
    assert.equal(detailText(state({ total: 10, done: 1, tier1Total: 0 })), '全部 1/10', 'no essential tier ⇒ no 必需 line');
  });

  test('percent: by bytes when every file is sized, by file count otherwise, clamped', () => {
    assert.equal(percent(state()), 0);
    assert.equal(percent(state({ total: 100, wanted: 100, done: 25 })), 25);
    assert.equal(percent(state({ total: 100, wanted: 80, done: 40 })), 50, 'skipped files do not count as missing');
    assert.equal(percent(state({ total: 100, wanted: 100, done: 100 })), 100);
    assert.equal(percent(state({ total: 100, wanted: 100, done: 0, totalBytes: 200, sizedTotal: 100, bytes: 50 })), 25);
    assert.equal(percent(state({ total: 100, wanted: 100, done: 0, totalBytes: 200, sizedTotal: 50, bytes: 50 })), 0, 'a partly sized manifest falls back to files');
    assert.equal(percent(state({ total: 4, wanted: 4, done: 9 })), 100, 'clamped');
  });
});

describe('where the preload is reachable', () => {
  test('the settings modal still has its row (in-match management)', () => {
    const settings = read('public/js/ui/settings.js');
    assert.match(settings, /import \{ ResourceRow \} from '\.\/resourcePanel\.js';/);
    assert.match(settings, /<\$\{ResourceRow\} enabled=\$\{s\.preload\} onChange=\$\{\(v\) => updateSettings\(\{ preload: v \}\)\} \/>/);
  });

  test('the title screen mounts the launcher in its bottom-right corner', () => {
    const title = read('public/js/screens/title.js');
    assert.match(title, /import \{ ResourceLauncher \} from '\.\.\/ui\/resourcePanel\.js';/);
    assert.match(title, /import \{ updateSettings, useSettings \} from '\.\.\/ui\/settings\.js';/);
    assert.match(title, /const settings = useSettings\(\);/);
    assert.match(title, /<div class="title-preload"><\$\{ResourceLauncher\} enabled=\$\{settings\.preload\} onChange=\$\{\(v\) => updateSettings\(\{ preload: v \}\)\} \/><\/div>/);
    const css = read('public/css/screens/title.css');
    assert.match(css, /\.title-preload \{[^}]*position: absolute;[^}]*right: \.44rem;[^}]*bottom: \.86rem;/, 'bottom-right, above the footer');
    assert.match(css, /\.res-pill \{/, 'the pill has its own styling');
  });

  test('the launcher starts the preload in one click and can always undo it', () => {
    const panel = read('public/js/ui/resourcePanel.js');
    assert.match(panel, /export function ResourceLauncher/);
    assert.match(panel, /onClick=\$\{\(\) => \{ if \(!enabled\) onChange\(true\); \}\}/, 'the header starts it');
    assert.match(panel, /onClose=\$\{\(\) => onChange\(false\)\}/, '关闭预载 turns the setting back off');
    assert.match(panel, /if \(!enabled && !st\.supported\) return null;/, 'no clutter on a plain-HTTP LAN');
    assert.match(panel, /disabled=\$\{!enabled && !st\.supported \? 'disabled' : null\}/, 'a browser that cannot cache can still turn it back off');
    assert.match(panel, /onChange\(false\)\}>关闭预载<\/button>/, 'and the pill can always be closed');
    assert.match(panel, /startResources\(\)/, 'continue');
    assert.match(panel, /pauseResources\(\)/, 'pause');
    assert.match(panel, /clearResources\(\)/, 'clear');
    // both faces render the shared progress bar and the same actions, so they can never drift apart
    assert.equal(panel.match(/\$\{ResourceActions\}/g).length, 2);
    assert.equal(panel.match(/\$\{ProgressBar\}/g).length, 2);
  });
});
