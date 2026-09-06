const token = new URLSearchParams(location.search).get('token') || '';
const playerId = globalThis.crypto?.randomUUID?.() || `player-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const stateNames = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };
const slots = {
  a: createSlot('a'),
  b: createSlot('b'),
};

let activeSlotName = 'a';
let standbySlotName = 'b';
let playersReady = false;
let commandRevision = 0;
let currentVideoId = '';
let currentStatus = {};
let cueRecoveryTimer = null;
let crossfadeTimer = null;
let lastTelemetryAt = 0;
let baseVolume = 35;
let pollInFlight = false;

const statusElement = document.querySelector('#status');
const trackElement = document.querySelector('#track');
const artistElement = document.querySelector('#artist');
const activationElement = document.querySelector('#activation');
const footerElement = document.querySelector('#footer');
const volumeElement = document.querySelector('#volume');
const youtubeLink = document.querySelector('#youtube-link');

function createSlot(name) {
  return {
    name,
    container: document.querySelector(`#slot-${name}`),
    elementId: `player-${name}`,
    player: null,
    ready: false,
    videoId: '',
    warming: false,
    preloaded: false,
    warmTimer: null,
  };
}

function activeSlot() {
  return slots[activeSlotName];
}

function standbySlot() {
  return slots[standbySlotName];
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function sendEvent(event, extra = {}) {
  const eventVideoId = extra.videoId ?? currentVideoId;
  return api('/v1/player-event', {
    method: 'POST',
    body: JSON.stringify({ event, playerId, ...extra, videoId: eventVideoId }),
  }).catch((error) => { footerElement.textContent = error.message; });
}

function clearCueRecovery() {
  if (cueRecoveryTimer) clearTimeout(cueRecoveryTimer);
  cueRecoveryTimer = null;
}

function clearWarmTimer(slot) {
  if (slot.warmTimer) clearTimeout(slot.warmTimer);
  slot.warmTimer = null;
}

function slotTelemetry(slot, playbackState = null) {
  if (!slot?.ready || !slot.player || !slot.videoId) return null;
  try {
    return {
      currentTime: Number(slot.player.getCurrentTime() || 0),
      duration: Number(slot.player.getDuration() || 0),
      playbackState: playbackState || stateNames[slot.player.getPlayerState()] || 'unknown',
      muted: Boolean(slot.player.isMuted()),
      volume: Number(slot.player.getVolume() || 0),
    };
  } catch {
    return null;
  }
}

function activeTelemetry() {
  return slotTelemetry(activeSlot());
}

function restoreSlotVisuals() {
  activeSlot().container.style.opacity = '1';
  activeSlot().container.classList.add('active');
  standbySlot().container.style.opacity = '0';
  standbySlot().container.classList.remove('active');
}

function cancelCrossfade({ restoreOutgoing = true } = {}) {
  const wasCrossfading = Boolean(crossfadeTimer);
  if (crossfadeTimer) clearInterval(crossfadeTimer);
  crossfadeTimer = null;
  if (wasCrossfading) {
    const incoming = standbySlot();
    try {
      incoming.player.pauseVideo();
      incoming.player.mute();
      incoming.player.setVolume(0);
      incoming.player.seekTo(0, true);
      incoming.preloaded = Boolean(incoming.videoId);
    } catch { /* The standby player may no longer be available. */ }
  }
  if (restoreOutgoing && activeSlot().ready) activeSlot().player.setVolume(baseVolume);
  restoreSlotVisuals();
}

function resetStandby({ stop = true } = {}) {
  const slot = standbySlot();
  clearWarmTimer(slot);
  slot.warming = false;
  slot.preloaded = false;
  if (stop && slot.ready) {
    try { slot.player.stopVideo(); } catch { /* Player may still be initializing. */ }
  }
  slot.videoId = '';
  slot.container.style.opacity = '0';
  slot.container.classList.remove('active');
}

function resetAllPlayers() {
  cancelCrossfade();
  clearCueRecovery();
  for (const slot of Object.values(slots)) {
    clearWarmTimer(slot);
    slot.warming = false;
    slot.preloaded = false;
    slot.videoId = '';
    if (slot.ready) {
      try { slot.player.stopVideo(); } catch { /* Player may still be initializing. */ }
    }
  }
  activeSlotName = 'a';
  standbySlotName = 'b';
  restoreSlotVisuals();
}

function recoverCuedPlayback() {
  clearCueRecovery();
  cueRecoveryTimer = setTimeout(() => {
    const slot = activeSlot();
    if (!slot.ready || slot.player.getPlayerState() !== 5) return;
    slot.player.unMute();
    slot.player.setVolume(baseVolume);
    slot.player.playVideo();
    cueRecoveryTimer = setTimeout(() => {
      if (slot.ready && slot.player.getPlayerState() === 5) {
        sendEvent('cuedStalled', slotTelemetry(slot) || {});
      }
    }, 1_500);
  }, 350);
}

function renderStatus(status) {
  currentStatus = status;
  statusElement.textContent = status.phase;
  baseVolume = Number(status.volume ?? 35);
  volumeElement.value = String(baseVolume);
  if (status.currentTrack) {
    trackElement.textContent = status.currentTrack.trackTitle || status.currentTrack.title;
    artistElement.textContent = status.currentTrack.artist || status.currentTrack.channelTitle;
    youtubeLink.href = `https://www.youtube.com/watch?v=${encodeURIComponent(status.currentTrack.videoId)}`;
  } else {
    trackElement.textContent = '선택된 곡 없음';
    artistElement.textContent = '';
    youtubeLink.href = 'https://www.youtube.com';
  }
  activationElement.classList.toggle('visible', ['awaiting_user', 'cued_stalled'].includes(status.phase));
  const historyNotice = `재생 이력 ${status.historySize}곡`;
  const nextNotice = status.nextTrack
    ? `다음 곡 준비됨: ${status.nextTrack.trackTitle || status.nextTrack.title}`
    : '';
  footerElement.textContent = status.lastError
    ? status.lastError
    : status.relaxedArtistCooldown
      ? `${historyNotice} · 후보 부족으로 아티스트 제한을 완화했습니다.`
      : [historyNotice, nextNotice, '이 페이지를 열어 둔 상태에서 RisuAI를 사용하세요.'].filter(Boolean).join(' · ');
}

function markStandbyPreloaded(slot) {
  if (!slot.warming) return;
  slot.warming = false;
  slot.preloaded = true;
  try {
    slot.player.pauseVideo();
    slot.player.seekTo(0, true);
    slot.player.setVolume(0);
  } catch { /* A preload error will be reported separately. */ }
  sendEvent('preloaded', { videoId: slot.videoId, ...slotTelemetry(slot, 'preloaded') });
}

function handlePlayerState(slot, event) {
  const name = stateNames[event.data];
  if (slot.name === standbySlotName) {
    if (slot.warming && event.data === 1) {
      clearWarmTimer(slot);
      slot.warmTimer = setTimeout(() => markStandbyPreloaded(slot), 450);
    }
    return;
  }
  if (slot.name !== activeSlotName || slot.videoId !== currentVideoId) return;
  if (crossfadeTimer && event.data === 0) return;
  if (event.data === 5) recoverCuedPlayback();
  else clearCueRecovery();
  if (name) sendEvent(name, { videoId: slot.videoId, ...(slotTelemetry(slot, name) || {}) });
}

function handlePlayerError(slot, event) {
  const errorCode = Number(event.data);
  if (slot.name === standbySlotName && slot.videoId) {
    clearWarmTimer(slot);
    slot.warming = false;
    slot.preloaded = false;
    sendEvent('preloadError', {
      videoId: slot.videoId,
      errorCode,
      message: `YouTube preload error ${errorCode}`,
    });
    return;
  }
  sendEvent('error', {
    videoId: slot.videoId || currentVideoId,
    errorCode,
    message: `YouTube player error ${errorCode}`,
  });
}

function handleAutoplayBlocked(slot) {
  if (slot.name === standbySlotName) {
    cancelCrossfade();
    slot.preloaded = false;
    sendEvent('preloadBlocked', { videoId: slot.videoId });
    return;
  }
  sendEvent('autoplayBlocked', { videoId: slot.videoId || currentVideoId });
}

window.onYouTubeIframeAPIReady = () => {
  for (const slot of Object.values(slots)) {
    slot.player = new YT.Player(slot.elementId, {
      width: '100%',
      height: '100%',
      playerVars: { playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => {
          slot.ready = true;
          if (!playersReady && Object.values(slots).every((entry) => entry.ready)) {
            playersReady = true;
            sendEvent('ready');
          }
        },
        onStateChange: (event) => handlePlayerState(slot, event),
        onError: (event) => handlePlayerError(slot, event),
        onAutoplayBlocked: () => handleAutoplayBlocked(slot),
      },
    });
  }
};

function prepareStandby(payload) {
  const slot = standbySlot();
  if (!slot.ready || !payload?.track?.videoId) return;
  resetStandby();
  slot.videoId = payload.track.videoId;
  slot.warming = true;
  slot.preloaded = false;
  try {
    slot.player.mute();
    slot.player.setVolume(0);
    slot.player.loadVideoById(slot.videoId);
  } catch (error) {
    slot.warming = false;
    sendEvent('preloadError', { videoId: slot.videoId, message: error.message });
  }
}

function finishCrossfade(incoming, outgoing) {
  if (crossfadeTimer) clearInterval(crossfadeTimer);
  crossfadeTimer = null;
  activeSlotName = incoming.name;
  standbySlotName = outgoing.name;
  incoming.preloaded = false;
  incoming.container.style.opacity = '1';
  incoming.container.classList.add('active');
  currentVideoId = incoming.videoId;
  try { outgoing.player.stopVideo(); } catch { /* The outgoing video may have ended naturally. */ }
  outgoing.videoId = '';
  outgoing.preloaded = false;
  outgoing.warming = false;
  outgoing.container.style.opacity = '0';
  outgoing.container.classList.remove('active');
  try { incoming.player.setVolume(baseVolume); } catch { /* Ignore a final cosmetic volume write failure. */ }
  sendEvent('crossfadeComplete', {
    videoId: currentVideoId,
    ...(slotTelemetry(incoming, 'playing') || {}),
  });
}

function startCrossfade() {
  const incoming = standbySlot();
  const outgoing = activeSlot();
  const seconds = Math.max(1, Number(currentStatus.crossfadeSeconds || 5));
  if (crossfadeTimer || !incoming.preloaded || !incoming.videoId || !outgoing.videoId) return;
  if (currentStatus.nextTrack?.videoId !== incoming.videoId) return;

  clearCueRecovery();
  incoming.preloaded = false;
  try {
    incoming.player.seekTo(0, true);
    incoming.player.setVolume(0);
    incoming.player.unMute();
    incoming.player.playVideo();
  } catch (error) {
    sendEvent('preloadError', { videoId: incoming.videoId, message: error.message });
    return;
  }
  sendEvent('crossfadeStarted', { videoId: incoming.videoId });
  const startedAt = performance.now();
  crossfadeTimer = setInterval(() => {
    const progress = Math.min(1, Math.max(0, (performance.now() - startedAt) / (seconds * 1_000)));
    try {
      outgoing.player.setVolume(Math.round(baseVolume * (1 - progress)));
      incoming.player.setVolume(Math.round(baseVolume * progress));
      outgoing.container.style.opacity = String(1 - progress);
      incoming.container.style.opacity = String(progress);
    } catch {
      cancelCrossfade();
      return;
    }
    if (progress >= 1) finishCrossfade(incoming, outgoing);
  }, 100);
}

function maybeStartCrossfade() {
  if (!currentStatus.crossfadeEnabled || !currentStatus.nextTrack || crossfadeTimer) return;
  const telemetry = activeTelemetry();
  if (!telemetry || telemetry.playbackState !== 'playing' || telemetry.duration <= 0) return;
  const remaining = telemetry.duration - telemetry.currentTime;
  if (remaining <= Number(currentStatus.crossfadeSeconds || 5)) startCrossfade();
}

async function executeCommand(command) {
  if (!command || !playersReady) return;
  commandRevision = command.revision;
  const payload = command.payload || {};
  switch (command.action) {
    case 'play': {
      resetAllPlayers();
      const slot = activeSlot();
      currentVideoId = payload.track.videoId;
      slot.videoId = currentVideoId;
      baseVolume = Number(payload.volume ?? 35);
      slot.player.setVolume(baseVolume);
      slot.player.unMute();
      slot.player.loadVideoById(currentVideoId);
      slot.player.playVideo();
      break;
    }
    case 'preload':
      prepareStandby(payload);
      break;
    case 'clearPreload':
      resetStandby();
      break;
    case 'resume':
      activeSlot().player.playVideo();
      break;
    case 'pause':
      cancelCrossfade();
      activeSlot().player.pauseVideo();
      break;
    case 'stop':
      resetAllPlayers();
      currentVideoId = '';
      sendEvent('stopped', { videoId: '' });
      break;
    case 'volume':
      baseVolume = Number(payload.volume ?? 35);
      if (!crossfadeTimer) activeSlot().player.setVolume(baseVolume);
      break;
    default:
      break;
  }
}

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const body = await api(`/v1/player-command?since=${commandRevision}&playerId=${encodeURIComponent(playerId)}`);
    renderStatus(body.status);
    if (!body.playerActive) {
      statusElement.textContent = '다른 플레이어가 활성 상태';
      footerElement.textContent = '가장 최근에 연 플레이어 탭에서 재생을 제어합니다.';
    }
    await executeCommand(body.command);
    maybeStartCrossfade();
    if (Date.now() - lastTelemetryAt >= 2_000) {
      const telemetry = activeTelemetry();
      if (telemetry) {
        lastTelemetryAt = Date.now();
        await sendEvent('heartbeat', { videoId: currentVideoId, ...telemetry });
      }
    }
  } catch (error) {
    statusElement.textContent = '연결 끊김';
    footerElement.textContent = error.message;
  } finally {
    pollInFlight = false;
  }
}

