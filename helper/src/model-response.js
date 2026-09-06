export function extractJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // Ignore malformed prose/examples and keep scanning.
        }
        start = -1;
      }
    }
  }
  return objects;
}

export function extractCandidatePayload(text) {
  const trimmed = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const direct = JSON.parse(trimmed);
    if (Array.isArray(direct?.candidates)) return direct;
  } catch {
    // Reasoning or prose may precede the payload.
  }
  return extractJsonObjects(trimmed)
    .reverse()
    .find((object) => object && Array.isArray(object.candidates)) || null;
}
