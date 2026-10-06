import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ticker } from '@pixi/ticker';
import { applyFrameRate, renderFrameBudget } from '../../public/js/frameRate.js';

function runTicks(ticker, hz, seconds = 2, start = 0) {
  for (let i = 1; i <= hz * seconds; i++) ticker.update(start + i * 1000 / hz);
}

test('actual Pixi ticker caps render callbacks at 30 / 60 / 120 on a 240 Hz display; uncapped follows refresh', () => {
  for (const limit of [0, 30, 60, 120]) {
    const ticker = new Ticker();
    let frames = 0;
    ticker.add(() => frames++);
    applyFrameRate(ticker, limit);
    runTicks(ticker, 240);
    const expected = (limit || 240) * 2;
    // Pixi quantizes its elapsed check to whole milliseconds, occasionally skipping a high-refresh frame.
    assert.ok(frames <= expected + 1 && frames >= expected * 0.95,
      `${limit || 'unlimited'}: ${frames} frames vs cap ${expected}`);
    ticker.destroy();
  }
});

test('switching a running ticker from 30 to 60 to unlimited takes effect without scaling its animation speed', () => {
  const ticker = new Ticker();
  let frames = 0, animationMs = 0;
  ticker.add(() => { frames++; animationMs += ticker.deltaMS; });
  applyFrameRate(ticker, 30);
  runTicks(ticker, 240);
  const first = frames;
  assert.ok(Math.abs(first - 60) <= 2);
  applyFrameRate(ticker, 60);
  runTicks(ticker, 240, 2, 2000);
  assert.ok(Math.abs(frames - first - 120) <= 2);
  const second = frames;
  applyFrameRate(ticker, 0);
  runTicks(ticker, 240, 2, 4000);
  assert.equal(frames - second, 480);
  assert.equal(ticker.speed, 1);
  assert.ok(Math.abs(animationMs - 6000) < 40, `animation keeps real-time duration (${animationMs} ms)`);
  ticker.destroy();
});

test('adaptive quality tolerates intentional 30 FPS and still identifies genuinely slower rendering', () => {
  const slow30 = renderFrameBudget(30) * 1.17;
  const fast30 = renderFrameBudget(30) * 1.056;
  assert.ok(1000 / 30 < slow30, 'a stable capped frame is not slow');
  assert.ok(1000 / 30 < fast30, 'a stable capped frame can recover quality');
  assert.ok(1000 / 20 > slow30, '20 FPS is slow even with a 30 FPS cap');
  for (const limit of [0, 60, 120]) {
    assert.equal(renderFrameBudget(limit) * 1.17, 19.5, 'higher caps retain the existing load threshold');
    assert.ok(1000 / 60 < renderFrameBudget(limit) * 1.056, 'a 60 Hz monitor is not penalized for a higher cap');
  }
});
