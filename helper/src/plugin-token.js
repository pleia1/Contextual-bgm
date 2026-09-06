const TOKEN_MARKER = /^const BUNDLED_HELPER_TOKEN = ".*"; \/\/ @launcher-managed$/m;

export function injectHelperToken(source, authToken) {
  const token = String(authToken || '').trim();
  if (!token) throw new Error('The helper auth token is empty.');
  if (!TOKEN_MARKER.test(source)) {
    throw new Error('The plugin file has no launcher-managed helper token marker.');
  }
  return source.replace(
    TOKEN_MARKER,
    `const BUNDLED_HELPER_TOKEN = ${JSON.stringify(token)}; // @launcher-managed`,
  );
}
