import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';

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


function makeBackgroundSyncHarness({ indexText, indexEncoding = 'base64', advanceBranchOnRecheck = false, missingPaths = [], failOnce = null, patchOutcome = null, cancelAt = null, blobDelayMs = 0, blobResponder = null, treeTamper = null, sourcePatches = [] }) {
  const listeners = [];
  const createdTrees = new Map();
  const blobContents = new Map();
  const requests = [];
  const baseSha = 'base-commit';
  const concurrentSha = 'concurrent-commit';
  let masterRefReads = 0;
  let blobCount = 0;
  let injectedFailures = 0;
  let failOnceMatches = 0;
  let cancelTriggered = false;
  let currentHeadSha = baseSha;
  let settingsReadCount = 0;
  let activeBlobRequests = 0;
  let maxActiveBlobRequests = 0;
  const storedValues = {};
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
        set: async (values) => { Object.assign(storedValues, values); },
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

  // The branch's tree: every path the index references, minus `missingPaths`.
  function baseTreeItems() {
    let indexedPaths = [];
    try {
      const parsedIndex = JSON.parse(indexText || '{}');
      indexedPaths = (parsedIndex.conversations || []).flatMap((entry) => [
        entry.path,
        ...(Array.isArray(entry.assets) ? entry.assets.map((asset) => asset?.path) : []),
      ]).filter(Boolean);
    } catch {}
    const missing = new Set(missingPaths);
    return new Map([...new Set(indexedPaths)].filter((path) => !missing.has(path)).map((path) => [path, `existing-${path}`]));
  }

  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const method = options.method || 'GET';
    requests.push({ pathname, method, body: options.body ? JSON.parse(options.body) : null });

    if (cancelAt && !cancelTriggered && method === cancelAt.method && pathname.endsWith(cancelAt.pathSuffix)) {
      cancelTriggered = true;
      listeners[0]({ type: 'cancelSync' }, {}, () => {});
    }

    if (failOnce && method === failOnce.method && pathname.endsWith(failOnce.pathSuffix) && (failOnceMatches += 1) > (failOnce.after || 0)
      && injectedFailures < (failOnce.times || 1)) {
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
      return response({ sha: 'base-tree', tree: [...baseTreeItems()].map(([path, sha]) => ({ path, type: 'blob', mode: '100644', sha })) });
    }
    if (method === 'GET' && pathname.includes('/git/trees/')) {
      const sha = decodeURIComponent(pathname.split('/git/trees/')[1]);
      const tree = createdTrees.get(sha);
      if (!tree) return response({ message: 'Not Found' }, 404);
      return response({ sha, truncated: false, tree: [...tree].map(([path, blob]) => ({ path, type: 'blob', mode: '100644', sha: blob })) });
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
      const custom = blobResponder?.(requests.at(-1).body);
      if (custom) return response(custom.body, custom.status, custom.headers || {});
      activeBlobRequests += 1;
      maxActiveBlobRequests = Math.max(maxActiveBlobRequests, activeBlobRequests);
      try {
        if (blobDelayMs) await new Promise((resolve) => setTimeout(resolve, blobDelayMs));
        blobCount += 1;
        blobContents.set(`blob-${blobCount}`, requests.at(-1).body);
        return response({ sha: `blob-${blobCount}` });
      } finally {
        activeBlobRequests -= 1;
      }
    }
    if (pathname.endsWith('/git/trees') && method === 'POST') {
      // Applies the entries to the base tree like GitHub does (a null SHA
      // deletes the path); `treeTamper` simulates GitHub building a different tree.
      const body = requests.at(-1).body;
      const base = body.base_tree === 'base-tree' ? baseTreeItems() : (createdTrees.get(body.base_tree) || new Map());
      const entries = new Map(base);
      for (const entry of body.tree) {
        if (entry.sha === null) entries.delete(entry.path);
        else entries.set(entry.path, entry.sha);
      }
      treeTamper?.(entries);
      const sha = `tree-${createdTrees.size + 1}`;
      createdTrees.set(sha, entries);
      return response({ sha });
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
  let fastSource = backgroundSource.replace('const GITHUB_RETRY_BASE_DELAY_MS = 1000;', 'const GITHUB_RETRY_BASE_DELAY_MS = 1;');
  for (const [from, to] of sourcePatches) {
    assert.ok(fastSource.includes(from), `test patch target exists: ${from}`);
    fastSource = fastSource.replace(from, to);
  }
  vm.runInNewContext(`${fastSource}
globalThis.__testHooks = {
  sync, assetPath, normalizeAssetList, conversationMarkdown,
  conversationPath, indexEntry, sha256, archiveState, archiveSyncState, archiveAccounts, broadcast,
  createBlob, gitHubError, syncCommitMessage, base64RequestBytes, formatBytes,
  MAX_BLOB_REQUEST_BYTES, MAX_ARCHIVED_FILE_BYTES, BlobTooLargeError,
};
`, context, { filename: 'extension/background.js' });

  return {
    sync: context.__testHooks.sync,
    archiveState: context.__testHooks.archiveState,
    archiveAccounts: context.__testHooks.archiveAccounts,
    storedValues: () => storedValues,
    hooks: context.__testHooks,
    requests,
    // The tree and archive/index.json of the last commit this harness was asked to create.
    endInjectedFailures() { failOnce = null; },
    lastCommittedArchive() {
      const commit = requests.filter((request) => request.method === 'POST' && request.pathname.endsWith('/git/commits')).at(-1);
      const tree = commit && createdTrees.get(commit.body.tree);
      if (!tree) return null;
      const indexBlob = blobContents.get(tree.get('archive/index.json'));
      return { tree, index: indexBlob ? JSON.parse(indexBlob.content) : null };
    },
    send(message, sender = { tab: { id: 7 } }) {
      let response;
      listeners[0](message, sender, (value) => { response = value; });
      return response;
    },
    request: (message, sender = { tab: { id: 7 } }) => new Promise((resolve) => listeners[0](message, sender, resolve)),
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
    // As many consecutive failures as the retry budget: the sync must give up safely.
    failOnce: { method: 'POST', pathSuffix: '/git/blobs', status: 503, times: 5 },
  });

  await assert.rejects(
    harness.sync(sampleConversation(), () => {}),
    /GitHub 503:.*Temporary injected failure \[while uploading a file; failed 5 attempts\] Nothing was published; the archive on GitHub is unchanged\./,
  );
  assert.equal(harness.requests.filter((request) => request.method === 'POST' && request.pathname.endsWith('/git/blobs')).length, 5);

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
  assert.match(done.message, /^Sync finished with problems: 1 conversation changed in 1 GitHub commit\. 1 conversation could not be exported and is not in the archive yet: "Broken one" \(Claude returned an invalid payload\)\. The next sync retries it\.$/);
  assert.equal(done.partial, true);
});

function loadBackgroundForSyncState() {
  const listeners = [];
  let now = Date.UTC(2026, 9, 26, 12, 0, 0);
  class FakeDate extends Date {
    static now() { return now; }
  }
  const tabMessages = [];
  const broadcasts = [];
  const chrome = {
    storage: { local: { get: async () => ({}) } },
    runtime: { onMessage: { addListener(listener) { listeners.push(listener); } }, sendMessage(message) { broadcasts.push(message); return Promise.resolve(); } },
    tabs: { sendMessage(tabId, message) { tabMessages.push({ tabId, message }); return Promise.resolve(); } },
  };
  vm.runInNewContext(backgroundSource, { chrome, AbortController, fetch: () => new Promise(() => {}), Date: FakeDate, TextEncoder, TextDecoder, Uint8Array, atob, btoa, crypto: webcrypto });
  const send = (message, sender = {}) => {
    let response;
    listeners[0](message, sender, (value) => { response = value; });
    return response;
  };
  // For messages the background may answer asynchronously (an attachment's
  // last chunk is checked and staged before the answer).
  const request = (message, sender = {}) => new Promise((resolve) => listeners[0](message, sender, resolve));
  return { send, request, tabMessages, broadcasts, advance(ms) { now += ms; } };
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


function archivedEntry(id, extra = {}) {
  return {
    id, provider: 'claude', account: 'personal', title: id, updated_at: `2026-10-0${id.length % 9 + 1}T00:00:00Z`,
    path: `archive/conversations/claude/personal/${id}.md`, assets: [], message_count: 1, format_version: 4,
    exporter_version: 1, ...extra,
  };
}

test('archive account picker lists unique Claude account names from the archive index', async () => {
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: [
    { provider: 'claude', account: 'logan' },
    { provider: 'claude', account: 'work' },
    { provider: 'claude', account: 'logan' },
    { provider: 'chatgpt', account: 'not-a-claude-account' },
  ] });
  const harness = makeBackgroundSyncHarness({ indexText });
  const accounts = JSON.parse(JSON.stringify(await harness.archiveAccounts()));
  assert.deepEqual(accounts, ['logan', 'work']);
  assert.equal(harness.requests.some((request) => request.pathname.endsWith('/git/trees/base-tree')), false,
    'account discovery should read the index without downloading the full repository tree');
});

test('archive account picker reads account names when a large index needs blob fallback', async () => {
  const indexText = JSON.stringify({ version: 2, conversations: [
    { provider: 'claude', account: 'work' },
  ] });
  const harness = makeBackgroundSyncHarness({ indexText, indexEncoding: 'none' });
  const accounts = JSON.parse(JSON.stringify(await harness.archiveAccounts()));
  assert.deepEqual(accounts, ['work']);
  assert.ok(harness.requests.some((request) => request.pathname.endsWith('/git/blobs/large-index-blob')));
});

test('archive account picker refuses to use a corrupt archive index', async () => {
  const harness = makeBackgroundSyncHarness({ indexText: '{invalid json' });
  await assert.rejects(harness.archiveAccounts(), /archive\/index\.json is invalid JSON/);
});

