import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const popupSource = await readFile(fileURLToPath(new URL('./popup.js', import.meta.url)), 'utf8');

function loadPopup({ tabs = {} } = {}) {
  const elements = new Map();
  const storedSettings = {};
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, value: '', checked: false, disabled: false, textContent: '', className: '', style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        children: [], replaceChildren(...nodes) { this.children = nodes; }, focus() {},
      });
    }
    return elements.get(id);
  };
  const chrome = {
    storage: { local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in storedSettings).map((key) => [key, storedSettings[key]])),
      set: async (values) => { Object.assign(storedSettings, values); },
      remove: async (keys) => { for (const key of (Array.isArray(keys) ? keys : [keys])) delete storedSettings[key]; },
    } },
    runtime: { lastError: null, getManifest() { return { version: '0.5.10' }; }, onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); } },
    tabs: { query: async () => [], ...tabs },
  };
  const context = {
    chrome,
    document: {
      getElementById: element,
      createElement(tag) { return { tagName: tag.toUpperCase(), value: '', textContent: '', disabled: false }; },
    },
    GITHUB_OWNER: '',
    GITHUB_REPO: '',
    fetch: async () => { throw new Error('unexpected fetch'); },
    setTimeout: (fn) => setImmediate(fn),
  };
  vm.runInNewContext(`${popupSource}\nglobalThis.__describeRepoCheck = describeRepoCheck;\nglobalThis.__describeLastSync = describeLastSync;\nglobalThis.__describeSyncReport = describeSyncReport;\nglobalThis.__sendToClaude = sendToClaude;
globalThis.__renderAccountOptions = renderAccountOptions;
globalThis.__findExistingAccountName = findExistingAccountName;
globalThis.__createArchiveAccount = createArchiveAccount;
globalThis.__loadDiagnostics = loadDiagnostics;
globalThis.__isCurrentDiagnosticReport = isCurrentDiagnosticReport;
globalThis.__getLastDiagnostics = () => lastDiagnostics;
globalThis.__disconnectGithubSettings = disconnectGithubSettings;`, context);
  return {
    describeRepoCheck: context.__describeRepoCheck,
    describeLastSync: context.__describeLastSync,
    describeSyncReport: context.__describeSyncReport,
    sendToClaude: context.__sendToClaude,
    renderAccountOptions: context.__renderAccountOptions,
    findExistingAccountName: context.__findExistingAccountName,
    createArchiveAccount: context.__createArchiveAccount,
    loadDiagnostics: context.__loadDiagnostics,
    isCurrentDiagnosticReport: context.__isCurrentDiagnosticReport,
    getLastDiagnostics: context.__getLastDiagnostics,
    disconnectGithubSettings: context.__disconnectGithubSettings,
    refresh: context.refresh,
    element, chrome, storedSettings
  };
}

test('renders saved archive names as selectable options and keeps the selected name', () => {
  const { renderAccountOptions, element } = loadPopup();
  const names = JSON.parse(JSON.stringify(renderAccountOptions(['logan', 'work', 'logan'], 'work')));
  assert.deepEqual(names, ['logan', 'work']);
  assert.deepEqual(element('accountLogged').children.slice(1).map((option) => option.value), ['logan', 'work']);
  assert.equal(element('accountLogged').value, 'work');
  assert.equal(element('sync').disabled, false);
  assert.equal(element('autoSync').disabled, false);
});

test('disables syncing until an account is selected', () => {
  const { renderAccountOptions, element } = loadPopup();
  renderAccountOptions(['logan', 'work'], '');
  assert.equal(element('accountLogged').value, '');
  assert.equal(element('sync').disabled, true);
  assert.equal(element('autoSync').disabled, true);
});

test('account creation resolves slug variants to the existing account instead of creating a duplicate', () => {
  const { findExistingAccountName } = loadPopup();
  assert.equal(findExistingAccountName('LOGAN', ['logan', 'work']), 'logan');
  assert.equal(findExistingAccountName('work account', ['work-account']), 'work-account');
  assert.equal(findExistingAccountName('lohan', ['logan', 'work']), null);
});

