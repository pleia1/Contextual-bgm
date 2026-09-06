import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_POLICY,
  buildBlockState,
  compactBlocklist,
  createHistoryEntry,
  isSearchResultBlocked,
  nextSequence,
  orderCandidates,
} from './src/history.js';
import {
  isTrackDurationAllowed,
  isVideoAvailableInRegion,
  parseYouTubeDuration,
  preferEmbeddableDerivatives,
} from './src/youtube.js';
import { hasPlaybackProof, updatePlaybackEvidence } from './src/playback-evidence.js';
import {
  DEFAULT_CROSSFADE_SECONDS,
  normalizeCrossfadeSettings,
  playbackRemainingSeconds,
  shouldPrepareNextTrack,
} from './src/crossfade.js';

const HELPER_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HELPER_DIR, 'data');
const CONFIG_PATH = join(HELPER_DIR, 'config.local.json');
const HISTORY_PATH = join(DATA_DIR, 'history.json');
const PLAYER_PATH = join(HELPER_DIR, 'static', 'player.html');
const PLAYER_SCRIPT_PATH = join(HELPER_DIR, 'static', 'player.js');
const MAX_BODY_BYTES = 128 * 1024;
const PLAYER_STALE_MS = 90_000;

const defaultConfig = {
  port: 43127,
  authToken: randomBytes(24).toString('base64url'),
  youtubeApiKey: '',
  regionCode: 'KR',
  relevanceLanguage: 'ko',
  defaultVolume: 35,
  recordAfterSeconds: 10,
  playbackStartTimeoutSeconds: 15,
  policy: { ...DEFAULT_POLICY },
};

async function loadConfig() {
  let saved = {};
  if (existsSync(CONFIG_PATH)) {
    saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } else {
    await writeFile(CONFIG_PATH, `${JSON.stringify(defaultConfig, null, 2)}\n`, 'utf8');
    console.log(`Created ${CONFIG_PATH}`);
  }
  return {
    ...defaultConfig,
    ...saved,
    policy: { ...DEFAULT_POLICY, ...(saved.policy ?? {}) },
    youtubeApiKey: process.env.RISU_BGM_YOUTUBE_API_KEY || saved.youtubeApiKey || '',
  };
}

async function loadHistory() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    const parsed = JSON.parse(await readFile(HISTORY_PATH, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const verified = parsed.filter((entry) => entry?.playbackVerified === true);
    if (verified.length !== parsed.length) {
      console.warn(`Discarded ${parsed.length - verified.length} legacy playback history entr${parsed.length - verified.length === 1 ? 'y' : 'ies'} that had no progress proof.`);
      const temporary = `${HISTORY_PATH}.tmp`;
      await writeFile(temporary, `${JSON.stringify(verified, null, 2)}\n`, 'utf8');
      await rename(temporary, HISTORY_PATH);
    }
    return verified;
  } catch (error) {
    console.error('Could not read history; starting with an empty list:', error.message);
    return [];
  }
}

const config = await loadConfig();
let history = await loadHistory();
let playbackStartTimer = null;

const runtime = {
  phase: 'idle',
  currentTrack: null,
  historyRecorded: false,
  lastError: null,
  volume: clampNumber(config.defaultVolume, 0, 100, 35),
  playerLastSeenAt: 0,
  activePlayerId: '',
  playerState: 'unstarted',
  command: { revision: 0, action: 'none', payload: null },
  relaxedArtistCooldown: false,
  selectionCandidates: [],
  rejectedVideoIds: new Set(),
  searchCache: new Map(),
  fallbackAttempts: 0,
  selectionIgnoresCooldown: false,
  queue: [],
  playbackEvidence: null,
  playbackCurrentTime: 0,
  playbackDuration: 0,
  crossfadeEnabled: false,
  crossfadeSeconds: DEFAULT_CROSSFADE_SECONDS,
  crossfadeInProgress: false,
  nextTrack: null,
  nextSelectionCandidates: [],
  nextRejectedVideoIds: new Set(),
  nextSearchCache: new Map(),
  nextFallbackAttempts: 0,
  nextSelectionIgnoresCooldown: false,
  nextPreloadPlayerId: '',
};

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function isPlayerConnected() {
  return runtime.playerLastSeenAt > 0 && Date.now() - runtime.playerLastSeenAt < PLAYER_STALE_MS;
}

function isOccupied() {
  return runtime.queue.length > 0 || !['idle', 'error'].includes(runtime.phase);
}

function issueCommand(action, payload = null) {
  runtime.command = {
    revision: runtime.command.revision + 1,
    action,
    payload,
  };
}

function resetPlaybackEvidence() {
  runtime.playbackEvidence = null;
}

function resetPlaybackTelemetry() {
  runtime.playbackCurrentTime = 0;
  runtime.playbackDuration = 0;
}