test('incremental archive state lists only complete conversations written by the current exporter', async () => {
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: [
    archivedEntry('complete'),
    archivedEntry('missing-asset', { assets: [{ path: 'archive/conversations/claude/personal/assets/x/gone.png' }] }),
    archivedEntry('legacy-exporter', { exporter_version: undefined }),
    archivedEntry('older-exporter', { exporter_version: 0 }),
    archivedEntry('other-account', { account: 'work', path: 'archive/conversations/claude/work/other-account.md' }),
  ] });
  const harness = makeBackgroundSyncHarness({
    indexText,
    missingPaths: ['archive/conversations/claude/personal/assets/x/gone.png'],
  });
  const state = JSON.parse(JSON.stringify(await harness.archiveState()));
  assert.deepEqual(state, [{ id: 'complete', updated_at: archivedEntry('complete').updated_at }]);
});

test('a sync with unchanged conversations reports them and does not count them as unlisted', async () => {
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: [archivedEntry('kept-unchanged')] });
  const harness = makeBackgroundSyncHarness({ indexText });
  const progress = [];
  await harness.sync(sampleConversation(), (event) => progress.push(event), [], { fullList: true, unchangedIds: ['kept-unchanged'] });
  const message = progress.find((event) => event.stage === 'done').message;
  assert.match(message, / 1 unchanged conversation was not downloaded again\./);
  assert.doesNotMatch(message, /not returned by Claude/);
});

test('a sync that could not read the archive state says every conversation was downloaded again', async () => {
  const harness = makeBackgroundSyncHarness({ indexText: emptyIndex() });
  const progress = [];
  const result = await harness.sync(sampleConversation(), (event) => progress.push(event), [], {
    fullList: true, listed: 1, unchangedIds: [], archiveStateError: 'GitHub 502: Server Error',
  });
  assert.equal(result.partial, false, 'a full download loses nothing, so the sync is not partial');
  assert.equal(result.report.archiveStateError, 'GitHub 502: Server Error');
  assert.match(progress.at(-1).message,
    /The archive state could not be read \(GitHub 502: Server Error\), so every conversation was downloaded again instead of skipping unchanged ones\./);

  const automatic = makeBackgroundSyncHarness({ indexText: emptyIndex() });
  const automaticProgress = [];
  await automatic.sync(sampleConversation(), (event) => automaticProgress.push(event), [], { fullList: false, archiveStateError: 'GitHub 502: Server Error' });
  assert.match(automaticProgress.at(-1).message, /so this automatic sync checked only the latest conversations\./);

  const normal = makeBackgroundSyncHarness({ indexText: emptyIndex() });
  const normalProgress = [];
  await normal.sync(sampleConversation(), (event) => normalProgress.push(event), [], { fullList: true, listed: 1 });
  assert.doesNotMatch(normalProgress.at(-1).message, /archive state/);
});

test('records the exporter version for a previously archived conversation even when its Markdown is unchanged', async () => {
  // First sync writes the conversation; capture its index entry without the exporter version.
  const first = makeBackgroundSyncHarness({ indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }) });
  await first.sync(sampleConversation(), () => {});
  const writtenIndex = first.requests
    .filter((request) => request.method === 'POST' && request.pathname.endsWith('/git/blobs'))
    .map((request) => request.body?.content)
    .filter((content) => typeof content === 'string' && content.includes('"conversations"'))
    .map((content) => JSON.parse(content))
    .pop();
  assert.equal(writtenIndex.conversations[0].exporter_version, 1, 'new index entries carry the exporter version');

  const legacy = JSON.parse(JSON.stringify(writtenIndex));
  delete legacy.conversations[0].exporter_version;
  const second = makeBackgroundSyncHarness({ indexText: JSON.stringify(legacy) });
  const result = await second.sync(sampleConversation(), () => {});
  assert.equal(result.changed, 0, 'the Markdown itself did not change');
  assert.equal(result.commit, 'new-commit', 'an index-only commit records the exporter version');
});