test('creates and remembers a new archive account only after the explicit create action', async () => {
  const { renderAccountOptions, createArchiveAccount, element, storedSettings } = loadPopup();
  renderAccountOptions(['logan'], 'logan');
  element('newAccountName').value = 'lohan';
  const created = await createArchiveAccount();
  assert.equal(created, 'lohan');
  assert.equal(storedSettings.archive_account, 'lohan');
  assert.equal(storedSettings.archive_account_pending, true);
  assert.equal(element('accountLogged').value, 'lohan');
  assert.match(element('status').textContent, /archive folder will be created on the next sync/);
});

test('creating a slug variant selects the existing account instead of creating another one', async () => {
  const { renderAccountOptions, createArchiveAccount, element, storedSettings } = loadPopup();
  renderAccountOptions(['work-account'], 'work-account');
  element('newAccountName').value = 'work account';
  const selected = await createArchiveAccount();
  assert.equal(selected, 'work-account');
  assert.equal(storedSettings.archive_account, 'work-account');
  assert.equal(storedSettings.archive_account_pending, false);
  assert.match(element('status').textContent, /no duplicate was created/);
});

test('clears a persisted diagnostic report created by an older extension version', async () => {
  const { loadDiagnostics, getLastDiagnostics, refresh, element, storedSettings } = loadPopup();
  await refresh();
  const stale = { extension_version: '0.5.8', items: [{ outcome: 'failed' }] };
  storedSettings.last_sync_diagnostics = stale;
  await loadDiagnostics(stale);
  assert.equal('last_sync_diagnostics' in storedSettings, false,
    'the obsolete persistent record should be removed from extension storage');
  assert.equal(getLastDiagnostics(), null, 'an older report should not be offered for copying');
});

test('keeps diagnostics from the current extension version visible', async () => {
  const { loadDiagnostics, getLastDiagnostics, refresh } = loadPopup();
  await refresh();
  const current = { extension_version: '0.5.10', items: [{ outcome: 'incomplete' }] };
  await loadDiagnostics(current);
  assert.deepEqual(JSON.parse(JSON.stringify(getLastDiagnostics())), current);
});

test('does not consider a legacy diagnostic report without a version current', () => {
  const { isCurrentDiagnosticReport } = loadPopup();
  assert.equal(isCurrentDiagnosticReport({ items: [{ outcome: 'failed' }] }), false);
  assert.equal(isCurrentDiagnosticReport({ extension_version: '0.5.8', items: [{ outcome: 'failed' }] }), false);
  assert.equal(isCurrentDiagnosticReport({ extension_version: '0.5.10', items: [{ outcome: 'failed' }] }), true);
});

test('disconnect removes GitHub credentials and all persisted sync reports', async () => {
  const {
    loadDiagnostics, getLastDiagnostics, disconnectGithubSettings, refresh,
    element, storedSettings,
  } = loadPopup();

  Object.assign(storedSettings, {
    github_owner: 'owner',
    github_repo: 'archive',
    github_token: 'secret',
    archive_account: 'logan',
    archive_account_pending: false,
    auto_sync: true,
    auto_sync_configured: true,
    last_sync: { stage: 'done', at: '2026-11-02T10:00:00.000Z', message: 'old sync result', report: { failed: [{ id: 'old' }] } },
    last_sync_diagnostics: { extension_version: '0.5.10', items: [{ outcome: 'failed' }] },
  });
  // The popup calls refresh() at module load; settle that initial async read
  // before exercising the persisted diagnostics lifecycle.
  await refresh();
  await loadDiagnostics(storedSettings.last_sync_diagnostics);
  assert.ok(getLastDiagnostics(), 'fixture should first display the persisted diagnostic report');

  await disconnectGithubSettings();

  for (const key of [
    'github_owner', 'github_repo', 'github_token', 'archive_account',
    'archive_account_pending', 'auto_sync', 'auto_sync_configured',
    'last_sync', 'last_sync_diagnostics',
  ]) {
    assert.equal(key in storedSettings, false, `${key} should be removed`);
  }
  assert.equal(getLastDiagnostics(), null);
  assert.equal(element('lastSync').textContent, '');
  assert.equal(element('syncReport').children.length, 0);
  assert.match(element('status').textContent, /previous sync reports removed/);
});

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
