import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConversationMarkdown } from './github.js';

test('parses canonical metadata, title, and messages', () => {
  const markdown = `<!-- AI_ARCHIVE_METADATA
{
  "id": "abc123",
  "provider": "claude",
  "account": "personal",
  "title": "Test conversation",
  "model": "claude-test",
  "message_count": 2
}
-->

# Test conversation

## You

Hello

---

## Claude

Hi there
`;

  const result = parseConversationMarkdown(markdown);

  assert.equal(result.id, 'abc123');
  assert.equal(result.provider, 'claude');
  assert.equal(result.account, 'personal');
  assert.equal(result.title, 'Test conversation');
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[0], {
    role: 'user',
    roleName: 'You',
    content: 'Hello',
  });
  assert.deepEqual(result.messages[1], {
    role: 'assistant',
    roleName: 'Claude',
    content: 'Hi there',
  });
});

test('uses the H1 as title when metadata has no title', () => {
  const result = parseConversationMarkdown(`<!-- AI_ARCHIVE_METADATA
{"id":"abc","provider":"claude","account":"personal"}
-->

# H1 title

## You

Message
`);

  assert.equal(result.title, 'H1 title');
  assert.equal(result.messages[0].content, 'Message');
});

test('keeps unknown roles instead of dropping them', () => {
  const result = parseConversationMarkdown(`# Test

## You

Question

---

## Tool

Some tool output

---

## Claude

Answer
`);

  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[1].role, 'tool');
  assert.equal(result.messages[1].roleName, 'Tool');
});

test('does not treat a normal horizontal rule inside message content as a message separator', () => {
  const result = parseConversationMarkdown(`# Test

## You

Before

---

This is still user content.

---

## Claude

Answer
`);

  assert.equal(result.messages.length, 2);
  assert.match(result.messages[0].content, /This is still user content/);
});

test('survives malformed metadata without losing the markdown body', () => {
  const result = parseConversationMarkdown(`<!-- AI_ARCHIVE_METADATA
not valid json
-->

# Test

## You

Hello
`);

  assert.equal(result.title, 'Test');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].content, 'Hello');
});

test('normalizes CRLF input', () => {
  const result = parseConversationMarkdown('# Test\\r\\n\\r\\n## You\\r\\n\\r\\nHello\\r\\n\\r\\n---\\r\\n\\r\\n## Claude\\r\\n\\r\\nHi');

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].content, 'Hello');
  assert.equal(result.messages[1].content, 'Hi');
});