document.querySelector('#enable').addEventListener('click', () => {
  const slot = activeSlot();
  if (!slot.ready) return;
  slot.player.unMute();
  slot.player.setVolume(baseVolume);
  slot.player.playVideo();
  activationElement.classList.remove('visible');
});
document.querySelector('#play').addEventListener('click', () => api('/v1/control', { method: 'POST', body: JSON.stringify({ action: 'play' }) }));
document.querySelector('#pause').addEventListener('click', () => api('/v1/control', { method: 'POST', body: JSON.stringify({ action: 'pause' }) }));
document.querySelector('#stop').addEventListener('click', () => api('/v1/control', { method: 'POST', body: JSON.stringify({ action: 'stop' }) }));
document.querySelector('#skip').addEventListener('click', () => api('/v1/control', { method: 'POST', body: JSON.stringify({ action: 'skip' }) }));
volumeElement.addEventListener('change', () => api('/v1/control', { method: 'POST', body: JSON.stringify({ action: 'volume', volume: Number(volumeElement.value) }) }));

if (!token) {
  statusElement.textContent = '토큰 없음';
  footerElement.textContent = '터미널에 출력된 전체 Player URL로 다시 접속하세요.';
} else {
  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(script);
  setInterval(poll, 1_000);
  poll();
}
