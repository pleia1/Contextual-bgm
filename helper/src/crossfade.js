export const DEFAULT_CROSSFADE_SECONDS = 5;
export const MIN_CROSSFADE_SECONDS = 1;
export const MAX_CROSSFADE_SECONDS = 15;
export const DEFAULT_PREFETCH_LEAD_SECONDS = 45;

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeCrossfadeSettings(value = {}) {
  return {
    enabled: value.enabled === true,
    seconds: clampNumber(
      value.seconds,
      MIN_CROSSFADE_SECONDS,
      MAX_CROSSFADE_SECONDS,
      DEFAULT_CROSSFADE_SECONDS,
    ),
  };
}

export function playbackRemainingSeconds(currentTime, duration) {
  const current = Number(currentTime);
  const total = Number(duration);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, total - Math.max(0, current));
}

export function shouldPrepareNextTrack({
  enabled,
  phase,
  currentTrack,
  nextTrack,
  currentTime,
  duration,
  crossfadeSeconds = DEFAULT_CROSSFADE_SECONDS,
  prefetchLeadSeconds = DEFAULT_PREFETCH_LEAD_SECONDS,
}) {
  if (!enabled || !currentTrack || nextTrack) return false;
  if (!['playing', 'crossfading'].includes(String(phase))) return false;
  const remaining = playbackRemainingSeconds(currentTime, duration);
  if (remaining === null) return false;
  const lead = Math.max(Number(prefetchLeadSeconds) || 0, Number(crossfadeSeconds) + 20);
  return remaining <= lead;
}

export function crossfadeVolumes(elapsedMilliseconds, durationSeconds, targetVolume) {
  const durationMilliseconds = Math.max(1, Number(durationSeconds) * 1_000);
  const progress = Math.min(1, Math.max(0, Number(elapsedMilliseconds) / durationMilliseconds));
  const volume = clampNumber(targetVolume, 0, 100, 35);
  return {
    progress,
    outgoing: Math.round(volume * (1 - progress)),
    incoming: Math.round(volume * progress),
  };
}
