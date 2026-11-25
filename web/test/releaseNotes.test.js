import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseNotes, releaseInfo } from '../tools/releaseNotes.mjs';

const BODY = `<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
* Web: show progress and ETA in the tab title by @someone in https://github.com/o/r/pull/2
* Mac: fix the menu bar icon by @someone in https://github.com/o/r/pull/4
* CI: move actions to Node 24 majors by @someone in https://github.com/o/r/pull/5
* kitchen mode: fill the screen by @someone in https://github.com/o/r/pull/1

## New Contributors
* @someone made their first contribution in https://github.com/o/r/pull/1

**Full Changelog**: https://github.com/o/r/compare/web-v1.0.0...web-v1.1.0`;

test('keeps web PRs from the What\'s Changed list', () => {
  assert.deepEqual(parseReleaseNotes(BODY), [
    { title: 'Show progress and ETA in the tab title', url: 'https://github.com/o/r/pull/2' },
    { title: 'Kitchen mode: fill the screen', url: 'https://github.com/o/r/pull/1' },
  ]);
});

test('hand-written bullets from the release page', () => {
  const body = `## What's Changed
- Reconnecting is more reliable.
* web: a probe shows one time only.
- CI: faster builds.

**Full Changelog**: https://github.com/o/r/compare/web-v1.0.0...web-v1.0.1`;
  assert.deepEqual(parseReleaseNotes(body), [
    { title: 'Reconnecting is more reliable.', url: null },
    { title: 'A probe shows one time only.', url: null },
  ]);
});

test('empty or missing notes', () => {
  assert.deepEqual(parseReleaseNotes(''), []);
  assert.deepEqual(parseReleaseNotes(undefined), []);
  assert.deepEqual(parseReleaseNotes('## What\'s Changed\n\n**Full Changelog**: x'), []);
});

test('release info only for web tags', () => {
  const date = new Date('2026-11-25T12:00:00Z');
  assert.deepEqual(releaseInfo({ tag: 'web-v1.2.0', notesBody: BODY, date }).version, '1.2.0');
  assert.equal(releaseInfo({ tag: 'web-v1.2.0', notesBody: BODY, date }).date, '2026-11-25');
  assert.equal(releaseInfo({ tag: 'v1.2.0', notesBody: BODY }), null);
  assert.equal(releaseInfo({ tag: '', notesBody: BODY }), null);
});
