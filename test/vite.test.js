// Verify real production artifacts and simulation parity without browser automation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { createStaticHandler, computeBuildTag } from '../server/index.js';
import { getData } from '../server/data.js';
import * as nativeSpec from '../server/sim/spec.js';
import { DataSource } from '../server/sim/simdata.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let temp, publicDir, outDir, manifest, server, origin;
before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-vite-'));
  await fs.writeFile(path.join(temp, 'package.json'), '{"type":"module"}');
  publicDir = path.join(temp, 'public');
  outDir = path.join(publicDir, 'build');
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(path.join(publicDir, 'index.html'), '<html>source client</html>');
  await build({ configFile: path.join(root, 'vite.config.js'), logLevel: 'silent', build: { outDir } });
  manifest = JSON.parse(await fs.readFile(path.join(outDir, '.vite/manifest.json'), 'utf8'));
  const handler = createStaticHandler({ publicDir, dataDir: path.join(root, 'data'), sharedDir: path.join(root, 'shared'),
    cdnBase: 'https://art.example.com/game', dataCdnBase: 'https://data.example.com/game' });
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    handler(req, res, url.pathname, url.search.slice(1)).catch((err) => { res.statusCode = 500; res.end(String(err)); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});

test('built HTML, hashed assets, runtime CDN and data routes preserve the production contracts', async () => {
  for (const route of ['/', '/index.html', '/build/index.html']) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    const html = await response.text();
    assert.match(html, /src="\/build\/assets\/index-[\w-]+\.js"/);
    assert.match(html, /onerror="window\.__spBootFail/);
    assert.doesNotMatch(html, /type="importmap"|href="\/css\//);
    for (const [, url] of html.matchAll(/(?:src|href)="(\/build\/[^" ]+)"/g)) {
      const asset = await fetch(origin + url);
      assert.equal(asset.status, 200, url);
      assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable', url);
      assert.equal(asset.headers.get('content-encoding'), 'gzip', url);
      assert.equal((await fetch(origin + url, { headers: { 'If-None-Match': asset.headers.get('etag') } })).status, 304);
      await asset.arrayBuffer();
    }
  }
  const allJs = await Promise.all(Object.values(manifest).filter((m) => m.file.endsWith('.js'))
    .map((m) => fs.readFile(path.join(outDir, m.file), 'utf8')));
  assert.ok(allJs.some((s) => /from["']\/js\/asset-cdn\.js["']/.test(s)), 'CDN module stays external');
  assert.ok(allJs.every((s) => !/node:fs|node:path|nodeData\.js|__vite-browser-external/.test(s)), 'no Node-only imports');
  const config = await fetch(origin + '/js/asset-cdn.js');
  assert.equal(config.headers.get('cache-control'), 'no-cache');
  const configText = await config.text();
  assert.match(configText, /export const ASSETS_CDN = "https:\/\/art\.example\.com\/game"/);
  assert.match(configText, /export const DATA_CDN = "https:\/\/data\.example\.com\/game"/);
  assert.ok(allJs.some((s) => /DATA_CDN/.test(s)), 'built loaders consume the runtime data CDN');
  const data = await fetch(origin + '/data/chess.json', { redirect: 'manual' });
  assert.equal(data.status, 307);
  assert.equal(data.headers.get('location'), 'https://data.example.com/game/data/chess.json');
  // Explicit source mode works even with built files present.
  const source = createStaticHandler({ publicDir, dataDir: path.join(root, 'data'), sharedDir: path.join(root, 'shared'), clientBuild: false });
  const srv = http.createServer((req, res) => source(req, res, '/', ''));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try { assert.equal(await (await fetch(`http://127.0.0.1:${srv.address().port}/`)).text(), '<html>source client</html>'); }
  finally { await new Promise((resolve) => srv.close(resolve)); }
});

test('rendering, simulation and Three.js remain outside the initial static import graph', () => {
  const seen = new Set();
  function visit(key) {
    if (seen.has(key)) return;
    seen.add(key);
    for (const dependency of manifest[key].imports || []) visit(dependency);
  }
  visit('index.html');
  const initial = [...seen].map((key) => manifest[key].name);
  for (const name of ['simulation', 'app', 'three']) assert.ok(!initial.includes(name), `${name} loads lazily`);
});

test('built simulation retains operator kits and domain mechanics: same deterministic battle results as Node', async () => {
  const simulation = Object.values(manifest).find((m) => m.name === 'simulation');
  const namespaces = Object.values(await import(pathToFileURL(path.join(outDir, simulation.file)).href));
  const spec = namespaces.find((n) => typeof n?.createBattleFromSpec === 'function');
  const simdata = namespaces.find((n) => typeof n?.setSimData === 'function');
  assert.ok(spec && simdata, 'simulation entry namespaces exist');
  const raw = getData({ log: { warn() {} } });
  simdata.setSimData(raw);
  const ids = Object.keys(raw.chess).filter((id) => id.endsWith('_a'));
  assert.ok(ids.length > 20);
  for (const seed of [17, 29, 53]) {
    const units = ids.slice((seed % 5) * 6, (seed % 5) * 6 + 6).map((chessId, i) => ({
      uid: i + 1, chessId, row: 9 + Math.floor(i / 3), col: 4 + i % 3,
    }));
    const input = nativeSpec.buildBattleSpec({ kind: 'normal', seed, round: 3, stageId: Object.keys(raw.stages)[0], timeLimit: 30,
      players: [{ playerId: 'p', units, bonds: {} }],
      spawns: [{ enemyKey: Object.keys(raw.enemies)[0], count: 4, time: 1 }], flags: { layerGainsEnabled: true } });
    const options = { quiet: true, recordEvents: false };
    const native = nativeSpec.createBattleFromSpec(input, new DataSource(raw), options);
    const built = spec.createBattleFromSpec(input, new simdata.DataSource(raw), options);
    native.runToEnd(100);
    built.runToEnd(100);
    assert.ok(native.finished && built.finished);
    assert.equal(native.errors.length, 0);
    assert.equal(built.errors.length, 0);
    assert.deepEqual(spec.compactResult(built.result()), nativeSpec.compactResult(native.result()), `seed ${seed}`);
    assert.deepEqual(built.allyUnits.map((u) => Object.keys(u.kit || {})), native.allyUnits.map((u) => Object.keys(u.kit || {})));
  }
});

test('build detection follows built files and separately served worker modules', async () => {
  const initial = computeBuildTag(temp);
  await fs.writeFile(path.join(publicDir, 'index.html'), 'source-only change');
  assert.equal(computeBuildTag(temp), initial, 'unserved source shell does not change the production tag');
  await fs.writeFile(path.join(outDir, manifest['index.html'].file), '// new built code');
  assert.notEqual(computeBuildTag(temp), initial);
  const updated = computeBuildTag(temp);
  await fs.writeFile(path.join(publicDir, 'resource-sw.js'), '// new worker');
  assert.notEqual(computeBuildTag(temp), updated);
});
