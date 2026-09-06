import test from 'node:test';
import assert from 'node:assert/strict';
import {
  crossfadeVolumes,
  normalizeCrossfadeSettings,
  playbackRemainingSeconds,
  shouldPrepareNextTrack,
} from '../src/crossfade.js';

test('normalizes crossfade settings to the supported range', () => {
  assert.deepEqual(normalizeCrossfadeSettings({ enabled: true, seconds: 99 }), {
    enabled: true,
    seconds: 15,
  });
  assert.deepEqual(normalizeCrossfadeSettings({ enabled: 'true', seconds: 0 }), {
    enabled: false,
    seconds: 1,
  });
});

test('computes remaining playback time only for valid durations', () => {
  assert.equal(playbackRemainingSeconds(235, 240), 5);
  assert.equal(playbackRemainingSeconds(250, 240), 0);
  assert.equal(playbackRemainingSeconds(10, 0), null);
});

test('requests a next track only near the end of active playback', () => {
  const base = {
    enabled: true,
    phase: 'playing',
    currentTrack: { videoId: 'current' },
    nextTrack: null,
    duration: 240,
    crossfadeSeconds: 5,
  };
  assert.equal(shouldPrepareNextTrack({ ...base, currentTime: 190 }), false);
  assert.equal(shouldPrepareNextTrack({ ...base, currentTime: 196 }), true);
  assert.equal(shouldPrepareNextTrack({ ...base, nextTrack: { videoId: 'next' }, currentTime: 230 }), false);
  assert.equal(shouldPrepareNextTrack({ ...base, enabled: false, currentTime: 230 }), false);
});

test('returns complementary linear crossfade volumes', () => {
  assert.deepEqual(crossfadeVolumes(0, 5, 40), { progress: 0, outgoing: 40, incoming: 0 });
  assert.deepEqual(crossfadeVolumes(2_500, 5, 40), { progress: 0.5, outgoing: 20, incoming: 20 });
  assert.deepEqual(crossfadeVolumes(5_000, 5, 40), { progress: 1, outgoing: 0, incoming: 40 });
});
