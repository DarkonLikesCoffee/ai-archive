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

function createHarness(conversation, {
  sandboxFiles = [],
  sandboxContents = {},
  sandboxContentTypes = {},
  sandboxDownloadStatuses = {},
  sandboxDownloadDelays = {},
  sandboxListStatus = 200,
  assetResponses = {},
  downloadDelayMs = 0,
  sandboxDownloadDelayMs = 0,
} = {}) {
  const listeners = [];
  const requests = [];
  const handoffs = [];
  const progressMessages = [];
  let resolveFirstHandoff;
  const firstHandoff = new Promise((resolve) => { resolveFirstHandoff = resolve; });
  let resolveErrorProgress;
  const errorProgress = new Promise((resolve) => { resolveErrorProgress = resolve; });
  let finishFirstHandoff;
  let activeDownloads = 0;
  let maxActiveDownloads = 0;

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
      sendMessage(message, callback) {
        if (message.type === 'syncProgress') {
          progressMessages.push(message);
          if (message.stage === 'error') resolveErrorProgress(message);
        }
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
    const requestUrl = String(url);
    requests.push(requestUrl);
    if (/^https?:\/\//i.test(requestUrl)) {
      const configured = assetResponses[requestUrl] || {};
      const status = configured.status ?? 200;
      const bytes = new TextEncoder().encode(configured.content ?? 'asset bytes');
      activeDownloads += 1;
      maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
      try {
        const delay = configured.delayMs ?? downloadDelayMs;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => ({}),
          arrayBuffer: async () => bytes.slice().buffer,
          headers: { get: () => configured.contentType || null },
        };
      } finally {
        activeDownloads -= 1;
      }
    }
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
      if (sandboxListStatus !== 200) {
        return { ok: false, status: sandboxListStatus, json: async () => ({ error: 'test failure' }) };
      }
      return jsonResponse({ files_metadata: sandboxFiles });
    }
    if (String(url).includes('/wiggle/download-file?path=')) {
      const match = String(url).match(/[?&]path=([^&]*)/);
      const filePath = match ? decodeURIComponent(match[1]) : '';
      const status = sandboxDownloadStatuses[filePath] ?? 200;
      const bytes = new TextEncoder().encode(sandboxContents[filePath] ?? '');
      activeDownloads += 1;
      maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
      try {
        const delay = sandboxDownloadDelays[filePath] ?? sandboxDownloadDelayMs;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => ({}),
          arrayBuffer: async () => bytes.slice().buffer,
          headers: {
            get: (name) => name.toLowerCase() === 'content-type'
              ? (sandboxContentTypes[filePath] || null)
              : null,
          },
        };
      } finally {
        activeDownloads -= 1;
      }
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
    progressMessages,
    errorProgress,
    firstHandoff,
    metrics() {
      return { maxActiveDownloads };
    },
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


test('deduplicates extracted attachments by message and content, not filename alone', async () => {
  const conversation = {
    uuid: 'conversation-1',
    name: 'Repeated attachment names test',
    current_leaf_message_uuid: 'follow-up',
    chat_messages: [
      {
        uuid: 'first-message',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: 'First file.' }],
        attachments: [
          { file_name: 'notes.txt', extracted_content: 'First version' },
          { file_name: 'notes.txt', extracted_content: 'First version' },
          { file_name: 'notes.txt', extracted_content: 'Different version with same name' },
        ],
      },
      {
        uuid: 'follow-up',
        parent_message_uuid: 'first-message',
        sender: 'human',
        content: [{ type: 'text', text: 'Here is another attachment.' }],
        attachments: [
          { file_name: 'notes.txt', extracted_content: 'First version' },
        ],
      },
    ],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;
  const assets = handoff.conversations[0].assets;

  assert.equal(assets.length, 3, 'only an exact duplicate within the same message should be removed');
  assert.deepEqual(
    Array.from(assets, (asset) => [
      asset.message_external_id,
      Buffer.from(asset.base64, 'base64').toString('utf8'),
    ]),
    [
      ['first-message', 'First version'],
      ['first-message', 'Different version with same name'],
      ['follow-up', 'First version'],
    ],
  );

  harness.finishFirstHandoff({ ok: true });
});


