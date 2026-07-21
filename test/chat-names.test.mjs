// readChatNames — the one pure, network-free piece of the chat-rename feature.
// (The rename round-trip and the profiles/RLS behaviour are integration tests
// against a live Supabase project, which don't run here.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readChatNames } from '../server/issues-store.mjs';

test('readChatNames returns the map when present', () => {
  assert.deepEqual(readChatNames({ chat_names: { 'sess-1': 'planning' } }), { 'sess-1': 'planning' });
});

test('readChatNames defends against missing / null / legacy shapes', () => {
  assert.deepEqual(readChatNames(null), {});
  assert.deepEqual(readChatNames({}), {});
  assert.deepEqual(readChatNames({ chat_names: null }), {});
  assert.deepEqual(readChatNames({ chat_names: ['not', 'a', 'map'] }), {});
  assert.deepEqual(readChatNames({ chat_names: 'nope' }), {});
});
