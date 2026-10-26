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
  conversationListResponse = null,
  fullConversationResponse = null,
  assetResponses = {},
  downloadDelayMs = 0,
  sandboxDownloadDelayMs = 0,
  assetDownloadConcurrency = 3,
  cancelOnFirstDigest = false,
} = {}) {
  const listeners = [];
  const requests = [];
  const handoffs = [];
  const progressMessages = [];
  let resolveFirstHandoff;
  const firstHandoff = new Promise((resolve) => { resolveFirstHandoff = resolve; });
  let resolveErrorProgress;
  const errorProgress = new Promise((resolve) => { resolveErrorProgress = resolve; });
  let resolveCancelledProgress;
  const cancelledProgress = new Promise((resolve) => { resolveCancelledProgress = resolve; });
  let cancelTriggeredDuringDigest = false;
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
          if (message.stage === 'cancelled') resolveCancelledProgress(message);
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
      return jsonResponse(conversationListResponse ?? [{
        uuid: conversation?.uuid || 'conversation-1',
        name: 'Exporter regression test',
        created_at: '2026-10-26T08:00:00.000Z',
        updated_at: '2026-10-26T08:30:00.000Z',
      }]);
    }
    if (/\/chat_conversations\/[^/?]+\?/.test(String(url))) {
      return jsonResponse(fullConversationResponse ?? conversation);
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

  const harnessSource = contentSource.replace(
    'const ASSET_DOWNLOAD_CONCURRENCY = 3;',
    `const ASSET_DOWNLOAD_CONCURRENCY = ${assetDownloadConcurrency};`,
  );
  vm.runInNewContext(harnessSource, {
    chrome,
    fetch,
    AbortController,
    DOMException,
    TextEncoder,
    Uint8Array,
    btoa,
    crypto: {
      subtle: {
        digest: async (...args) => {
          if (cancelOnFirstDigest && !cancelTriggeredDuringDigest) {
            cancelTriggeredDuringDigest = true;
            listeners[0]?.({ type: 'cancelSync' }, {}, () => {});
          }
          return webcrypto.subtle.digest(...args);
        },
      },
    },
  }, { filename: 'extension/content.js' });

  assert.equal(listeners.length, 1, 'content script should register one message listener');
  return {
    onMessage: listeners[0],
    requests,
    handoffs,
    progressMessages,
    errorProgress,
    cancelledProgress,
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
      content: [{ type: 'text', text: 'Please keep both generated reports: outputs/first/report.txt and outputs/second/report.txt.' }],
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
      content: [{ type: 'text', text: 'Keep the generated file at outputs/render.png.' }],
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
      content: [{ type: 'text', text: `Keep these files in order: ${sandboxFiles.map((file) => file.path).join(', ')}.` }],
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
      content: [{ type: 'text', text: `Keep every file or fail safely: ${sandboxFiles.map((file) => file.path).join(', ')}.` }],
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



test('benchmark: bounded asset downloads against sequential baseline at multiple archive sizes', async (t) => {
  const delayMs = 12;
  const sizes = [6, 24, 48];
  const measurements = [];

  async function measureDownloadRun(fileCount, concurrency) {
    const sandboxFiles = Array.from({ length: fileCount }, (_, index) => ({
      path: `benchmark/file-${index + 1}.txt`,
      content_type: 'text/plain',
    }));
    const sandboxContents = Object.fromEntries(sandboxFiles.map((file, index) => [
      file.path,
      `synthetic benchmark payload ${index + 1}`,
    ]));
    const conversation = {
      uuid: 'conversation-1',
      name: 'Synthetic download benchmark',
      current_leaf_message_uuid: 'user-message',
      chat_messages: [{
        uuid: 'user-message',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: `Synthetic performance test only: ${sandboxFiles.map((file) => file.path).join(', ')}.` }],
      }],
    };
    const harness = createHarness(conversation, {
      sandboxFiles,
      sandboxContents,
      sandboxDownloadDelayMs: delayMs,
      assetDownloadConcurrency: concurrency,
    });

    const start = performance.now();
    harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
    const handoff = await harness.firstHandoff;
    const elapsedMs = performance.now() - start;

    assert.equal(handoff.conversations[0].assets.length, fileCount);
    harness.finishFirstHandoff({ ok: true });
    return elapsedMs;
  }

  for (const fileCount of sizes) {
    // Both runs execute the same content script and simulated per-file latency;
    // only the configured concurrency differs between the two measurements.
    const sequentialMs = await measureDownloadRun(fileCount, 1);
    const concurrentMs = await measureDownloadRun(fileCount, 3);
    const speedup = sequentialMs / concurrentMs;
    measurements.push({
      files: fileCount,
      sequentialMs: Number(sequentialMs.toFixed(1)),
      concurrentMs: Number(concurrentMs.toFixed(1)),
      speedup: Number(speedup.toFixed(2)),
    });

    if (fileCount >= 24) {
      assert.ok(
        speedup >= 1.5,
        `expected at least 1.5x speedup for ${fileCount} files; got ${speedup.toFixed(2)}x (sequential ${sequentialMs.toFixed(1)}ms, concurrent ${concurrentMs.toFixed(1)}ms)`,
      );
    }
  }

  t.diagnostic('Synthetic asset download benchmark (lower time is better; simulated network latency only):');
  t.diagnostic(JSON.stringify(measurements));
});



