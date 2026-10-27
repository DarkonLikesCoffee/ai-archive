import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConversationMarkdown, readAsset, readText, readIndex, githubBlobUrl, describeConnectError } from './github.js';

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
  const markdown = [
    '# Test',
    '',
    '## You',
    '',
    'Hello',
    '',
    '---',
    '',
    '## Claude',
    '',
    'Hi',
  ].join('\r\n');

  const result = parseConversationMarkdown(markdown);

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].content, 'Hello');
  assert.equal(result.messages[1].content, 'Hi');
});

test('does not split on a separator-looking line inside a fenced code block', () => {
  const markdown = [
    '# Test',
    '',
    '## You',
    '',
    '```text',
    '---',
    '## Not a message',
    '---',
    '```',
    '',
    '---',
    '',
    '## Claude',
    '',
    'Answer',
    '',
  ].join('\n');

  const result = parseConversationMarkdown(markdown);

  assert.equal(result.messages.length, 2);
  assert.match(result.messages[0].content, /## Not a message/);
  assert.match(result.messages[0].content, /---/);
});

test('accepts LF-separated role headings without requiring two blank lines', () => {
  const result = parseConversationMarkdown(`# Test
## You
Hello
---
## Claude
Hi
`);

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].content, 'Hello');
  assert.equal(result.messages[1].content, 'Hi');
});


test('uses archived MIME metadata to preview an image whose filename has no recognized extension', async (t) => {
  const imageBytes = Buffer.from('fake-png-bytes', 'utf8');
  const imageBase64 = imageBytes.toString('base64');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const value = String(url);
    calls.push(value);
    const payload = value.endsWith('/contents/archive/conversations/claude/personal/assets/conversation/ab12-diagram')
      ? {
          type: 'file',
          content: '',
          encoding: 'none',
          sha: 'image-blob-sha',
          size: imageBytes.length,
          content_type: 'application/octet-stream',
          html_url: 'https://github.com/example/archive/blob/main/image',
          download_url: null,
        }
      : value.endsWith('/git/blobs/image-blob-sha')
        ? { encoding: 'base64', content: imageBase64 }
        : null;
    if (!payload) throw new Error(`Unexpected test request: ${value}`);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  });

  const settings = { owner: 'example', repo: 'archive', token: 'test-token' };
  const path = 'archive/conversations/claude/personal/assets/conversation/ab12-diagram';
  const asset = await readAsset(settings, path, { path, name: 'diagram', mime: 'image/png' });

  assert.equal(asset.mime, 'image/png');
  assert.equal(asset.dataUrl, `data:image/png;base64,${imageBase64}`);
  assert.equal(calls.length, 2, 'the reader should fetch metadata and the binary blob');
});



test('reads large GitHub text files through the blob API when Contents omits content', async (t) => {
  const expectedText = JSON.stringify({
    version: 2,
    conversations: [{ id: 'older-conversation', search_text: 'a'.repeat(12000) }],
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const value = String(url);
    calls.push(value);
    const payload = value.endsWith('/contents/archive/index.json')
      ? {
          type: 'file',
          encoding: 'none',
          content: '',
          sha: 'large-index-sha',
          size: expectedText.length,
        }
      : value.endsWith('/git/blobs/large-index-sha')
        ? {
            encoding: 'base64',
            content: Buffer.from(expectedText, 'utf8').toString('base64'),
          }
        : null;

    if (!payload) throw new Error(`Unexpected test request: ${value}`);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  });

  const result = await readText(
    { owner: 'example', repo: 'archive', token: 'test-token' },
    'archive/index.json',
  );

  assert.equal(result, expectedText);
  assert.equal(calls.length, 2, 'the reader should fetch Contents metadata then the exact Git blob');
  assert.ok(calls[1].endsWith('/git/blobs/large-index-sha'));
});



test('readIndex inflates compressed search entries and preserves legacy plain entries', async (t) => {
  const searchText = 'Find this exact phrase in a compact search index. '.repeat(100);
  const compressedStream = new Blob([searchText]).stream().pipeThrough(new CompressionStream('gzip'));
  const compressedBytes = new Uint8Array(await new Response(compressedStream).arrayBuffer());
  const compressedBase64 = Buffer.from(compressedBytes).toString('base64');
  const indexPayload = {
    version: 2,
    conversations: [
      {
        id: 'compressed-entry',
        title: 'Compressed conversation',
        search_text_encoding: 'gzip-base64',
        search_text_gzip: compressedBase64,
        search_text_sha256: 'a'.repeat(64),
      },
      {
        id: 'legacy-entry',
        title: 'Legacy conversation',
        search_text: 'legacy searchable content',
      },
    ],
  };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const value = String(url);
    calls.push(value);
    if (!value.endsWith('/contents/archive/index.json')) {
      throw new Error(`Unexpected test request: ${value}`);
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(indexPayload), 'utf8').toString('base64'),
      }),
    };
  });

  const result = await readIndex({ owner: 'example', repo: 'archive', token: 'test-token' });
  assert.equal(result.conversations[0].search_text, searchText);
  assert.equal(result.conversations[1].search_text, 'legacy searchable content');
  assert.equal(result.conversations[0].search_text_gzip, undefined, 'compressed payload should not remain in the UI search model');
  assert.equal(result.conversations[0].search_text_encoding, undefined);
  assert.equal(calls.length, 1, 'search data should be decoded from the single index request');
});

test('GitHub file links follow the default branch and encode the path', () => {
  assert.equal(
    githubBlobUrl({ owner: 'me', repo: 'archive' }, 'archive/conversations/claude/personal/What is #1? 100%.md'),
    'https://github.com/me/archive/blob/HEAD/archive/conversations/claude/personal/What%20is%20%231%3F%20100%25.md',
  );
});

test('a repository without an archive yet reads as an empty archive', async (t) => {
  const settings = { owner: 'me', repo: 'archive', token: 't' };
  for (const [status, body] of [[404, '{"message":"Not Found"}'], [409, '{"message":"Git Repository is empty."}']]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(body, { status }));
    assert.deepEqual(await readIndex(settings), { version: 2, conversations: [], missing: true }, `HTTP ${status}`);
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('{"message":"Bad credentials"}', { status: 401 }));
  await assert.rejects(readIndex(settings), /GitHub 401/);
});

test('explains a repository that cannot be found when connecting', () => {
  const settings = { owner: 'me', repo: 'archiv' };
  assert.match(describeConnectError(new Error('GitHub 404: {"message":"Not Found"}'), settings), /^Repository me\/archiv was not found, or the token cannot access it\./);
  assert.equal(describeConnectError(new Error('GitHub 401: GitHub rejected the access token.'), settings), 'GitHub 401: GitHub rejected the access token.');
});