test('persists the outcome of every finished sync, including content-side failures', async () => {
  const stored = {};
  const listeners = [];
  const chrome = {
    storage: { local: { get: async () => ({}), set: async (values) => { Object.assign(stored, values); } } },
    runtime: { onMessage: { addListener(listener) { listeners.push(listener); } }, sendMessage() { return Promise.resolve(); } },
    tabs: { sendMessage() { return Promise.resolve(); } },
  };
  vm.runInNewContext(`${backgroundSource}\nglobalThis.__broadcast = broadcast;`, (() => {
    const context = { chrome, AbortController, fetch: () => new Promise(() => {}) };
    context.globalThis = context;
    return context;
  })());
  const send = (message, sender = {}) => listeners[0](message, sender, () => {});

  // Progress stages are not persisted; only final outcomes are.
  send({ type: 'syncProgress', stage: 'fetching', current: 1, total: 3 }, { tab: { id: 1 } });
  assert.equal(stored.last_sync, undefined);

  send({ type: 'syncProgress', stage: 'error', error: 'Claude conversations: 500' }, { tab: { id: 1 } });
  assert.equal(stored.last_sync.stage, 'error');
  assert.equal(stored.last_sync.message, 'Claude conversations: 500');
  assert.match(stored.last_sync.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('persists a completed GitHub sync with its summary', async () => {
  const harness = makeBackgroundSyncHarness({ indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }) });
  // The extension runs syncs with broadcast() as the progress callback.
  await harness.sync(sampleConversation(), harness.hooks.broadcast);
  const record = harness.storedValues().last_sync;
  assert.equal(record.stage, 'done');
  assert.equal(record.changed, 1);
  assert.equal(record.commit, 'new-commit');
  assert.match(record.message, /^Sync complete: 1 conversation changed in 1 GitHub commit\./);
});

test('a finished sync is not reported as still fetching to a reopened popup', async () => {
  const background = loadBackgroundForSyncState();
  const tab = { tab: { id: 7 } };
  background.send({ type: 'syncProgress', stage: 'fetching', current: 2, total: 2 }, tab);
  // The content script hands the conversations to the background; its GitHub
  // phase ends (here at once, with no GitHub settings configured).
  background.send({ type: 'syncNormalized', conversations: [], skipped: [], unchangedIds: [], fullList: true }, tab);
  for (let i = 0; i < 20 && background.send({ type: 'getSyncState' }).running; i++) await new Promise((resolve) => setImmediate(resolve));
  const state = background.send({ type: 'getSyncState' });
  assert.equal(state.running, false, JSON.stringify(state));
  assert.notEqual(state.stage, 'fetching');
});


const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Builds the transfer messages content.js sends for `conversations`, chunked
// at `chunkChars`: a header and one record per message, then attachments.
function streamTransferMessages(transferId, conversations, { chunkChars = 9, recordsPerBatch = 2 } = {}) {
  const messages = [];
  let batchIndex = 0;
  const pushBatch = (records) => {
    const text = JSON.stringify(records);
    const chunks = text.match(new RegExp(`[\\s\\S]{1,${chunkChars}}`, 'g'));
    for (const [chunkIndex, data] of chunks.entries()) {
      messages.push({ type: 'syncTransferBatchChunk', transferId, batchIndex, chunkIndex, totalChunks: chunks.length, totalChars: text.length, data });
    }
    batchIndex++;
  };
  for (const [conversationIndex, conversation] of conversations.entries()) {
    const { messages: conversationMessages = [], assets = [], ...header } = conversation;
    const records = [{
      conversation_index: conversationIndex,
      message_count: conversationMessages.length,
      conversation: {
        ...header,
        assets: assets.map(({ base64, ...asset }) => ({ ...asset, base64: '', payload_chars: base64 ? base64.length : 0 })),
      },
    }, ...conversationMessages.map((message) => ({ conversation_index: conversationIndex, message }))];
    for (let i = 0; i < records.length; i += recordsPerBatch) pushBatch(records.slice(i, i + recordsPerBatch));
    for (const [assetIndex, asset] of assets.entries()) {
      if (!asset.base64) continue;
      const chunks = asset.base64.match(new RegExp(`[\\s\\S]{1,${chunkChars}}`, 'g'));
      for (const [chunkIndex, data] of chunks.entries()) {
        messages.push({ type: 'syncTransferAssetChunk', transferId, conversationIndex, assetIndex, chunkIndex, totalChunks: chunks.length, totalChars: asset.base64.length, data });
      }
    }
  }
  return messages;
}

function transferAsset(name, text) {
  const bytes = Buffer.from(text, 'utf8');
  return { name, size: bytes.length, sha256: sha256Hex(bytes), base64: bytes.toString('base64') };
}

async function deliverAll(background, messages) {
  const responses = [];
  for (const message of messages) responses.push(await background.request(message, { tab: { id: 7 } }));
  return responses;
}

test('reassembles bounded conversation batches and rejects incomplete transfers', async () => {
  const background = loadBackgroundForSyncState();
  assert.equal(background.send({ type: 'syncTransferStart', transferId: 'batches-1' }, { tab: { id: 7 } }).ok, true);

  const conversations = [
    { external_id: 'new-1', messages: [{ external_id: 'm1', content: 'one' }, { external_id: 'm2', content: 'two' }], assets: [transferAsset('image.png', 'hello world!')] },
    { external_id: 'new-2', messages: [], assets: [] },
  ];
  const responses = await deliverAll(background, streamTransferMessages('batches-1', conversations));
  assert.ok(responses.every((response) => response.ok), JSON.stringify(responses.find((response) => !response.ok)));

  const metadata = { skipped: [], unchangedIds: ['old-1'], fullList: true, listed: 3 };
  background.send({ type: 'syncNormalized', transferId: 'batches-1', conversationCount: 2, metadata }, { tab: { id: 7 } });
  for (let i = 0; i < 20 && !background.broadcasts.some((m) => m.stage === 'error'); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.match(background.broadcasts.find((m) => m.stage === 'error').error, /Configure GitHub settings/,
    'the assembled conversations should reach sync()');

  const incomplete = loadBackgroundForSyncState();
  assert.equal(incomplete.send({ type: 'syncTransferStart', transferId: 'batches-2' }).ok, true);
  // Only the header of a conversation said to have two messages arrives.
  const [header] = streamTransferMessages('batches-2', [{ external_id: 'only-one', messages: [{}, {}] }], { chunkChars: 10000, recordsPerBatch: 1 });
  assert.equal(incomplete.send(header).ok, true);
  const response = incomplete.send({ type: 'syncNormalized', transferId: 'batches-2', conversationCount: 1, metadata }, { tab: { id: 7 } });
  assert.equal(response.ok, false, 'the finalizer must reject a conversation with missing messages');
  assert.match(response.error, /did not fully reach the extension .*0 of 2 messages/);

  const missingConversation = loadBackgroundForSyncState();
  assert.equal(missingConversation.send({ type: 'syncTransferStart', transferId: 'batches-3' }).ok, true);
  await deliverAll(missingConversation, streamTransferMessages('batches-3', [{ external_id: 'a', messages: [] }]));
  const countMismatch = missingConversation.send({ type: 'syncNormalized', transferId: 'batches-3', conversationCount: 2, metadata }, { tab: { id: 7 } });
  assert.equal(countMismatch.ok, false, 'the finalizer must reject a missing conversation');
  assert.match(countMismatch.error, /1 of 2 conversations arrived/);
});


test('refuses to finalize a transfer while attachment chunks are incomplete', async () => {
  const background = loadBackgroundForSyncState();
  assert.equal(background.send({ type: 'syncTransferStart', transferId: 'asset-incomplete' }).ok, true);
  const messages = streamTransferMessages('asset-incomplete', [
    { external_id: 'with-asset', messages: [], assets: [transferAsset('large.bin', 'abcdefghijklmnop')] },
  ], { chunkChars: 8 });
  const assetChunks = messages.filter((message) => message.type === 'syncTransferAssetChunk');
  assert.ok(assetChunks.length > 1);
  await deliverAll(background, messages.slice(0, -1));
  const response = background.send({ type: 'syncNormalized', transferId: 'asset-incomplete', conversationCount: 1, metadata: {} }, { tab: { id: 7 } });
  assert.equal(response.ok, false);
  assert.match(response.error, /did not fully reach the extension/);

  // An attachment whose metadata says it carries bytes that never arrive.
  const neverSent = loadBackgroundForSyncState();
  assert.equal(neverSent.send({ type: 'syncTransferStart', transferId: 'asset-missing' }).ok, true);
  const headerOnly = messages.filter((message) => message.type === 'syncTransferBatchChunk')
    .map((message) => ({ ...message, transferId: 'asset-missing' }));
  await deliverAll(neverSent, headerOnly);
  const missing = neverSent.send({ type: 'syncNormalized', transferId: 'asset-missing', conversationCount: 1, metadata: {} }, { tab: { id: 7 } });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /1 attachment\(s\) of conversation "with-asset" did not arrive/);
});

test('rejects conversation batch chunks that arrive out of order', () => {
  const background = loadBackgroundForSyncState();
  assert.equal(background.send({ type: 'syncTransferStart', transferId: 'batches-order' }).ok, true);
  const response = background.send({
    type: 'syncTransferBatchChunk',
    transferId: 'batches-order',
    batchIndex: 0,
    chunkIndex: 1,
    totalChunks: 2,
    totalChars: 2,
    data: '}',
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /out of order/);
});

test('reassembles a sync handed off in chunks before syncing', async () => {
  const background = loadBackgroundForSyncState();
  const text = JSON.stringify({ conversations: [], skipped: [], unchangedIds: [], fullList: true });
  const chunks = text.match(/[\s\S]{1,7}/g);
  for (const [index, data] of chunks.entries()) {
    assert.equal(background.send({ type: 'syncTransferChunk', transferId: 't1', index, total: chunks.length, data }).ok, true);
  }
  background.send({ type: 'syncNormalized', transferId: 't1' }, { tab: { id: 7 } });
  for (let i = 0; i < 20 && !background.broadcasts.some((m) => m.stage === 'error'); i++) await new Promise((resolve) => setImmediate(resolve));
  // The reassembled payload reached sync(), which stops here only because no
  // GitHub settings are configured in this harness.
  const error = background.broadcasts.find((m) => m.stage === 'error');
  assert.match(error.error, /Configure GitHub settings/);
});

test('an out-of-order or incomplete chunked handoff publishes nothing and says to sync again', () => {
  const outOfOrder = loadBackgroundForSyncState();
  outOfOrder.send({ type: 'syncTransferChunk', transferId: 't1', index: 0, total: 3, data: '{"a"' });
  const skipped = outOfOrder.send({ type: 'syncTransferChunk', transferId: 't1', index: 2, total: 3, data: '}' });
  assert.equal(skipped.ok, false);
  assert.match(skipped.error, /out of order/);

  const incomplete = loadBackgroundForSyncState();
  incomplete.send({ type: 'syncTransferChunk', transferId: 't2', index: 0, total: 2, data: '{"conversations":' });
  const response = incomplete.send({ type: 'syncNormalized', transferId: 't2' }, { tab: { id: 7 } });
  assert.equal(response.ok, false);
  assert.match(response.error, /did not fully reach the extension .*Nothing was published; sync again/);
  assert.equal(incomplete.broadcasts.at(-1).stage, 'error');

  const unknown = loadBackgroundForSyncState();
  assert.equal(unknown.send({ type: 'syncNormalized', transferId: 'never-sent' }, { tab: { id: 7 } }).ok, false);
});

test('an attachment over the API upload limit is left out with a note instead of failing the sync', async () => {
  const harness = makeBackgroundSyncHarness({ indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }) });
  const [conversation] = sampleConversation();
  conversation.messages[0].files = [{ file_uuid: 'huge', file_name: 'screen recording.mov' }, { file_uuid: 'small', file_name: 'notes.txt' }];
  conversation.assets = [
    { file_uuid: 'huge', name: 'screen recording.mov', mime: 'video/quicktime', base64: '', sha256: 'b'.repeat(64), size: 150 * 1024 * 1024, message_external_id: 'message-1' },
    { file_uuid: 'small', name: 'notes.txt', mime: 'text/plain', base64: btoa('hi'), sha256: 'c'.repeat(64), size: 2, message_external_id: 'message-1' },
  ];
  const result = await harness.sync([conversation], () => {});
  assert.equal(result.commit, 'new-commit');

  const blobs = harness.requests.filter((r) => r.pathname.endsWith('/git/blobs') && r.method === 'POST').map((r) => r.body);
  const markdown = blobs.map((b) => b.content).find((c) => c.includes('AI_ARCHIVE_METADATA'));
  assert.match(markdown, /\*\*Not archived: screen recording\.mov\*\* \(150\.0 MiB; larger than the 30\.0 MiB AI Archive can upload through GitHub's API\)/);
  assert.match(markdown, /\[notes\.txt\]\(assets\/[^)]*notes\.txt\)/);
  const tree = harness.requests.find((r) => r.pathname.endsWith('/git/trees') && r.method === 'POST').body.tree;
  assert.equal(tree.some((entry) => /recording/.test(entry.path)), false, 'the oversized file is never uploaded');
  assert.equal(tree.some((entry) => /notes\.txt$/.test(entry.path) && entry.sha), true);
  const index = JSON.parse(blobs.at(-1).content);
  assert.deepEqual(index.conversations[0].assets.map((a) => a.name), ['notes.txt'], 'the index lists only archived files');
  // The conversation is marked incomplete, so it is reported and checked again.
  assert.equal(result.partial, true);
  assert.deepEqual([...result.report.incomplete[0].missing], ["screen recording.mov (150.0 MiB, over AI Archive's 30.0 MiB upload limit)"]);
  assert.equal(index.conversations[0].incomplete[0].name, 'screen recording.mov');
  assert.equal(index.conversations[0].incomplete[0].too_large, true);
});

// The shape of the owner's first real sync: Claude listed 11 conversations;
// 3 were archived and unchanged, 1 exported, 7 could not be exported (sandbox
// list HTTP 404 and an attachment without a URL) and were never archived.
test('a partial sync reports every conversation by outcome and never calls itself complete', async () => {
  const unchangedIds = ['busqueda', 'carrera', 'gym'];
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: unchangedIds.map((id) => archivedEntry(id)) });
  const harness = makeBackgroundSyncHarness({ indexText });
  const failed = ['repaso', 'canva', 'base-de-datos', 'proyecto', 'edicion-1', 'edition', 'medios'].map((id) => ({
    id, title: id, error: `Could not list Claude sandbox files for conversation "${id}" (HTTP 404).`,
  }));
  const progress = [];
  const result = await harness.sync(sampleConversation(), (event) => progress.push(event), failed, { fullList: true, unchangedIds, listed: 11 });
  const done = progress.find((event) => event.stage === 'done');

  assert.equal(result.commit, 'new-commit');
  assert.equal(done.partial, true);
  assert.match(done.message, /^Sync finished with problems: 1 conversation changed in 1 GitHub commit\. Claude listed 11 conversations\. 3 unchanged conversations were not downloaded again\. 7 conversations could not be exported and are not in the archive yet: "repaso" .*; and 2 more\. The next sync retries them\.$/);
  const report = JSON.parse(JSON.stringify(done.report));
  assert.equal(report.listed, 11);
  assert.equal(report.unchanged, 3);
  assert.deepEqual(report.committed.map((item) => item.id), ['conversation-123456']);
  assert.deepEqual(report.failed.map((item) => [item.id, item.archived]), failed.map((item) => [item.id, false]));
  assert.equal(report.committed.length + report.unchanged + report.failed.length, report.listed, 'every listed conversation is accounted for');

  const index = JSON.parse(harness.requests.filter((r) => r.pathname.endsWith('/git/blobs') && r.method === 'POST').at(-1).body.content);
  assert.deepEqual(index.conversations.map((entry) => entry.id).sort(), ['busqueda', 'carrera', 'conversation-123456', 'gym'], 'failed conversations are not written to the index');
});

test('a failed export of an archived conversation keeps its archived copy and says so', async () => {
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: [archivedEntry('archived-before', { assets: [{ path: 'archive/conversations/claude/personal/assets/a/keep.png', sha256: 'f'.repeat(64) }] })] });
  const harness = makeBackgroundSyncHarness({ indexText });
  const progress = [];
  await harness.sync(sampleConversation(), (event) => progress.push(event), [{ id: 'archived-before', title: 'Archived before', error: 'HTTP 503' }], { fullList: true, listed: 2 });
  const done = progress.find((event) => event.stage === 'done');
  assert.match(done.message, /1 conversation could not be exported; its previously archived copy was kept: "Archived before" \(HTTP 503\)\./);
  const tree = harness.requests.find((r) => r.pathname.endsWith('/git/trees') && r.method === 'POST').body.tree;
  assert.equal(tree.some((entry) => entry.path.includes('archived-before') || entry.path.includes('keep.png')), false, 'nothing of the archived copy is touched');
  const index = JSON.parse(harness.requests.filter((r) => r.pathname.endsWith('/git/blobs') && r.method === 'POST').at(-1).body.content);
  assert.deepEqual(index.conversations.find((entry) => entry.id === 'archived-before'), JSON.parse(indexText).conversations[0]);
});

