import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleStatus, clock } from '../src/ui/format.js';

const view = (o) => ({ state: 'predicting', mode: 'timeToRemoval', type: 'removal', percentToRemoval: 62.7,
  secondsRemaining: 8000, readyAt: Date.UTC(2026, 10, 24, 2, 42), isStale: false, ...o });

test('predicting shows progress and time left', () => {
  assert.equal(titleStatus(view()), '62% · 2:13');
  assert.equal(titleStatus(view({ secondsRemaining: 125 })), '62% · 2m 05s');
  assert.equal(titleStatus(view({ percentToRemoval: null })), '2:13');
});

test('clock preference shows the ready time', () => {
  const v = view();
  assert.equal(titleStatus(v, 'clock'), `62% · ${clock(v.readyAt)}`);
});

test('resting, warming, ready', () => {
  assert.equal(titleStatus(view({ type: 'resting' })), 'Resting · 2:13');
  assert.equal(titleStatus(view({ state: 'warming', secondsRemaining: null, percentToRemoval: 40.2 })), '40% · Warming');
  assert.equal(titleStatus(view({ state: 'removalPredictionDone' })), 'Ready');
});

test('nothing to show', () => {
  assert.equal(titleStatus(null), null);
  assert.equal(titleStatus(view({ isStale: true })), null);
  assert.equal(titleStatus(view({ state: 'notInserted', mode: 'none' })), null);
  assert.equal(titleStatus(view({ state: 'warming', mode: 'none' })), null);
  assert.equal(titleStatus(view({ secondsRemaining: null })), null);
});
