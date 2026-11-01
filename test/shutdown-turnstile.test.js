import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnstileLoader } from '../deploy/shutdown/site/turnstile.js';

function browser(turnstile) {
  const scripts = [], timers = new Map();
  let timerId = 0;
  const scope = {
    turnstile,
    document: {
      createElement() { return { remove() { this.removed = true; } }; },
      head: { append(script) { scripts.push(script); } },
    },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const callbackName = script => new URL(script.src).searchParams.get('onload');
  const ready = script => scope[callbackName(script)]();
  return { scope, scripts, timers, callbackName, ready, load: createTurnstileLoader(scope) };
}
const sdk = () => ({ render() {}, remove() {}, reset() {} });

test('a window.turnstile DOM element does not skip SDK loading', async () => {
  const browserState = browser({ tagName: 'DIV', id: 'turnstile' });
  const { load, scope, scripts, timers, ready } = browserState;
  let resolved = false;
  const loading = load();
  loading.then(() => { resolved = true; });
  assert.equal(scripts.length, 1);
  // A script load event cannot be used as the SDK readiness signal.
  scripts[0].onload?.();
  await Promise.resolve();
  assert.equal(resolved, false);
  scope.turnstile = sdk();
  ready(scripts[0]);
  assert.equal(await loading, scope.turnstile);
  assert.equal(timers.size, 0);
});

test('concurrent attempts share a script and an initialized SDK is reused', async () => {
  const { load, scope, scripts, ready } = browser();
  const first = load(), second = load();
  assert.equal(first, second);
  assert.equal(scripts.length, 1);
  scope.turnstile = sdk(); ready(scripts[0]);
  assert.equal(await first, scope.turnstile);
  assert.equal(await load(), scope.turnstile);
  assert.equal(scripts.length, 1);
});

test('script failure can be retried and does not poison subsequent attempts', async () => {
  const { load, scope, scripts, timers, ready, callbackName } = browser();
  const first = load();
  const failure = assert.rejects(first, /无法加载人机验证/);
  scripts[0].onerror();
  await failure;
  assert.equal(scripts[0].removed, true);
  assert.equal(scope[callbackName(scripts[0])], undefined);
  assert.equal(timers.size, 0);
  const second = load();
  assert.equal(scripts.length, 2);
  scope.turnstile = sdk(); ready(scripts[1]);
  assert.equal(await second, scope.turnstile);
});

test('timeout permits retry; a delayed old callback cannot settle the new attempt', async () => {
  const { load, scope, scripts, timers, ready, callbackName } = browser();
  const first = load();
  const oldCallback = scope[callbackName(scripts[0])];
  const failure = assert.rejects(first, /加载超时/);
  [...timers.values()][0]();
  await failure;
  assert.equal(scripts[0].removed, true);
  const second = load();
  let resolved = false;
  second.then(() => { resolved = true; });
  scope.turnstile = sdk(); oldCallback();
  await Promise.resolve();
  assert.equal(resolved, false);
  ready(scripts[1]);
  assert.equal(await second, scope.turnstile);
});

test('an incomplete SDK gives an initialization error and allows retry', async () => {
  const { load, scope, scripts, ready } = browser({ ready() {} });
  const first = load();
  const failure = assert.rejects(first, /初始化失败/);
  ready(scripts[0]); await failure;
  const second = load();
  scope.turnstile = sdk(); ready(scripts[1]);
  assert.equal(await second, scope.turnstile);
});

test('a preloaded usable SDK requires no extra script or timeout', async () => {
  const api = sdk();
  const { load, scripts, timers } = browser(api);
  assert.equal(await load(), api);
  assert.equal(scripts.length, 0);
  assert.equal(timers.size, 0);
});
