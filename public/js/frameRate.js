// Rendering preferences only. The deterministic battle runner keeps its independent clock and scheduler.
export const FRAME_RATES = Object.freeze([0, 30, 60, 120]);
export const normalizeFrameRate = (value) => FRAME_RATES.includes(value) ? value : 0;

/** Pixi's 0 means no cap; the same ticker drives units, effects and the Three.js board. */
export function applyFrameRate(ticker, value) {
  const limit = normalizeFrameRate(value);
  ticker.maxFPS = limit;
  return limit;
}

/** Keep the existing 60 FPS adaptive-quality baseline, allowing the intentional wait at a lower cap. */
export const renderFrameBudget = (limit) => 1000 / Math.min(normalizeFrameRate(limit) || 60, 60);
