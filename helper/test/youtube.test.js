import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TRACK_SECONDS,
  embeddingPreferenceScore,
  isLikelyShort,
  isLiveVideo,
  isTrackDurationAllowed,
  isVideoAvailableInRegion,
  parseYouTubeDuration,
  preferEmbeddableDerivatives,
} from '../src/youtube.js';

function video(overrides = {}) {
  return {
    status: { embeddable: true, privacyStatus: 'public' },
    contentDetails: {},
    ...overrides,
  };
}

test('accepts a public embeddable video without a region restriction', () => {
  assert.equal(isVideoAvailableInRegion(video(), 'KR'), true);
});

test('rejects videos that are private or marked non-embeddable', () => {
  assert.equal(
    isVideoAvailableInRegion(video({ status: { embeddable: false, privacyStatus: 'public' } }), 'KR'),
    false,
  );
  assert.equal(
    isVideoAvailableInRegion(video({ status: { embeddable: true, privacyStatus: 'private' } }), 'KR'),
    false,
  );
});

test('honors allowed and blocked region lists', () => {
  assert.equal(
    isVideoAvailableInRegion(video({ contentDetails: { regionRestriction: { blocked: ['KR'] } } }), 'KR'),
    false,
  );
  assert.equal(
    isVideoAvailableInRegion(video({ contentDetails: { regionRestriction: { allowed: ['US', 'JP'] } } }), 'KR'),
    false,
  );
  assert.equal(
    isVideoAvailableInRegion(video({ contentDetails: { regionRestriction: { allowed: ['KR'] } } }), 'KR'),
    true,
  );
});

test('parses YouTube ISO 8601 durations', () => {
  assert.equal(parseYouTubeDuration('PT3M42S'), 222);
  assert.equal(parseYouTubeDuration('PT8M'), 480);
  assert.equal(parseYouTubeDuration('PT1H2M3S'), 3723);
  assert.equal(parseYouTubeDuration('not-a-duration'), null);
});

test('allows tracks up to eight minutes and rejects longer or unknown durations', () => {
  assert.equal(isTrackDurationAllowed({ contentDetails: { duration: 'PT8M' } }), true);
  assert.equal(isTrackDurationAllowed({ contentDetails: { duration: 'PT8M1S' } }), false);
  assert.equal(isTrackDurationAllowed({ contentDetails: {} }), false);
  assert.equal(MAX_TRACK_SECONDS, 480);
});

test('prioritizes clean lyric uploads and moves official, live, and altered uploads later', () => {
  const results = [
    { title: 'Song (Official Audio)', channelTitle: 'Artist - Topic' },
    { title: 'Song Lyrics', channelTitle: 'listener123' },
    { title: 'Song (Official Video)', channelTitle: 'ArtistVEVO' },
    { title: 'Song', channelTitle: 'music archive' },
    {
      title: 'Song Lyrics (Live)',
      channelTitle: 'listener456',
      liveStreamingDetails: { actualStartTime: '2024-01-01T00:00:00Z' },
    },
    { title: 'Song slowed + reverb', channelTitle: 'listener789' },
  ];
  const ordered = preferEmbeddableDerivatives(results);
  assert.equal(ordered[0].title, 'Song Lyrics');
  assert.ok(ordered.indexOf(results[3]) < ordered.indexOf(results[0]));
  assert.ok(ordered.indexOf(results[3]) < ordered.indexOf(results[2]));
  assert.ok(ordered.indexOf(results[3]) < ordered.indexOf(results[4]));
  assert.ok(ordered.indexOf(results[3]) < ordered.indexOf(results[5]));
  assert.ok(embeddingPreferenceScore(results[0]) > embeddingPreferenceScore(results[1]));
});

test('recognizes live broadcasts including completed streams', () => {
  assert.equal(isLiveVideo({ liveBroadcastContent: 'live' }), true);
  assert.equal(isLiveVideo({ liveBroadcastContent: 'upcoming' }), true);
  assert.equal(isLiveVideo({ liveStreamingDetails: { actualEndTime: '2024-01-01T01:00:00Z' } }), true);
  assert.equal(isLiveVideo({ liveBroadcastContent: 'none' }), false);
  assert.equal(embeddingPreferenceScore({ title: 'Long Live', channelTitle: 'listener' }), 0);
  assert.ok(
    embeddingPreferenceScore({ title: 'Song (Live)', channelTitle: 'listener' }) >
      embeddingPreferenceScore({ title: 'Song', channelTitle: 'listener' }),
  );
});

test('filters explicit Shorts markers without rejecting ordinary short songs', () => {
  assert.equal(isLikelyShort({ title: 'Song #Shorts' }), true);
  assert.equal(isLikelyShort({ title: 'Song', tags: ['music', 'youtubeShorts'] }), true);
  assert.equal(isLikelyShort({ title: 'A Short Song', tags: ['music'] }), false);
  assert.deepEqual(
    preferEmbeddableDerivatives([
      { title: 'Song #shorts', channelTitle: 'clipper' },
      { title: 'Song Lyrics', channelTitle: 'listener' },
    ]).map((item) => item.title),
    ['Song Lyrics'],
  );
});
