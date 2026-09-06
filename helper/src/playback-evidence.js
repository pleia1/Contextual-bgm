export function updatePlaybackEvidence(previous, sample, observedAt = Date.now()) {
  const videoId = String(sample?.videoId || '');
  const currentTime = Number(sample?.currentTime);
  if (!videoId || !Number.isFinite(currentTime)) return previous || null;
  const audible = sample?.muted === false && Number(sample?.volume) > 0;
  if (!previous || previous.videoId !== videoId || currentTime < previous.latestTime) {
    return {
      videoId,
      firstObservedAt: observedAt,
      firstTime: currentTime,
      latestTime: currentTime,
      audible,
    };
  }
  return {
    ...previous,
    latestTime: currentTime,
    audible: previous.audible || audible,
  };
}

export function hasPlaybackProof(evidence, requiredSeconds, observedAt = Date.now()) {
  if (!evidence?.audible) return false;
  const elapsedSeconds = (observedAt - evidence.firstObservedAt) / 1_000;
  const progressedSeconds = evidence.latestTime - evidence.firstTime;
  return elapsedSeconds >= requiredSeconds && progressedSeconds >= requiredSeconds - 0.75;
}
