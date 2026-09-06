export const MAX_TRACK_SECONDS = 8 * 60;

function metadataText(result) {
  const tags = Array.isArray(result?.tags) ? result.tags.join(' ') : '';
  return [result?.title, result?.channelTitle, result?.description, tags]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
}

export function isLikelyShort(result) {
  const title = String(result?.title || '').toLowerCase();
  const description = String(result?.description || '').toLowerCase();
  const tags = Array.isArray(result?.tags)
    ? result.tags.map((tag) => String(tag || '').trim().toLowerCase())
    : [];
  return (
    /(?:^|\s)#(?:shorts?|ytshorts|youtubeshorts)\b/.test(`${title} ${description}`) ||
    /\b(?:youtube|yt)\s+shorts?\b/.test(`${title} ${description}`) ||
    tags.some((tag) => /^(?:#?shorts?|ytshorts|youtubeshorts)$/.test(tag))
  );
}

export function isLiveVideo(result) {
  const broadcastState = String(result?.liveBroadcastContent || '').toLowerCase();
  return (
    broadcastState === 'live' ||
    broadcastState === 'upcoming' ||
    Boolean(result?.liveStreamingDetails)
  );
}

export function embeddingPreferenceScore(result) {
  const title = String(result?.title || '').toLowerCase();
  const channel = String(result?.channelTitle || '').toLowerCase();
  const combined = metadataText(result);
  const titleAndChannel = `${title} ${channel}`;
  let score = 0;
  if (/\b(?:lyrics?|lyric video|audio only|full audio|full song)\b|가사/.test(combined)) score -= 55;
  if (/\b(?:official video|official audio|official music video|official visuali[sz]er)\b/.test(titleAndChannel)) score += 80;
  if (/\bofficial\b/.test(channel)) score += 45;
  if (/\bvevo\b/.test(channel) || channel.endsWith('vevo')) score += 90;
  if (/- topic\b/.test(channel)) score += 95;
  if (isLiveVideo(result)) score += 140;
  if (/\b(?:live at|live from|live performance|live session|studio session|in concert|concert footage|festival performance)\b|[([]\s*live\s*[)\]]|라이브|공연/.test(title)) {
    score += 90;
  }
  if (/\b(?:cover|karaoke|reaction|review|commentary|tutorial|remix|mashup|nightcore|sped[ -]?up|slowed|reverb|edit|fancam|fan cam|fanmade video|fan-made video|amv|vlog|gameplay|dance practice|8d audio|bass boosted)\b/.test(title)) {
    score += 120;
  }
  return score;
}

export function preferEmbeddableDerivatives(results) {
  return results
    .filter((result) => !isLikelyShort(result))
    .map((result, index) => ({ result, index, score: embeddingPreferenceScore(result) }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.result);
}

export function parseYouTubeDuration(value) {
  const match = String(value || '').match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!match) return null;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  const total = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  return Number.isFinite(total) && total > 0 ? total : null;
}

export function isTrackDurationAllowed(video, maxSeconds = MAX_TRACK_SECONDS) {
  const durationSeconds = parseYouTubeDuration(video?.contentDetails?.duration);
  return durationSeconds !== null && durationSeconds <= maxSeconds;
}

export function isVideoAvailableInRegion(video, regionCode = '') {
  if (!video || video.status?.embeddable !== true || video.status?.privacyStatus !== 'public') {
    return false;
  }

  const region = String(regionCode || '').trim().toUpperCase();
  if (!region) return true;
  const restriction = video.contentDetails?.regionRestriction;
  const allowed = Array.isArray(restriction?.allowed)
    ? restriction.allowed.map((value) => String(value).toUpperCase())
    : null;
  const blocked = Array.isArray(restriction?.blocked)
    ? restriction.blocked.map((value) => String(value).toUpperCase())
    : [];
  if (allowed && !allowed.includes(region)) return false;
  return !blocked.includes(region);
}