function clearNextSelectionSession() {
  runtime.nextTrack = null;
  runtime.nextSelectionCandidates = [];
  runtime.nextRejectedVideoIds = new Set();
  runtime.nextSearchCache = new Map();
  runtime.nextFallbackAttempts = 0;
  runtime.nextSelectionIgnoresCooldown = false;
  runtime.nextPreloadPlayerId = '';
  runtime.crossfadeInProgress = false;
}

function clearPlaybackStartTimer() {
  if (playbackStartTimer) clearTimeout(playbackStartTimer);
  playbackStartTimer = null;
}

async function saveHistory() {
  const limited = history.slice(-config.policy.maxHistory);
  history = limited;
  const temporary = `${HISTORY_PATH}.tmp`;
  await writeFile(temporary, `${JSON.stringify(limited, null, 2)}\n`, 'utf8');
  await rename(temporary, HISTORY_PATH);
}

async function observePlaybackProgress(body) {
  if (runtime.historyRecorded || !runtime.currentTrack) return;
  const videoId = String(body.videoId || '');
  const currentTime = Number(body.currentTime);
  const playbackState = String(body.playbackState || body.event || '');
  if (videoId !== runtime.currentTrack.videoId || playbackState !== 'playing' || !Number.isFinite(currentTime)) return;

  const now = Date.now();
  runtime.playbackEvidence = updatePlaybackEvidence(runtime.playbackEvidence, {
    videoId,
    currentTime,
    muted: body.muted,
    volume: body.volume,
  }, now);
  const requiredSeconds = clampNumber(config.recordAfterSeconds, 1, 120, 10);
  if (!hasPlaybackProof(runtime.playbackEvidence, requiredSeconds, now)) return;

  const entry = {
    ...createHistoryEntry(runtime.currentTrack, nextSequence(history)),
    playbackVerified: true,
  };
  history.push(entry);
  runtime.historyRecorded = true;
  try {
    await saveHistory();
    console.log(`Recorded verified BGM history: ${entry.artist} — ${entry.title}`);
  } catch (error) {
    history = history.filter((item) => item !== entry);
    runtime.historyRecorded = false;
    console.error('Could not save history:', error.message);
  }
}

function publicStatus() {
  reconcilePlayerLiveness();
  const remainingSeconds = playbackRemainingSeconds(
    runtime.playbackCurrentTime,
    runtime.playbackDuration || runtime.currentTrack?.durationSeconds,
  );
  return {
    ok: true,
    phase: runtime.phase,
    occupied: isOccupied(),
    currentTrack: runtime.currentTrack,
    historyRecorded: runtime.historyRecorded,
    historySize: history.length,
    playerConnected: isPlayerConnected(),
    playerState: runtime.playerState,
    volume: runtime.volume,
    relaxedArtistCooldown: runtime.relaxedArtistCooldown,
    lastError: runtime.lastError,
    youtubeConfigured: Boolean(config.youtubeApiKey),
    commandRevision: runtime.command.revision,
    fallbackAttempts: runtime.fallbackAttempts,
    queueLength: runtime.queue.length,
    queue: runtime.queue.map((entry) => entry.track),
    nextTrack: runtime.nextTrack,
    crossfadeEnabled: runtime.crossfadeEnabled,
    crossfadeSeconds: runtime.crossfadeSeconds,
    crossfadeInProgress: runtime.crossfadeInProgress,
    playbackCurrentTime: runtime.playbackCurrentTime,
    playbackDuration: runtime.playbackDuration,
    remainingSeconds,
    needsNextTrack: shouldPrepareNextTrack({
      enabled: runtime.crossfadeEnabled,
      phase: runtime.phase,
      currentTrack: runtime.currentTrack,
      nextTrack: runtime.nextTrack,
      currentTime: runtime.playbackCurrentTime,
      duration: runtime.playbackDuration || runtime.currentTrack?.durationSeconds,
      crossfadeSeconds: runtime.crossfadeSeconds,
    }),
  };
}

function clearSelectionSession() {
  runtime.selectionCandidates = [];
  runtime.rejectedVideoIds = new Set();
  runtime.searchCache = new Map();
  runtime.fallbackAttempts = 0;
  runtime.selectionIgnoresCooldown = false;
}

function reconcilePlayerLiveness() {
  const playerOwnedPhases = new Set(['loading', 'playing', 'crossfading', 'paused', 'buffering', 'cued', 'cued_stalled', 'awaiting_user']);
  if (
    runtime.playerLastSeenAt > 0 &&
    Date.now() - runtime.playerLastSeenAt >= PLAYER_STALE_MS &&
    playerOwnedPhases.has(runtime.phase)
  ) {
    resetPlaybackEvidence();
    resetPlaybackTelemetry();
    clearPlaybackStartTimer();
    runtime.phase = 'idle';
    runtime.playerState = 'disconnected';
    runtime.currentTrack = null;
    runtime.historyRecorded = false;
    runtime.relaxedArtistCooldown = false;
    clearNextSelectionSession();
    issueCommand('stop');
  }
}

