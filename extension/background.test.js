import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const MARKER_NONCE = '0123456789abcdef0123456789abcdef';
const marker = (index) => `[[AI_ARCHIVE_INLINE_ASSET:${MARKER_NONCE}:${index}]]`;

const backgroundPath = fileURLToPath(new URL('./background.js', import.meta.url));
const backgroundSource = await readFile(backgroundPath, 'utf8');

function loadBackgroundWithPendingGitHubRequest() {
  const listeners = [];
  const chrome = {
    storage: {
      local: {
        get: async () => {
          settingsReadCount += 1;
          return {
          github_owner: 'example-owner',
          github_repo: 'example-archive',
          github_token: 'test-token',
          archive_account: 'personal',
          };
        },
      },
    },
    runtime: {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
      sendMessage() {
        return Promise.resolve();
      },
    },
  };

  vm.runInNewContext(backgroundSource, {
    chrome,
    AbortController,
    fetch: () => new Promise(() => {}),
  }, { filename: 'extension/background.js' });

  assert.equal(listeners.length, 1, 'background service worker should register its message listener');
  return listeners[0];
}

test('ignores duplicate normalized sync messages while a GitHub sync is running', () => {
  const onMessage = loadBackgroundWithPendingGitHubRequest();

  const firstReturn = onMessage(
    { type: 'syncNormalized', conversations: [] },
    {},
    () => {},
  );
  assert.equal(firstReturn, true, 'the first sync should keep its response channel open');

  let duplicateResponse;
  const duplicateReturn = onMessage(
    { type: 'syncNormalized', conversations: [] },
    {},
    (response) => { duplicateResponse = response; },
  );

  assert.equal(duplicateReturn, false, 'a duplicate sync should not start a second async operation');
  assert.equal(duplicateResponse?.ok, true);
  assert.equal(duplicateResponse?.alreadyRunning, true);
});


function loadBackgroundAssetHelpers() {
  const listeners = [];
  const chrome = {
    storage: { local: { get: async () => ({}) } },
    runtime: {
      onMessage: {
        addListener(listener) { listeners.push(listener); },
      },
      sendMessage() { return Promise.resolve(); },
    },
  };
  const sourceWithTestHooks = `${backgroundSource}
globalThis.__testHooks = {
  assetMatchesMessage,
  findMessageAssets,
  assetPath,
  normalizeAssetList,
  attachmentMarkdown,
  conversationMarkdown,
  conversationPath,
  indexEntry,
  sha256,
};
`;
  const context = {
    chrome, AbortController,
    fetch: () => new Promise(() => {}),
    TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, btoa, atob,
  };
  vm.runInNewContext(sourceWithTestHooks, context, { filename: 'extension/background.js' });
  assert.equal(listeners.length, 1);
  return context.__testHooks;
}

test('does not associate a message-scoped asset with another message that has the same filename', () => {
  const { assetMatchesMessage } = loadBackgroundAssetHelpers();
  const asset = {
    name: 'report.txt',
    file_uuid: 'file-a',
    message_external_id: 'assistant-message',
  };
  const otherMessage = {
    external_id: 'user-message',
    files: [{ file_uuid: 'file-a', file_name: 'report.txt' }],
    metadata: { content: [{ type: 'text', text: 'report.txt' }] },
  };

  assert.equal(assetMatchesMessage(asset, otherMessage, [asset]), false);
  assert.equal(assetMatchesMessage(asset, { external_id: 'assistant-message' }, [asset]), true);
});

test('does not use a filename fallback when a message exposes a different file UUID', () => {
  const { assetMatchesMessage } = loadBackgroundAssetHelpers();
  const asset = { name: 'report.txt', file_uuid: 'file-a' };
  const message = {
    external_id: 'message-1',
    files: [{ file_uuid: 'file-b', file_name: 'report.txt' }],
  };

  assert.equal(assetMatchesMessage(asset, message, [asset]), false);
});

test('associates same-named sandbox assets only when their full paths identify them', () => {
  const { findMessageAssets } = loadBackgroundAssetHelpers();
  const first = { name: 'report.txt', source_path: 'outputs/first/report.txt' };
  const second = { name: 'report.txt', source_path: 'outputs/second/report.txt' };
  const allAssets = [first, second];
  const firstMessage = {
    external_id: 'assistant-1',
    metadata: { content: [{ type: 'tool_use', input: { command: 'cat outputs/first/report.txt' } }] },
  };
  const ambiguousMessage = {
    external_id: 'assistant-2',
    metadata: { content: [{ type: 'text', text: 'The report.txt file is ready.' }] },
  };

  assert.deepEqual(findMessageAssets(firstMessage, allAssets), [first]);
  assert.deepEqual(findMessageAssets(ambiguousMessage, allAssets), []);
});


