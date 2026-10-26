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
  vm.runInNewContext(`${popupSource}\nglobalThis.__describeRepoCheck = describeRepoCheck;`, context);
  return { describeRepoCheck: context.__describeRepoCheck, element };
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
