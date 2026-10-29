// Motion detection helpers for the VisionCamera frame processor.
// Mirrors the web camera's hasMotion(): a sample "changes" when it differs by
// more than PIXEL_THRESHOLD, and motion is reported when more than MOTION_PCT
// of samples changed since the previous checked frame.

export const MOTION_COOLDOWN_MS = 60 * 1000;

const GRID_COLS = 80;
const GRID_ROWS = 45;
const PIXEL_THRESHOLD = 25;
const MOTION_PCT = 1.5;

// Samples a coarse grid from the frame's first plane (luma for 'yuv' frames).
// Only the same byte positions are ever compared between frames, so the exact
// buffer layout (row padding, plane order) doesn't matter as long as it's stable.
export function sampleFrame(data, width, height) {
  'worklet';
  const rowBytes = Math.floor(data.length / height);
  const cols = Math.min(width, rowBytes);
  const samples = new Array(GRID_COLS * GRID_ROWS);
  for (let r = 0; r < GRID_ROWS; r++) {
    const rowStart = Math.floor(((r + 0.5) * height) / GRID_ROWS) * rowBytes;
    for (let c = 0; c < GRID_COLS; c++) {
      samples[r * GRID_COLS + c] = data[rowStart + Math.floor(((c + 0.5) * cols) / GRID_COLS)];
    }
  }
  return samples;
}

// Returns true if enough samples changed between two sampleFrame() results.
export function hasMotion(prev, curr) {
  'worklet';
  if (prev.length !== curr.length || curr.length === 0) return false;
  let changed = 0;
  for (let i = 0; i < curr.length; i++) {
    if (Math.abs(prev[i] - curr[i]) > PIXEL_THRESHOLD) changed++;
  }
  return (changed / curr.length) * 100 > MOTION_PCT;
}