function makeBackgroundSyncHarness({ indexText, indexEncoding = 'base64', advanceBranchOnRecheck = false, missingPaths = [], failOnce = null, patchOutcome = null, cancelAt = null, blobDelayMs = 0 }) {
  const listeners = [];
  const requests = [];
  const baseSha = 'base-commit';
  const concurrentSha = 'concurrent-commit';
  let masterRefReads = 0;
  let blobCount = 0;
  let injectedFailures = 0;
  let cancelTriggered = false;
  let currentHeadSha = baseSha;
  let settingsReadCount = 0;
  let activeBlobRequests = 0;
  let maxActiveBlobRequests = 0;
  const chrome = {
    storage: {
      local: {
        get: async () => {
          settingsReadCount += 1;
          return {
            github_owner: 'example-owner',
            github_repo: 'example-archive',
            github_token: 'test-token',
            archive_account: 'personal',
          };
        },
      },
    },
    runtime: {
      onMessage: {
        addListener(listener) { listeners.push(listener); },
      },
      sendMessage() { return Promise.resolve(); },
    },
  };

  const response = (body, status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  });

  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const method = options.method || 'GET';
    requests.push({ pathname, method, body: options.body ? JSON.parse(options.body) : null });

    if (cancelAt && !cancelTriggered && method === cancelAt.method && pathname.endsWith(cancelAt.pathSuffix)) {
      cancelTriggered = true;
      listeners[0]({ type: 'cancelSync' }, {}, () => {});
    }

    if (failOnce && injectedFailures < (failOnce.times || 1) && method === failOnce.method && pathname.endsWith(failOnce.pathSuffix)) {
      injectedFailures += 1;
      if (failOnce.network) throw new TypeError('Failed to fetch');
      return response({ message: failOnce.message || 'Temporary injected failure' }, failOnce.status || 503, failOnce.headers || {});
    }

    if (pathname.endsWith('/git/ref/heads/main')) {
      return response({ message: 'Not Found' }, 404);
    }
    if (pathname.endsWith('/git/ref/heads/master') && method === 'GET') {
      masterRefReads += 1;
      const sha = advanceBranchOnRecheck && masterRefReads > 1 ? concurrentSha : currentHeadSha;
      return response({ ref: 'refs/heads/master', object: { sha } });
    }
    if (pathname.endsWith('/git/commits/base-commit') && method === 'GET') {
      return response({ sha: baseSha, tree: { sha: 'base-tree' } });
    }
    if (pathname.endsWith('/git/trees/base-tree') && method === 'GET') {
      let indexedPaths = [];
      try {
        const parsedIndex = JSON.parse(indexText || '{}');
        indexedPaths = (parsedIndex.conversations || []).flatMap((entry) => [
          entry.path,
          ...(Array.isArray(entry.assets) ? entry.assets.map((asset) => asset?.path) : []),
        ]).filter(Boolean);
      } catch {}
      const missing = new Set(missingPaths);
      return response({
        sha: 'base-tree',
        tree: [...new Set(indexedPaths)].filter((path) => !missing.has(path)).map((path) => ({ path, type: 'blob', mode: '100644', sha: `existing-${path}` })),
      });
    }
    if (pathname.endsWith('/contents/archive/index.json') && method === 'GET') {
      if (indexText == null) return response({ message: 'Not Found' }, 404);
      if (indexEncoding === 'none') {
        return response({
          sha: 'large-index-blob',
          content: '',
          encoding: 'none',
          size: Buffer.byteLength(indexText, 'utf8'),
        });
      }
      return response({ content: Buffer.from(indexText, 'utf8').toString('base64'), encoding: 'base64' });
    }
    if (pathname.endsWith('/git/blobs/large-index-blob') && method === 'GET') {
      return response({
        encoding: 'base64',
        content: Buffer.from(indexText, 'utf8').toString('base64'),
      });
    }
    if (pathname.endsWith('/git/blobs') && method === 'POST') {
      activeBlobRequests += 1;
      maxActiveBlobRequests = Math.max(maxActiveBlobRequests, activeBlobRequests);
      try {
        if (blobDelayMs) await new Promise((resolve) => setTimeout(resolve, blobDelayMs));
        blobCount += 1;
        return response({ sha: `blob-${blobCount}` });
      } finally {
        activeBlobRequests -= 1;
      }
    }
    if (pathname.endsWith('/git/trees') && method === 'POST') {
      return response({ sha: 'new-tree' });
    }
    if (pathname.endsWith('/git/commits') && method === 'POST') {
      return response({ sha: 'new-commit' });
    }
    if (pathname.endsWith('/git/refs/heads/master') && method === 'PATCH') {
      if (patchOutcome === 'apply-then-abort') {
        currentHeadSha = 'new-commit';
        const error = new Error('The response was interrupted after GitHub accepted the update');
        error.name = 'AbortError';
        throw error;
      }
      if (patchOutcome === 'abort-before-apply') {
        const error = new Error('The request was aborted before GitHub applied the update');
        error.name = 'AbortError';
        throw error;
      }
      currentHeadSha = 'new-commit';
      return response({ ref: 'refs/heads/master', object: { sha: 'new-commit' } });
    }
    throw new Error(`Unexpected test request: ${method} ${pathname}`);
  };

  const context = {
    chrome, fetch, AbortController, TextEncoder, TextDecoder, Uint8Array,
    Blob, Response, CompressionStream, crypto: webcrypto, btoa, atob, setTimeout, clearTimeout,
  };
  // Keep retry backoff instant in tests; the retry policy itself is unchanged.
  const fastSource = backgroundSource.replace('const GITHUB_RETRY_BASE_DELAY_MS = 1000;', 'const GITHUB_RETRY_BASE_DELAY_MS = 1;');
  vm.runInNewContext(`${fastSource}
globalThis.__testHooks = {
  sync, assetPath, normalizeAssetList, conversationMarkdown,
  conversationPath, indexEntry, sha256,
};
`, context, { filename: 'extension/background.js' });

  return {
    sync: context.__testHooks.sync,
    hooks: context.__testHooks,
    requests,
    metrics() {
      return { settingsReadCount, maxActiveBlobRequests, blobCount };
    },
  };
}

function sampleConversation() {
  return [{
    external_id: 'conversation-123456',
    title: 'Sync test',
    model: 'test-model',
    source_created_at: '2026-10-26T08:00:00.000Z',
    source_updated_at: '2026-10-26T09:00:00.000Z',
    message_count: 1,
    messages: [{ external_id: 'message-1', role: 'user', content: 'hello', files: [], attachments: [] }],
    assets: [],
  }];
}

test('refuses to overwrite a corrupt archive index', async () => {
  const harness = makeBackgroundSyncHarness({ indexText: '{"version":2,"conversations":' });

  await assert.rejects(
    harness.sync(sampleConversation(), () => {}),
    /archive\/index\.json is invalid JSON/,
  );

  assert.equal(harness.requests.some((request) => request.method === 'POST'), false, 'no Git objects should be created');
  assert.equal(harness.requests.some((request) => request.method === 'PATCH'), false, 'the branch must not be changed');
});

test('refuses an archive index with an invalid structure', async () => {
  const harness = makeBackgroundSyncHarness({ indexText: JSON.stringify({ version: 2, conversations: {} }) });

  await assert.rejects(
    harness.sync(sampleConversation(), () => {}),
    /archive\/index\.json has an invalid structure/,
  );

  assert.equal(harness.requests.some((request) => request.method === 'POST'), false);
  assert.equal(harness.requests.some((request) => request.method === 'PATCH'), false);
});

test('does not publish a sync built from a stale branch head', async () => {
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }),
    advanceBranchOnRecheck: true,
  });

  await assert.rejects(
    harness.sync(sampleConversation(), () => {}),
    /GitHub branch changed during this sync/,
  );

  assert.equal(
    harness.requests.some((request) => request.method === 'PATCH'),
    false,
    'a concurrent commit must not be overwritten by this sync',
  );
});


test('same-named message-scoped attachments render against their own messages', () => {
  const { normalizeAssetList, conversationMarkdown } = loadBackgroundAssetHelpers();
  const conversation = {
    external_id: 'conversation-attachment-links',
    title: 'Same filename links',
    model: 'test',
    message_count: 2,
    messages: [
      {
        external_id: 'user-message',
        role: 'user',
        content: 'First report',
        files: [{ file_name: 'report.txt' }],
        attachments: [],
      },
      {
        external_id: 'assistant-message',
        role: 'assistant',
        content: 'Second report',
        files: [{ file_name: 'report.txt' }],
        attachments: [],
      },
    ],
    assets: [
      {
        name: 'report.txt',
        mime: 'text/plain',
        base64: btoa('First report content'),
        size: 19,
        sha256: '11111111' + 'a'.repeat(56),
        source: 'message',
        message_external_id: 'user-message',
      },
      {
        name: 'report.txt',
        mime: 'text/plain',
        base64: btoa('Second report content'),
        size: 20,
        sha256: '22222222' + 'b'.repeat(56),
        source: 'message',
        message_external_id: 'assistant-message',
      },
    ],
  };
  const normalized = normalizeAssetList(conversation, 'claude', 'personal');
  const markdown = conversationMarkdown(conversation, 'claude', 'personal', normalized.byKey, normalized.assets);
  const firstAsset = normalized.assets.find((asset) => asset.message_external_id === 'user-message');
  const secondAsset = normalized.assets.find((asset) => asset.message_external_id === 'assistant-message');
  const firstLink = `[report.txt](assets/${firstAsset.path.split('/assets/').pop()})`;
  const secondLink = `[report.txt](assets/${secondAsset.path.split('/assets/').pop()})`;
  const firstSection = markdown.slice(markdown.indexOf('## You'), markdown.indexOf('\n---\n'));
  const secondSection = markdown.slice(markdown.indexOf('## Claude'));

  assert.ok(firstSection.includes(firstLink), 'the user message should link to its own report');
  assert.ok(!firstSection.includes(secondLink), 'the user message must not link to another message’s same-named report');
  assert.ok(secondSection.includes(secondLink), 'the assistant message should link to its own report');
  assert.ok(!secondSection.includes(firstLink), 'the assistant message must not pick the first global filename match');
});

