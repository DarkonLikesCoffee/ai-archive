import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const popupSource = await readFile(fileURLToPath(new URL('./popup.js', import.meta.url)), 'utf8');

function loadPopup({ tabs = {} } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, value: '', checked: false, disabled: false, textContent: '', className: '', style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        children: [], replaceChildren(...nodes) { this.children = nodes; },
      });
    }
    return elements.get(id);
  };
  const chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    runtime: { lastError: null, onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); } },
    tabs: { query: async () => [], ...tabs },
  };
  const context = {
    chrome,
    document: { getElementById: element },
    GITHUB_OWNER: '',
    GITHUB_REPO: '',
    fetch: async () => { throw new Error('unexpected fetch'); },
    setTimeout: (fn) => setImmediate(fn),
  };
  vm.runInNewContext(`${popupSource}\nglobalThis.__describeRepoCheck = describeRepoCheck;\nglobalThis.__describeLastSync = describeLastSync;\nglobalThis.__describeSyncReport = describeSyncReport;\nglobalThis.__sendToClaude = sendToClaude;`, context);
  return { describeRepoCheck: context.__describeRepoCheck, describeLastSync: context.__describeLastSync, describeSyncReport: context.__describeSyncReport, sendToClaude: context.__sendToClaude, element, chrome };
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

// A fake chrome.tabs: `open` lists existing tabs; `ready` decides whether a
// tab's content script answers a message (a function of the tab and attempt).
function fakeTabs({ open = [], activeId = null, ready = () => true } = {}) {
  const tabs = [...open];
  const sent = [];
  const created = [];
  let lastError = null;
  const api = {
    async query(filter) {
      if (filter.active) return tabs.filter((t) => t.id === activeId);
      return tabs.filter((t) => t.url.startsWith('https://claude.ai/'));
    },
    async create(props) {
      const tab = { id: 100 + created.length, url: props.url, active: props.active };
      created.push(props);
      tabs.push(tab);
      return tab;
    },
    sendMessage(tabId, message, callback) {
      sent.push({ tabId, message });
      const attempt = sent.filter((s) => s.tabId === tabId).length;
      const ok = ready(tabId, attempt);
      lastError = ok ? null : { message: 'Could not establish connection. Receiving end does not exist.' };
      api.onSend?.(lastError);
      callback(ok ? { ok: true } : undefined);
    },
  };
  return { api, sent, created, setLastErrorHook: (fn) => { api.onSend = fn; } };
}

function loadWithTabs(options) {
  const fake = fakeTabs(options);
  const popup = loadPopup({ tabs: fake.api });
  fake.setLastErrorHook((error) => { popup.chrome.runtime.lastError = error; });
  return { ...popup, ...fake };
}

test('sync goes to the active Claude tab', async () => {
  const { sendToClaude, sent, created } = loadWithTabs({ open: [{ id: 1, url: 'https://claude.ai/chat/x', lastAccessed: 1 }, { id: 2, url: 'https://claude.ai/new', lastAccessed: 9 }], activeId: 1 });
  await sendToClaude({ type: 'startSync', limit: 'all' }, { openIfMissing: true });
  assert.deepEqual(sent.map((s) => s.tabId), [1]);
  assert.equal(created.length, 0);
});

test('from another tab, sync uses the most recently used Claude tab', async () => {
  const { sendToClaude, sent } = loadWithTabs({ open: [{ id: 1, url: 'https://claude.ai/chat/x', lastAccessed: 5 }, { id: 2, url: 'https://claude.ai/new', lastAccessed: 9 }, { id: 3, url: 'https://example.com/', lastAccessed: 99 }], activeId: 3 });
  await sendToClaude({ type: 'startSync', limit: 'all' }, { openIfMissing: true });
  assert.deepEqual(sent.map((s) => s.tabId), [2]);
});

test('without a Claude tab, sync opens one in the background and waits for it to load', async () => {
  const { sendToClaude, sent, created, element } = loadWithTabs({ ready: (tabId, attempt) => attempt >= 3 });
  assert.deepEqual(JSON.parse(JSON.stringify(await sendToClaude({ type: 'startSync', limit: 'all' }, { openIfMissing: true }))), { ok: true });
  assert.deepEqual(JSON.parse(JSON.stringify(created)), [{ url: 'https://claude.ai/', active: false }]);
  assert.equal(sent.length, 3);
  assert.equal(element('status').textContent, 'Claude.ai opened in a background tab.');
});

test('a new Claude tab that never answers ends with a clear error', async () => {
  const { sendToClaude, sent } = loadWithTabs({ ready: () => false });
  await assert.rejects(sendToClaude({ type: 'startSync', limit: 'all' }, { openIfMissing: true }), /did not finish loading in the new tab/);
  assert.equal(sent.length, 40);
});

test('cancel never opens a tab, and an unresponsive Claude tab asks for a refresh', async () => {
  const none = loadWithTabs({});
  await assert.rejects(none.sendToClaude({ type: 'cancelSync' }), /Open a Claude.ai tab first/);
  assert.equal(none.created.length, 0);
  const stale = loadWithTabs({ open: [{ id: 1, url: 'https://claude.ai/new' }], activeId: 1, ready: () => false });
  await assert.rejects(stale.sendToClaude({ type: 'startSync', limit: 'all' }, { openIfMissing: true }), /Refresh the Claude.ai tab/);
  assert.equal(stale.created.length, 0);
});

test('a partial sync is labelled as such and lists each affected conversation with its ID', () => {
  const { describeLastSync, describeSyncReport } = loadPopup();
  const now = Date.parse('2026-10-27T12:00:00Z');
  assert.match(describeLastSync({ stage: 'done', at: '2026-10-27T11:58:00Z', message: 'Sync finished with problems: …', partial: true }, now), /^Last sync finished with problems 2 min ago: /);
  const lines = JSON.parse(JSON.stringify(describeSyncReport({
    failed: [{ id: 'c-1', title: 'Repaso de Information Science', error: 'HTTP 503', archived: false }, { id: 'c-2', title: 'Old', error: 'HTTP 500', archived: true }],
    incomplete: [{ id: 'c-3', title: 'Base de datos', missing: ['BD-GICD-Tema2-MER+DC+UML.pdf'] }],
    keptPrevious: [{ id: 'c-4', title: 'Kept' }],
  })));
  assert.deepEqual(lines, [
    'Not exported, not in the archive yet: Repaso de Information Science (c-1) — HTTP 503',
    'Not exported, archived copy kept: Old (c-2) — HTTP 500',
    'Archived with files missing: Base de datos (c-3) — BD-GICD-Tema2-MER+DC+UML.pdf',
    'Not updated, archived copy kept (new export is missing files): Kept (c-4)',
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(describeSyncReport(null))), []);
});
