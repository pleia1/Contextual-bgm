import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBlockState,
  compactBlocklist,
  createHistoryEntry,
  isSearchResultBlocked,
  makeSongKey,
  normalizeArtist,
  normalizeText,
  orderCandidates,
} from '../src/history.js';

const NOW = Date.UTC(2026, 8, 5);

function entry(overrides = {}) {
  return {
    videoId: 'abcdefghijk',
    title: 'Song Name',
    artist: 'Artist Name',
    titleKey: 'song name',
    artistKey: 'artist name',
    songKey: 'artist name:song name',
    channelTitle: 'Artist Name - Topic',
    query: 'Artist Name Song Name',
    playedAt: NOW - 1_000,
    playedSequence: 1,
    ...overrides,
  };
}

test('normalizes common YouTube title and channel noise', () => {
  assert.equal(normalizeText('Song Name (Official Audio) [Lyrics]'), 'song name');
  assert.equal(normalizeArtist('Artist Name - Topic'), 'artist name');
  assert.equal(normalizeArtist('ArtistNameVEVO'), 'artistname');
  assert.equal(makeSongKey('Artist Name', 'Song Name (Official Video)'), 'artist name:song name');
});

test('blocks recent video, song, and artist identities', () => {
  const state = buildBlockState([entry()], undefined, NOW);
  assert.equal(state.videoIds.has('abcdefghijk'), true);
  assert.equal(state.songKeys.has('artist name:song name'), true);
  assert.equal(state.artistKeys.has('artist name'), true);
});

test('expires a cooldown when its time window has elapsed', () => {
  const old = entry({ playedAt: NOW - 31 * 24 * 60 * 60 * 1_000 });
  const state = buildBlockState([old], undefined, NOW);
  assert.equal(state.videoIds.size, 0);
  assert.equal(state.songKeys.size, 0);
  assert.equal(state.artistKeys.size, 0);
});

test('hard-blocks a repeated song and relaxes only artist cooldown if needed', () => {
  const state = buildBlockState([entry()], undefined, NOW);
  const repeatedSong = { artist: 'Artist Name', title: 'Song Name', query: 'same' };
  const repeatedArtist = { artist: 'Artist Name', title: 'Different Song', query: 'different' };
  const fresh = { artist: 'New Artist', title: 'Fresh Song', query: 'fresh' };

  const mixed = orderCandidates([repeatedSong, repeatedArtist, fresh], state, () => 0);
  assert.equal(mixed.relaxedArtistCooldown, false);
  assert.equal(mixed.ordered.length, 1);
  assert.equal(mixed.ordered[0].candidate.title, 'Fresh Song');

  const fallback = orderCandidates([repeatedSong, repeatedArtist], state, () => 0);
  assert.equal(fallback.relaxedArtistCooldown, true);
  assert.equal(fallback.ordered.length, 1);
  assert.equal(fallback.ordered[0].candidate.title, 'Different Song');
});

test('blocks the same video and alternate uploads with normalized titles', () => {
  const state = buildBlockState([entry()], undefined, NOW);
  const candidateItem = {
    candidate: { artist: 'New Artist', title: 'New Track', query: 'query' },
    artistKey: 'new artist',
  };
  assert.equal(
    isSearchResultBlocked(
      { videoId: 'abcdefghijk', title: 'Anything', channelTitle: 'Anyone' },
      candidateItem,
      state,
    ),
    true,
  );
  assert.equal(
    isSearchResultBlocked(
      { videoId: 'zzzzzzzzzzz', title: 'Artist Name - Song Name (Official Audio)', channelTitle: 'Uploader' },
      candidateItem,
      state,
    ),
    true,
  );
  assert.equal(
    isSearchResultBlocked(
      { videoId: 'yyyyyyyyyyy', title: 'Different Song', channelTitle: 'Artist Name - Topic' },
      candidateItem,
      state,
    ),
    true,
  );
  assert.equal(
    isSearchResultBlocked(
      { videoId: 'yyyyyyyyyyy', title: 'Different Song', channelTitle: 'Artist Name - Topic' },
      candidateItem,
      state,
      { relaxArtistCooldown: true },
    ),
    false,
  );
});

test('creates compact model blocklists and canonical history entries', () => {
  const track = {
    videoId: '12345678901',
    artist: 'Example Artist',
    trackTitle: 'Example Song',
    channelTitle: 'Example Artist - Topic',
    query: 'Example Artist Example Song',
  };
  const created = createHistoryEntry(track, 4, NOW);
  assert.equal(created.songKey, 'example artist:example song');
  const list = compactBlocklist([created], undefined, NOW);
  assert.deepEqual(list.songs, [{ artist: 'Example Artist', title: 'Example Song' }]);
  assert.deepEqual(list.artists, ['Example Artist']);
});