test('asset paths distinguish conversation IDs that share the same first eight characters', () => {
  const { assetPath } = loadBackgroundAssetHelpers();
  const asset = { name: 'shared.txt', sha256: 'abcd1234' + 'c'.repeat(56) };
  const first = assetPath({ external_id: 'conversation-alpha' }, asset, 'claude', 'personal', new Set());
  const second = assetPath({ external_id: 'conversation-beta' }, asset, 'claude', 'personal', new Set());

  assert.notEqual(first, second, 'same-prefixed conversation IDs must not share an asset directory');
});

async function buildIndexEntry(hooks, conversation) {
  const provider = 'claude';
  const account = 'personal';
  const accountSlug = 'personal';
  const normalized = hooks.normalizeAssetList(conversation, provider, accountSlug);
  const path = hooks.conversationPath(conversation, provider, accountSlug);
  const markdown = hooks.conversationMarkdown(conversation, provider, account, normalized.byKey, normalized.assets);
  const entry = hooks.indexEntry(conversation, path, provider, account, normalized.assets);
  const searchText = entry.search_text;
  entry.search_text_sha256 = await hooks.sha256(searchText);
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([searchText]).stream().pipeThrough(new CompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    entry.search_text_encoding = 'gzip-base64';
    entry.search_text_gzip = Buffer.from(bytes).toString('base64');
    delete entry.search_text;
  } else {
    entry.search_text_encoding = 'plain';
  }
  entry.content_sha256 = await hooks.sha256(markdown);
  return { entry, normalized, markdown };
}

test('removing an attachment deletes its old asset path in the same commit', async () => {
  const conversation = sampleConversation()[0];
  const hooks = loadBackgroundAssetHelpers();
  const previousAsset = {
    path: 'archive/conversations/claude/personal/assets/conversation-123456/abcd1234-old.txt',
    sha256: 'abcd1234' + 'd'.repeat(56),
    size: 10,
    mime: 'text/plain',
    name: 'old.txt',
  };
  const previous = {
    id: conversation.external_id,
    provider: 'claude',
    account: 'personal',
    path: hooks.conversationPath(conversation, 'claude', 'personal'),
    title: conversation.title,
    model: conversation.model,
    created_at: conversation.source_created_at,
    updated_at: conversation.source_updated_at,
    message_count: conversation.message_count,
    assets: [previousAsset],
    format_version: 4,
    content_sha256: 'previous-content-hash',
  };
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [previous] }),
  });

  await harness.sync([conversation], () => {});
  const treeRequest = harness.requests.find((request) => request.pathname.endsWith('/git/trees') && request.method === 'POST');
  assert.ok(treeRequest, 'the changed conversation should create a new tree');
  assert.ok(
    treeRequest.body.tree.some((entry) => entry.path === previousAsset.path && entry.sha === null),
    'the removed asset must be deleted in the same commit as the updated Markdown/index',
  );
});

test('renaming a conversation updates its Markdown path without deleting a still-referenced asset', async () => {
  const hooks = loadBackgroundAssetHelpers();
  const oldConversation = sampleConversation()[0];
  oldConversation.title = 'Old conversation title';
  oldConversation.assets = [{
    name: 'diagram.png',
    mime: 'image/png',
    base64: btoa('image bytes'),
    size: 11,
    sha256: 'abcd5678' + 'e'.repeat(56),
    source: 'message',
    message_external_id: 'message-1',
  }];
  const { entry: previous } = await buildIndexEntry(hooks, oldConversation);
  const currentConversation = { ...oldConversation, title: 'Renamed conversation' };
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [previous] }),
  });

  await harness.sync([currentConversation], () => {});
  const treeRequest = harness.requests.find((request) => request.pathname.endsWith('/git/trees') && request.method === 'POST');
  assert.ok(treeRequest);
  const entries = treeRequest.body.tree;
  const assetPath = previous.assets[0].path;
  assert.ok(entries.some((entry) => entry.path === previous.path && entry.sha === null), 'old Markdown path must be deleted');
  assert.ok(entries.some((entry) => entry.path.includes('Renamed-conversation--') && entry.sha), 'new Markdown path must be written');
  assert.equal(entries.some((entry) => entry.path === assetPath && entry.sha === null), false, 'still-referenced asset must not be deleted');
  assert.equal(entries.some((entry) => entry.path === assetPath && entry.sha), false, 'unchanged asset should not need another blob upload');
});

test('re-syncing identical conversation data creates no commit', async () => {
  const hooks = loadBackgroundAssetHelpers();
  const conversation = sampleConversation()[0];
  const { entry } = await buildIndexEntry(hooks, conversation);
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [entry] }),
  });

  const result = await harness.sync([conversation], () => {});
  assert.equal(result.changed, 0);
  assert.equal(result.commit, null);
  assert.equal(harness.requests.some((request) => request.pathname.endsWith('/git/blobs') && request.method === 'POST'), false);
  assert.equal(harness.requests.some((request) => request.pathname.endsWith('/git/trees') && request.method === 'POST'), false);
  assert.equal(harness.requests.some((request) => request.method === 'PATCH'), false);
});


test('repairs a missing asset for a selected conversation by uploading it again', async () => {
  const hooks = loadBackgroundAssetHelpers();
  const conversation = sampleConversation()[0];
  conversation.assets = [{
    name: 'diagram.png',
    mime: 'image/png',
    base64: btoa('image bytes'),
    size: 11,
    sha256: 'abcd5678' + 'e'.repeat(56),
    source: 'message',
    message_external_id: 'message-1',
  }];
  const { entry } = await buildIndexEntry(hooks, conversation);
  const missingAssetPath = entry.assets[0].path;
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [entry] }),
    missingPaths: [missingAssetPath],
  });

  const result = await harness.sync([conversation], () => {});
  assert.equal(result.changed, 1, 'the missing asset should mark the conversation as changed');
  assert.ok(harness.requests.some((request) => request.pathname.endsWith('/git/blobs') && request.method === 'POST'), 'the missing asset should be uploaded');
  const treeRequest = harness.requests.find((request) => request.pathname.endsWith('/git/trees') && request.method === 'POST');
  assert.ok(treeRequest.body.tree.some((item) => item.path === missingAssetPath && item.sha), 'the repaired asset should be written into the new tree');
});

