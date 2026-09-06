import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPlaybackProof, updatePlaybackEvidence } from '../src/playback-evidence.js';

test('requires both wall time and actual audible playback progress', () => {
  const started = updatePlaybackEvidence(null, {
    videoId: 'abcdefghijk', currentTime: 0, muted: false, volume: 35,
  }, 1_000);
  const stalled = updatePlaybackEvidence(started, {
    videoId: 'abcdefghijk', currentTime: 0, muted: false, volume: 35,
  }, 12_000);
  assert.equal(hasPlaybackProof(stalled, 10, 12_000), false);

  const progressed = updatePlaybackEvidence(stalled, {
    videoId: 'abcdefghijk', currentTime: 10.1, muted: false, volume: 35,
  }, 12_000);
  assert.equal(hasPlaybackProof(progressed, 10, 12_000), true);
});

test('does not verify muted or zero-volume playback', () => {
  let evidence = updatePlaybackEvidence(null, {
    videoId: 'abcdefghijk', currentTime: 0, muted: true, volume: 35,
  }, 0);
  evidence = updatePlaybackEvidence(evidence, {
    videoId: 'abcdefghijk', currentTime: 12, muted: true, volume: 35,
  }, 12_000);
  assert.equal(hasPlaybackProof(evidence, 10, 12_000), false);
});

test('resets proof when playback seeks backward or the video changes', () => {
  const first = updatePlaybackEvidence(null, {
    videoId: 'abcdefghijk', currentTime: 20, muted: false, volume: 35,
  }, 0);
  const sought = updatePlaybackEvidence(first, {
    videoId: 'abcdefghijk', currentTime: 2, muted: false, volume: 35,
  }, 5_000);
  assert.equal(sought.firstTime, 2);
  assert.equal(sought.firstObservedAt, 5_000);
});