test('cancelling while hashing an extracted attachment prevents the GitHub handoff', async () => {
  const conversation = {
    uuid: 'conversation-1',
    name: 'Cancellation during attachment hashing',
    current_leaf_message_uuid: 'user-message',
    chat_messages: [{
      uuid: 'user-message',
      parent_message_uuid: ROOT,
      sender: 'human',
      content: [{ type: 'text', text: 'Archive this extracted attachment.' }],
      attachments: [{
        file_name: 'notes.txt',
        file_type: 'text/plain',
        extracted_content: 'Synthetic text attachment used to test cancellation.',
      }],
    }],
  };
  const harness = createHarness(conversation, { cancelOnFirstDigest: true });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const outcome = await Promise.race([
    harness.firstHandoff.then(() => 'handoff'),
    harness.cancelledProgress.then(() => 'cancelled'),
  ]);

  assert.equal(outcome, 'cancelled', 'the cancellation message should win before any archive handoff');
  assert.equal(harness.handoffs.length, 0, 'a cancelled normalization must not be handed to GitHub');
});


test('refuses malformed Claude conversation-list payloads before fetching conversations', async () => {
  for (const [label, payload, expected] of [
    ['object instead of array', { conversations: [] }, /invalid conversation list/],
    ['missing UUID', [{ name: 'No ID' }], /without a valid UUID/],
    ['duplicate UUID', [{ uuid: 'conversation-1' }, { uuid: 'conversation-1' }], /duplicate conversation UUID/],
  ]) {
    const harness = createHarness({
      uuid: 'conversation-1',
      current_leaf_message_uuid: 'message-1',
      chat_messages: [{ uuid: 'message-1', parent_message_uuid: ROOT, sender: 'human', content: [{ type: 'text', text: 'hello' }] }],
    }, { conversationListResponse: payload });

    harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
    const error = await harness.errorProgress;
    assert.match(error.error, expected, label);
    assert.equal(
      harness.requests.some((url) => url.includes('/chat_conversations/conversation-1?')),
      false,
      `the full conversation should not be fetched for invalid list case: ${label}`,
    );
    assert.equal(harness.handoffs.length, 0, 'invalid list data must never reach GitHub');
  }
});

