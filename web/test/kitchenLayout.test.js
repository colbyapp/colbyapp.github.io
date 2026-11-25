import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kitchenGrid, MIN_TILE_HEIGHT } from '../src/ui/kitchenLayout.js';

const grid = (n, w, h) => { const g = kitchenGrid(n, w, h); return `${g.cols}x${g.rows}`; };

test('one probe fills the area', () => {
  assert.equal(grid(1, 1392, 790), '1x1');
  assert.equal(grid(1, 400, 800), '1x1');
});

test('landscape screens (1440x900 kitchen area)', () => {
  assert.equal(grid(2, 1392, 790), '2x1');
  assert.equal(grid(3, 1392, 790), '2x2'); // 2 + 1, not three thin columns
  assert.equal(grid(4, 1392, 790), '2x2');
  assert.equal(grid(5, 1392, 790), '3x2');
  assert.equal(grid(6, 1392, 790), '3x2');
  assert.equal(grid(8, 1392, 790), '3x3'); // 3 + 3 + 2: larger readouts than 4x2
});

test('portrait screens stack', () => {
  assert.equal(grid(2, 760, 1200), '1x2');
  assert.equal(grid(3, 760, 1200), '1x3');
  assert.equal(grid(4, 760, 1200), '1x4');
  assert.equal(grid(8, 760, 1200), '2x4');
});

test('very wide screens use more columns', () => {
  assert.equal(grid(3, 3000, 700), '3x1');
});

test('tiles never shrink below the minimum height; the grid scrolls', () => {
  const g = kitchenGrid(8, 360, 600);
  assert.equal(g.tileHeight, MIN_TILE_HEIGHT);
  assert.equal(kitchenGrid(4, 1392, 790).tileHeight, null);
});

test('no space yet (hidden) falls back safely', () => {
  assert.deepEqual(kitchenGrid(3, 0, 0), { cols: 1, rows: 3, tileHeight: null });
  assert.equal(grid(0, 1000, 800), '1x1');
});
