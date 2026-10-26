import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { parseConversationMarkdown } from './github.js';

const backgroundPath = fileURLToPath(new URL('../../extension/background.js', import.meta.url));
const backgroundSource = await readFile(backgroundPath, 'utf8');

function loadExporter() {
  const listeners = [];
  const chrome = {
    storage: { local: { get: async () => ({}) } },
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      sendMessage() { return Promise.resolve(); },
    },
  };
  const context = {
    chrome,
    AbortController,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    crypto: webcrypto,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
  };
  vm.runInNewContext(`${backgroundSource}
globalThis.__exporterTestHooks = {
  normalizeAssetList,
  conversationMarkdown,
  conversationPath,
  indexEntry,
  sha256,
};
`, context, { filename: 'extension/background.js' });
  assert.equal(listeners.length, 1);
  return context.__exporterTestHooks;
}

test('round-trips a generated archive conversation through the web reader parser', async () => {
  const exporter = loadExporter();
  const conversation = {
    external_id: 'conversation-round-trip-001',
    title: 'End-to-end archive round trip',
    model: 'claude-test',
    source_created_at: '2026-10-26T08:00:00.000Z',
    source_updated_at: '2026-10-26T09:00:00.000Z',
    message_count: 3,
    messages: [
      {
        external_id: 'user-message',
        role: 'user',
        content: 'Please review this image and document.',
        files: [{ file_name: 'diagram' }],
        attachments: [{ file_name: 'notes.txt' }],
      },
      {
        external_id: 'assistant-message',
        role: 'assistant',
        content: [
          'The image is clear.',
          '',
          '```js',
          'const answer = 42;',
          '```',
          '',
          'A horizontal rule inside this answer:',
          '',
          '---',
          '',
          'This sentence belongs to the same answer.',
        ].join('\n'),
        files: [],
        attachments: [],
      },
      {
        external_id: 'user-followup',
        role: 'user',
        content: 'Can you expand on the quoted section?',
        files: [],
        attachments: [{
          file_name: 'excerpt_from_previous_claude_message.txt',
          extracted_content: 'An earlier quote with ``` markers:\nconst previous = true;',
        }],
      },
    ],
    assets: [
      {
        name: 'diagram',
        mime: 'image/png',
        base64: Buffer.from('png bytes').toString('base64'),
        size: 9,
        sha256: 'a'.repeat(64),
        source: 'message',
        message_external_id: 'user-message',
      },
      {
        name: 'notes.txt',
        mime: 'text/plain',
        base64: Buffer.from('notes body').toString('base64'),
        size: 10,
        sha256: 'b'.repeat(64),
        source: 'message',
        message_external_id: 'user-message',
      },
    ],
  };

  const normalized = exporter.normalizeAssetList(conversation, 'claude', 'personal');
  const markdown = exporter.conversationMarkdown(
    conversation,
    'claude',
    'personal',
    normalized.byKey,
    normalized.assets,
  );
  const path = exporter.conversationPath(conversation, 'claude', 'personal');
  const entry = exporter.indexEntry(conversation, path, 'claude', 'personal', normalized.assets);
  entry.content_sha256 = await exporter.sha256(markdown);

  const parsed = parseConversationMarkdown(markdown);
  assert.equal(parsed.id, conversation.external_id);
  assert.equal(parsed.provider, 'claude');
  assert.equal(parsed.account, 'personal');
  assert.equal(parsed.title, conversation.title);
  assert.equal(parsed.message_count, 3);
  assert.equal(parsed.messages.length, 3);
  assert.deepEqual(parsed.messages.map(message => message.role), ['user', 'assistant', 'user']);
  assert.match(parsed.messages[0].content, /Please review this image and document/);
  assert.match(parsed.messages[1].content, /const answer = 42/);
  assert.match(parsed.messages[1].content, /This sentence belongs to the same answer/);
  assert.match(parsed.messages[2].content, /excerpt_from_previous_claude_message\.txt/);
  assert.match(parsed.messages[2].content, /const previous = true/);

  assert.equal(entry.assets.length, 2);
  for (const asset of entry.assets) {
    const relativePath = `assets/${asset.path.split('/assets/').pop()}`;
    const markdownLink = asset.mime.startsWith('image/')
      ? `![${asset.name}](${relativePath})`
      : `[${asset.name}](${relativePath})`;
    assert.ok(markdown.includes(markdownLink), `Markdown should link the indexed asset ${asset.name}`);

    const conversationDirectory = path.slice(0, path.lastIndexOf('/'));
    const readerResolvedPath = `${conversationDirectory}/${relativePath}`;
    assert.equal(readerResolvedPath, asset.path, 'relative Markdown links must resolve to the exact asset path in index.json');
  }
});

test('keeps a Claude answer whole when it contains a horizontal rule followed by a heading', () => {
  const exporter = loadExporter();
  const answer = [
    'Here is the overview.',
    '',
    '---',
    '',
    '## Details',
    '',
    'The details belong to the same answer.',
    '',
    '---',
    '',
    '## Summary',
    '',
    'So does the summary.',
  ].join('\n');
  const conversation = {
    external_id: 'conversation-rule-heading',
    title: 'Rules and headings',
    source_created_at: '2026-10-26T08:00:00.000Z',
    source_updated_at: '2026-10-26T09:00:00.000Z',
    message_count: 3,
    messages: [
      { external_id: 'u1', role: 'user', content: 'Explain it.', files: [], attachments: [] },
      { external_id: 'a1', role: 'assistant', content: answer, files: [], attachments: [] },
      { external_id: 'u2', role: 'user', content: 'Thanks!\n\n---\n\n## My notes\n\nMine too.', files: [], attachments: [] },
    ],
    assets: [],
  };
  const normalized = exporter.normalizeAssetList(conversation, 'claude', 'personal');
  const markdown = exporter.conversationMarkdown(conversation, 'claude', 'personal', normalized.byKey, normalized.assets);

  const parsed = parseConversationMarkdown(markdown);
  assert.deepEqual(parsed.messages.map((message) => [message.role, message.roleName]), [
    ['user', 'You'],
    ['assistant', 'Claude'],
    ['user', 'You'],
  ]);
  assert.equal(parsed.messages[1].content, answer);
  assert.equal(parsed.messages[2].content, 'Thanks!\n\n---\n\n## My notes\n\nMine too.');
});

test('still separates messages with raw exporter roles when provider metadata is present', () => {
  const exporter = loadExporter();
  const conversation = {
    external_id: 'conversation-raw-role',
    title: 'Raw role',
    message_count: 3,
    messages: [
      { external_id: 'u1', role: 'user', content: 'Hi', files: [], attachments: [] },
      // A sender other than human/assistant is exported under its raw role name.
      { external_id: 's1', role: 'system', content: 'System note', files: [], attachments: [] },
      { external_id: 'a1', role: 'assistant', content: 'Hello', files: [], attachments: [] },
    ],
    assets: [],
  };
  const normalized = exporter.normalizeAssetList(conversation, 'claude', 'personal');
  const markdown = exporter.conversationMarkdown(conversation, 'claude', 'personal', normalized.byKey, normalized.assets);

  const parsed = parseConversationMarkdown(markdown);
  assert.deepEqual(parsed.messages.map((message) => [message.role, message.content]), [
    ['user', 'Hi'],
    ['system', 'System note'],
    ['assistant', 'Hello'],
  ]);
});