test('refuses a full-conversation response whose UUID differs from the requested conversation', async () => {
  const conversation = {
    uuid: 'conversation-1',
    name: 'Exporter regression test',
    current_leaf_message_uuid: 'message-1',
    chat_messages: [{
      uuid: 'message-1',
      parent_message_uuid: ROOT,
      sender: 'human',
      content: [{ type: 'text', text: 'hello' }],
    }],
  };
  const harness = createHarness(conversation, {
    fullConversationResponse: { ...conversation, uuid: 'different-conversation' },
  });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /returned conversation "different-conversation" when "conversation-1" was requested/);
  assert.equal(harness.handoffs.length, 0, 'mismatched conversation data must not be archived under the wrong ID');
});

test('refuses a full-conversation payload with no messages array', async () => {
  const harness = createHarness({
    uuid: 'conversation-1',
    name: 'Incomplete response',
    current_leaf_message_uuid: null,
  }, {
    fullConversationResponse: { uuid: 'conversation-1', name: 'Incomplete response' },
  });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /without a valid messages array/);
  assert.equal(harness.handoffs.length, 0, 'incomplete response must not become an empty archived conversation');
});


test('refuses malformed or ambiguous message nodes when no active leaf pointer is provided', async () => {
  const cases = [
    ['non-object message', [null], /message at position 1 does not have a valid UUID/],
    ['missing UUID', [{ sender: 'human', content: [{ type: 'text', text: 'hello' }] }], /message at position 1 does not have a valid UUID/],
    ['empty UUID', [{ uuid: '   ', sender: 'human' }], /message at position 1 does not have a valid UUID/],
    ['duplicate UUID', [
      { uuid: 'duplicate-message', sender: 'human' },
      { uuid: 'duplicate-message', sender: 'assistant' },
    ], /message UUID "duplicate-message" appears more than once/],
  ];

  for (const [label, chat_messages, expected] of cases) {
    const conversation = {
      uuid: 'conversation-no-leaf',
      name: 'Message integrity test',
      current_leaf_message_uuid: null,
      chat_messages,
    };
    const harness = createHarness(conversation);

    harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
    const error = await harness.errorProgress;

    assert.match(error.error, expected, label);
    assert.equal(harness.handoffs.length, 0, `invalid message data must not be handed off: ${label}`);
  }
});

test('refuses malformed message nodes even when they are outside the active branch', async () => {
  const conversation = {
    uuid: 'conversation-bad-abandoned-node',
    name: 'Malformed abandoned branch node',
    current_leaf_message_uuid: 'active-leaf',
    chat_messages: [
      { uuid: 'active-leaf', parent_message_uuid: ROOT, sender: 'assistant', content: [{ type: 'text', text: 'Active answer' }] },
      { sender: 'assistant', content: [{ type: 'text', text: 'Malformed abandoned answer' }] },
    ],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /message at position 2 does not have a valid UUID/);
  assert.equal(harness.handoffs.length, 0, 'malformed response nodes must not be silently omitted from the archive');
});


test('associates a single downloaded direct asset with every message that references it', async () => {
  const assetUrl = 'https://files.example/shared-report.png';
  const sharedFile = {
    file_uuid: 'shared-file-id',
    file_name: 'shared-report.png',
    preview_url: assetUrl,
    mime_type: 'image/png',
  };
  const conversation = {
    uuid: 'conversation-shared-attachment',
    name: 'Shared attachment reference',
    current_leaf_message_uuid: 'assistant-message',
    chat_messages: [
      {
        uuid: 'user-message',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: 'Here is the report.' }],
        files: [{ ...sharedFile }],
        attachments: [{ file_name: 'shared-report.png', extracted_content: 'shared image bytes' }],
      },
      {
        uuid: 'assistant-message',
        parent_message_uuid: 'user-message',
        sender: 'assistant',
        content: [{ type: 'text', text: 'I will refer to that same report.' }],
        files: [{ ...sharedFile }],
        attachments: [{ file_name: 'shared-report.png', extracted_content: 'shared image bytes' }],
      },
    ],
  };
  const harness = createHarness(conversation, {
    assetResponses: { [assetUrl]: { content: 'shared image bytes', contentType: 'image/png' } },
  });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;
  const assets = handoff.conversations[0].assets;

  assert.equal(assets.length, 1, 'the shared file should only be downloaded and archived once');
  assert.deepEqual(Array.from(assets[0].message_external_ids), ['user-message', 'assistant-message']);
  assert.equal(assets[0].message_external_id, 'user-message', 'keep the legacy primary association for compatibility');
  assert.equal(harness.requests.filter((url) => url === assetUrl).length, 1, 'duplicate references should share one download');

  harness.finishFirstHandoff({ ok: true });
});


