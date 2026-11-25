// Kitchen mode grid: picks the column count that gives each probe tile the largest readout for the screen shape.
// The readout's font size is min(30% of tile content width, 55% of tile content height) (see .kitchen .tile .big in
// app.css), so this scores each candidate grid by that size. One probe fills the screen; more probes share it in the
// grid that wastes the least space, e.g. 3 probes on a landscape screen go 2 + 1 (not 3 tall, thin columns).

export const KITCHEN_GAP = 16; // px between tiles; matches .kitchen .tiles gap
export const TILE_PAD = 24; // px tile padding; matches .kitchen .tile padding
export const MIN_TILE_HEIGHT = 200; // px; below this the grid scrolls instead of shrinking further

/** Readout font size (px) for a tile of the given outer size. Mirrors the CSS clamp's middle term. */
export function readoutSize(tileWidth, tileHeight) {
  return Math.min(0.30 * (tileWidth - 2 * TILE_PAD), 0.55 * (tileHeight - 2 * TILE_PAD));
}

/**
 * Best grid for `count` tiles in a `width` x `height` area.
 * @returns {{cols: number, rows: number, tileHeight: number|null}} tileHeight is set only when tiles would be shorter
 *   than MIN_TILE_HEIGHT; the caller then fixes the row height and lets the grid scroll.
 */
export function kitchenGrid(count, width, height, gap = KITCHEN_GAP) {
  const n = Math.max(1, count | 0);
  if (!(width > 0 && height > 0)) return { cols: 1, rows: n, tileHeight: null };
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    if (cols > 1 && Math.ceil(n / (cols - 1)) === rows) continue; // same rows with fewer columns: wider tiles win
    const tw = (width - gap * (cols - 1)) / cols;
    const th = Math.max(MIN_TILE_HEIGHT, (height - gap * (rows - 1)) / rows);
    const score = readoutSize(tw, th);
    if (!best || score > best.score + 0.5) best = { cols, rows, score, th };
  }
  const natural = (height - gap * (best.rows - 1)) / best.rows;
  return { cols: best.cols, rows: best.rows, tileHeight: natural < MIN_TILE_HEIGHT ? MIN_TILE_HEIGHT : null };
}