test('aborts the sync when an explicitly referenced message attachment fails to download', async () => {
  const assetUrl = 'https://files.example/photo.png';
  const conversation = {
    uuid: 'conversation-1',
    name: 'Failed attachment download test',
    current_leaf_message_uuid: 'user-message',
    chat_messages: [{
      uuid: 'user-message',
      parent_message_uuid: ROOT,
      sender: 'human',
      content: [{ type: 'text', text: 'Look at this image.' }],
      files: [{
        file_name: 'photo.png',
        preview_url: assetUrl,
        mime_type: 'image/png',
      }],
    }],
  };
  const harness = createHarness(conversation, {
    assetResponses: { [assetUrl]: { status: 503 } },
  });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /photo\.png/);
  assert.match(error.error, /HTTP 503/);
  assert.match(error.error, /Sync stopped before anything was sent to GitHub/);
  assert.equal(harness.handoffs.length, 0, 'no partial conversation batch may reach GitHub sync');
});

test('aborts the sync when a listed sandbox attachment cannot be downloaded', async () => {
  const conversation = {
    uuid: 'conversation-1',
    name: 'Failed sandbox download test',
    current_leaf_message_uuid: 'user-message',
    chat_messages: [{
      uuid: 'user-message',
      parent_message_uuid: ROOT,
      sender: 'human',
      content: [{ type: 'text', text: 'Keep the generated file.' }],
    }],
  };
  const harness = createHarness(conversation, {
    sandboxFiles: [{ path: 'outputs/render.png', content_type: 'image/png' }],
    sandboxDownloadStatuses: { 'outputs/render.png': 404 },
  });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /outputs\/render\.png/);
  assert.match(error.error, /HTTP 404/);
  assert.equal(harness.handoffs.length, 0, 'a missing sandbox file must stop the archive sync');
});

test('aborts the sync when the sandbox file list cannot be retrieved', async () => {
  const conversation = {
    uuid: 'conversation-1',
    name: 'Failed sandbox list test',
    current_leaf_message_uuid: 'user-message',
    chat_messages: [{
      uuid: 'user-message',
      parent_message_uuid: ROOT,
      sender: 'human',
      content: [{ type: 'text', text: 'Please archive this conversation.' }],
    }],
  };
  const harness = createHarness(conversation, { sandboxListStatus: 503 });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /Could not list Claude sandbox files/);
  assert.match(error.error, /HTTP 503/);
  assert.equal(harness.handoffs.length, 0, 'unknown sandbox contents must not be archived as an empty file list');
});


test('refuses to export all messages when the active Claude leaf cannot be found', async () => {
  const conversation = {
    uuid: 'conversation-bad-leaf',
    name: 'Missing active leaf',
    current_leaf_message_uuid: 'leaf-not-returned',
    chat_messages: [
      { uuid: 'old-question', parent_message_uuid: ROOT, sender: 'human', content: [{ type: 'text', text: 'Old question' }] },
      { uuid: 'old-answer', parent_message_uuid: 'old-question', sender: 'assistant', content: [{ type: 'text', text: 'Old answer' }] },
    ],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /current_leaf_message_uuid "leaf-not-returned" was not found/);
  assert.equal(harness.handoffs.length, 0, 'an ambiguous conversation must not be sent to the GitHub sync');
});

test('refuses to export a partial lineage when a parent message is missing', async () => {
  const conversation = {
    uuid: 'conversation-missing-parent',
    name: 'Missing parent',
    current_leaf_message_uuid: 'active-leaf',
    chat_messages: [
      { uuid: 'active-leaf', parent_message_uuid: 'missing-parent', sender: 'human', content: [{ type: 'text', text: 'Follow-up' }] },
    ],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /parent message "missing-parent".*was not found/);
  assert.equal(harness.handoffs.length, 0, 'a partial active branch must not be archived');
});

test('refuses to export an active lineage with a cyclic parent chain', async () => {
  const conversation = {
    uuid: 'conversation-cycle',
    name: 'Cyclic lineage',
    current_leaf_message_uuid: 'message-a',
    chat_messages: [
      { uuid: 'message-a', parent_message_uuid: 'message-b', sender: 'assistant', content: [{ type: 'text', text: 'A' }] },
      { uuid: 'message-b', parent_message_uuid: 'message-a', sender: 'human', content: [{ type: 'text', text: 'B' }] },
    ],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /active message lineage contains a cycle/);
  assert.equal(harness.handoffs.length, 0, 'a cyclic branch must not be archived');
});