test('refuses to silently skip a listed message file with no URL or matching archive asset', async () => {
  const conversation = {
    uuid: 'conversation-file-without-url',
    name: 'Missing file URL',
    current_leaf_message_uuid: 'user-message',
    chat_messages: [{
      uuid: 'user-message',
      parent_message_uuid: ROOT,
      sender: 'human',
      content: [{ type: 'text', text: 'Please archive this attachment.' }],
      files: [{ file_uuid: 'file-without-url', file_name: 'lost-report.pdf' }],
    }],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /attachment "lost-report\.pdf" has no downloadable URL/);
  assert.match(error.error, /no matching archiveable file was found/);
  assert.equal(harness.handoffs.length, 0, 'an uncovered attachment must block the archive handoff');
});

test('accepts a listed message file without a URL when the sandbox contains a unique matching file', async () => {
  const conversation = {
    uuid: 'conversation-file-sandbox-fallback',
    name: 'Sandbox attachment fallback',
    current_leaf_message_uuid: 'user-message',
    chat_messages: [{
      uuid: 'user-message',
      parent_message_uuid: ROOT,
      sender: 'human',
      content: [{ type: 'text', text: 'Please keep the report.' }],
      files: [{ file_uuid: 'file-without-url', file_name: 'report.txt' }],
    }],
  };
  const harness = createHarness(conversation, {
    sandboxFiles: [{ path: 'uploads/report.txt', content_type: 'text/plain' }],
    sandboxContents: { 'uploads/report.txt': 'Report contents' },
  });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;

  assert.equal(handoff.conversations[0].assets.length, 1);
  assert.equal(handoff.conversations[0].assets[0].source_path, 'uploads/report.txt');
  harness.finishFirstHandoff({ ok: true });
});

test('accepts a listed message file without a URL when extracted attachment text is preserved', async () => {
  const conversation = {
    uuid: 'conversation-file-extracted-fallback',
    name: 'Extracted attachment fallback',
    current_leaf_message_uuid: 'user-message',
    chat_messages: [{
      uuid: 'user-message',
      parent_message_uuid: ROOT,
      sender: 'human',
      content: [{ type: 'text', text: 'Please keep the notes.' }],
      files: [{ file_uuid: 'notes-file', file_name: 'notes.txt' }],
      attachments: [{ file_name: 'notes.txt', extracted_content: 'Notes content' }],
    }],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;

  assert.equal(handoff.conversations[0].assets.length, 1);
  assert.equal(Buffer.from(handoff.conversations[0].assets[0].base64, 'base64').toString('utf8'), 'Notes content');
  harness.finishFirstHandoff({ ok: true });
});


test('does not download or archive sandbox files only referenced by an abandoned branch', async () => {
  const conversation = {
    uuid: 'conversation-branch-assets',
    name: 'Active versus abandoned branch files',
    current_leaf_message_uuid: 'active-answer',
    chat_messages: [
      {
        uuid: 'root-user',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: 'Generate a current result.' }],
      },
      {
        uuid: 'active-answer',
        parent_message_uuid: 'root-user',
        sender: 'assistant',
        content: [{ type: 'tool_result', content: 'Created outputs/current-result.txt' }],
      },
      {
        uuid: 'abandoned-answer',
        parent_message_uuid: 'root-user',
        sender: 'assistant',
        content: [{ type: 'tool_result', content: 'Created outputs/abandoned-result.txt' }],
      },
    ],
  };
  const sandboxFiles = [
    { path: 'outputs/current-result.txt', content_type: 'text/plain' },
    { path: 'outputs/abandoned-result.txt', content_type: 'text/plain' },
  ];
  const harness = createHarness(conversation, {
    sandboxFiles,
    sandboxContents: {
      'outputs/current-result.txt': 'Current branch result',
      'outputs/abandoned-result.txt': 'Abandoned branch result',
    },
  });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;
  const assets = handoff.conversations[0].assets;
  const sandboxDownloads = harness.requests.filter((url) => url.includes('/wiggle/download-file?path='));

  assert.deepEqual(Array.from(assets, (asset) => asset.source_path), ['outputs/current-result.txt']);
  assert.equal(sandboxDownloads.some((url) => url.includes('abandoned-result.txt')), false,
    'an asset referenced only by the abandoned branch must not be downloaded');
  assert.equal(Buffer.from(assets[0].base64, 'base64').toString('utf8'), 'Current branch result');

  harness.finishFirstHandoff({ ok: true });
});