test('refuses to publish an index while an unselected conversation still references a missing file', async () => {
  const hooks = loadBackgroundAssetHelpers();
  const unselected = sampleConversation()[0];
  unselected.external_id = 'unselected-conversation';
  unselected.title = 'Unselected conversation';
  const { entry } = await buildIndexEntry(hooks, unselected);
  const missingAssetPath = 'archive/conversations/claude/personal/assets/unselected-conversation/missing.png';
  entry.assets = [{
    path: missingAssetPath,
    name: 'missing.png',
    sha256: 'missing',
    size: 10,
    mime: 'image/png',
  }];
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [entry] }),
    missingPaths: [missingAssetPath],
  });

  await assert.rejects(
    harness.sync(sampleConversation(), () => {}),
    /Archive integrity check failed:.*missing\.png.*Sync that conversation to repair it/,
  );
  assert.equal(harness.requests.some((request) => request.method === 'PATCH'), false, 'the broken index must not be published');
});


test('conversation Markdown paths distinguish IDs with the same first eight characters', () => {
  const { conversationPath } = loadBackgroundAssetHelpers();
  const first = conversationPath(
    { external_id: 'abcdefgh-conversation-one', title: 'Same title' },
    'claude',
    'personal',
  );
  const second = conversationPath(
    { external_id: 'abcdefgh-conversation-two', title: 'Same title' },
    'claude',
    'personal',
  );

  assert.notEqual(first, second, 'same-title conversations must not collide on an eight-character ID prefix');
  assert.match(first, /abcdefgh-conversation-one/);
  assert.match(second, /abcdefgh-conversation-two/);
});

test('conversation Markdown paths distinguish IDs that normalize to the same slug', () => {
  const { conversationPath } = loadBackgroundAssetHelpers();
  const first = conversationPath({ external_id: 'conversation/a', title: 'Same title' }, 'claude', 'personal');
  const second = conversationPath({ external_id: 'conversation:a', title: 'Same title' }, 'claude', 'personal');

  assert.notEqual(first, second, 'normalized IDs need a stable uniqueness suffix');
});


test('recovers after a persistent GitHub upload failure without publishing a partial archive', async () => {
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }),
    // More consecutive failures than the retry budget: the sync must give up safely.
    failOnce: { method: 'POST', pathSuffix: '/git/blobs', status: 503, times: 3 },
  });

  await assert.rejects(
    harness.sync(sampleConversation(), () => {}),
    /GitHub 503:.*Temporary injected failure/,
  );

  assert.equal(
    harness.requests.some((request) => request.method === 'PATCH'),
    false,
    'a failed upload must never move the branch ref',
  );

  const retry = await harness.sync(sampleConversation(), () => {});
  assert.equal(retry.changed, 1, 'a later retry should rebuild and publish the conversation');
  assert.equal(retry.commit, 'new-commit');
  assert.equal(
    harness.requests.some((request) => request.method === 'PATCH'),
    true,
    'the successful retry should publish the completed commit',
  );
});



test('reports success when the final ref update was applied but its response was interrupted', async () => {
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }),
    patchOutcome: 'apply-then-abort',
  });

  const progress = [];
  const result = await harness.sync(sampleConversation(), (event) => progress.push(event));

  assert.equal(result.commit, 'new-commit');
  assert.equal(result.changed, 1);
  assert.ok(
    progress.some((event) => event.stage === 'done' && /GitHub confirms the commit is published/.test(event.message)),
    'the UI should show verified publication rather than cancellation',
  );
  const patchIndex = harness.requests.findIndex((request) => request.method === 'PATCH');
  assert.ok(
    harness.requests.some((request, index) => index > patchIndex && request.pathname.endsWith('/git/ref/heads/master') && request.method === 'GET'),
    'the code should re-read the ref after the interrupted update',
  );
});

test('keeps cancellation semantics when a ref update was interrupted and the branch stayed unchanged', async () => {
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }),
    patchOutcome: 'abort-before-apply',
  });

  await assert.rejects(
    harness.sync(sampleConversation(), () => {}),
    (error) => error.name === 'AbortError',
  );
  assert.equal(
    harness.requests.some((request) => request.method === 'PATCH'),
    true,
    'the test must interrupt the final ref update',
  );
});

test('cancelling during blob upload does not publish and a later retry can succeed', async () => {
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }),
    cancelAt: { method: 'POST', pathSuffix: '/git/blobs' },
  });

  await assert.rejects(
    harness.sync(sampleConversation(), () => {}),
    /__SYNC_CANCELLED__/,
  );
  assert.equal(
    harness.requests.some((request) => request.method === 'PATCH'),
    false,
    'cancellation during upload must not move the branch head',
  );

  const retry = await harness.sync(sampleConversation(), () => {});
  assert.equal(retry.commit, 'new-commit');
  assert.equal(retry.changed, 1);
});


test('asset paths distinguish conversation IDs that normalize to the same slug', () => {
  const { assetPath } = loadBackgroundAssetHelpers();
  const asset = { name: 'shared.txt', sha256: 'abcd1234' + 'c'.repeat(56) };
  const first = assetPath({ external_id: 'conversation/a' }, asset, 'claude', 'personal', new Set());
  const second = assetPath({ external_id: 'conversation:a' }, asset, 'claude', 'personal', new Set());

  assert.notEqual(first, second, 'normalized conversation IDs must not share an asset directory');
});

test('does not delete a legacy asset path while an unselected conversation still references it', async () => {
  const hooks = loadBackgroundAssetHelpers();
  const selected = sampleConversation()[0];
  const oldAssetPath = 'archive/conversations/claude/personal/assets/conversation-shared/abcd1234-report.txt';
  const previousSelected = {
    id: selected.external_id,
    provider: 'claude',
    account: 'personal',
    path: hooks.conversationPath(selected, 'claude', 'personal'),
    title: selected.title,
    model: selected.model,
    created_at: selected.source_created_at,
    updated_at: selected.source_updated_at,
    message_count: selected.message_count,
    assets: [{ path: oldAssetPath, sha256: 'abcd1234', size: 12, mime: 'text/plain', name: 'report.txt' }],
    format_version: 4,
    content_sha256: 'previous-content-hash',
  };
  const unselected = {
    ...previousSelected,
    id: 'conversation-unselected',
    title: 'Unselected conversation',
    path: hooks.conversationPath({ ...selected, external_id: 'conversation-unselected', title: 'Unselected conversation' }, 'claude', 'personal'),
    assets: [{ path: oldAssetPath, sha256: 'abcd1234', size: 12, mime: 'text/plain', name: 'report.txt' }],
  };
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [previousSelected, unselected] }),
  });

  await harness.sync([selected], () => {});
  const treeRequest = harness.requests.find((request) => request.pathname.endsWith('/git/trees') && request.method === 'POST');
  assert.ok(treeRequest, 'the changed conversation should produce a tree');
  assert.equal(
    treeRequest.body.tree.some((entry) => entry.path === oldAssetPath && entry.sha === null),
    false,
    'the shared path must be preserved for the still-indexed unselected conversation',
  );
});