function secureTokenMatches(value) {
  const expected = Buffer.from(String(config.authToken));
  const supplied = Buffer.from(String(value ?? ''));
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function requestToken(request, url) {
  const header = request.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return url.searchParams.get('token') || '';
}

function setCors(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  response.setHeader('Cache-Control', 'no-store');
}

function sendJson(response, status, body) {
  setCors(response);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function sendText(response, status, body, contentType = 'text/plain; charset=utf-8') {
  setCors(response);
  response.writeHead(status, { 'Content-Type': contentType });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

function cleanCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const artist = String(candidate.artist ?? '').trim().slice(0, 120);
  const title = String(candidate.title ?? '').trim().slice(0, 180);
  const query = String(candidate.query ?? '').trim().slice(0, 220);
  if (!title || !query) return null;
  return { artist, title, query };
}

function buildCandidateSearchQueries(candidate) {
  const identity = `${candidate.artist} ${candidate.title}`.trim();
  return [...new Set([candidate.query, identity ? `${identity} lyrics` : ''].filter(Boolean))];
}

async function searchYouTube(query) {
  if (!config.youtubeApiKey) {
    throw Object.assign(new Error('YouTube API key is not configured'), { status: 503 });
  }
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.search = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    maxResults: '20',
    safeSearch: 'moderate',
    key: config.youtubeApiKey,
    ...(config.regionCode ? { regionCode: String(config.regionCode) } : {}),
    ...(config.relevanceLanguage ? { relevanceLanguage: String(config.relevanceLanguage) } : {}),
  }).toString();

  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || `YouTube search failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: 502 });
  }
  const searchResults = (body.items ?? [])
    .map((item) => ({
      videoId: String(item?.id?.videoId ?? ''),
      title: String(item?.snippet?.title ?? ''),
      channelTitle: String(item?.snippet?.channelTitle ?? ''),
      description: String(item?.snippet?.description ?? ''),
      liveBroadcastContent: String(item?.snippet?.liveBroadcastContent ?? 'none'),
      thumbnailUrl:
        item?.snippet?.thumbnails?.medium?.url || item?.snippet?.thumbnails?.default?.url || '',
    }))
    .filter((item) => /^[\w-]{11}$/.test(item.videoId));

  if (!searchResults.length) return [];
  const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailsUrl.search = new URLSearchParams({
    part: 'snippet,status,contentDetails,liveStreamingDetails',
    id: searchResults.map((item) => item.videoId).join(','),
    key: config.youtubeApiKey,
  }).toString();
  const detailsResponse = await fetch(detailsUrl, { signal: AbortSignal.timeout(15_000) });
  const detailsBody = await detailsResponse.json().catch(() => ({}));
  if (!detailsResponse.ok) {
    const message = detailsBody?.error?.message || `YouTube video check failed with HTTP ${detailsResponse.status}`;
    throw Object.assign(new Error(message), { status: 502 });
  }
  const playableDetails = new Map(
    (detailsBody.items ?? [])
      .filter(
        (item) =>
          isVideoAvailableInRegion(item, config.regionCode) && isTrackDurationAllowed(item),
      )
      .map((item) => [String(item.id), item]),
  );
  const playableResults = searchResults
    .filter((item) => playableDetails.has(item.videoId))
    .map((item) => {
      const details = playableDetails.get(item.videoId);
      return {
        ...item,
        title: String(details?.snippet?.title || item.title),
        channelTitle: String(details?.snippet?.channelTitle || item.channelTitle),
        description: String(details?.snippet?.description || item.description),
        tags: Array.isArray(details?.snippet?.tags) ? details.snippet.tags : [],
        liveBroadcastContent: String(
          details?.snippet?.liveBroadcastContent || item.liveBroadcastContent || 'none',
        ),
        liveStreamingDetails: details?.liveStreamingDetails || null,
        durationSeconds: parseYouTubeDuration(details?.contentDetails?.duration),
      };
    });
  const rankedResults = preferEmbeddableDerivatives(playableResults);
  console.log(
    `YouTube search "${query}": ${searchResults.length} result(s), ${playableResults.length} playable at or under 8 minutes, ${rankedResults.length} after Shorts filtering.`,
  );
  return rankedResults;
}

async function chooseTrack(candidates, options = {}) {
  const excludedVideoIds = options.excludedVideoIds ?? new Set();
  const searchCache = options.searchCache ?? new Map();
  const blockState = buildBlockState(options.ignoreCooldown ? [] : history, config.policy);
  const { ordered, relaxedArtistCooldown } = orderCandidates(candidates, blockState);
  if (!ordered.length) {
    throw Object.assign(new Error('Every proposed track is still inside its song cooldown'), { status: 409 });
  }

  for (const item of ordered) {
    for (const searchQuery of buildCandidateSearchQueries(item.candidate)) {
      let results = searchCache.get(searchQuery);
      if (!results) {
        results = await searchYouTube(searchQuery);
        searchCache.set(searchQuery, results);
      }
      const result = results.find(
        (entry) =>
          !excludedVideoIds.has(entry.videoId) &&
          !isSearchResultBlocked(entry, item, blockState, {
            relaxArtistCooldown: relaxedArtistCooldown,
          }),
      );
      if (!result) continue;
      return {
        track: {
          ...result,
          artist: item.candidate.artist || result.channelTitle,
          trackTitle: item.candidate.title || result.title,
          query: searchQuery,
          requestedQuery: item.candidate.query,
        },
        relaxedArtistCooldown,
      };
    }
  }
  throw Object.assign(new Error('No playable YouTube result survived the cooldown filters'), { status: 404 });
}

function schedulePlaybackStartWatch(videoId) {
  clearPlaybackStartTimer();
  const delay = clampNumber(config.playbackStartTimeoutSeconds, 5, 60, 15) * 1_000;
  playbackStartTimer = setTimeout(async () => {
    playbackStartTimer = null;
    if (runtime.currentTrack?.videoId !== videoId || runtime.phase === 'playing') return;
    if (runtime.phase === 'awaiting_user') return;
    console.warn(`Playback did not start within ${delay / 1_000}s for ${videoId}; trying a fallback.`);
    runtime.playerState = 'start_timeout';
    if (await tryPlayerFallback('재생 시작 시간 초과', videoId)) return;
    if (playNextQueuedTrack()) return;
    runtime.phase = 'error';
    runtime.currentTrack = null;
    runtime.historyRecorded = false;
    runtime.lastError = '재생 시작 신호가 오지 않았고 더 이상 시도할 YouTube 후보가 없습니다.';
  }, delay);
}

function applyTrackChoice(choice, fallbackMessage = null) {
  clearPlaybackStartTimer();
  resetPlaybackEvidence();
  resetPlaybackTelemetry();
  clearNextSelectionSession();
  runtime.currentTrack = choice.track;
  runtime.historyRecorded = false;
  runtime.relaxedArtistCooldown = choice.relaxedArtistCooldown;
  runtime.lastError = fallbackMessage;
  runtime.phase = isPlayerConnected() ? 'loading' : 'awaiting_player';
  issueCommand('play', { track: choice.track, volume: runtime.volume });
  if (runtime.phase === 'loading') schedulePlaybackStartWatch(choice.track.videoId);
}

function applyNextTrackChoice(choice) {
  runtime.nextTrack = choice.track;
  runtime.lastError = null;
  issueCommand('preload', {
    track: choice.track,
    volume: runtime.volume,
    crossfadeSeconds: runtime.crossfadeSeconds,
  });
  runtime.nextPreloadPlayerId = runtime.activePlayerId;
  console.log(`Preloading crossfade track: ${choice.track.artist} — ${choice.track.trackTitle}`);
}

function ensureNextTrackPreloadForActivePlayer() {
  if (!runtime.nextTrack || !runtime.activePlayerId) return;
  if (runtime.nextPreloadPlayerId === runtime.activePlayerId) return;
  issueCommand('preload', {
    track: runtime.nextTrack,
    volume: runtime.volume,
    crossfadeSeconds: runtime.crossfadeSeconds,
  });
  runtime.nextPreloadPlayerId = runtime.activePlayerId;
}

function stageQueuedTrackForCrossfade() {
  const entry = runtime.queue.shift();
  if (!entry) return false;
  runtime.nextSelectionCandidates = [entry.candidate];
  runtime.nextRejectedVideoIds = new Set();
  runtime.nextSearchCache = entry.searchCache;
  runtime.nextFallbackAttempts = 0;
  runtime.nextSelectionIgnoresCooldown = true;
  applyNextTrackChoice({
    track: entry.track,
    relaxedArtistCooldown: entry.relaxedArtistCooldown,
  });
  return true;
}

function promoteNextTrack({ issuePlaybackCommand }) {
  if (!runtime.nextTrack) return false;
  const nextTrack = runtime.nextTrack;
  const nextCandidates = runtime.nextSelectionCandidates;
  const nextRejectedVideoIds = runtime.nextRejectedVideoIds;
  const nextSearchCache = runtime.nextSearchCache;
  const nextFallbackAttempts = runtime.nextFallbackAttempts;
  const nextIgnoresCooldown = runtime.nextSelectionIgnoresCooldown;

  clearPlaybackStartTimer();
  resetPlaybackEvidence();
  resetPlaybackTelemetry();
  runtime.currentTrack = nextTrack;
  runtime.historyRecorded = false;
  runtime.relaxedArtistCooldown = false;
  runtime.lastError = null;
  runtime.selectionCandidates = nextCandidates;
  runtime.rejectedVideoIds = nextRejectedVideoIds;
  runtime.searchCache = nextSearchCache;
  runtime.fallbackAttempts = nextFallbackAttempts;
  runtime.selectionIgnoresCooldown = nextIgnoresCooldown;
  clearNextSelectionSession();

  if (issuePlaybackCommand) {
    runtime.phase = isPlayerConnected() ? 'loading' : 'awaiting_player';
    issueCommand('play', { track: nextTrack, volume: runtime.volume });
    if (runtime.phase === 'loading') schedulePlaybackStartWatch(nextTrack.videoId);
  } else {
    runtime.phase = 'playing';
    runtime.playerState = 'playing';
  }
  return true;
}

function makeManualCandidate(query) {
  const separator = query.match(/^(.+?)\s[-–—]\s(.+)$/);
  return {
    artist: separator ? separator[1].trim() : '',
    title: separator ? separator[2].trim() : query,
    query,
  };
}

async function createQueueEntry(query) {
  const candidate = makeManualCandidate(query);
  const searchCache = new Map();
  const excludedVideoIds = new Set([
    runtime.currentTrack?.videoId,
    ...runtime.queue.map((entry) => entry.track.videoId),
  ].filter(Boolean));
  const choice = await chooseTrack([candidate], {
    excludedVideoIds,
    searchCache,
    ignoreCooldown: true,
  });
  return {
    candidate,
    track: choice.track,
    relaxedArtistCooldown: choice.relaxedArtistCooldown,
    searchCache,
  };
}

function startQueueEntry(entry) {
  clearSelectionSession();
  runtime.selectionCandidates = [entry.candidate];
  runtime.searchCache = entry.searchCache;
  runtime.selectionIgnoresCooldown = true;
  applyTrackChoice({
    track: entry.track,
    relaxedArtistCooldown: entry.relaxedArtistCooldown,
  });
}

function playNextQueuedTrack() {
  const entry = runtime.queue.shift();
  if (!entry) return false;
  startQueueEntry(entry);
  return true;
}

async function tryPlayerFallback(reason, failedVideoId) {
  if (!runtime.selectionCandidates.length || runtime.fallbackAttempts >= 12) return false;
  if (failedVideoId) runtime.rejectedVideoIds.add(failedVideoId);
  runtime.fallbackAttempts += 1;
  runtime.phase = 'searching';
  runtime.currentTrack = null;
  runtime.historyRecorded = false;
  try {
    const choice = await chooseTrack(runtime.selectionCandidates, {
      excludedVideoIds: runtime.rejectedVideoIds,
      searchCache: runtime.searchCache,
      ignoreCooldown: runtime.selectionIgnoresCooldown,
    });
    const message = `${reason}: 현재 영상을 건너뛰고 다른 YouTube 업로드를 재생합니다.`;
    console.warn(`${message} Next video: ${choice.track.videoId}`);
    applyTrackChoice(choice, message);
    return true;
  } catch (error) {
    console.warn(`No YouTube fallback remained after ${reason}: ${error.message}`);
    return false;
  }
}

async function tryNextTrackFallback(reason, failedVideoId) {
  if (!runtime.nextSelectionCandidates.length || runtime.nextFallbackAttempts >= 12) return false;
  if (failedVideoId) runtime.nextRejectedVideoIds.add(failedVideoId);
  runtime.nextFallbackAttempts += 1;
  runtime.nextTrack = null;
  try {
    const choice = await chooseTrack(runtime.nextSelectionCandidates, {
      excludedVideoIds: runtime.nextRejectedVideoIds,
      searchCache: runtime.nextSearchCache,
      ignoreCooldown: runtime.nextSelectionIgnoresCooldown,
    });
    console.warn(`${reason}: preloading another YouTube upload (${choice.track.videoId}).`);
    applyNextTrackChoice(choice);
    return true;
  } catch (error) {
    console.warn(`No crossfade fallback remained after ${reason}: ${error.message}`);
    clearNextSelectionSession();
    runtime.lastError = `다음 곡 프리로드 실패: ${error.message}`;
    return false;
  }
}

function updatePlaybackTelemetry(body) {
  const currentTime = Number(body.currentTime);
  const duration = Number(body.duration);
  if (Number.isFinite(currentTime)) runtime.playbackCurrentTime = Math.max(0, currentTime);
  if (Number.isFinite(duration) && duration > 0) runtime.playbackDuration = duration;
}

function maybeStageQueuedTrack() {
  if (!runtime.queue.length) return false;
  const shouldPrepare = shouldPrepareNextTrack({
    enabled: runtime.crossfadeEnabled,
    phase: runtime.phase,
    currentTrack: runtime.currentTrack,
    nextTrack: runtime.nextTrack,
    currentTime: runtime.playbackCurrentTime,
    duration: runtime.playbackDuration || runtime.currentTrack?.durationSeconds,
    crossfadeSeconds: runtime.crossfadeSeconds,
  });
  return shouldPrepare ? stageQueuedTrackForCrossfade() : false;
}

async function handlePlayerEvent(body) {
  const event = String(body.event ?? 'heartbeat');
  const videoId = String(body.videoId ?? '');
  const playerId = String(body.playerId ?? '');

  if (event === 'ready' && playerId) {
    runtime.activePlayerId = playerId;
  }
  if (!playerId || playerId !== runtime.activePlayerId) return;
  runtime.playerLastSeenAt = Date.now();

  if (event !== 'heartbeat') {
    console.log(`Player event: ${event}${videoId ? ` (${videoId})` : ''}`);
  }
  if (event === 'ready') {
    if (runtime.currentTrack) {
      resetPlaybackEvidence();
      resetPlaybackTelemetry();
      runtime.phase = 'loading';
      runtime.nextPreloadPlayerId = '';
      issueCommand('play', { track: runtime.currentTrack, volume: runtime.volume });
      schedulePlaybackStartWatch(runtime.currentTrack.videoId);
    }
    return;
  }

  if (event === 'preloadError') {
    if (runtime.nextTrack && videoId === runtime.nextTrack.videoId) {
      await tryNextTrackFallback(`다음 곡 YouTube 오류 ${Number(body.errorCode) || ''}`.trim(), videoId);
    }
    return;
  }
  if (event === 'preloaded') {
    if (runtime.nextTrack && videoId === runtime.nextTrack.videoId) {
      console.log(`Crossfade track is ready: ${videoId}`);
    }
    return;
  }
  if (event === 'crossfadeStarted') {
    if (runtime.nextTrack && videoId === runtime.nextTrack.videoId) {
      runtime.crossfadeInProgress = true;
      runtime.phase = 'crossfading';
    }
    return;
  }
  if (event === 'crossfadeComplete') {
    if (runtime.nextTrack && videoId === runtime.nextTrack.videoId) {
      promoteNextTrack({ issuePlaybackCommand: false });
      updatePlaybackTelemetry(body);
      await observePlaybackProgress({ ...body, playbackState: 'playing' });
    }
    return;
  }
  if (runtime.currentTrack && videoId && runtime.currentTrack.videoId !== videoId) return;

  if (event === 'heartbeat') {
    const playbackState = String(body.playbackState || '');
    if (runtime.currentTrack && playbackState === 'playing') {
      updatePlaybackTelemetry(body);
      clearPlaybackStartTimer();
      runtime.playerState = 'playing';
      runtime.phase = runtime.crossfadeInProgress ? 'crossfading' : 'playing';
      runtime.lastError = null;
      await observePlaybackProgress(body);
      ensureNextTrackPreloadForActivePlayer();
      maybeStageQueuedTrack();
    }
    return;
  }

  runtime.playerState = event;
  switch (event) {
    case 'playing':
      updatePlaybackTelemetry(body);
      clearPlaybackStartTimer();
      runtime.phase = runtime.crossfadeInProgress ? 'crossfading' : 'playing';
      runtime.lastError = null;
      await observePlaybackProgress({ ...body, playbackState: 'playing' });
      ensureNextTrackPreloadForActivePlayer();
      break;
    case 'paused':
      clearPlaybackStartTimer();
      runtime.phase = 'paused';
      resetPlaybackEvidence();
      break;
    case 'buffering':
      runtime.phase = 'buffering';
      break;
    case 'cued':
    case 'unstarted':
      runtime.phase = 'cued';
      resetPlaybackEvidence();
      break;
    case 'cuedStalled':
      runtime.phase = 'cued_stalled';
      resetPlaybackEvidence();
      break;
    case 'autoplayBlocked':
      clearPlaybackStartTimer();
      runtime.phase = 'awaiting_user';
      resetPlaybackEvidence();
      break;
    case 'ended':
    case 'stopped':
      resetPlaybackEvidence();
      resetPlaybackTelemetry();
      clearPlaybackStartTimer();
      runtime.phase = 'idle';
      runtime.currentTrack = null;
      runtime.historyRecorded = false;
      runtime.relaxedArtistCooldown = false;
      clearSelectionSession();
      if (event === 'ended' && promoteNextTrack({ issuePlaybackCommand: true })) break;
      clearNextSelectionSession();
      if (event === 'ended' && playNextQueuedTrack()) break;
      break;
    case 'error':
      resetPlaybackEvidence();
      clearPlaybackStartTimer();
      const errorCode = Number(body.errorCode);
      if (
        [5, 100, 101, 150].includes(errorCode) &&
        (await tryPlayerFallback(`YouTube 오류 ${errorCode}`, videoId))
      ) {
        break;
      }
      if (playNextQueuedTrack()) break;
      runtime.lastError = String(body.message ?? `YouTube player error ${errorCode || ''}`).trim();
      runtime.phase = 'error';
      runtime.currentTrack = null;
      runtime.historyRecorded = false;
      break;
    default:
      break;
  }
}

const playerHtml = await readFile(PLAYER_PATH, 'utf8');
const playerScript = await readFile(PLAYER_SCRIPT_PATH, 'utf8');

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (request.method === 'OPTIONS') {
      setCors(response);
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === '/' && request.method === 'GET') {
      sendText(response, 200, 'Risu Contextual BGM helper is running. Open the authenticated /player URL printed in the terminal.');
      return;
    }

    if (url.pathname === '/player.js' && request.method === 'GET') {
      sendText(response, 200, playerScript, 'text/javascript; charset=utf-8');
      return;
    }

    if (!secureTokenMatches(requestToken(request, url))) {
      sendJson(response, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    if (url.pathname === '/player' && request.method === 'GET') {
      sendText(response, 200, playerHtml, 'text/html; charset=utf-8');
      return;
    }

    if (url.pathname === '/v1/status' && request.method === 'GET') {
      sendJson(response, 200, publicStatus());
      return;
    }

    if (url.pathname === '/v1/history/blocklist' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, ...compactBlocklist(history, config.policy) });
      return;
    }

    if (url.pathname === '/v1/history' && request.method === 'GET') {
      const limit = clampNumber(url.searchParams.get('limit') || 100, 1, 500, 100);
      sendJson(response, 200, {
        ok: true,
        historySize: history.length,
        history: history.slice(-limit).reverse(),
      });
      return;
    }

    if (url.pathname === '/v1/history' && request.method === 'DELETE') {
      const body = await readJson(request);
      if (body.confirm !== true && url.searchParams.get('confirm') !== 'true') {
        sendJson(response, 400, { ok: false, error: 'Set confirm=true to clear history' });
        return;
      }
      history = [];
      await saveHistory();
      sendJson(response, 200, { ok: true, historySize: 0 });
      return;
    }

    if (url.pathname === '/v1/queue' && request.method === 'POST') {
      if (runtime.queue.length >= 20) {
        sendJson(response, 409, { ok: false, error: 'The queue can contain at most 20 tracks' });
        return;
      }
      const body = await readJson(request);
      const query = String(body.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
      if (!query) {
        sendJson(response, 400, { ok: false, error: 'Enter an artist and song title' });
        return;
      }
      try {
        const entry = await createQueueEntry(query);
        runtime.queue.push(entry);
        console.log(`Queued track: ${entry.track.artist} — ${entry.track.trackTitle}`);
        if (!runtime.currentTrack && ['idle', 'error'].includes(runtime.phase)) playNextQueuedTrack();
        sendJson(response, 200, publicStatus());
      } catch (error) {
        sendJson(response, error.status || 500, { ok: false, error: error.message, ...publicStatus() });
      }
      return;
    }

    if (url.pathname === '/v1/queue' && request.method === 'DELETE') {
      runtime.queue = [];
      sendJson(response, 200, publicStatus());
      return;
    }

    if (url.pathname === '/v1/crossfade/settings' && request.method === 'POST') {
      const settings = normalizeCrossfadeSettings(await readJson(request));
      const hadNextTrack = Boolean(runtime.nextTrack);
      runtime.crossfadeEnabled = settings.enabled;
      runtime.crossfadeSeconds = settings.seconds;
      if (!settings.enabled) {
        clearNextSelectionSession();
        if (hadNextTrack) issueCommand('clearPreload');
      } else {
        maybeStageQueuedTrack();
      }
      sendJson(response, 200, publicStatus());
      return;
    }

    if (url.pathname === '/v1/preload-candidates' && request.method === 'POST') {
      if (!runtime.crossfadeEnabled) {
        sendJson(response, 409, { ok: false, error: 'Crossfade is disabled', ...publicStatus() });
        return;
      }
      if (!runtime.currentTrack || !['playing', 'crossfading'].includes(runtime.phase)) {
        sendJson(response, 409, { ok: false, error: 'No actively playing track to crossfade from', ...publicStatus() });
        return;
      }
      if (runtime.nextTrack) {
        sendJson(response, 409, { ok: false, error: 'A crossfade track is already prepared', ...publicStatus() });
        return;
      }
      const body = await readJson(request);
      const candidates = (Array.isArray(body.candidates) ? body.candidates : [])
        .slice(0, 8)
        .map(cleanCandidate)
        .filter(Boolean);
      if (!candidates.length) {
        sendJson(response, 400, { ok: false, error: 'No valid crossfade candidates were supplied' });
        return;
      }

      runtime.nextSelectionCandidates = candidates;
      runtime.nextRejectedVideoIds = new Set([runtime.currentTrack.videoId]);
      runtime.nextSearchCache = new Map();
      runtime.nextFallbackAttempts = 0;
      runtime.nextSelectionIgnoresCooldown = false;
      try {
        const choice = await chooseTrack(candidates, {
          excludedVideoIds: runtime.nextRejectedVideoIds,
          searchCache: runtime.nextSearchCache,
        });
        applyNextTrackChoice(choice);
        sendJson(response, 200, { ok: true, ...publicStatus() });
      } catch (error) {
        clearNextSelectionSession();
        runtime.lastError = error.message;
        sendJson(response, error.status || 500, { ok: false, error: error.message, ...publicStatus() });
      }
      return;
    }

    if (url.pathname === '/v1/play-candidates' && request.method === 'POST') {
      if (isOccupied()) {
        sendJson(response, 409, { ok: false, error: 'Player is already occupied', ...publicStatus() });
        return;
      }
      const body = await readJson(request);
      const candidates = (Array.isArray(body.candidates) ? body.candidates : [])
        .slice(0, 8)
        .map(cleanCandidate)
        .filter(Boolean);
      if (!candidates.length) {
        sendJson(response, 400, { ok: false, error: 'No valid candidates were supplied' });
        return;
      }

      runtime.phase = 'searching';
      runtime.lastError = null;
      runtime.selectionCandidates = candidates;
      runtime.rejectedVideoIds = new Set();
      runtime.searchCache = new Map();
      runtime.fallbackAttempts = 0;
      runtime.selectionIgnoresCooldown = false;
      try {
        const choice = await chooseTrack(candidates, {
          excludedVideoIds: runtime.rejectedVideoIds,
          searchCache: runtime.searchCache,
        });
        applyTrackChoice(choice);
        sendJson(response, 200, { ok: true, ...publicStatus() });
      } catch (error) {
        runtime.phase = 'error';
        runtime.lastError = error.message;
        sendJson(response, error.status || 500, { ok: false, error: error.message, ...publicStatus() });
      }
      return;
    }

    if (url.pathname === '/v1/control' && request.method === 'POST') {
      const body = await readJson(request);
      const action = String(body.action ?? '');
      if (action === 'stop') {
        resetPlaybackEvidence();
        resetPlaybackTelemetry();
        clearPlaybackStartTimer();
        issueCommand('stop');
        runtime.phase = 'idle';
        runtime.currentTrack = null;
        runtime.historyRecorded = false;
        clearSelectionSession();
        clearNextSelectionSession();
      } else if (action === 'skip' && runtime.currentTrack) {
        resetPlaybackEvidence();
        clearPlaybackStartTimer();
        const skipped = await tryPlayerFallback('사용자 건너뛰기', runtime.currentTrack.videoId);
        if (!skipped) {
          if (!playNextQueuedTrack()) {
            runtime.phase = 'error';
            runtime.currentTrack = null;
            runtime.historyRecorded = false;
            runtime.lastError = '더 이상 시도할 YouTube 후보가 없습니다.';
          }
        }
      } else if (action === 'pause' && runtime.currentTrack) {
        issueCommand('pause');
      } else if (action === 'play' && runtime.currentTrack) {
        issueCommand('resume');
      } else if (action === 'play' && runtime.queue.length) {
        playNextQueuedTrack();
      } else if (action === 'volume') {
        runtime.volume = clampNumber(body.volume, 0, 100, runtime.volume);
        issueCommand('volume', { volume: runtime.volume });
      } else {
        sendJson(response, 400, { ok: false, error: 'Unsupported control action' });
        return;
      }
      sendJson(response, 200, publicStatus());
      return;
    }

    if (url.pathname === '/v1/player-command' && request.method === 'GET') {
      const playerId = String(url.searchParams.get('playerId') || '');
      if (playerId && (!runtime.activePlayerId || !isPlayerConnected())) {
        runtime.activePlayerId = playerId;
      }
      const playerActive = Boolean(playerId) && playerId === runtime.activePlayerId;
      if (playerActive) runtime.playerLastSeenAt = Date.now();
      const since = Number(url.searchParams.get('since') || 0);
      sendJson(response, 200, {
        ok: true,
        playerActive,
        command: playerActive && runtime.command.revision > since ? runtime.command : null,
        status: publicStatus(),
      });
      return;
    }

    if (url.pathname === '/v1/player-event' && request.method === 'POST') {
      await handlePlayerEvent(await readJson(request));
      sendJson(response, 200, publicStatus());
      return;
    }

    sendJson(response, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    console.error(error);
    sendJson(response, error.status || 500, { ok: false, error: error.message || 'Internal error' });
  }
});

server.listen(config.port, '127.0.0.1', () => {
  const playerUrl = `http://127.0.0.1:${config.port}/player?token=${encodeURIComponent(config.authToken)}`;
  console.log('Risu Contextual YouTube BGM helper v0.4.1 is running.');
  console.log(`Player: ${playerUrl}`);
  console.log(`Plugin helper URL: http://127.0.0.1:${config.port}`);
  console.log(`Plugin helper token: ${config.authToken}`);
  if (!config.youtubeApiKey) {
    console.warn(`YouTube API key is empty. Set RISU_BGM_YOUTUBE_API_KEY or edit ${CONFIG_PATH}`);
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Stop the existing helper or change port in config.local.json.`);
  } else {
    console.error('Helper server error:', error);
  }
});

function shutdown() {
  resetPlaybackEvidence();
  clearPlaybackStartTimer();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