test('requires an explicit path when multiple sandbox files share a basename', async () => {
  const conversation = {
    uuid: 'conversation-ambiguous-paths',
    name: 'Ambiguous sandbox basename',
    current_leaf_message_uuid: 'active-answer',
    chat_messages: [
      {
        uuid: 'root-user',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: 'Prepare the reports.' }],
      },
      {
        uuid: 'active-answer',
        parent_message_uuid: 'root-user',
        sender: 'assistant',
        content: [{ type: 'text', text: 'The report.txt file is ready.' }],
      },
    ],
  };
  const sandboxFiles = [
    { path: 'outputs/first/report.txt', content_type: 'text/plain' },
    { path: 'outputs/second/report.txt', content_type: 'text/plain' },
  ];
  const harness = createHarness(conversation, {
    sandboxFiles,
    sandboxContents: {
      'outputs/first/report.txt': 'First report',
      'outputs/second/report.txt': 'Second report',
    },
  });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;
  assert.equal(handoff.conversations[0].assets.length, 0,
    'ambiguous sandbox assets must not be included based on basename-only mentions');
  assert.equal(harness.requests.some((url) => url.includes('/wiggle/download-file?path=')), false,
    'ambiguous, unreferenced sandbox files should not be downloaded');

  harness.finishFirstHandoff({ ok: true });
});


test('does not associate a same-named sandbox file with a direct attachment unless its path is explicit', async () => {
  const url = 'https://assets.example/photo.png';
  const conversation = {
    uuid: 'conversation-direct-sandbox-collision',
    name: 'Direct and sandbox same-name collision',
    current_leaf_message_uuid: 'assistant-answer',
    chat_messages: [
      {
        uuid: 'user-question',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: 'Please review photo.png.' }],
        files: [{
          file_uuid: 'direct-photo-id',
          file_name: 'photo.png',
          preview_url: url,
          mime_type: 'image/png',
        }],
      },
      {
        uuid: 'assistant-answer',
        parent_message_uuid: 'user-question',
        sender: 'assistant',
        content: [{ type: 'text', text: 'I reviewed photo.png.' }],
      },
    ],
  };
  const harness = createHarness(conversation, {
    assetResponses: { [url]: { content: 'direct attachment bytes', contentType: 'image/png' } },
    sandboxFiles: [{ path: 'outputs/photo.png', content_type: 'image/png' }],
    sandboxContents: { 'outputs/photo.png': 'different sandbox file bytes' },
  });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;
  const assets = handoff.conversations[0].assets;

  assert.equal(assets.length, 1, 'the ambiguous sandbox copy should not be archived by basename alone');
  assert.equal(assets[0].source, 'message');
  assert.equal(Buffer.from(assets[0].base64, 'base64').toString('utf8'), 'direct attachment bytes');
  assert.equal(harness.requests.some((request) => request.includes('outputs/photo.png')), false,
    'the unrelated same-named sandbox file should not be downloaded');

  harness.finishFirstHandoff({ ok: true });
});

