import test from 'node:test';
import assert from 'node:assert/strict';
import { injectHelperToken } from '../src/plugin-token.js';

test('injects and refreshes the launcher-managed helper token', () => {
  const placeholder = 'const BUNDLED_HELPER_TOKEN = "__RISU_BGM_HELPER_TOKEN__"; // @launcher-managed';
  const first = injectHelperToken(placeholder, 'first-token');
  assert.match(first, /BUNDLED_HELPER_TOKEN = "first-token"/);
  const refreshed = injectHelperToken(first, 'new-token');
  assert.match(refreshed, /BUNDLED_HELPER_TOKEN = "new-token"/);
  assert.doesNotMatch(refreshed, /first-token/);
});

test('escapes token text as a JavaScript string literal', () => {
  const source = 'const BUNDLED_HELPER_TOKEN = "old"; // @launcher-managed';
  const updated = injectHelperToken(source, 'quote"and\\slash');
  assert.match(updated, /"quote\\"and\\\\slash"/);
});

test('refuses to edit a plugin without the managed marker', () => {
  assert.throws(() => injectHelperToken('const token = "x";', 'token'), /no launcher-managed/);
});
