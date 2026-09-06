const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_POLICY = Object.freeze({
  videoCooldownPlays: 40,
  videoCooldownDays: 30,
  songCooldownPlays: 30,
  songCooldownDays: 30,
  artistCooldownPlays: 8,
  artistCooldownDays: 7,
  maxHistory: 500,
});

const NOISE_PATTERNS = [
  /\[(?:official\s*)?(?:music\s*)?video[^\]]*\]/giu,
  /\[(?:official\s*)?audio[^\]]*\]/giu,
  /\[(?:한글\s*)?가사[^\]]*\]/giu,
  /\[(?:lyrics?|visuali[sz]er)[^\]]*\]/giu,
  /\((?:official\s*)?(?:music\s*)?video[^)]*\)/giu,
  /\((?:official\s*)?audio[^)]*\)/giu,
  /\((?:lyrics?|visuali[sz]er|가사)[^)]*\)/giu,
  /\((?:remaster(?:ed)?|\d{4}\s*remaster)[^)]*\)/giu,
];

export function normalizeText(value) {
  let text = String(value ?? '').normalize('NFKC').toLocaleLowerCase();
  for (const pattern of NOISE_PATTERNS) text = text.replace(pattern, ' ');
  return text
    .replace(/\b(?:official|audio|video|lyrics?|visuali[sz]er|mv)\b/giu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeArtist(value) {
  return normalizeText(
    String(value ?? '')
      .replace(/\s+-\s+topic\s*$/iu, '')
      .replace(/vevo\s*$/iu, '')
      .replace(/\bofficial\b\s*$/iu, ''),
  );
}

export function makeSongKey(artist, title) {
  const artistKey = normalizeArtist(artist);
  const titleKey = normalizeText(title);
  return artistKey && titleKey ? `${artistKey}:${titleKey}` : titleKey;
}

export function nextSequence(history) {
  return history.reduce((max, entry) => Math.max(max, Number(entry.playedSequence) || 0), 0) + 1;
}

function isWithinCooldown(entry, currentSequence, now, plays, days) {
  const sequenceDistance = Math.max(0, currentSequence - (Number(entry.playedSequence) || 0));
  const age = Math.max(0, now - (Number(entry.playedAt) || 0));
  return sequenceDistance <= plays && age < days * DAY_MS;
}

export function buildBlockState(history, policy = DEFAULT_POLICY, now = Date.now()) {
  const merged = { ...DEFAULT_POLICY, ...policy };
  const currentSequence = nextSequence(history);
  const videoIds = new Set();
  const songKeys = new Set();
  const artistKeys = new Set();
  const artistLastSequence = new Map();

  for (const entry of history) {
    if (
      entry.videoId &&
      isWithinCooldown(
        entry,
        currentSequence,
        now,
        merged.videoCooldownPlays,
        merged.videoCooldownDays,
      )
    ) {
      videoIds.add(entry.videoId);
    }
    if (
      entry.songKey &&
      isWithinCooldown(
        entry,
        currentSequence,
        now,
        merged.songCooldownPlays,
        merged.songCooldownDays,
      )
    ) {
      songKeys.add(entry.songKey);
    }
    if (
      entry.artistKey &&
      isWithinCooldown(
        entry,
        currentSequence,
        now,
        merged.artistCooldownPlays,
        merged.artistCooldownDays,
      )
    ) {
      artistKeys.add(entry.artistKey);
      artistLastSequence.set(
        entry.artistKey,
        Math.max(artistLastSequence.get(entry.artistKey) ?? 0, Number(entry.playedSequence) || 0),
      );
    }
  }

  return { videoIds, songKeys, artistKeys, artistLastSequence, currentSequence };
}

export function classifyCandidate(candidate, blockState) {
  const artistKey = normalizeArtist(candidate.artist);
  const titleKey = normalizeText(candidate.title);
  const songKey = makeSongKey(candidate.artist, candidate.title);
  if (!titleKey || !String(candidate.query ?? '').trim()) {
    return { allowed: false, hardBlocked: true, reason: 'invalid', artistKey, titleKey, songKey };
  }
  if (blockState.songKeys.has(songKey)) {
    return { allowed: false, hardBlocked: true, reason: 'song', artistKey, titleKey, songKey };
  }
  if (artistKey && blockState.artistKeys.has(artistKey)) {
    return { allowed: false, hardBlocked: false, reason: 'artist', artistKey, titleKey, songKey };
  }
  return { allowed: true, hardBlocked: false, reason: null, artistKey, titleKey, songKey };
}

export function orderCandidates(candidates, blockState, random = Math.random) {
  const hardAllowed = [];
  const softBlocked = [];

  candidates.forEach((candidate, rank) => {
    const classification = classifyCandidate(candidate, blockState);
    const item = { candidate, rank, ...classification };
    if (classification.hardBlocked) return;
    if (classification.allowed) hardAllowed.push(item);
    else softBlocked.push(item);
  });

  const weighted = weightedRandomOrder(hardAllowed, random);
  if (weighted.length) return { ordered: weighted, relaxedArtistCooldown: false };

  softBlocked.sort((a, b) => {
    const aLast = blockState.artistLastSequence.get(a.artistKey) ?? 0;
    const bLast = blockState.artistLastSequence.get(b.artistKey) ?? 0;
    return aLast - bLast || a.rank - b.rank;
  });
  return { ordered: softBlocked, relaxedArtistCooldown: softBlocked.length > 0 };
}

function weightedRandomOrder(items, random) {
  const pool = [...items];
  const ordered = [];
  while (pool.length) {
    const weights = pool.map((item) => Math.max(1, 5 - item.rank));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let point = random() * total;
    let selected = pool.length - 1;
    for (let index = 0; index < pool.length; index += 1) {
      point -= weights[index];
      if (point <= 0) {
        selected = index;
        break;
      }
    }
    ordered.push(pool.splice(selected, 1)[0]);
  }
  return ordered;
}

export function isSearchResultBlocked(result, item, blockState, options = {}) {
  if (blockState.videoIds.has(result.videoId)) return true;
  const resultTitleKey = normalizeText(result.title);
  const resultArtistKey = normalizeArtist(result.channelTitle);
  if (!options.relaxArtistCooldown) {
    if (resultArtistKey && blockState.artistKeys.has(resultArtistKey)) return true;
    for (const blockedArtist of blockState.artistKeys) {
      if (blockedArtist && resultTitleKey.includes(blockedArtist)) return true;
    }
  }
  if (blockState.songKeys.has(makeSongKey(item.candidate.artist, item.candidate.title))) return true;

  // Catch a prior upload of the same song even when the model formats the title differently.
  for (const songKey of blockState.songKeys) {
    const separator = songKey.indexOf(':');
    const historicArtist = separator >= 0 ? songKey.slice(0, separator) : '';
    const historicTitle = separator >= 0 ? songKey.slice(separator + 1) : songKey;
    const artistMatches =
      !historicArtist ||
      historicArtist === item.artistKey ||
      historicArtist === resultArtistKey ||
      resultTitleKey.includes(historicArtist);
    if (artistMatches && historicTitle && resultTitleKey.includes(historicTitle)) return true;
  }
  return false;
}

export function compactBlocklist(history, policy = DEFAULT_POLICY, now = Date.now()) {
  const blockState = buildBlockState(history, policy, now);
  const songs = [];
  const artists = [];
  const seenSongs = new Set();
  const seenArtists = new Set();

  for (const entry of [...history].sort((a, b) => b.playedSequence - a.playedSequence)) {
    if (entry.songKey && blockState.songKeys.has(entry.songKey) && !seenSongs.has(entry.songKey)) {
      seenSongs.add(entry.songKey);
      songs.push({ artist: entry.artist, title: entry.title });
    }
    if (entry.artistKey && blockState.artistKeys.has(entry.artistKey) && !seenArtists.has(entry.artistKey)) {
      seenArtists.add(entry.artistKey);
      artists.push(entry.artist);
    }
  }

  return {
    songs: songs.slice(0, 40),
    artists: artists.slice(0, 20),
    policy: { ...DEFAULT_POLICY, ...policy },
  };
}

export function createHistoryEntry(track, sequence, playedAt = Date.now()) {
  const artist = String(track.artist || track.channelTitle || '').trim();
  const title = String(track.trackTitle || track.title || '').trim();
  return {
    videoId: track.videoId,
    title,
    artist,
    titleKey: normalizeText(title),
    artistKey: normalizeArtist(artist),
    songKey: makeSongKey(artist, title),
    channelTitle: String(track.channelTitle || '').trim(),
    query: String(track.query || '').trim(),
    playedAt,
    playedSequence: sequence,
  };
}