test('includes a same-named sandbox file when the exact path is explicitly referenced', async () => {
  const conversation = {
    uuid: 'conversation-explicit-sandbox-path',
    name: 'Explicit sandbox file reference',
    current_leaf_message_uuid: 'assistant-answer',
    chat_messages: [
      {
        uuid: 'user-question',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: 'Please inspect photo.png.' }],
        files: [{
          file_uuid: 'direct-photo-id',
          file_name: 'photo.png',
          preview_url: 'https://assets.example/explicit-photo.png',
          mime_type: 'image/png',
        }],
      },
      {
        uuid: 'assistant-answer',
        parent_message_uuid: 'user-question',
        sender: 'assistant',
        content: [{ type: 'text', text: 'The generated output is at outputs/photo.png.' }],
      },
    ],
  };
  const harness = createHarness(conversation, {
    assetResponses: { 'https://assets.example/explicit-photo.png': { content: 'direct attachment bytes' } },
    sandboxFiles: [{ path: 'outputs/photo.png', content_type: 'image/png' }],
    sandboxContents: { 'outputs/photo.png': 'different sandbox file bytes' },
  });

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;

  assert.equal(handoff.conversations[0].assets.length, 2);
  assert.deepEqual(
    Array.from(handoff.conversations[0].assets, (asset) => asset.source),
    ['message', 'sandbox'],
  );
  harness.finishFirstHandoff({ ok: true });
});


test('refuses detailed Claude payloads without a valid conversation UUID', async () => {
  const conversation = {
    uuid: 'conversation-1',
    name: 'Payload identity check',
    current_leaf_message_uuid: 'message-1',
    chat_messages: [{
      uuid: 'message-1',
      parent_message_uuid: ROOT,
      sender: 'human',
      content: [{ type: 'text', text: 'hello' }],
    }],
  };

  for (const [label, response, expected] of [
    ['missing UUID', { name: 'Payload identity check', chat_messages: conversation.chat_messages }, /without a valid UUID/],
    ['blank UUID', { ...conversation, uuid: '   ' }, /without a valid UUID/],
    ['non-string UUID', { ...conversation, uuid: 123 }, /without a valid UUID/],
  ]) {
    const harness = createHarness(conversation, { fullConversationResponse: response });
    harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
    const error = await harness.errorProgress;

    assert.match(error.error, expected, label);
    assert.equal(harness.handoffs.length, 0, `payload with ${label} must not reach GitHub`);
  }
});


test('refuses an active lineage whose leaf has no parent pointer', async () => {
  const conversation = {
    uuid: 'conversation-missing-parent-pointer',
    name: 'Missing parent pointer',
    current_leaf_message_uuid: 'active-leaf',
    chat_messages: [
      {
        uuid: 'root-user',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: 'Original request' }],
      },
      {
        uuid: 'active-leaf',
        sender: 'assistant',
        content: [{ type: 'text', text: 'Response with missing parent pointer' }],
      },
    ],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /message "active-leaf" has no parent_message_uuid/);
  assert.match(error.error, /active lineage cannot be verified back to the root/);
  assert.equal(harness.handoffs.length, 0, 'an unverified active chain must not reach GitHub');
});

test('refuses an active lineage whose intermediate message has no parent pointer', async () => {
  const conversation = {
    uuid: 'conversation-missing-intermediate-parent',
    name: 'Missing intermediate parent pointer',
    current_leaf_message_uuid: 'active-leaf',
    chat_messages: [
      {
        uuid: 'root-user',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: 'Original request' }],
      },
      {
        uuid: 'middle-message',
        sender: 'assistant',
        content: [{ type: 'text', text: 'Intermediate reply with missing parent' }],
      },
      {
        uuid: 'active-leaf',
        parent_message_uuid: 'middle-message',
        sender: 'human',
        content: [{ type: 'text', text: 'Follow-up' }],
      },
    ],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const error = await harness.errorProgress;

  assert.match(error.error, /message "middle-message" has no parent_message_uuid/);
  assert.equal(harness.handoffs.length, 0, 'a truncated intermediate chain must not be exported');
});