test('uploads blobs with bounded concurrency and reads settings only once per sync', async () => {
  const conversation = sampleConversation()[0];
  conversation.assets = Array.from({ length: 12 }, (_, index) => {
    const content = `asset payload ${index}`;
    return {
      name: `asset-${index}.txt`,
      mime: 'text/plain',
      base64: btoa(content),
      size: content.length,
      sha256: String(index + 1).repeat(64),
      source: 'sandbox',
      source_path: `outputs/asset-${index}.txt`,
    };
  });
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }),
    blobDelayMs: 8,
  });

  const result = await harness.sync([conversation], () => {});
  const metrics = harness.metrics();

  assert.equal(result.changed, 1);
  assert.ok(metrics.maxActiveBlobRequests > 1, 'independent blobs should upload in parallel');
  assert.ok(metrics.maxActiveBlobRequests <= 4, 'blob uploads must stay within the concurrency limit');
  assert.equal(metrics.settingsReadCount, 1, 'GitHub settings should be read once per sync, not once per request');
  assert.equal(metrics.blobCount, 14, '12 assets, one conversation Markdown file, and one index blob should be created');
  const treeRequest = harness.requests.find((request) => request.pathname.endsWith('/git/trees') && request.method === 'POST');
  assert.equal(treeRequest.body.tree.filter(item => item.sha).length, 14);
});



test('preserves unselected conversations when GitHub omits a large index file from Contents response', async () => {
  const unselectedEntry = {
    id: 'older-conversation',
    provider: 'claude',
    account: 'personal',
    path: 'archive/conversations/claude/personal/older-conversation.md',
    title: 'Older conversation that was not selected',
    model: 'test-model',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    message_count: 2,
    assets: [],
    format_version: 4,
    preview: 'An older preview',
    search_text: 'older conversation search content',
    content_sha256: 'previous-content-hash',
  };
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: [unselectedEntry] });
  const harness = makeBackgroundSyncHarness({ indexText, indexEncoding: 'none' });

  const result = await harness.sync(sampleConversation(), () => {});
  assert.equal(result.changed, 1);

  assert.ok(
    harness.requests.some((request) => request.pathname.endsWith('/git/blobs/large-index-blob') && request.method === 'GET'),
    'the exporter should read the full index via the Git blob endpoint',
  );
  const blobWrites = harness.requests.filter((request) => request.pathname.endsWith('/git/blobs') && request.method === 'POST');
  const nextIndex = JSON.parse(blobWrites.at(-1).body.content);
  assert.ok(
    nextIndex.conversations.some((entry) => entry.id === 'older-conversation'),
    'an unselected conversation must remain in the index after a limited sync',
  );
  assert.ok(
    nextIndex.conversations.some((entry) => entry.id === 'conversation-123456'),
    'the selected conversation should also be included in the next index',
  );
});



test('compacts legacy search text to gzip without rewriting unchanged conversation Markdown', async () => {
  const hooks = loadBackgroundAssetHelpers();
  const conversation = sampleConversation()[0];
  const largeMessageText = 'Searchable repeated conversation phrase. '.repeat(4000);
  conversation.messages[0].content = largeMessageText;

  const { entry } = await buildIndexEntry(hooks, conversation);
  entry.search_text = [conversation.title, ...conversation.messages.map((message) => message.content)].join('\\n');
  delete entry.search_text_encoding;
  delete entry.search_text_gzip;
  delete entry.search_text_sha256;

  const originalSearchLength = entry.search_text.length;
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: [entry] });
  const harness = makeBackgroundSyncHarness({ indexText });

  const result = await harness.sync([conversation], () => {});
  assert.equal(result.changed, 0, 'only the search-cache representation should change');
  assert.ok(result.commit, 'the index-only migration should be committed');

  const blobWrites = harness.requests.filter(
    (request) => request.pathname.endsWith('/git/blobs') && request.method === 'POST',
  );
  assert.equal(blobWrites.length, 1, 'the index should be the only new blob; Markdown must not be rewritten');
  const compactIndex = JSON.parse(blobWrites[0].body.content);
  const compactedEntry = compactIndex.conversations[0];

  assert.equal(compactedEntry.search_text, undefined, 'plain duplicated search text should be removed from the index');
  assert.equal(compactedEntry.search_text_encoding, 'gzip-base64');
  assert.equal(typeof compactedEntry.search_text_gzip, 'string');
  assert.ok(
    compactedEntry.search_text_gzip.length < originalSearchLength,
    'gzip/base64 should be smaller than the original repetitive search text',
  );
  assert.equal(compactedEntry.search_text_sha256.length, 64, 'the uncompressed search text should retain a stable integrity hash');
});


test('renders a shared direct asset in every message that references it', () => {
  const { assetMatchesMessage, findMessageAssets, conversationMarkdown } = loadBackgroundAssetHelpers();
  const asset = {
    name: 'shared-report.png',
    mime: 'image/png',
    file_uuid: 'shared-file-id',
    message_external_id: 'user-message',
    message_external_ids: ['user-message', 'assistant-message'],
    path: 'archive/conversations/claude/personal/assets/conversation/shared-report.png',
    sha256: 'a'.repeat(64),
    size: 17,
  };
  const userMessage = {
    external_id: 'user-message',
    role: 'user',
    content: 'Here is the report.',
    files: [{ file_uuid: 'shared-file-id', file_name: 'shared-report.png' }],
    attachments: [],
    metadata: {},
  };
  const assistantMessage = {
    external_id: 'assistant-message',
    role: 'assistant',
    content: 'I will refer to that same report.',
    files: [{ file_uuid: 'shared-file-id', file_name: 'shared-report.png' }],
    attachments: [],
    metadata: {},
  };
  const allAssets = [asset];
  const assetMap = new Map([['id:shared-file-id', asset], ['name:shared-report.png', asset]]);

  assert.equal(assetMatchesMessage(asset, userMessage, allAssets), true);
  assert.equal(assetMatchesMessage(asset, assistantMessage, allAssets), true);
  assert.deepEqual(findMessageAssets(userMessage, allAssets), [asset]);
  assert.deepEqual(findMessageAssets(assistantMessage, allAssets), [asset]);

  const markdown = conversationMarkdown({
    external_id: 'conversation-shared-attachment',
    title: 'Shared attachment reference',
    messages: [userMessage, assistantMessage],
    message_count: 2,
  }, 'claude', 'personal', assetMap, allAssets);
  const expectedLink = '![shared-report.png](assets/conversation/shared-report.png)';
  assert.equal(markdown.split(expectedLink).length - 1, 2, 'each message should link to the shared file');
});