function incompleteConversation() {
  const [conversation] = sampleConversation();
  conversation.title = 'Base de datos';
  conversation.messages[0].files = [{ file_uuid: 'pdf-1', file_name: 'BD-GICD-Tema2-MER+DC+UML.pdf' }];
  conversation.incomplete = [{ kind: 'attachment', message_external_id: 'message-1', file_uuid: 'pdf-1', name: 'BD-GICD-Tema2-MER+DC+UML.pdf', reason: 'Claude did not provide a download link for this file' }];
  return conversation;
}

test('a file that could not be archived is shown where it was attached, and the conversation is marked incomplete', async () => {
  const harness = makeBackgroundSyncHarness({ indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }) });
  const progress = [];
  await harness.sync([incompleteConversation()], (event) => progress.push(event), [], { fullList: true, listed: 1 });
  const blobs = harness.requests.filter((r) => r.pathname.endsWith('/git/blobs') && r.method === 'POST').map((r) => r.body.content);
  const markdown = blobs.find((content) => content.includes('AI_ARCHIVE_METADATA'));
  assert.match(markdown, /## You\n\n\*\*Attachment not archived: BD-GICD-Tema2-MER\+DC\+UML\.pdf\*\* \(Claude did not provide a download link for this file\)\n\nhello/);
  const entry = JSON.parse(blobs.at(-1)).conversations[0];
  assert.deepEqual(entry.incomplete.map((item) => item.name), ['BD-GICD-Tema2-MER+DC+UML.pdf']);
  const done = progress.find((event) => event.stage === 'done');
  assert.equal(done.partial, true);
  assert.match(done.message, /1 conversation was archived with files missing .*"Base de datos" \(BD-GICD-Tema2-MER\+DC\+UML\.pdf\)/);
});

test('an incomplete archive is never treated as unchanged, so the next sync retries it', async () => {
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: [
    archivedEntry('complete'),
    archivedEntry('incomplete', { incomplete: [{ kind: 'attachment', name: 'x.pdf', reason: 'Claude did not provide a download link for this file' }] }),
  ] });
  const harness = makeBackgroundSyncHarness({ indexText });
  const state = JSON.parse(JSON.stringify(await harness.archiveState()));
  assert.deepEqual(state.map((entry) => entry.id), ['complete']);
});

test('an incomplete export never replaces an archived copy that has files the new export lacks', async () => {
  const conversation = incompleteConversation();
  const keptAsset = { path: 'archive/conversations/claude/personal/assets/conversation-123456/aaaa-BD.pdf', sha256: 'a'.repeat(64), size: 10, mime: 'application/pdf', name: 'BD-GICD-Tema2-MER+DC+UML.pdf' };
  const previous = archivedEntry('conversation-123456', { title: 'Base de datos', assets: [keptAsset], updated_at: '2026-10-01T00:00:00Z' });
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: [previous] });
  const harness = makeBackgroundSyncHarness({ indexText });
  const progress = [];
  const result = await harness.sync([conversation], (event) => progress.push(event), [], { fullList: true, listed: 1 });

  assert.equal(result.commit, null, 'nothing is published');
  assert.equal(harness.requests.some((r) => r.method === 'POST' || r.method === 'PATCH'), false);
  const done = progress.find((event) => event.stage === 'done');
  assert.match(done.message, /^Sync finished with problems: no archived conversation changed, so no GitHub commit was made\. Claude listed 1 conversation\. 1 conversation was not updated because the new export is missing files that are already archived; the archived copy was kept: "Base de datos"\.$/);
});

// ---- Streaming transfer receiver: malformed, interrupted and staged transfers ----

async function startedTransfer(id = 'stream-1', sender = { tab: { id: 7 } }) {
  const background = loadBackgroundForSyncState();
  assert.equal(background.send({ type: 'syncTransferStart', transferId: id }, sender).ok, true);
  return background;
}

function finalize(background, transferId, conversationCount) {
  return background.send({ type: 'syncNormalized', transferId, conversationCount, metadata: {} }, { tab: { id: 7 } });
}

test('a duplicated, skipped or resized batch chunk fails the transfer and nothing can be finalized', async () => {
  const conversations = [{ external_id: 'c1', messages: [{ external_id: 'm1', content: 'x'.repeat(40) }] }];
  const messages = streamTransferMessages('dup', conversations, { chunkChars: 10, recordsPerBatch: 10 });
  assert.ok(messages.length > 3);

  const duplicated = await startedTransfer('dup');
  assert.equal(duplicated.send(messages[0]).ok, true);
  const again = duplicated.send(messages[0]);
  assert.equal(again.ok, false, 'a repeated chunk must be refused');
  assert.match(again.error, /interrupted|incomplete or out of order/);
  assert.equal(duplicated.send(messages[1]).ok, false, 'the failed transfer accepts nothing more');
  assert.equal(finalize(duplicated, 'dup', 1).ok, false);

  const skipped = await startedTransfer('dup');
  assert.equal(skipped.send(messages[0]).ok, true);
  assert.equal(skipped.send(messages[2]).ok, false, 'a missing chunk must be detected');

  const resized = await startedTransfer('dup');
  assert.equal(resized.send(messages[0]).ok, true);
  assert.equal(resized.send({ ...messages[1], totalChars: messages[1].totalChars + 1 }).ok, false,
    'chunks of one batch must agree on its total length');

  const truncated = await startedTransfer('dup');
  const lastIndex = messages.length - 1;
  for (const message of messages.slice(0, lastIndex)) assert.equal(truncated.send(message).ok, true);
  const short = truncated.send({ ...messages[lastIndex], data: messages[lastIndex].data.slice(0, -1) });
  assert.equal(short.ok, false, 'a batch shorter than announced must not be decoded');
});

test('an attachment corrupted in transfer is caught by its checksum before anything is published', async () => {
  const asset = transferAsset('report.txt', 'The quarterly report, exactly as downloaded.');
  const messages = streamTransferMessages('corrupt', [{ external_id: 'c1', messages: [], assets: [asset] }], { chunkChars: 16 });
  const lastAsset = messages.findLastIndex((message) => message.type === 'syncTransferAssetChunk');
  // Same length, one different character: only the checksum can tell.
  const original = messages[lastAsset].data;
  const flipped = (original[0] === 'A' ? 'B' : 'A') + original.slice(1);
  const corrupted = messages.map((message, index) => (index === lastAsset ? { ...message, data: flipped } : message));

  const background = await startedTransfer('corrupt');
  const responses = await deliverAll(background, corrupted);
  const failure = responses.at(-1);
  assert.equal(failure.ok, false);
  assert.match(failure.error, /"report\.txt" could not be received safely: (its contents do not match the checksum|it arrived with \d+ bytes)/);
  assert.equal(finalize(background, 'corrupt', 1).ok, false, 'a corrupted transfer can never be finalized');

  const reordered = await startedTransfer('reordered');
  const reorderedMessages = streamTransferMessages('reordered', [{ external_id: 'c1', messages: [], assets: [asset] }], { chunkChars: 16 });
  const assetChunks = reorderedMessages.filter((message) => message.type === 'syncTransferAssetChunk');
  for (const message of reorderedMessages.filter((message) => message.type === 'syncTransferBatchChunk')) {
    assert.equal(reordered.send(message).ok, true);
  }
  assert.equal(reordered.send(assetChunks[0]).ok, true);
  const swapped = reordered.send(assetChunks[2]);
  assert.equal(swapped.ok, false, 'attachment chunks out of order must be refused');
  assert.match(swapped.error, /incomplete or out of order/);
});