test('preserves unknown content block metadata instead of silently dropping it', async () => {
  const largePayload = 'A'.repeat(4096);
  const conversation = {
    uuid: 'conversation-unknown-block',
    name: 'Unknown content block preservation',
    current_leaf_message_uuid: 'assistant-message',
    chat_messages: [
      {
        uuid: 'user-message',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: 'Review these results.' }],
      },
      {
        uuid: 'assistant-message',
        parent_message_uuid: 'user-message',
        sender: 'assistant',
        content: [
          { type: 'text', text: 'The result is available.' },
          {
            type: 'future_media_block',
            media_type: 'audio/wav',
            data: largePayload,
            transcript_id: 'transcript-123',
          },
          {
            type: 'citation_reference',
            title: 'Primary source',
            url: 'https://example.com/source',
            cited_text: 'The source supports the result.',
          },
        ],
      },
    ],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;
  const rendered = handoff.conversations[0].messages[1].content;

  assert.match(rendered, /### Claude content block: future_media_block\n\n```json/);
  assert.match(rendered, /audio\/wav/);
  assert.match(rendered, /omitted inline payload: 4096 characters/);
  assert.equal(rendered.includes(largePayload), false, 'large binary payload must not be dumped into Markdown');
  assert.match(rendered, /Claude content block: citation_reference/);
  assert.match(rendered, /https:\/\/example\.com\/source/);
  assert.match(rendered, /The source supports the result/);

  harness.finishFirstHandoff({ ok: true });
});

test('never renders thinking blocks even when they expose generic text fields', async () => {
  const conversation = {
    uuid: 'conversation-thinking-safety',
    name: 'Thinking exclusion check',
    current_leaf_message_uuid: 'assistant-message',
    chat_messages: [
      {
        uuid: 'user-message',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: 'Answer this.' }],
      },
      {
        uuid: 'assistant-message',
        parent_message_uuid: 'user-message',
        sender: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private reasoning A', text: 'private reasoning B', content: 'private reasoning C' },
          { type: 'text', text: 'The final answer.' },
        ],
      },
    ],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;
  const rendered = handoff.conversations[0].messages[1].content;

  assert.match(rendered, /The final answer/);
  assert.equal(rendered.includes('private reasoning A'), false);
  assert.equal(rendered.includes('private reasoning B'), false);
  assert.equal(rendered.includes('private reasoning C'), false);

  harness.finishFirstHandoff({ ok: true });
});


test('redacts oversized media payloads nested inside tool results', async () => {
  const binaryPayload = 'B'.repeat(8192);
  const conversation = {
    uuid: 'conversation-tool-result-media',
    name: 'Tool result with inline media',
    current_leaf_message_uuid: 'assistant-message',
    chat_messages: [
      {
        uuid: 'user-message',
        parent_message_uuid: ROOT,
        sender: 'human',
        content: [{ type: 'text', text: 'Generate a chart.' }],
      },
      {
        uuid: 'assistant-message',
        parent_message_uuid: 'user-message',
        sender: 'assistant',
        content: [
          {
            type: 'tool_result',
            name: 'render_chart',
            content: [
              { type: 'text', text: 'Chart generated.' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: binaryPayload } },
            ],
          },
        ],
      },
    ],
  };
  const harness = createHarness(conversation);

  harness.onMessage({ type: 'startSync', limit: 'all' }, {}, () => {});
  const handoff = await harness.firstHandoff;
  const rendered = handoff.conversations[0].messages[1].content;

  assert.match(rendered, /Tool result: render_chart/);
  assert.match(rendered, /Chart generated/);
  assert.match(rendered, /omitted inline payload: 8192 characters/);
  assert.equal(rendered.includes(binaryPayload), false, 'binary data should not inflate the Markdown transcript');

  harness.finishFirstHandoff({ ok: true });
});