test('renders inline image markers at their original message position without duplicating them as attachments', () => {
  const { conversationMarkdown, findMessageAssets } = loadBackgroundAssetHelpers();
  const imageAsset = {
    name: 'inline-image-123456789abc.png',
    mime: 'image/png',
    source: 'message-content',
    message_external_id: 'assistant-message',
    inline_positions: [{ message_external_id: 'assistant-message', index: 0 }],
    path: 'archive/conversations/claude/personal/assets/conversation/image.png',
    sha256: 'a'.repeat(64),
    size: 12,
  };
  const assistantMessage = {
    external_id: 'assistant-message',
    role: 'assistant',
    content: `Before image. ${marker(0)} After image.`,
    files: [],
    attachments: [],
    metadata: {},
  };
  const allAssets = [imageAsset];
  const assetMap = new Map();

  assert.deepEqual(findMessageAssets(assistantMessage, allAssets), [imageAsset]);
  const markdown = conversationMarkdown({
    external_id: 'conversation-inline-image',
    title: 'Inline image render',
    inline_marker_nonce: MARKER_NONCE,
    messages: [assistantMessage],
    message_count: 1,
  }, 'claude', 'personal', assetMap, allAssets);
  const link = '![inline-image-123456789abc.png](assets/conversation/image.png)';

  assert.equal(markdown.includes(marker(0)), false, 'the image marker must be resolved');
  assert.equal(markdown.split(link).length - 1, 1, 'the image should be linked exactly once');
  assert.ok(markdown.indexOf('Before image.') < markdown.indexOf(link));
  assert.ok(markdown.indexOf(link) < markdown.indexOf('After image.'));
});


test('escapes untrusted attachment filenames in Markdown labels', () => {
  const { conversationMarkdown } = loadBackgroundAssetHelpers();
  const hostileName = 'plot](https://evil.example/collect).png';
  const asset = {
    name: hostileName,
    mime: 'image/png',
    path: 'archive/conversations/claude/personal/assets/conversation/plot.png',
    sha256: 'a'.repeat(64),
    size: 12,
    message_external_id: 'assistant-message',
  };
  const message = {
    external_id: 'assistant-message',
    role: 'assistant',
    content: 'Generated the image.',
    files: [{ file_name: hostileName }],
    attachments: [],
    metadata: {},
  };
  const markdown = conversationMarkdown({
    external_id: 'conversation-hostile-filename',
    title: 'Filename escaping',
    messages: [message],
    message_count: 1,
  }, 'claude', 'personal', new Map(), [asset]);

  assert.match(markdown, /!\[plot\\\]\\\(https:\/\/evil\.example\/collect\\\)\.png\]\(assets\/conversation\/plot\.png\)/);
  assert.equal(markdown.includes('![plot](https://evil.example/collect)'), false,
    'untrusted filename text must not create a link to an external destination');
});

test('escapes HTML and Markdown formatting characters in attachment labels', () => {
  const { conversationMarkdown } = loadBackgroundAssetHelpers();
  const hostileName = '<img src=x onerror=alert(1)> *unsafe* & notes.txt';
  const asset = {
    name: hostileName,
    mime: 'text/plain',
    path: 'archive/conversations/claude/personal/assets/conversation/notes.txt',
    sha256: 'b'.repeat(64),
    size: 8,
    message_external_id: 'assistant-message',
  };
  const message = {
    external_id: 'assistant-message',
    role: 'assistant',
    content: 'Generated notes.',
    files: [{ file_name: hostileName }],
    attachments: [],
    metadata: {},
  };
  const markdown = conversationMarkdown({
    external_id: 'conversation-hostile-html-filename',
    title: 'HTML filename escaping',
    messages: [message],
    message_count: 1,
  }, 'claude', 'personal', new Map(), [asset]);

  assert.equal(markdown.includes('<img src=x onerror=alert(1)>'), false);
  assert.equal(markdown.includes('**unsafe**'), false);
  assert.ok(markdown.includes('&lt;img src=x onerror=alert\\(1\\)&gt;'));
  assert.match(markdown, /&amp; notes\.txt/);
});


test('keeps inline image positions of a shared asset scoped to their own message', () => {
  const { conversationMarkdown } = loadBackgroundAssetHelpers();
  // A file attached to two messages and inlined only in the second one,
  // plus a different inline image in the first message at the same index.
  const sharedAsset = {
    name: 'shared.png',
    mime: 'image/png',
    source: 'message',
    file_uuid: 'shared-file-id',
    message_external_id: 'first-user-message',
    message_external_ids: ['first-user-message', 'second-user-message'],
    inline_positions: [{ message_external_id: 'second-user-message', index: 0 }],
    path: 'archive/conversations/claude/personal/assets/conversation/aaaaaaaa-shared.png',
    sha256: 'a'.repeat(64),
    size: 6,
  };
  const ownInlineAsset = {
    name: 'inline-image-bbbbbbbbbbbb.png',
    mime: 'image/png',
    source: 'message-content',
    message_external_id: 'first-user-message',
    inline_positions: [{ message_external_id: 'first-user-message', index: 0 }],
    path: 'archive/conversations/claude/personal/assets/conversation/bbbbbbbb-inline-image-bbbbbbbbbbbb.png',
    sha256: 'b'.repeat(64),
    size: 3,
  };
  const sharedFile = { file_uuid: 'shared-file-id', file_name: 'shared.png' };
  const messages = [
    {
      external_id: 'first-user-message',
      role: 'user',
      content: `First upload. ${marker(0)}`,
      files: [sharedFile],
      attachments: [],
      metadata: {},
    },
    {
      external_id: 'second-user-message',
      role: 'user',
      content: `Same image again. ${marker(0)}`,
      files: [sharedFile],
      attachments: [],
      metadata: {},
    },
  ];
  const allAssets = [sharedAsset, ownInlineAsset];
  const assetMap = new Map([['id:shared-file-id', sharedAsset]]);
  const markdown = conversationMarkdown({
    external_id: 'conversation-shared-inline',
    title: 'Shared inline image',
    inline_marker_nonce: MARKER_NONCE,
    messages,
    message_count: 2,
  }, 'claude', 'personal', assetMap, allAssets);
  const [first, second] = markdown.split('\n---\n');
  const sharedLink = '![shared.png](assets/conversation/aaaaaaaa-shared.png)';
  const ownLink = '![inline-image-bbbbbbbbbbbb.png](assets/conversation/bbbbbbbb-inline-image-bbbbbbbbbbbb.png)';

  assert.equal(markdown.includes('AI_ARCHIVE_INLINE_ASSET'), false, 'every marker must be resolved');
  assert.ok(first.includes(ownLink), 'the first message marker must resolve to its own inline image');
  assert.equal(first.split(sharedLink).length - 1, 1,
    'the first message must still list the shared file it was sent with');
  assert.ok(first.indexOf(sharedLink) < first.indexOf('First upload.'), 'user attachments precede the text');
  assert.equal(second.includes(ownLink), false);
  assert.equal(second.split(sharedLink).length - 1, 1,
    'the second message shows the shared image inline once, not again as an attachment');
  assert.ok(second.indexOf('Same image again.') < second.indexOf(sharedLink));
});

