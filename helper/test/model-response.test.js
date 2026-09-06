import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidatePayload, extractJsonObjects } from '../src/model-response.js';

test('selects the final candidate JSON after a Thoughts block containing a schema example', () => {
  const response = String.raw`\<Thoughts>
Schema: {"mood":"example","candidates":[{"artist":"placeholder","title":"placeholder","query":"placeholder"}]}
The actual answer follows.
\</Thoughts>
{"mood":"London lounge","candidates":[{"artist":"Tom Misch","title":"The Journey","query":"Tom Misch The Journey"}]}`;
  const payload = extractCandidatePayload(response);
  assert.equal(payload.mood, 'London lounge');
  assert.equal(payload.candidates[0].artist, 'Tom Misch');
});

test('tracks braces and escapes inside JSON strings', () => {
  const objects = extractJsonObjects('prose {"mood":"a } brace and \\\"quote\\\"","candidates":[]} tail');
  assert.equal(objects.length, 1);
  assert.equal(objects[0].mood, 'a } brace and "quote"');
});

test('returns null when no candidate payload exists', () => {
  assert.equal(extractCandidatePayload('<Thoughts>Nothing usable</Thoughts>'), null);
});
