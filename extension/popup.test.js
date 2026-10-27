import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const popupSource = await readFile(fileURLToPath(new URL('./popup.js', import.meta.url)), 'utf8');

function loadPopup() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, value: '', checked: false, disabled: false, textContent: '', className: '', style: {},
        classList: { add() {}, remove() {} },
      });
    }
    return elements.get(id);
  };
  const chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    runtime: { lastError: null, onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); } },
    tabs: { query: async () => [] },
  };
  const context = {
    chrome,
    document: { getElementById: element },
    GITHUB_OWNER: '',
    GITHUB_REPO: '',
    fetch: async () => { throw new Error('unexpected fetch'); },
  };
  vm.runInNewContext(`${popupSource}\nglobalThis.__describeRepoCheck = describeRepoCheck;\nglobalThis.__describeLastSync = describeLastSync;`, context);
  return { describeRepoCheck: context.__describeRepoCheck, describeLastSync: context.__describeLastSync, element };
}

test('explains repository check failures before saving GitHub settings', () => {
  const { describeRepoCheck } = loadPopup();
  assert.match(describeRepoCheck(401, null, 'me', 'archive'), /rejected the token \(401\)/);
  assert.match(describeRepoCheck(404, null, 'me', 'archive'), /Repository me\/archive was not found, or the token cannot access it/);
  assert.match(describeRepoCheck(403, null, 'me', 'archive'), /needs read and write access/);
  assert.match(describeRepoCheck(502, null, 'me', 'archive'), /could not check me\/archive \(502\)/);
  assert.match(describeRepoCheck(200, { permissions: { pull: true, push: false } }, 'me', 'archive'),
    /can read me\/archive but cannot write/);
});

test('accepts a repository the token can write to', () => {
  const { describeRepoCheck } = loadPopup();
  assert.equal(describeRepoCheck(200, { permissions: { pull: true, push: true } }, 'me', 'archive'), null);
  // Without permission data (for example some token types), do not block saving.
  assert.equal(describeRepoCheck(200, { full_name: 'me/archive' }, 'me', 'archive'), null);
});

test('describes the most recent sync outcome for the popup', () => {
  const { describeLastSync } = loadPopup();
  const now = Date.parse('2026-10-27T12:00:00Z');
  assert.equal(describeLastSync(null, now), '');
  assert.equal(describeLastSync({ stage: 'done', at: 'not a date' }, now), '');
  assert.equal(describeLastSync({ stage: 'done', at: '2026-10-27T11:59:30Z', message: 'Sync complete: 2 conversations changed in 1 GitHub commit.' }, now),
    'Last sync just now: Sync complete: 2 conversations changed in 1 GitHub commit.');
  assert.equal(describeLastSync({ stage: 'error', at: '2026-10-27T11:48:00Z', message: 'GitHub 401: GitHub rejected the access token.' }, now),
    'Last sync failed 12 min ago: GitHub 401: GitHub rejected the access token.');
  assert.equal(describeLastSync({ stage: 'cancelled', at: '2026-10-27T09:00:00Z', message: '' }, now), 'Last sync cancelled 3 h ago.');
  assert.equal(describeLastSync({ stage: 'done', at: '2026-10-20T09:00:00Z', message: 'Everything is already up to date.' }, now),
    'Last sync on 2026-10-20: Everything is already up to date.');
});