test('refuses duplicate message UUIDs instead of choosing an arbitrary branch node', async () => {
  const conversation = {
    uuid: 'conversation-duplicate-ids',
    name: 'Duplicate message IDs',
    current_leaf_message_uuid: 'active-leaf',
    chat_messages: [
      { uuid: 'active-leaf', parent_message_uuid: ROOT, sender: 'assistant', content: [{ type: 'text', text: 'First copy' }] },
      { uuid: 'active-leaf', parent_message_uuid: ROOT, sender: 'assistant', content: [{ type: 'text', text: 'Second copy' }] },
    ],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /message UUID "active-leaf" appears more than once/);
  assert.equal(harness.handoffs.length, 0, 'ambiguous duplicate message IDs must not be archived');
});


test('downloads message and sandbox assets concurrently with a bounded limit and stable order', async () => {
  const directFiles = Array.from({ length: 5 }, (_, index) => ({
    file_uuid: `direct-${index + 1}`,
    file_name: `direct-${index + 1}.txt`,
    preview_url: `https://assets.example/direct-${index + 1}`,
  }));
  const sandboxFiles = Array.from({ length: 5 }, (_, index) => ({
    path: `outputs/sandbox-${index + 1}.txt`,
    content_type: 'text/plain',
  }));
  const assetResponses = Object.fromEntries(directFiles.map((file, index) => [
    file.preview_url,
    { content: `direct content ${index + 1}` },
  ]));
  const sandboxContents = Object.fromEntries(sandboxFiles.map((file, index) => [
    file.path,
    `sandbox content ${index + 1}`,
  ]));
  const conversation = {
    uuid: 'conversation-1',
    name: 'Concurrent attachment downloads',
    current_leaf_message_uuid: 'user-message',
    chat_messages: [{
      uuid: 'user-message',
      parent_message_uuid: ROOT,
      sender: 'human',
      content: [{ type: 'text', text: 'Keep these files in order.' }],
      files: directFiles,
    }],
  };
  const harness = createHarness(conversation, {
    sandboxFiles,
    sandboxContents,
    assetResponses,
    downloadDelayMs: 15,
    sandboxDownloadDelayMs: 15,
  });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;
  const assets = handoff.conversations[0].assets;

  assert.equal(assets.length, 10);
  assert.deepEqual(
    Array.from(assets.slice(0, 5), (asset) => asset.name),
    directFiles.map((file) => file.file_name),
    'message assets should retain their original order',
  );
  assert.deepEqual(
    Array.from(assets.slice(5), (asset) => asset.source_path),
    sandboxFiles.map((file) => file.path),
    'sandbox assets should retain the metadata order',
  );
  const { maxActiveDownloads } = harness.metrics();
  assert.ok(maxActiveDownloads > 1, 'independent asset downloads should overlap');
  assert.ok(maxActiveDownloads <= 3, 'asset downloads must stay within the concurrency limit');

  harness.finishFirstHandoff({ ok: true });
});


test('stops scheduling sandbox downloads after a failure and never hands off a partial archive', async () => {
  const sandboxFiles = Array.from({ length: 6 }, (_, index) => ({
    path: `outputs/file-${index + 1}.txt`,
    content_type: 'text/plain',
  }));
  const sandboxContents = Object.fromEntries(sandboxFiles.map((file) => [file.path, 'valid file']));
  const sandboxDownloadDelays = Object.fromEntries(sandboxFiles.map((file, index) => [
    file.path,
    index === 1 ? 0 : 25,
  ]));
  const conversation = {
    uuid: 'conversation-1',
    name: 'Download failure safety',
    current_leaf_message_uuid: 'user-message',
    chat_messages: [{
      uuid: 'user-message',
      parent_message_uuid: ROOT,
      sender: 'human',
      content: [{ type: 'text', text: 'Keep every file or fail safely.' }],
    }],
  };
  const harness = createHarness(conversation, {
    sandboxFiles,
    sandboxContents,
    sandboxDownloadDelays,
    sandboxDownloadStatuses: { 'outputs/file-2.txt': 503 },
  });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /Failed to download sandbox file "outputs\/file-2\.txt"/);
  assert.equal(harness.handoffs.length, 0, 'a failed asset collection must never send a partial conversation to GitHub');
  const downloadRequests = harness.requests.filter((url) => url.includes('/wiggle/download-file?path='));
  assert.equal(downloadRequests.length, 3, 'no further downloads should be scheduled after the first failure');
  assert.ok(harness.metrics().maxActiveDownloads <= 3, 'failed downloads must respect the concurrency limit');
});
