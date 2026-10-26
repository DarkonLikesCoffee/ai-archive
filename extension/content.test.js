import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const contentPath = fileURLToPath(new URL('./content.js', import.meta.url));
const contentSource = await readFile(contentPath, 'utf8');
const ROOT = '00000000-0000-4000-8000-000000000000';

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    json: async () => value,
    headers: { get: () => null },
  };
}

function createHarness(conversation, { sandboxFiles = [], sandboxContents = {}, sandboxContentTypes = {} } = {}) {
  const listeners = [];
  const requests = [];
  const handoffs = [];
  let resolveFirstHandoff;
  const firstHandoff = new Promise((resolve) => { resolveFirstHandoff = resolve; });
  let finishFirstHandoff;

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
      sendMessage(message, callback) {
        if (message.type === 'syncNormalized') {
          handoffs.push(message);
          if (handoffs.length === 1) {
            finishFirstHandoff = callback;
            resolveFirstHandoff(message);
          } else {
            callback?.({ ok: true });
          }
        }
        return Promise.resolve();
      },
    },
  };

  const fetch = async (url) => {
    requests.push(String(url));
    if (url === '/api/organizations') return jsonResponse([{ uuid: 'org-id' }]);
    if (url === '/api/organizations/org-id/chat_conversations') {
      return jsonResponse([{
        uuid: 'conversation-1',
        name: 'Exporter regression test',
        created_at: '2026-10-26T08:00:00.000Z',
        updated_at: '2026-10-26T08:30:00.000Z',
      }]);
    }
    if (String(url).includes('/chat_conversations/conversation-1?')) {
      return jsonResponse(conversation);
    }
    if (String(url).includes('/wiggle/list-files')) {
      return jsonResponse({ files_metadata: sandboxFiles });
    }
    if (String(url).includes('/wiggle/download-file?path=')) {
      const match = String(url).match(/[?&]path=([^&]*)/);
      const filePath = match ? decodeURIComponent(match[1]) : '';
      const bytes = new TextEncoder().encode(sandboxContents[filePath] ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => bytes.slice().buffer,
        headers: {
          get: (name) => name.toLowerCase() === 'content-type'
            ? (sandboxContentTypes[filePath] || null)
            : null,
        },
      };
    }
    throw new Error(`Unexpected request in test: ${url}`);
  };

  vm.runInNewContext(contentSource, {
    chrome,
    fetch,
    AbortController,
    DOMException,
    TextEncoder,
    Uint8Array,
    btoa,
    crypto: webcrypto,
  }, { filename: 'extension/content.js' });

  assert.equal(listeners.length, 1, 'content script should register one message listener');
  return {
    onMessage: listeners[0],
    requests,
    handoffs,
    firstHandoff,
    finishFirstHandoff(response) {
      finishFirstHandoff?.(response);
    },
  };
}

test('exports only the active Claude message lineage and locks while GitHub sync is pending', async () => {
  const conversation = {
    uuid: 'conversation-1',
    name: 'Exporter regression test',
    current_leaf_message_uuid: 'active-leaf',
    chat_messages: [
      {
        uuid: 'active-leaf',
        parent_message_uuid: 'active-answer',
        sender: 'human',
        content: [{ type: 'text', text: 'Follow-up question' }],
      },
      {
        uuid: 'abandoned-answer',
        parent_message_uuid: 'root-user',
        sender: 'assistant',
        content: [{ type: 'text', text: 'Abandoned answer' }],
      },
      {
        uuid: 'root-user',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: 'Original request' }],
      },
      {
        uuid: 'active-answer',
        parent_message_uuid: 'root-user',
        sender: 'assistant',
        content: [{ type: 'text', text: 'Current answer' }],
      },
    ],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;
  const messages = handoff.conversations[0].messages;

  assert.deepEqual(Array.from(messages, (message) => message.external_id), [
    'root-user',
    'active-answer',
    'active-leaf',
  ]);
  assert.equal(messages.some((message) => message.content.includes('Abandoned answer')), false);

  // The content script must stay locked until the background has replied to the
  // normalized handoff, not merely until it has finished collecting conversation data.
  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  assert.equal(harness.requests.filter((url) => url === '/api/organizations').length, 1);
  assert.equal(harness.handoffs.length, 1);

  harness.finishFirstHandoff({ ok: true });
});

test('preserves extracted document text as a downloadable asset rather than message prose', async () => {
  const conversation = {
    uuid: 'conversation-1',
    name: 'Attachment regression test',
    current_leaf_message_uuid: 'user-message',
    chat_messages: [
      {
        uuid: 'user-message',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: 'Summarize this file.' }],
        attachments: [{
          file_name: 'notes.txt',
          file_type: 'text/plain',
          extracted_content: 'Secret extracted document contents',
        }],
      },
    ],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;
  const normalized = handoff.conversations[0];

  assert.equal(normalized.messages[0].content.includes('Secret extracted document contents'), false);
  assert.equal(normalized.assets.length, 1);
  assert.equal(normalized.assets[0].name, 'notes.txt');
  assert.equal(Buffer.from(normalized.assets[0].base64, 'base64').toString('utf8'), 'Secret extracted document contents');

  harness.finishFirstHandoff({ ok: true });
});


test('preserves different sandbox files that share a basename and uses response MIME fallback', async () => {
  const conversation = {
    uuid: 'conversation-1',
    name: 'Same-name assets regression test',
    current_leaf_message_uuid: 'user-message',
    chat_messages: [{
      uuid: 'user-message',
      parent_message_uuid: ROOT,
      sender: 'human',
      content: [{ type: 'text', text: 'Please keep both generated reports.' }],
    }],
  };
  const sandboxFiles = [
    { path: 'outputs/first/report.txt', content_type: 'text/plain' },
    { path: 'outputs/second/report.txt' },
  ];
  const harness = createHarness(conversation, {
    sandboxFiles,
    sandboxContents: {
      'outputs/first/report.txt': 'First report contents',
      'outputs/second/report.txt': 'Second report contains different information',
    },
    sandboxContentTypes: {
      'outputs/first/report.txt': 'text/plain',
      'outputs/second/report.txt': 'application/pdf',
    },
  });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;
  const assets = handoff.conversations[0].assets;

  assert.equal(assets.length, 2, 'same basenames at different paths must not cause a file to be dropped');
  assert.deepEqual(
    Array.from(assets, (asset) => asset.source_path).sort(),
    ['outputs/first/report.txt', 'outputs/second/report.txt'],
  );
  assert.equal(new Set(assets.map((asset) => asset.sha256)).size, 2, 'different contents must remain distinct');
  const second = assets.find((asset) => asset.source_path === 'outputs/second/report.txt');
  assert.equal(second.mime, 'application/pdf', 'response Content-Type should be used when metadata omits MIME type');
  assert.equal(
    Buffer.from(second.base64, 'base64').toString('utf8'),
    'Second report contains different information',
  );

  harness.finishFirstHandoff({ ok: true });
});
