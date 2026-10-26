import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

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
  const closing = '\n})();';
  const closingIndex = backgroundSource.lastIndexOf(closing);
  assert.notEqual(closingIndex, -1, 'background service worker closing marker must exist');
  const sourceWithTestHooks = `${backgroundSource.slice(0, closingIndex)}
  globalThis.__testHooks = { assetMatchesMessage, findMessageAssets };
})();${backgroundSource.slice(closingIndex + closing.length)}`;
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
