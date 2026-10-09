import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { TimingHistogram, NetDiagnostics, DIAGNOSTIC_WINDOW_MS } from '../server/netDiagnostics.js';

test('timing histogram exposes cumulative buckets, exact sum and independent snapshots', () => {
  const h = new TimingHistogram();
  for (const ms of [0.01, 0.25, 2, 5, 80000]) h.record(ms);
  const view = h.stats();
  assert.equal(view.count, 5);
  assert.equal(view.sumMs, 80007.26);
  assert.equal(view.buckets.at(-1).leMs, '+Inf');
  assert.equal(view.buckets.at(-1).count, 5);
  assert.equal(view.buckets.find((b) => b.leMs === 2).count, 3);
  assert.ok(view.buckets.every((b, i) => !i || b.count >= view.buckets[i - 1].count));
  view.buckets[0].count = 999;
  assert.equal(h.stats().buckets[0].count, 1);
});

test('recent event-loop window and CPU preserve since-start diagnostics; scraping does not reset them', async (t) => {
  const d = new NetDiagnostics();
  t.after(() => d.close());
  assert.equal(d.stats().recentEventLoop, null);
  d.received('ping', 12, 0.3);
  const sent = [];
  for (let i = 0; i < 128; i++) {
    const done = d.sent('abc');
    if (done) { done(null); sent.push(done); }
  }
  assert.equal(sent.length, 2);
  await delay(80);
  d.sampleWindow();
  const first = d.stats(), second = d.stats();
  assert.deepEqual(second.recentEventLoop, first.recentEventLoop, 'two collectors must see the same completed window');
  assert.ok(first.recentEventLoop.sampleCount > 0);
  assert.ok(first.recentEventLoop.windowMs > 0);
  assert.ok(first.processCpu.userSeconds >= 0 && first.processCpu.systemSeconds >= 0);
  assert.equal(first.handlerMs.ping.sumMs, 0.3);
  assert.equal(first.sendCompletionMs.count, 2);
  assert.equal(first.sentFrames, 128);
  assert.equal(first.sentBytes, 384);
  await delay(50);
  d.sampleWindow();
  assert.equal(d.stats().handlerMs.ping.count, 1, 'window reset must not affect cumulative handler stats');
  assert.equal(d.stats().sendCompletionMs.count, 2);
  first.recentEventLoop.maxMs = 999999;
  assert.notEqual(d.stats().recentEventLoop.maxMs, 999999);
});

test('10-second diagnostics window is independent of HTTP and stops at disposal', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const d = new NetDiagnostics();
  const sampler = t.mock.method(d, 'sampleWindow', () => {});
  t.mock.timers.tick(DIAGNOSTIC_WINDOW_MS - 1);
  assert.equal(sampler.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(sampler.mock.callCount(), 1);
  d.close();
  t.mock.timers.tick(DIAGNOSTIC_WINDOW_MS * 3);
  assert.equal(sampler.mock.callCount(), 1);
});