test('attachments and messages are accepted only for the conversation being received', async () => {
  const first = { external_id: 'first', messages: [{ external_id: 'm1' }], assets: [transferAsset('a.txt', 'first file')] };
  const second = { external_id: 'second', messages: [{ external_id: 'm2' }], assets: [transferAsset('b.txt', 'second file')] };
  const all = streamTransferMessages('scope', [first, second], { chunkChars: 4096 });
  const [firstHeader, firstAsset, secondHeader, secondAsset] = all;
  assert.deepEqual(all.map((m) => m.type), ['syncTransferBatchChunk', 'syncTransferAssetChunk', 'syncTransferBatchChunk', 'syncTransferAssetChunk']);

  // The next conversation cannot start while this one's attachment is missing.
  const early = await startedTransfer('scope');
  assert.equal(early.send(firstHeader).ok, true);
  const next = early.send({ ...secondHeader, batchIndex: 1 });
  assert.equal(next.ok, false);
  assert.match(next.error, /attachment\(s\) of conversation "first" did not arrive/);

  // An attachment of an earlier conversation is refused after the next one began.
  const late = await startedTransfer('scope');
  assert.equal(late.send(firstHeader).ok, true);
  assert.equal((await late.request(firstAsset)).ok, true);
  assert.equal(late.send(secondHeader).ok, true);
  assert.equal((await late.request(firstAsset)).ok, false, 'a finished conversation accepts no attachment chunks');

  // The same attachment cannot be delivered twice.
  const twice = await startedTransfer('scope');
  assert.equal(twice.send(firstHeader).ok, true);
  assert.equal((await twice.request(firstAsset)).ok, true);
  const repeated = await twice.request(firstAsset);
  assert.equal(repeated.ok, false);
  assert.match(repeated.error, /already received/);

  // A message record for a conversation that is not the current one.
  const wrong = await startedTransfer('wrong');
  const header = streamTransferMessages('wrong', [{ external_id: 'only', messages: [{ external_id: 'm' }] }], { chunkChars: 4096, recordsPerBatch: 1 })[0];
  assert.equal(wrong.send(header).ok, true);
  const misplacedText = JSON.stringify([{ conversation_index: 3, message: { external_id: 'x' } }]);
  const misplaced = wrong.send({ type: 'syncTransferBatchChunk', transferId: 'wrong', batchIndex: 1, chunkIndex: 0, totalChunks: 1, totalChars: misplacedText.length, data: misplacedText });
  assert.equal(misplaced.ok, false);
  assert.match(misplaced.error, /out of order or for an unexpected conversation/);

  // And a complete, correct transfer of both conversations is accepted.
  const complete = await startedTransfer('scope');
  assert.ok((await deliverAll(complete, all)).every((response) => response.ok));
  assert.equal(finalize(complete, 'scope', 2), undefined, 'the finalizer hands off to sync(), which answers asynchronously');
  for (let i = 0; i < 20 && !complete.broadcasts.some((m) => m.stage === 'error'); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.match(complete.broadcasts.find((m) => m.stage === 'error').error, /Configure GitHub settings/, 'both conversations reached sync()');
});

test('a stray message from another transfer never destroys the running one, and a fresh retry replaces an interrupted one', async () => {
  const background = await startedTransfer('current');
  const conversations = [{ external_id: 'c1', messages: [{ external_id: 'm1', content: 'hello' }] }];
  const stray = streamTransferMessages('older-sync', conversations, { chunkChars: 4096 })[0];
  const strayResponse = background.send(stray);
  assert.equal(strayResponse.ok, false);
  assert.match(strayResponse.error, /no longer receiving this sync/);
  assert.equal(background.send({ type: 'syncTransferAbort', transferId: 'older-sync' }).ok, true);
  assert.equal(background.send({ type: 'syncTransferKeepAlive', transferId: 'current' }).ok, true, 'the running transfer is untouched');

  // Another Claude tab cannot take over a transfer that is still active...
  const otherTab = background.send({ type: 'syncTransferStart', transferId: 'other-tab' }, { tab: { id: 8 } });
  assert.equal(otherTab.ok, false);
  assert.match(otherTab.error, /Another Claude tab/);
  // ...but one abandoned for longer than the stale limit is replaced.
  background.advance(3 * 60 * 1000);
  assert.equal(background.send({ type: 'syncTransferStart', transferId: 'other-tab' }, { tab: { id: 8 } }).ok, true);
  assert.equal(background.send({ type: 'syncTransferKeepAlive', transferId: 'current' }).ok, false, 'the abandoned transfer is gone');

  // The same tab retrying (for example after a reload) replaces its interrupted transfer at once.
  const interrupted = await startedTransfer('first-try');
  const firstTry = streamTransferMessages('first-try', conversations, { chunkChars: 8 });
  assert.equal(interrupted.send(firstTry[0]).ok, true);
  assert.equal(interrupted.send({ type: 'syncTransferStart', transferId: 'retry' }, { tab: { id: 7 } }).ok, true);
  assert.equal(interrupted.send(firstTry[1]).ok, false, 'chunks of the interrupted transfer are refused');
  assert.ok((await deliverAll(interrupted, streamTransferMessages('retry', conversations))).every((response) => response.ok));
  assert.equal(finalize(interrupted, 'first-try', 1).ok, false, 'the interrupted transfer cannot be finalized');
});

test('cancelling clears a transfer that is being received, and a restarted worker reports the transfer as lost', async () => {
  const background = await startedTransfer('to-cancel');
  background.send({ type: 'cancelSync' });
  const keepAlive = background.send({ type: 'syncTransferKeepAlive', transferId: 'to-cancel' });
  assert.equal(keepAlive.ok, false);
  assert.match(keepAlive.error, /no longer receiving this sync .*Nothing was published; sync again/);

  // A fresh worker (Chrome restarted it) knows nothing of the transfer.
  const restarted = loadBackgroundForSyncState();
  const chunk = streamTransferMessages('to-cancel', [{ external_id: 'c', messages: [] }])[0];
  assert.equal(restarted.send(chunk).ok, false);
  assert.equal(finalize(restarted, 'to-cancel', 1).ok, false);
});

test('attachments are uploaded as Git blobs while the transfer is received and only referenced by the final commit', async () => {
  const archivedBytes = Buffer.from('already archived image bytes');
  const archivedAsset = { path: 'archive/conversations/claude/personal/assets/old/aaaa-old.png', sha256: sha256Hex(archivedBytes), size: archivedBytes.length, name: 'old.png' };
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: [{ id: 'old', provider: 'claude', account: 'personal', path: 'archive/conversations/claude/personal/old.md', assets: [archivedAsset] }] });
  const harness = makeBackgroundSyncHarness({ indexText });
  assert.equal(harness.send({ type: 'syncTransferStart', transferId: 'staged' }).ok, true);

  const fresh = transferAsset('notes.txt', 'brand new notes '.repeat(50));
  const reused = { name: 'copy.png', size: archivedBytes.length, sha256: archivedAsset.sha256, base64: archivedBytes.toString('base64') };
  const oversized = { name: 'huge.mov', size: 150 * 1024 * 1024, sha256: 'f'.repeat(64), base64: '' };
  const conversation = {
    ...sampleConversation()[0],
    messages: [{ external_id: 'message-1', role: 'user', content: 'see files', files: [], attachments: [] }],
    assets: [
      { ...fresh, message_external_id: 'message-1' },
      { ...reused, message_external_id: 'message-1' },
      { ...oversized, message_external_id: 'message-1' },
    ],
  };
  const messages = streamTransferMessages('staged', [conversation], { chunkChars: 64 });
  const assetChunks = messages.filter((message) => message.type === 'syncTransferAssetChunk');
  assert.ok(assetChunks.length > 2, 'the new file travels in several chunks');
  assert.equal(assetChunks.some((message) => message.assetIndex === 2), false, 'an oversized file sends no bytes');
  const responses = await deliverAll(harness, messages);
  assert.ok(responses.every((response) => response.ok), JSON.stringify(responses.find((response) => !response.ok)));

  const blobPosts = () => harness.requests.filter((request) => request.method === 'POST' && request.pathname.endsWith('/git/blobs'));
  assert.equal(blobPosts().length, 1, 'only the new file is uploaded; bytes already in the archive are reused');
  assert.equal(blobPosts()[0].body.content, fresh.base64);
  assert.equal(blobPosts()[0].body.encoding, 'base64');
  assert.equal(harness.requests.some((request) => request.method === 'PATCH'), false, 'nothing is published during the transfer');

  const result = await harness.request({ type: 'syncNormalized', transferId: 'staged', conversationCount: 1, metadata: { skipped: [], unchangedIds: [] } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.commit, 'new-commit');
  const tree = harness.requests.find((request) => request.method === 'POST' && request.pathname.endsWith('/git/trees')).body.tree;
  const byName = (name) => tree.find((entry) => entry.path.endsWith(name));
  assert.equal(byName('notes.txt').sha, 'blob-1', 'the commit references the blob uploaded during the transfer');
  assert.equal(byName('copy.png').sha, `existing-${archivedAsset.path}`, 'the reused file points at the archived blob');
  assert.equal(byName('huge.mov'), undefined, 'an oversized file is never written');
  const markdownBlob = blobPosts().find((request) => request.body.encoding === 'utf-8' && request.body.content.includes('# Sync test'));
  assert.match(markdownBlob.body.content, /\*\*Not archived: huge\.mov\*\* \(150\.0 MiB; larger than the 30\.0 MiB AI Archive can upload through GitHub's API\)/);
  assert.equal(blobPosts().filter((request) => request.body.content === fresh.base64).length, 1, 'no attachment is uploaded twice');
  const index = JSON.parse(blobPosts().find((request) => request.body.content.includes('"conversations"') && request.body.content.includes('format_version')).body.content);
  const entry = index.conversations.find((item) => item.id === 'conversation-123456');
  assert.deepEqual(entry.assets.map((asset) => asset.name).sort(), ['copy.png', 'notes.txt']);
  assert.equal(JSON.stringify(entry).includes('blob_sha'), false, 'transfer-only fields stay out of the index');
});

test('a conversation whose Markdown exceeds the API upload limit is reported and kept, and the others are still committed', async () => {
  const harness = makeBackgroundSyncHarness({ indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [] }) });
  const [small] = sampleConversation();
  // 15 million three-byte characters: about 45 MB of UTF-8, over the 40 MiB request limit.
  const huge = {
    ...small,
    external_id: 'conversation-huge',
    title: 'Enormous transcript',
    messages: [{ external_id: 'huge-1', role: 'assistant', content: '€'.repeat(15 * 1000 * 1000), files: [], attachments: [] }],
  };
  const result = await harness.sync([huge, small], () => {});
  assert.equal(result.commit, 'new-commit');
  assert.equal(result.changed, 1);
  assert.equal(result.partial, true);
  assert.equal(result.report.failed.length, 1);
  assert.equal(result.report.failed[0].id, 'conversation-huge');
  assert.match(result.report.failed[0].error, /over the 40\.0 MiB upload limit for GitHub's API/);
  const blobs = harness.requests.filter((request) => request.method === 'POST' && request.pathname.endsWith('/git/blobs'));
  assert.ok(blobs.every((request) => request.body.content.length < 1024 * 1024), 'the oversized transcript is never uploaded');
});

// ---- GitHub API upload limits, refused attachments, commit messages ----

const TOO_LARGE_422 = {
  status: 422,
  body: {
    message: 'Sorry, your input was too large to process. Consider creating the blob in a local clone of the repository and then pushing it to GitHub.',
    documentation_url: 'https://docs.github.com/rest/git/blobs#create-a-blob',
    status: '422',
  },
};

function fileAsset(name, text, messageId = 'message-1', extra = {}) {
  const bytes = Buffer.from(text, 'utf8');
  return { name, mime: 'text/plain', base64: bytes.toString('base64'), sha256: sha256Hex(bytes), size: bytes.length, source: 'message', message_external_id: messageId, ...extra };
}

function conversationWith(id, assets, { content = 'see attachments', title = `Conversation ${id}` } = {}) {
  return {
    external_id: id,
    title,
    model: 'test-model',
    source_created_at: '2026-10-26T08:00:00.000Z',
    source_updated_at: '2026-10-26T09:00:00.000Z',
    message_count: 1,
    messages: [{ external_id: `${id}-m1`, role: 'user', content, files: assets.map((asset) => ({ file_name: asset.name })), attachments: [] }],
    assets: assets.map((asset) => ({ ...asset, message_external_id: `${id}-m1` })),
  };
}

const blobPostsOf = (harness) => harness.requests.filter((request) => request.method === 'POST' && request.pathname.endsWith('/git/blobs'));
const markdownOf = (harness, title) => blobPostsOf(harness).map((request) => request.body.content).find((content) => content.includes(`# ${title}`));
const indexOf = (harness) => JSON.parse(blobPostsOf(harness).map((request) => request.body.content).findLast((content) => content.includes('"format_version"')));
const emptyIndex = () => JSON.stringify({ version: 2, updated_at: '', conversations: [] });

test('the upload limit is set on the base64 JSON request, not on the file size', async () => {
  const harness = makeBackgroundSyncHarness({ indexText: emptyIndex() });
  const { MAX_BLOB_REQUEST_BYTES, MAX_ARCHIVED_FILE_BYTES, base64RequestBytes, createBlob, BlobTooLargeError } = harness.hooks;
  assert.equal(MAX_BLOB_REQUEST_BYTES, 40 * 1024 * 1024);
  // The largest file whose request fits, and the first that does not.
  assert.ok(base64RequestBytes(MAX_ARCHIVED_FILE_BYTES) <= MAX_BLOB_REQUEST_BYTES);
  assert.ok(base64RequestBytes(MAX_ARCHIVED_FILE_BYTES + 3) > MAX_BLOB_REQUEST_BYTES);
  assert.ok(MAX_ARCHIVED_FILE_BYTES > 29.9 * 1024 * 1024 && MAX_ARCHIVED_FILE_BYTES < 30.1 * 1024 * 1024);

  // A request body of exactly the limit is sent; one byte more is refused
  // locally, before any request reaches GitHub.
  const fits = 'A'.repeat(MAX_BLOB_REQUEST_BYTES - JSON.stringify({ content: '', encoding: 'base64' }).length);
  const blob = await createBlob(fits, 'base64');
  assert.match(blob.sha, /^blob-/);
  const before = harness.requests.length;
  await assert.rejects(createBlob(`${fits}A`, 'base64'), (error) => error instanceof BlobTooLargeError && error.remote === null);
  assert.equal(harness.requests.length, before, 'an over-limit blob is never sent');
});

test('an attachment within the limit is archived, and one over it is noted without any upload attempt', async () => {
  const harness = makeBackgroundSyncHarness({ indexText: emptyIndex() });
  const fits = fileAsset('slides.pdf', 'pdf bytes '.repeat(100000));
  const tooBig = { ...fileAsset('recording.mov', 'stand-in bytes'), size: harness.hooks.MAX_ARCHIVED_FILE_BYTES + 1 };
  const result = await harness.sync([conversationWith('c1', [fits, tooBig])], () => {});
  assert.equal(result.commit, 'new-commit');
  assert.equal(blobPostsOf(harness).filter((request) => request.body.encoding === 'base64').length, 1, 'only the file within the limit is uploaded');
  assert.equal(blobPostsOf(harness)[0].body.content, fits.base64);
  const markdown = markdownOf(harness, 'Conversation c1');
  assert.match(markdown, /\[slides\.pdf\]\(assets\/[^)]*slides\.pdf\)/);
  assert.match(markdown, /\*\*Not archived: recording\.mov\*\* \(30\.0 MiB; larger than the 30\.0 MiB AI Archive can upload through GitHub's API\)/);
  assert.equal(result.partial, true);
});

test('an oversized file is recorded in the index and Markdown, and a repeat sync neither uploads it nor commits again', async () => {
  const first = makeBackgroundSyncHarness({ indexText: emptyIndex() });
  const limit = first.hooks.MAX_ARCHIVED_FILE_BYTES;
  const fits = fileAsset('slides.pdf', 'pdf bytes');
  const tooBig = { ...fileAsset('recording.mov', 'stand-in bytes'), size: limit + 1, base64: '' };
  const conversation = () => conversationWith('c1', [fits, tooBig]);
  const result = await first.sync([conversation()], () => {});
  assert.equal(result.partial, true);

  const index = indexOf(first);
  const [entry] = index.conversations;
  assert.deepEqual(entry.assets.map((asset) => asset.name), ['slides.pdf'], 'only archived files are listed as assets');
  assert.deepEqual(JSON.parse(JSON.stringify(entry.incomplete)), [{
    kind: 'attachment', name: 'recording.mov', message_external_id: 'c1-m1',
    reason: `30.0 MiB; larger than the 30.0 MiB AI Archive can upload through GitHub's API`,
    too_large: true, sha256: tooBig.sha256, size: limit + 1,
  }], 'the index keeps the name, size and SHA-256 of the file it could not archive');
  assert.match(markdownOf(first, 'Conversation c1'), /\*\*Not archived: recording\.mov\*\* \(30\.0 MiB; /);
  assert.match(result.report.incomplete[0].missing[0], /^recording\.mov \(31,457,233 bytes, over AI Archive's 31,457,232-byte upload limit\)$/,
    'the report does not call a file one byte over the limit "30.0 MiB, larger than 30.0 MiB"');

  // The same export again, against the archive the first sync produced.
  const repeat = makeBackgroundSyncHarness({ indexText: JSON.stringify(index) });
  const again = await repeat.sync([conversation()], () => {});
  assert.equal(again.commit, null, 'nothing changed, so nothing is committed');
  assert.equal(blobPostsOf(repeat).length, 0, 'the oversized file (and everything else) is not uploaded again');
  assert.equal(again.report.incomplete.length, 1, 'it is still reported as incomplete');
});

test('the report names the upload limit for oversized files and GitHub for refused ones', async () => {
  const harness = makeBackgroundSyncHarness({ indexText: emptyIndex() });
  const limit = harness.hooks.MAX_ARCHIVED_FILE_BYTES;
  const big = { ...fileAsset('big.zip', 'x'), size: 40 * 1024 * 1024, base64: '' };
  const result = await harness.sync([conversationWith('c1', [big])], () => {});
  assert.deepEqual(JSON.parse(JSON.stringify(result.report.incomplete[0].missing)), [`big.zip (40.0 MiB, over AI Archive's 30.0 MiB upload limit)`]);
  assert.ok(limit < 30 * 1024 * 1024, 'the limit is just under 30 MiB');
});

test('GitHub\'s 422 "input was too large" leaves that attachment out, keeps the others, and still publishes', async () => {
  const harness = makeBackgroundSyncHarness({
    indexText: emptyIndex(),
    blobResponder: (body) => (body.content === refused.base64 ? TOO_LARGE_422 : null),
  });
  const refused = fileAsset('T_RICKS_Menu___Slider.html', '<html>'.repeat(200000));
  const kept = fileAsset('notes.txt', 'kept notes');
  const other = conversationWith('c2', [fileAsset('other.txt', 'another conversation')], { title: 'Other conversation' });
  const result = await harness.sync([conversationWith('c1', [refused, kept], { title: 'Slider work' }), other], () => {});

  assert.equal(result.commit, 'new-commit', 'one refused attachment does not abort the sync');
  assert.equal(result.changed, 2);
  assert.equal(blobPostsOf(harness).filter((request) => request.body.content === refused.base64).length, 1,
    'a deterministic refusal is not retried');
  const markdown = markdownOf(harness, 'Slider work');
  assert.match(markdown, /\*\*Not archived: T\\_RICKS\\_Menu\\_\\_\\_Slider\.html\*\* \(1\.1 MiB; GitHub rejected the upload as too large to process \(HTTP 422: "Sorry, your input was too large to process\./);
  assert.match(markdown, /\[notes\.txt\]\(assets\/[^)]*notes\.txt\)/, 'the other attachment of the conversation is archived');
  assert.match(markdownOf(harness, 'Other conversation'), /\[other\.txt\]/);

  const tree = harness.requests.find((request) => request.method === 'POST' && request.pathname.endsWith('/git/trees')).body.tree;
  assert.equal(tree.some((entry) => /Slider\.html$/.test(entry.path)), false, 'the refused file is never claimed as archived');
  assert.equal(tree.filter((entry) => /notes\.txt$|other\.txt$/.test(entry.path)).length, 2);

  const entry = indexOf(harness).conversations.find((item) => item.id === 'c1');
  assert.deepEqual(entry.assets.map((asset) => asset.name), ['notes.txt']);
  assert.equal(entry.incomplete.length, 1);
  assert.equal(entry.incomplete[0].name, 'T_RICKS_Menu___Slider.html');
  assert.equal(entry.incomplete[0].github_rejected, true);
  assert.equal(entry.incomplete[0].sha256, refused.sha256);
  assert.equal(entry.incomplete[0].size, refused.size);
  assert.equal(result.partial, true);
  assert.deepEqual([...result.report.incomplete.map((item) => item.id)], ['c1']);
  assert.deepEqual([...result.report.incomplete[0].missing], ['T_RICKS_Menu___Slider.html (1.1 MiB, refused by GitHub as too large to process)']);
});

test('a different 422 is a real error: it names the attachment and its size, and nothing is published', async () => {
  const harness = makeBackgroundSyncHarness({
    indexText: emptyIndex(),
    blobResponder: () => ({ status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Blob', code: 'invalid', field: 'content' }], documentation_url: 'https://docs.github.com/rest' } }),
  });
  const asset = fileAsset('data.csv', 'a,b\n'.repeat(1000));
  await assert.rejects(harness.sync([conversationWith('c1', [asset])], () => {}),
    /^Error: Attachment "data\.csv" \(3\.9 KiB\) could not be uploaded to GitHub: GitHub 422: Validation Failed \(invalid\) \[while uploading a file\] Nothing was published; the archive on GitHub is unchanged\. Sync again to retry\.$/);
  assert.equal(harness.requests.some((request) => request.method === 'PATCH'), false);
  assert.equal(harness.requests.some((request) => request.pathname.endsWith('/git/trees') && request.method === 'POST'), false);
});

test('archived bytes are reused instead of uploaded again, and bytes GitHub refused are not sent again', async () => {
  const archived = fileAsset('logo.png', 'logo bytes');
  const refused = fileAsset('huge.html', '<p>'.repeat(5000));
  // The path the exporter gives this file, as in an archive it wrote itself.
  const archivedPath = makeBackgroundSyncHarness({ indexText: emptyIndex() }).hooks
    .normalizeAssetList(conversationWith('c1', [archived]), 'claude', 'personal').assets[0].path;
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: [{
    id: 'c1', provider: 'claude', account: 'personal', path: 'archive/conversations/claude/personal/c1.md', title: 'Old',
    updated_at: '2026-10-01T00:00:00.000Z', format_version: 4,
    assets: [{ path: archivedPath, sha256: archived.sha256, size: archived.size, name: 'logo.png' }],
    incomplete: [{ kind: 'attachment', name: 'huge.html', reason: '14.6 KiB; GitHub rejected the upload as too large to process (HTTP 422: "Sorry, your input was too large to process.")', too_large: true, github_rejected: true, sha256: refused.sha256, size: refused.size }],
  }] });
  const harness = makeBackgroundSyncHarness({ indexText, blobResponder: () => null });
  const result = await harness.sync([conversationWith('c1', [archived, refused], { title: 'Updated' })], () => {});
  assert.equal(result.commit, 'new-commit');
  const uploaded = blobPostsOf(harness).map((request) => request.body.content);
  assert.equal(uploaded.includes(archived.base64), false, 'the archived logo is not uploaded again');
  assert.equal(uploaded.includes(refused.base64), false, 'GitHub already refused these exact bytes');
  const tree = harness.requests.find((request) => request.method === 'POST' && request.pathname.endsWith('/git/trees')).body.tree;
  assert.equal(tree.some((entry) => entry.path === archivedPath), false, 'the archived logo stays as it is');
  assert.match(markdownOf(harness, 'Updated'), /\*\*Not archived: huge\.html\*\* \(14\.6 KiB; GitHub rejected the upload as too large to process/);
  assert.match(markdownOf(harness, 'Updated'), /!\[logo\.png\]\(assets\/[^)]*logo\.png\)|\[logo\.png\]/);

  // The same bytes archived under another path (an older layout) are reused
  // for the new path by their blob SHA, without another upload.
  const movedIndex = JSON.stringify({ version: 2, updated_at: '', conversations: [{
    id: 'c1', provider: 'claude', account: 'personal', path: 'archive/conversations/claude/personal/c1.md', title: 'Old',
    updated_at: '2026-10-01T00:00:00.000Z', format_version: 4,
    assets: [{ path: 'archive/conversations/claude/personal/assets/legacy/logo.png', sha256: archived.sha256, size: archived.size, name: 'logo.png' }],
  }] });
  const moved = makeBackgroundSyncHarness({ indexText: movedIndex });
  await moved.sync([conversationWith('c1', [archived], { title: 'Moved' })], () => {});
  assert.equal(blobPostsOf(moved).some((request) => request.body.content === archived.base64), false);
  const movedTree = moved.requests.find((request) => request.method === 'POST' && request.pathname.endsWith('/git/trees')).body.tree;
  assert.equal(movedTree.find((entry) => entry.path === archivedPath).sha, 'existing-archive/conversations/claude/personal/assets/legacy/logo.png');
});

test('a file that was unavailable before is archived by a later sync and the conversation is complete again', async () => {
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: [{
    id: 'c1', provider: 'claude', account: 'personal', path: 'archive/conversations/claude/personal/c1.md', title: 'Report',
    updated_at: '2026-10-26T09:00:00.000Z', format_version: 4, assets: [],
    incomplete: [{ kind: 'attachment', name: 'report.pdf', message_external_id: 'c1-m1', reason: 'Claude returned HTTP 404 for its download' }],
  }] });
  const harness = makeBackgroundSyncHarness({ indexText });
  const pdf = fileAsset('report.pdf', '%PDF finally available');
  const result = await harness.sync([conversationWith('c1', [pdf], { title: 'Report' })], () => {});
  assert.equal(result.commit, 'new-commit');
  assert.equal(result.partial, false);
  assert.equal(blobPostsOf(harness).filter((request) => request.body.content === pdf.base64).length, 1);
  const entry = indexOf(harness).conversations.find((item) => item.id === 'c1');
  assert.equal(entry.incomplete, undefined, 'the conversation is no longer marked incomplete');
  assert.deepEqual(entry.assets.map((asset) => asset.name), ['report.pdf']);
  assert.doesNotMatch(markdownOf(harness, 'Report'), /not archived/i);
});

test('a refused attachment received through the streaming transfer is noted, and the transfer still completes', async () => {
  const refused = transferAsset('T_RICKS_Menu___Slider.html', '<div>'.repeat(30000));
  const kept = transferAsset('ok.txt', 'fine');
  const harness = makeBackgroundSyncHarness({
    indexText: JSON.stringify({ version: 2, updated_at: '', conversations: [{ id: 'old', provider: 'claude', account: 'personal', path: 'archive/conversations/claude/personal/old.md', assets: [] }] }),
    blobResponder: (body) => (body.content === refused.base64 ? TOO_LARGE_422 : null),
  });
  assert.equal(harness.send({ type: 'syncTransferStart', transferId: 'refused' }).ok, true);
  const conversation = { ...conversationWith('c1', [], { title: 'Streamed' }), assets: [refused, kept].map((asset) => ({ ...asset, message_external_id: 'c1-m1' })) };
  const responses = await deliverAll(harness, streamTransferMessages('refused', [conversation], { chunkChars: 50000 }));
  assert.ok(responses.every((response) => response.ok), JSON.stringify(responses.find((response) => !response.ok)));
  const result = await harness.request({ type: 'syncNormalized', transferId: 'refused', conversationCount: 1, metadata: {} });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.partial, true);
  assert.match(markdownOf(harness, 'Streamed'), /\*\*Not archived: T\\_RICKS\\_Menu\\_\\_\\_Slider\.html\*\* \(146\.5 KiB; GitHub rejected the upload as too large to process \(HTTP 422/);
  assert.match(markdownOf(harness, 'Streamed'), /\[ok\.txt\]/);
  assert.match(harness.storedValues().last_sync.message, /^Sync finished with problems: 1 conversation changed in 1 GitHub commit\..*archived with files missing .*T_RICKS_Menu___Slider\.html \(146\.5 KiB, refused by GitHub as too large to process\)/);
});

test('the commit message counts changed conversations, not files, deletions or assets', async () => {
  const previousAsset = { path: 'archive/conversations/claude/personal/assets/x/old.png', sha256: 'e'.repeat(64), size: 3, name: 'old.png' };
  const indexText = JSON.stringify({ version: 2, updated_at: '', conversations: [{
    id: 'c1', provider: 'claude', account: 'personal', path: 'archive/conversations/claude/personal/c1-old-name.md', title: 'Old title',
    updated_at: '2026-10-01T00:00:00.000Z', format_version: 4, assets: [previousAsset],
  }] });
  const harness = makeBackgroundSyncHarness({ indexText });
  const ten = Array.from({ length: 10 }, (_, i) => conversationWith(`c${i + 1}`,
    i < 9 ? [fileAsset(`a${i}.txt`, `first ${i}`), fileAsset(`b${i}.txt`, `second ${i}`)] : []));
  const progress = [];
  const result = await harness.sync(ten, (message) => progress.push(message));
  assert.equal(result.changed, 10);
  const commit = harness.requests.find((request) => request.method === 'POST' && request.pathname.endsWith('/git/commits')).body;
  assert.equal(commit.message, 'Sync 10 AI conversations (18 assets)', 'the old file and its deleted asset do not count');
  assert.match(progress.find((message) => message.stage === 'done').message, /^Sync complete: 10 conversations changed in 1 GitHub commit\./,
    'the popup and the commit agree on the conversation count');

  const { syncCommitMessage } = harness.hooks;
  assert.equal(syncCommitMessage(1, 0), 'Sync 1 AI conversation');
  assert.equal(syncCommitMessage(2, 1), 'Sync 2 AI conversations (1 asset)');
  assert.equal(syncCommitMessage(0, 0), 'Update AI Archive index');
});

test('GitHub errors keep GitHub\'s own message, stay bounded, and never contain the token', async () => {
  const { gitHubError } = makeBackgroundSyncHarness({ indexText: emptyIndex() }).hooks;
  const settings = { github_owner: 'o', github_repo: 'r', github_token: 'github_pat_SECRET1234567890abcdefghij' };
  const response = (status) => ({ status, headers: { get: () => null } });
  const noisy = JSON.stringify({ message: `Bad things with github_pat_SECRET1234567890abcdefghij and ghp_${'x'.repeat(36)} ${'detail '.repeat(500)}`, documentation_url: 'https://docs.github.com/x' });
  const error = gitHubError(response(500), noisy, settings);
  assert.match(error.message, /^GitHub 500: Bad things with <token> and <token> detail/);
  assert.equal(error.message.includes('SECRET'), false);
  assert.ok(error.message.length < 700, `bounded: ${error.message.length}`);
  assert.equal(error.message.includes('documentation_url'), false, 'GitHub\'s message, not its raw JSON');

  const tooLarge = gitHubError(response(422), JSON.stringify(TOO_LARGE_422.body), settings);
  assert.equal(tooLarge.inputTooLarge, true);
  assert.match(tooLarge.message, /^GitHub 422: Sorry, your input was too large to process\. Consider creating the blob in a local clone of the repository and then pushing it to GitHub\.$/);
  const validation = gitHubError(response(422), JSON.stringify({ message: 'Validation Failed', errors: [{ code: 'missing_field' }] }), settings);
  assert.equal(validation.inputTooLarge, false, 'other 422 responses are not size errors');
  assert.equal(gitHubError(response(413), 'Request Entity Too Large', settings).inputTooLarge, true);
});


// ---- Large syncs and GitHub 502 "Server Error" responses ----
// Synthetic conversations only: no real conversation text or identifiers.

function syntheticConversations(count) {
  return Array.from({ length: count }, (_, i) => {
    const id = `synthetic-${String(i).padStart(4, '0')}-0000-0000-000000000000`;
    return {
      external_id: id,
      title: `Synthetic conversation ${i}`,
      model: 'test-model',
      source_created_at: '2026-10-26T08:00:00.000Z',
      source_updated_at: new Date(Date.UTC(2026, 9, 26, 9, 0, i)).toISOString(),
      message_count: 1,
      messages: [{ external_id: `${id}-m1`, role: 'user', content: `synthetic message ${i}`, files: [], attachments: [] }],
      assets: [],
    };
  });
}

const SERVER_ERROR_502 = { status: 502, message: 'Server Error' };
const countRequests = (harness, method, suffix) => harness.requests.filter((r) => r.method === method && r.pathname.endsWith(suffix)).length;

function assertCompleteArchive(harness, conversations) {
  const archive = harness.lastCommittedArchive();
  assert.ok(archive?.index, 'a commit with an index was created');
  const ids = archive.index.conversations.map((entry) => entry.id);
  assert.equal(ids.length, conversations.length, 'every conversation is in the index exactly once');
  assert.equal(new Set(ids).size, ids.length, 'no duplicated index entries');
  assert.deepEqual([...ids].sort(), conversations.map((c) => c.external_id).sort());
  for (const entry of archive.index.conversations) {
    assert.ok(archive.tree.has(entry.path), `the committed tree holds ${entry.path}`);
  }
  const markdownPaths = [...archive.tree.keys()].filter((path) => path.endsWith('.md'));
  assert.equal(markdownPaths.length, conversations.length, 'one Markdown file per conversation');
}

test('an 812-conversation sync builds its tree in chained batches and publishes one commit', async () => {
  const conversations = syntheticConversations(812);
  const harness = makeBackgroundSyncHarness({ indexText: emptyIndex() });
  const result = await harness.sync(conversations, () => {});
  assert.equal(result.changed, 812);
  const treePosts = harness.requests.filter((r) => r.method === 'POST' && r.pathname.endsWith('/git/trees'));
  assert.equal(treePosts.length, Math.ceil(813 / 100), '812 Markdown files and the index, at most 100 entries per request');
  assert.ok(treePosts.every((r) => r.body.tree.length <= 100));
  assert.equal(treePosts[0].body.base_tree, 'base-tree');
  for (let i = 1; i < treePosts.length; i++) {
    assert.match(treePosts[i].body.base_tree, /^tree-/, 'each batch starts from the tree the previous batch returned');
  }
  assert.equal(countRequests(harness, 'POST', '/git/commits'), 1);
  assert.equal(countRequests(harness, 'PATCH', '/git/refs/heads/master'), 1);
  assertCompleteArchive(harness, conversations);
});

test('a transient 502 Server Error on any idempotent step of a large sync is retried and the sync completes once', async () => {
  for (const failure of [
    { method: 'GET', pathSuffix: '/git/trees/base-tree' },
    { method: 'POST', pathSuffix: '/git/blobs', after: 300 },
    { method: 'POST', pathSuffix: '/git/trees', after: 4 },
    { method: 'POST', pathSuffix: '/git/commits' },
  ]) {
    const conversations = syntheticConversations(250);
    const harness = makeBackgroundSyncHarness({
      indexText: emptyIndex(),
      failOnce: { ...failure, ...SERVER_ERROR_502, times: 4 },
    });
    const result = await harness.sync(conversations, () => {});
    assert.equal(result.commit, 'new-commit', `${failure.method} ${failure.pathSuffix} recovers`);
    assert.equal(countRequests(harness, 'PATCH', '/git/refs/heads/master'), 1);
    assertCompleteArchive(harness, conversations);
  }
});

test('a persistent 502 publishes nothing, names the failed step, and the next sync resumes without duplicates', async () => {
  for (const [failure, operation] of [
    [{ method: 'GET', pathSuffix: '/git/trees/base-tree' }, 'reading the archive file list'],
    [{ method: 'POST', pathSuffix: '/git/blobs', after: 500 }, 'uploading a file'],
    [{ method: 'POST', pathSuffix: '/git/trees', after: 2 }, 'building the archive tree'],
    [{ method: 'POST', pathSuffix: '/git/commits' }, 'creating the sync commit'],
  ]) {
    const conversations = syntheticConversations(812);
    const harness = makeBackgroundSyncHarness({
      indexText: emptyIndex(),
      // GitHub keeps failing (with parallel uploads, failures land on several
      // files) until the outage ends below.
      failOnce: { ...failure, ...SERVER_ERROR_502, times: Infinity },
    });
    const progress = [];
    await assert.rejects(harness.sync(conversations, (event) => progress.push(event)), (error) => {
      assert.match(error.message, new RegExp(`^GitHub 502: Server Error \\[while ${operation.replace(/[()]/g, '\\$&')}; failed 5 attempts\\] Nothing was published; the archive on GitHub is unchanged\\. Sync again to retry\\.$`));
      return true;
    });
    assert.equal(countRequests(harness, 'PATCH', '/git/refs/heads/master'), 0, 'the branch is never moved after a failure');
    assert.equal(progress.some((event) => event.stage === 'done'), false);

    // The failed sync left the branch unchanged, so the retry starts from the
    // same archive and publishes every conversation exactly once.
    harness.endInjectedFailures();
    const retry = await harness.sync(conversations, () => {});
    assert.equal(retry.changed, 812);
    assert.equal(countRequests(harness, 'PATCH', '/git/refs/heads/master'), 1);
    assertCompleteArchive(harness, conversations);
  }
});

test('a 502 on the branch update is never repeated blindly; an unchanged branch is reported and the retry succeeds', async () => {
  const conversations = syntheticConversations(20);
  const harness = makeBackgroundSyncHarness({
    indexText: emptyIndex(),
    failOnce: { method: 'PATCH', pathSuffix: '/git/refs/heads/master', ...SERVER_ERROR_502, times: 1 },
  });
  await assert.rejects(harness.sync(conversations, () => {}),
    /^Error: GitHub 502: Server Error \[while publishing the sync commit \(branch update\)\] GitHub confirms the "master" branch is unchanged: nothing was published; sync again\.$/);
  assert.equal(countRequests(harness, 'PATCH', '/git/refs/heads/master'), 1, 'the ref update is sent once');
  const patchIndex = harness.requests.findIndex((r) => r.method === 'PATCH');
  assert.ok(harness.requests.slice(patchIndex + 1).some((r) => r.method === 'GET' && r.pathname.endsWith('/git/ref/heads/master')),
    'the branch head is read back to establish the outcome');

  const retry = await harness.sync(conversations, () => {});
  assert.equal(retry.commit, 'new-commit');
  assertCompleteArchive(harness, conversations);
});

test('a tree GitHub built differently from the planned changes is never committed', async () => {
  const conversations = syntheticConversations(150);
  let dropped = null;
  const harness = makeBackgroundSyncHarness({
    indexText: emptyIndex(),
    treeTamper: (entries) => {
      // Lose one Markdown file in the last batch, as a misapplied request would.
      if (!entries.has('archive/index.json')) return;
      dropped = [...entries.keys()].find((path) => path.endsWith('.md'));
      entries.delete(dropped);
    },
  });
  await assert.rejects(harness.sync(conversations, () => {}),
    /Archive integrity check failed: the tree GitHub built does not match this sync for 1 file\(s\).*No archive changes were published/);
  assert.ok(dropped);
  assert.equal(countRequests(harness, 'POST', '/git/commits'), 0);
  assert.equal(countRequests(harness, 'PATCH', '/git/refs/heads/master'), 0);
});

test('the index size is recorded, warned about near the request limit, and an oversized index fails before any upload', async () => {
  const conversations = syntheticConversations(30);
  const small = makeBackgroundSyncHarness({ indexText: emptyIndex() });
  const result = await small.sync(conversations, () => {});
  const indexBytes = result.report.index_bytes;
  assert.ok(Number.isSafeInteger(indexBytes) && indexBytes > 0, 'the outcome records the index size');

  const warned = makeBackgroundSyncHarness({
    indexText: emptyIndex(),
    sourcePatches: [['const INDEX_WARN_BYTES = 20 * 1024 * 1024;', `const INDEX_WARN_BYTES = ${indexBytes - 1};`]],
  });
  const progress = [];
  await warned.sync(conversations, (event) => progress.push(event));
  assert.match(progress.at(-1).message, /The archive index \(archive\/index\.json\) is [\d.]+ KiB; syncs will stop working when it nears 40\.0 MiB/);

  const blocked = makeBackgroundSyncHarness({
    indexText: emptyIndex(),
    sourcePatches: [['const MAX_BLOB_REQUEST_BYTES = 40 * 1024 * 1024;', `const MAX_BLOB_REQUEST_BYTES = ${indexBytes};`]],
  });
  await assert.rejects(blocked.sync(conversations, () => {}),
    /^Error: The archive index \(archive\/index\.json\) would be [\d.]+ KiB, more than the [\d.]+ KiB GitHub's API accepts in one request\. No archive changes were published\./);
  assert.equal(countRequests(blocked, 'POST', '/git/blobs'), 0, 'nothing is uploaded for a sync that cannot be published');
  assert.equal(countRequests(blocked, 'PATCH', '/git/refs/heads/master'), 0);
});

test('the archive state lists recorded oversized files for the current account only', async () => {
  const limit = makeBackgroundSyncHarness({ indexText: emptyIndex() }).hooks.MAX_ARCHIVED_FILE_BYTES;
  const item = (extra) => ({ kind: 'attachment', name: 'f', reason: 'r', too_large: true, file_uuid: 'u1', sha256: 'a'.repeat(64), size: limit + 1, ...extra });
  const entry = (id, account, incomplete) => ({ id, provider: 'claude', account, path: `archive/conversations/claude/${account}/${id}.md`, assets: [], incomplete, exporter_version: 1, updated_at: '2026-10-01T00:00:00Z' });
  const index = { version: 2, conversations: [
    entry('c1', 'personal', [item(), item({ file_uuid: 'u2', github_rejected: true, size: 4 * 1024 * 1024 }), item({ file_uuid: 'u3', sha256: 'bad' }), item({ file_uuid: undefined }), item({ file_uuid: 'u4', size: limit })]),
    entry('c2', 'work', [item()]),
  ] };
  const harness = makeBackgroundSyncHarness({ indexText: JSON.stringify(index) });
  const state = await harness.hooks.archiveSyncState();
  assert.deepEqual(JSON.parse(JSON.stringify(state.oversized)), [{ id: 'c1', file_uuid: 'u1', size: limit + 1, sha256: 'a'.repeat(64) }]);
  assert.deepEqual(JSON.parse(JSON.stringify(state.conversations)), [], 'incomplete conversations are still never skipped');
});
