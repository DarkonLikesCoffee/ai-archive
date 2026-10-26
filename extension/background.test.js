import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const backgroundPath = fileURLToPath(new URL('./background.js', import.meta.url));
const backgroundSource = await readFile(backgroundPath, 'utf8');

function loadBackgroundWithPendingGitHubRequest() {
  const listeners = [];
  const chrome = {
    storage: {
      local: {
        get: async () => ({
          github_owner: 'example-owner',
          github_repo: 'example-archive',
          github_token: 'test-token',
          archive_account: 'personal',
        }),
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


function makeBackgroundSyncHarness({ indexText, advanceBranchOnRecheck = false, missingPaths = [], failOnce = null, patchOutcome = null, cancelAt = null }) {
  const listeners = [];
  const requests = [];
  const baseSha = 'base-commit';
  const concurrentSha = 'concurrent-commit';
  let masterRefReads = 0;
  let blobCount = 0;
  let injectedFailureUsed = false;
  let cancelTriggered = false;
  let currentHeadSha = baseSha;
  const chrome = {
    storage: {
      local: {
        get: async () => ({
          github_owner: 'example-owner',
          github_repo: 'example-archive',
          github_token: 'test-token',
          archive_account: 'personal',
        }),
      },
    },
    runtime: {
      onMessage: {
        addListener(listener) { listeners.push(listener); },
      },
      sendMessage() { return Promise.resolve(); },
    },
  };

  const response = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
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

    if (failOnce && !injectedFailureUsed && method === failOnce.method && pathname.endsWith(failOnce.pathSuffix)) {
      injectedFailureUsed = true;
      return response({ message: 'Temporary injected failure' }, failOnce.status || 503);
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
      return indexText == null
        ? response({ message: 'Not Found' }, 404)
        : response({ content: Buffer.from(indexText, 'utf8').toString('base64'), encoding: 'base64' });
    }
    if (pathname.endsWith('/git/blobs') && method === 'POST') {
      blobCount += 1;
      return response({ sha: `blob-${blobCount}` });
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

  const context = { chrome, fetch, AbortController, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, btoa, atob };
  vm.runInNewContext(`${backgroundSource}
globalThis.__testHooks = {
  sync, assetPath, normalizeAssetList, conversationMarkdown,
  conversationPath, indexEntry, sha256,
};
`, context, { filename: 'extension/background.js' });

  return {
    sync: context.__testHooks.sync,
    hooks: context.__testHooks,
    requests,
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


test('recovers after a transient GitHub upload failure without publishing a partial archive', async () => {
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }),
    failOnce: { method: 'POST', pathSuffix: '/git/blobs', status: 503 },
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