test('never replaces marker-shaped text that does not carry the conversation nonce', () => {
  const { conversationMarkdown } = loadBackgroundAssetHelpers();
  const imageAsset = {
    name: 'inline-image-123456789abc.png',
    mime: 'image/png',
    source: 'message-content',
    message_external_id: 'user-message',
    inline_positions: [{ message_external_id: 'user-message', index: 0 }],
    path: 'archive/conversations/claude/personal/assets/conversation/image.png',
    sha256: 'a'.repeat(64),
    size: 12,
  };
  const legacyLiteral = '[[AI_ARCHIVE_INLINE_ASSET:0]]';
  const foreignNonceLiteral = `[[AI_ARCHIVE_INLINE_ASSET:${'f'.repeat(32)}:0]]`;
  const message = {
    external_id: 'user-message',
    role: 'user',
    content: `The docs mention ${legacyLiteral} and ${foreignNonceLiteral}.\n\n${marker(0)}`,
    files: [],
    attachments: [],
    metadata: {},
  };
  const markdown = conversationMarkdown({
    external_id: 'conversation-marker-collision',
    title: 'Marker collision',
    inline_marker_nonce: MARKER_NONCE,
    messages: [message],
    message_count: 1,
  }, 'claude', 'personal', new Map(), [imageAsset]);
  const link = '![inline-image-123456789abc.png](assets/conversation/image.png)';

  assert.ok(markdown.includes(`The docs mention ${legacyLiteral} and ${foreignNonceLiteral}.`),
    'user text must survive verbatim');
  assert.equal(markdown.split(link).length - 1, 1, 'only the real marker becomes an image');
  assert.equal(markdown.includes(MARKER_NONCE), false);
});

test('fails instead of publishing an inline image marker without an archived asset', () => {
  const { conversationMarkdown } = loadBackgroundAssetHelpers();
  const message = {
    external_id: 'assistant-message',
    role: 'assistant',
    content: `Lost image: ${marker(0)}`,
    files: [],
    attachments: [],
    metadata: {},
  };
  assert.throws(() => conversationMarkdown({
    external_id: 'conversation-missing-inline-asset',
    title: 'Missing inline asset',
    inline_marker_nonce: MARKER_NONCE,
    messages: [message],
    message_count: 1,
  }, 'claude', 'personal', new Map(), []), /inline image 0 in message "assistant-message" has no archived asset/);
});

test('keeps internal inline image markers out of the index preview and search text', () => {
  const { indexEntry } = loadBackgroundAssetHelpers();
  const entry = indexEntry({
    external_id: 'conversation-index-markers',
    title: 'Index markers',
    inline_marker_nonce: MARKER_NONCE,
    message_count: 2,
    messages: [
      { external_id: 'image-only', role: 'user', content: marker(0) },
      { external_id: 'text', role: 'assistant', content: `See ${marker(1)} and [[AI_ARCHIVE_INLINE_ASSET:0]].` },
    ],
  }, 'archive/conversations/claude/personal/x.md', 'claude', 'personal', []);

  assert.equal(entry.preview, 'See  and [[AI_ARCHIVE_INLINE_ASSET:0]].',
    'an image-only message is skipped for the preview; literal user text is kept');
  assert.equal(entry.search_text.includes(MARKER_NONCE), false);
  assert.ok(entry.search_text.includes('[[AI_ARCHIVE_INLINE_ASSET:0]]'));
});

test('renders non-image inline assets as links at their original message positions', () => {
  const { conversationMarkdown } = loadBackgroundAssetHelpers();
  const asset = (name, mime, index, letter) => ({
    name,
    mime,
    source: 'message-content',
    message_external_id: 'assistant-message',
    inline_positions: [{ message_external_id: 'assistant-message', index }],
    path: `archive/conversations/claude/personal/assets/conversation/${name}`,
    sha256: letter.repeat(64),
    size: 12,
  });
  const audio = asset('inline-audio-123456789abc.mp3', 'audio/mpeg', 0, 'a');
  const video = asset('inline-video-23456789abcd.mp4', 'video/mp4', 1, 'b');
  const message = {
    external_id: 'assistant-message',
    role: 'assistant',
    content: `Before audio. ${marker(0)} Before video. ${marker(1)} After video.`,
    files: [],
    attachments: [],
    metadata: {},
  };
  const markdown = conversationMarkdown({
    external_id: 'conversation-inline-audio-video',
    title: 'Inline audio/video rendering',
    inline_marker_nonce: MARKER_NONCE,
    messages: [message],
    message_count: 1,
  }, 'claude', 'personal', new Map(), [audio, video]);
  const audioLink = '[inline-audio-123456789abc.mp3](assets/conversation/inline-audio-123456789abc.mp3)';
  const videoLink = '[inline-video-23456789abcd.mp4](assets/conversation/inline-video-23456789abcd.mp4)';

  assert.equal(markdown.includes('AI_ARCHIVE_INLINE_ASSET'), false, 'all markers must resolve');
  assert.equal(markdown.includes(`!${audioLink}`), false, 'audio is linked, not embedded as an image');
  assert.equal(markdown.split(audioLink).length - 1, 1, 'audio is linked once, not repeated as an attachment');
  assert.equal(markdown.split(videoLink).length - 1, 1);
  assert.ok(markdown.indexOf('Before audio.') < markdown.indexOf(audioLink));
  assert.ok(markdown.indexOf(audioLink) < markdown.indexOf('Before video.'));
  assert.ok(markdown.indexOf('Before video.') < markdown.indexOf(videoLink));
  assert.ok(markdown.indexOf(videoLink) < markdown.indexOf('After video.'));
});

test('lists tool result media once as an attachment after the Claude message', () => {
  const { conversationMarkdown } = loadBackgroundAssetHelpers();
  const screenshot = {
    name: 'inline-image-123456789abc.png',
    mime: 'image/png',
    source: 'tool-result',
    message_external_id: 'assistant-message',
    path: 'archive/conversations/claude/personal/assets/conversation/screenshot.png',
    sha256: 'c'.repeat(64),
    size: 12,
  };
  const message = {
    external_id: 'assistant-message',
    role: 'assistant',
    content: '### Tool result: screenshot\n\n```text\n{"data": "[omitted inline payload: 16 characters; archived as a message attachment]"}\n```\n\nHere is the page.',
    files: [],
    attachments: [],
    metadata: {},
  };
  const markdown = conversationMarkdown({
    external_id: 'conversation-tool-media',
    title: 'Tool media',
    inline_marker_nonce: MARKER_NONCE,
    messages: [message],
    message_count: 1,
  }, 'claude', 'personal', new Map(), [screenshot]);
  const link = '![inline-image-123456789abc.png](assets/conversation/screenshot.png)';

  assert.equal(markdown.split(link).length - 1, 1);
  assert.ok(markdown.indexOf('Here is the page.') < markdown.indexOf(link), 'Claude attachments follow the response');
});


test('retries transient GitHub failures on idempotent requests and completes the sync', async () => {
  for (const failOnce of [
    { method: 'POST', pathSuffix: '/git/blobs', status: 502 },
    { method: 'GET', pathSuffix: '/contents/archive/index.json', network: true },
    { method: 'POST', pathSuffix: '/git/trees', status: 429, headers: { 'retry-after': '0' } },
    { method: 'POST', pathSuffix: '/git/commits', status: 403, message: 'You have exceeded a secondary rate limit', headers: { 'retry-after': '0' } },
  ]) {
    const harness = makeBackgroundSyncHarness({
      indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }),
      failOnce: { ...failOnce, times: 2 },
    });
    const result = await harness.sync(sampleConversation(), () => {});
    assert.equal(result.commit, 'new-commit', `${failOnce.method} ${failOnce.pathSuffix} should be retried`);
  }
});

