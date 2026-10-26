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
globalThis.__testHooks = { assetMatchesMessage, findMessageAssets };
`;
  const context = { chrome, AbortController, fetch: () => new Promise(() => {}) };
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


function makeBackgroundSyncHarness({ indexText, advanceBranchOnRecheck = false }) {
  const listeners = [];
  const requests = [];
  const baseSha = 'base-commit';
  const concurrentSha = 'concurrent-commit';
  let masterRefReads = 0;
  let blobCount = 0;
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
    requests.push({ pathname, method });

    if (pathname.endsWith('/git/ref/heads/main')) {
      return response({ message: 'Not Found' }, 404);
    }
    if (pathname.endsWith('/git/ref/heads/master') && method === 'GET') {
      masterRefReads += 1;
      const sha = advanceBranchOnRecheck && masterRefReads > 1 ? concurrentSha : baseSha;
      return response({ ref: 'refs/heads/master', object: { sha } });
    }
    if (pathname.endsWith('/git/commits/base-commit') && method === 'GET') {
      return response({ sha: baseSha, tree: { sha: 'base-tree' } });
    }
    if (pathname.endsWith('/git/trees/base-tree') && method === 'GET') {
      return response({ sha: 'base-tree', tree: [] });
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
      return response({ ref: 'refs/heads/master', object: { sha: 'new-commit' } });
    }
    throw new Error(`Unexpected test request: ${method} ${pathname}`);
  };

  const context = { chrome, fetch, AbortController, TextEncoder, Uint8Array, crypto: webcrypto, btoa, atob };
  vm.runInNewContext(`${backgroundSource}
globalThis.__testHooks = { sync };
`, context, { filename: 'extension/background.js' });

  return {
    sync: context.__testHooks.sync,
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
