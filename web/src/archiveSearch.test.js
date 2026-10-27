import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchQuery, searchConversations } from './archiveSearch.js';

const conv = (id, title, searchText, updatedAt = '2026-10-01T00:00:00Z') => ({ id, title, search_text: searchText, updated_at: updatedAt });

test('parses words and quoted phrases into lowercase terms', () => {
  assert.deepEqual(parseSearchQuery('  React   "custom Hooks" useEffect '), ['react', 'custom hooks', 'useeffect']);
  assert.deepEqual(parseSearchQuery('"unterminated phrase'), ['unterminated phrase']);
  assert.deepEqual(parseSearchQuery('   '), []);
});

test('matches every term anywhere in the conversation, not only the exact query string', () => {
  const conversations = [
    conv('a', 'Frontend help', 'We discussed React.\n...\nLater: how hooks re-render.'),
    conv('b', 'Backend', 'Only about React servers.'),
  ];
  const results = searchConversations(conversations, 'react hooks');
  assert.deepEqual(results.map((r) => r.conversation.id), ['a']);
});

test('treats a quoted phrase as one term', () => {
  const conversations = [
    conv('phrase', 'x', 'about custom hooks today'),
    conv('apart', 'y', 'custom code and some hooks'),
  ];
  assert.deepEqual(searchConversations(conversations, '"custom hooks"').map((r) => r.conversation.id), ['phrase']);
});

test('ranks title matches first, then by number of matches, then by recency', () => {
  const conversations = [
    conv('body-once-new', 'Notes', 'one mention of rust', '2026-10-20T00:00:00Z'),
    conv('body-many', 'Notes', 'rust rust rust', '2026-10-01T00:00:00Z'),
    conv('title', 'Rust ownership', 'nothing else', '2026-01-01T00:00:00Z'),
    conv('body-once-old', 'Notes', 'a rust note', '2026-02-01T00:00:00Z'),
  ];
  assert.deepEqual(searchConversations(conversations, 'Rust').map((r) => r.conversation.id),
    ['title', 'body-many', 'body-once-new', 'body-once-old']);
});

test('returns a snippet around the first match with the terms marked', () => {
  const text = `${'filler '.repeat(40)}the Borrow checker complains about borrow rules ${'tail '.repeat(40)}`;
  const [result] = searchConversations([conv('a', 'Untitled', text)], 'borrow');
  const joined = result.snippet.map((part) => part.text).join('');
  assert.ok(joined.startsWith('…') && joined.endsWith('…'), 'a long text is trimmed on both sides');
  assert.ok(joined.length < 200);
  assert.deepEqual(result.snippet.filter((part) => part.match).map((part) => part.text), ['Borrow', 'borrow'],
    'matches keep their original casing');
  assert.equal(joined.includes('\n'), false);
});

test('returns null for an empty query so the normal list is shown', () => {
  assert.equal(searchConversations([conv('a', 'x', 'y')], '  '), null);
});