test('never retries the branch ref update itself', async () => {
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }),
    failOnce: { method: 'PATCH', pathSuffix: '/git/refs/heads/master', status: 502 },
  });
  await assert.rejects(harness.sync(sampleConversation(), () => {}), /GitHub 502/);
  assert.equal(harness.requests.filter((request) => request.method === 'PATCH').length, 1);
});

test('explains authentication, permission, and rate-limit failures without retrying them', async () => {
  const cases = [
    [{ status: 401, message: 'Bad credentials' }, /GitHub 401: GitHub rejected the access token\. Update the token in the extension popup\. Nothing was published\./],
    [{ status: 403, message: 'Resource not accessible by personal access token' },
      /GitHub 403: GitHub denied access to example-owner\/example-archive\. The token needs read and write access to repository contents\. Nothing was published\./],
    [{ status: 403, message: 'API rate limit exceeded', headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1893456000' } },
      /GitHub 403: GitHub API rate limit reached; it resets at 2030-01-01T00:00:00\.000Z\. Nothing was published; sync again after that\./],
  ];
  for (const [failure, expected] of cases) {
    const harness = makeBackgroundSyncHarness({
      indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }),
      failOnce: { method: 'GET', pathSuffix: '/git/commits/base-commit', times: 5, ...failure },
    });
    await assert.rejects(harness.sync(sampleConversation(), () => {}), expected);
    assert.equal(harness.requests.filter((request) => request.pathname.endsWith('/git/commits/base-commit')).length, 1,
      `HTTP ${failure.status} must not be retried`);
    assert.equal(harness.requests.some((request) => request.method === 'PATCH'), false);
  }
});

test('names conversations that could not be exported in the completion message', async () => {
  const harness = makeBackgroundSyncHarness({ indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }) });
  const progress = [];
  const skipped = [{ id: 'conversation-broken', title: 'Broken one', error: 'Claude returned an invalid payload' }];
  const result = await harness.sync(sampleConversation(), (event) => progress.push(event), skipped);

  assert.equal(result.commit, 'new-commit');
  assert.equal(result.skipped, 1);
  const done = progress.find((event) => event.stage === 'done');
  assert.match(done.message, /^Sync complete: 1 conversation changed in 1 GitHub commit\. 1 conversation could not be exported and was left unchanged in the archive: "Broken one" \(Claude returned an invalid payload\)\. Sync again later to retry it\.$/);
});

function loadBackgroundForSyncState() {
  const listeners = [];
  let now = Date.UTC(2026, 9, 26, 12, 0, 0);
  class FakeDate extends Date {
    static now() { return now; }
  }
  const tabMessages = [];
  const chrome = {
    storage: { local: { get: async () => ({}) } },
    runtime: { onMessage: { addListener(listener) { listeners.push(listener); } }, sendMessage() { return Promise.resolve(); } },
    tabs: { sendMessage(tabId, message) { tabMessages.push({ tabId, message }); return Promise.resolve(); } },
  };
  vm.runInNewContext(backgroundSource, { chrome, AbortController, fetch: () => new Promise(() => {}), Date: FakeDate });
  const send = (message, sender = {}) => {
    let response;
    listeners[0](message, sender, (value) => { response = value; });
    return response;
  };
  return { send, tabMessages, advance(ms) { now += ms; } };
}

test('reports the content script fetching phase to a reopened popup', () => {
  const background = loadBackgroundForSyncState();
  const tab = { tab: { id: 7 } };

  assert.equal(background.send({ type: 'getSyncState' }).running, false);
  background.send({ type: 'syncProgress', stage: 'fetching', current: 3, total: 40 }, tab);
  const state = background.send({ type: 'getSyncState' });
  assert.equal(state.running, true, 'a fetch in a Claude tab counts as a running sync');
  assert.equal(state.stage, 'fetching');
  assert.equal(state.current, 3);
  assert.equal(state.total, 40);

  background.send({ type: 'syncProgress', stage: 'error', error: 'Claude conversations: 500' }, tab);
  assert.equal(background.send({ type: 'getSyncState' }).running, false);
});

test('does not report a fetch as running forever after its Claude tab went away', () => {
  const background = loadBackgroundForSyncState();
  background.send({ type: 'syncProgress', stage: 'fetching', current: 1, total: 5 }, { tab: { id: 7 } });
  background.advance(4 * 60 * 1000);
  assert.equal(background.send({ type: 'getSyncState' }).running, true);
  background.advance(2 * 60 * 1000);
  assert.equal(background.send({ type: 'getSyncState' }).running, false, 'stale content progress is not a running sync');
});

test('forwards a cancel to the Claude tab that is fetching, even from another tab', () => {
  const background = loadBackgroundForSyncState();
  background.send({ type: 'syncProgress', stage: 'fetching', current: 2, total: 9 }, { tab: { id: 42 } });
  background.send({ type: 'cancelSync' });
  assert.deepEqual(JSON.parse(JSON.stringify(background.tabMessages)), [{ tabId: 42, message: { type: 'cancelSync' } }]);

  // Nothing is fetching: no tab message is sent.
  const idle = loadBackgroundForSyncState();
  idle.send({ type: 'cancelSync' });
  assert.equal(idle.tabMessages.length, 0);
});

test('reports archived conversations that a full sync did not receive from Claude', async () => {
  const archived = (id, account = 'personal') => ({
    id, provider: 'claude', account, path: `archive/conversations/claude/${account}/${id}.md`, assets: [],
    title: id, updated_at: '2026-10-01T00:00:00Z', message_count: 1, format_version: 4,
  });
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: [
    archived('conversation-123456'), archived('deleted-or-unlisted'), archived('other-account', 'work'),
  ] });

  const full = makeBackgroundSyncHarness({ indexText });
  const fullProgress = [];
  await full.sync(sampleConversation(), (event) => fullProgress.push(event), [], { fullList: true });
  assert.match(fullProgress.find((event) => event.stage === 'done').message,
    / 1 archived conversation was not returned by Claude\.ai in this full sync \(deleted there, or Claude's list was incomplete\); its archived copy was kept\.$/);

  const partial = makeBackgroundSyncHarness({ indexText });
  const partialProgress = [];
  await partial.sync(sampleConversation(), (event) => partialProgress.push(event), [], { fullList: false });
  assert.doesNotMatch(partialProgress.find((event) => event.stage === 'done').message, /not returned by Claude/);
});

test('escapes filenames in placeholders for attachments that could not be archived', () => {
  const { attachmentMarkdown } = loadBackgroundAssetHelpers();
  const message = {
    external_id: 'user-message',
    role: 'user',
    content: 'See attachment.',
    files: [],
    attachments: [{ file_name: '*notes* [link](https://evil.example)\n## Claude.txt' }],
    metadata: {},
  };
  const markdown = attachmentMarkdown(message, new Map(), []);
  assert.equal(markdown, '**Attachment: \\*notes\\* \\[link\\]\\(https://evil.example\\) ## Claude.txt**');
  assert.equal(markdown.includes('\n'), false, 'a filename cannot start a new Markdown block');
});
