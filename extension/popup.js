const $ = (id) => document.getElementById(id);
const status = $('status');
let activeSync = false;

async function settings() { return chrome.storage.local.get(['github_owner', 'github_repo', 'github_token', 'archive_account', 'archive_account_pending', 'auto_sync', 'last_sync', 'last_sync_diagnostics']); }

let selectedArchiveAccount = '';
let knownArchiveAccounts = [];

function normalizeAccountName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function accountSlug(value) {
  return String(value || 'personal').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'personal';
}

function findExistingAccountName(value, accounts = knownArchiveAccounts) {
  const slug = accountSlug(value);
  return accounts.find((account) => accountSlug(account) === slug) || null;
}

function renderAccountOptions(accounts, selected) {
  const current = normalizeAccountName(selected);
  const names = [...new Set(
    (Array.isArray(accounts) ? accounts : []).map(normalizeAccountName).filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
  if (current && !names.includes(current)) names.push(current);
  knownArchiveAccounts = names;

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose an archive account…';
  placeholder.disabled = true;
  const options = names.map((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    return option;
  });
  $('accountLogged').replaceChildren(placeholder, ...options);
  $('accountLogged').value = current;
  selectedArchiveAccount = current;
  $('sync').disabled = !current;
  $('autoSync').disabled = !current;
  return names;
}

function updateAccountText(stored, account) {
  $('accountText').textContent = account
    ? `GitHub: ${stored.github_owner}/${stored.github_repo} · account: ${account}`
    : `GitHub: ${stored.github_owner}/${stored.github_repo} · select an archive account`;
}

async function chooseArchiveAccount(value, { pending = false } = {}) {
  const account = normalizeAccountName(value);
  if (!account || !knownArchiveAccounts.includes(account)) {
    throw new Error('Choose an account from the saved account list, or create a new one.');
  }
  await chrome.storage.local.set({ archive_account: account, archive_account_pending: pending });
  const stored = await settings();
  $('accountLogged').value = account;
  selectedArchiveAccount = account;
  $('sync').disabled = activeSync || !selectedArchiveAccount;
  $('autoSync').disabled = false;
  updateAccountText(stored, account);
  return account;
}

async function createArchiveAccount() {
  const requested = normalizeAccountName($('newAccountName').value);
  if (!requested) throw new Error('Enter a name for the new archive account.');
  if (requested.length > 80 || /[\u0000-\u001f\u007f]/.test(requested)) {
    throw new Error('Use an account name of at most 80 characters without control characters.');
  }

  const existing = findExistingAccountName(requested);
  if (existing) {
    await chooseArchiveAccount(existing);
    $('newAccountSection').classList.add('hidden');
    $('newAccountName').value = '';
    status.className = 'status ok';
    status.textContent = `"${requested}" already maps to the existing account "${existing}". That account was selected; no duplicate was created.`;
    return existing;
  }

  const accounts = [...knownArchiveAccounts, requested];
  renderAccountOptions(accounts, requested);
  await chooseArchiveAccount(requested, { pending: true });
  $('newAccountSection').classList.add('hidden');
  $('newAccountName').value = '';
  status.className = 'status ok';
  status.textContent = `New account "${requested}" selected. Its archive folder will be created on the next sync.`;
  return requested;
}

// One line about the most recent finished sync (manual or automatic), so an
// unattended automatic sync's success or failure is visible.
function describeLastSync(record, now = Date.now()) {
  const at = Date.parse(record?.at || '');
  if (!record || !Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const when = seconds < 60 ? 'just now'
    : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago`
      : seconds < 86400 ? `${Math.floor(seconds / 3600)} h ago`
        : `on ${new Date(at).toISOString().slice(0, 10)}`;
  const label = record.stage === 'error' ? 'Last sync failed'
    : record.stage === 'cancelled' ? 'Last sync cancelled'
      : record.partial ? 'Last sync finished with problems' : 'Last sync';
  const message = String(record.message || '').slice(0, 300);
  return message ? `${label} ${when}: ${message}` : `${label} ${when}.`;
}

// One line per conversation that was not archived completely, so a partial
// sync can be checked conversation by conversation (titles plus IDs).
function describeSyncReport(report) {
  if (!report || typeof report !== 'object') return [];
  const lines = [];
  const name = (item) => `${item.title || item.id} (${item.id})`;
  for (const item of Array.isArray(report.failed) ? report.failed : []) {
    lines.push(`Not exported${item.archived ? ', archived copy kept' : ', not in the archive yet'}: ${name(item)} — ${item.error || 'unknown error'}`);
  }
  for (const item of Array.isArray(report.incomplete) ? report.incomplete : []) {
    lines.push(`Archived with files missing: ${name(item)} — ${(item.missing || []).join(', ')}`);
  }
  for (const item of Array.isArray(report.keptPrevious) ? report.keptPrevious : []) {
    lines.push(`Not updated, archived copy kept (new export is missing files): ${name(item)}`);
  }
  return lines;
}

function showSyncReport(report) {
  const list = $('syncReport');
  if (!list) return;
  list.replaceChildren(...describeSyncReport(report).map((line) => {
    const item = document.createElement('li');
    item.textContent = line;
    return item;
  }));
  list.classList.toggle('hidden', !list.children.length);
}

// The sanitized diagnostics the content script stored for the last sync (see
// sanitizeShape in content.js), offered for copying when there are any.
let lastDiagnostics = null;
function showDiagnostics(diagnostics) {
  lastDiagnostics = Array.isArray(diagnostics?.items) && diagnostics.items.length ? diagnostics : null;
  $('copyDiagnostics')?.classList.toggle('hidden', !lastDiagnostics);
}

function diagnosticReportText(diagnostics, version) {
  return JSON.stringify({ report: 'AI Archive sync diagnostics', extension_version: version || null, ...diagnostics }, null, 2);
}

function setProgress(msg) {
  if (!msg || msg.stage === 'idle') return;
  const section = $('progressSection');
  section.classList.remove('hidden');
  const stageNames = {
    fetching: 'Fetching Claude conversations',
    'initializing-repo': 'Initializing GitHub repository',
    preparing: 'Preparing archive',
    checking: 'Checking for changes',
    uploading: 'Uploading changed files to GitHub',
    'creating-tree': 'Creating Git tree',
    'creating-commit': 'Creating Git commit',
    finalizing: 'Finalizing GitHub update',
    done: 'Sync complete',
    cancelled: 'Sync cancelled',
    error: 'Sync failed',
  };
  $('stage').textContent = stageNames[msg.stage] || 'Syncing';
  const total = Number(msg.total || 0), current = Number(msg.current || 0);
  const pct = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
  $('progressBar').style.width = `${pct}%`;
  let detail = '';
  if (msg.stage === 'fetching') detail = `${current}/${total} conversations fetched`;
  else if (msg.stage === 'preparing') detail = `${current}/${total} conversations prepared`;
  else if (msg.stage === 'checking') detail = `${current}/${total} checked · ${msg.changed || 0} changed`;
  else if (msg.stage === 'initializing-repo') detail = msg.message || 'Preparing the empty repository…';
  else if (msg.stage === 'uploading') detail = `${current}/${total} Git objects uploaded · ${msg.changed || 0} conversations changed`;
  else if (msg.stage === 'creating-tree') detail = 'Building the repository tree…';
  else if (msg.stage === 'creating-commit') detail = 'Creating one commit for this sync…';
  else if (msg.stage === 'finalizing') detail = 'Updating the repository branch…';
  else if (msg.stage === 'done') detail = msg.message || `${msg.changed || 0} conversations changed.`;
  else if (msg.stage === 'cancelled') detail = msg.message || 'Nothing else is being uploaded.';
  else if (msg.stage === 'error') detail = msg.error || 'Unknown error';
  $('progressText').textContent = detail;
  $('cancel').disabled = !['fetching','preparing','checking','initializing-repo','uploading','creating-tree','creating-commit','finalizing'].includes(msg.stage);
  activeSync = !$('cancel').disabled;
  $('sync').disabled = activeSync || !selectedArchiveAccount;
  if (msg.stage === 'error') status.className = 'status err';
  else if (msg.stage === 'done' || msg.stage === 'cancelled') status.className = 'status ok';
}

async function refresh() {
  const s = await settings();
  $('owner').value = s.github_owner || GITHUB_OWNER || '';
  $('repo').value = s.github_repo || GITHUB_REPO || '';
  $('autoSync').checked = s.auto_sync === true;
  $('lastSync').textContent = describeLastSync(s.last_sync);
  showSyncReport(s.last_sync?.report);
  showDiagnostics(s.last_sync_diagnostics);
  if (s.github_token) {
    $('setup').classList.add('hidden'); $('logged').classList.remove('hidden');
    const storedAccount = normalizeAccountName(s.archive_account);
    let accounts = [];
    let accountError = '';
    try {
      const response = await chrome.runtime.sendMessage({ type: 'getArchiveAccounts' });
      if (response?.ok && Array.isArray(response.accounts)) accounts = response.accounts;
      else accountError = response?.error || 'Could not load saved archive accounts.';
    } catch (error) {
      accountError = error?.message || 'Could not load saved archive accounts.';
    }

    let selected = '';
    let pendingSelection = false;
    if (accountError) {
      // Without the current GitHub account list, a saved non-pending value
      // cannot be distinguished from an old typo. Fail closed until it loads.
      selected = s.archive_account_pending === true ? storedAccount : '';
      pendingSelection = s.archive_account_pending === true;
    } else if (storedAccount) {
      const matchingExisting = accounts.find((name) => accountSlug(name) === accountSlug(storedAccount));
      if (matchingExisting) {
        selected = matchingExisting;
      } else if (s.archive_account_pending === true || accounts.length === 0) {
        selected = storedAccount;
        pendingSelection = true;
      }
      // A saved account that is absent from a non-empty archive index and was
      // not deliberately created locally may be a previous typo. Require the
      // user to pick a real account rather than silently syncing into it.
    } else if (accounts.length === 1) {
      selected = accounts[0];
    } else if (accounts.length === 0) {
      selected = 'personal';
      pendingSelection = true;
    }

    renderAccountOptions(accounts, selected);
    if (selected && (selected !== storedAccount || pendingSelection !== (s.archive_account_pending === true))) {
      await chrome.storage.local.set({ archive_account: selected, archive_account_pending: pendingSelection });
    }
    $('accountHelp').textContent = accountError
      ? `Could not refresh saved account names. Your saved selection is unchanged. ${accountError}`
      : accounts.length > 1 && !selected
        ? 'Several accounts exist, and the saved selection does not match them. Choose the correct existing account or deliberately create a new one before syncing.'
        : 'Select an existing account, or create a new one. Your selection is remembered for future syncs.';
    $('addAccount').disabled = Boolean(accountError);
    updateAccountText(s, selected);
  } else {
    $('addAccount').disabled = true;
    selectedArchiveAccount = '';
    knownArchiveAccounts = [];
    $('sync').disabled = true;
    $('autoSync').disabled = true;
    $('setup').classList.remove('hidden'); $('logged').classList.add('hidden');
  }
}

const CLAUDE_URL = 'https://claude.ai/';
const TAB_RETRY_DELAY_MS = 500;
const TAB_RETRY_ATTEMPTS = 40;
const isClaudeTab = (tab) => Boolean(tab?.id) && typeof tab.url === 'string' && tab.url.startsWith(CLAUDE_URL);

// The active tab if it is Claude, otherwise the most recently used Claude tab.
async function findClaudeTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isClaudeTab(active)) return active;
  const tabs = (await chrome.tabs.query({ url: 'https://claude.ai/*' })).filter(isClaudeTab);
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs[0] || null;
}

function messageTab(tabId, message) {
  return new Promise((resolve, reject) => chrome.tabs.sendMessage(tabId, message, (r) => {
    if (chrome.runtime.lastError) reject(Error(chrome.runtime.lastError.message || 'No response'));
    else resolve(r);
  }));
}

// Send a message to Claude's content script. With openIfMissing, a Claude tab
// is opened in the background when none exists, and the message is retried
// until the page has loaded and its content script answers.
async function sendToClaude(message, { openIfMissing = false } = {}) {
  const tab = await findClaudeTab();
  if (tab) {
    try {
      return await messageTab(tab.id, message);
    } catch {
      throw Error('Refresh the Claude.ai tab, then try again.');
    }
  }
  if (!openIfMissing) throw Error('Open a Claude.ai tab first.');
  status.className = 'status';
  status.textContent = 'Opening Claude.ai in a background tab…';
  const opened = await chrome.tabs.create({ url: CLAUDE_URL, active: false });
  for (let attempt = 1; attempt <= TAB_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await messageTab(opened.id, message);
      status.textContent = 'Claude.ai opened in a background tab.';
      return response;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, TAB_RETRY_DELAY_MS));
    }
  }
  throw Error('Claude.ai did not finish loading in the new tab. Check that you are signed in, then sync again.');
}

// Turn the repository check into an actionable message, or null when the
// token can write. `permissions` describes the token owner's access; when it
// already says "no push", the token certainly cannot publish a sync.
function describeRepoCheck(status, data, owner, repo) {
  const target = `${owner}/${repo}`;
  if (status === 401) return 'GitHub rejected the token (401). Check that it was copied completely and has not expired.';
  if (status === 404) return `Repository ${target} was not found, or the token cannot access it (404).`;
  if (status === 403) return `GitHub denied access to ${target} (403). The token needs read and write access to repository contents.`;
  if (status < 200 || status >= 300) return `GitHub could not check ${target} (${status}). Try again in a moment.`;
  if (data?.permissions && data.permissions.push === false) {
    return `The token can read ${target} but cannot write to it. Grant it write access to repository contents.`;
  }
  return null;
}

$('save').onclick = async () => {
  try {
    const owner = $('owner').value.trim(), repo = $('repo').value.trim(), token = $('token').value.trim();
    if (!owner || !repo || !token) throw Error('Owner, repository and token are required.');
    status.className = 'status'; status.textContent = 'Checking GitHub…';
    const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    let data = null;
    try { data = await r.json(); } catch {}
    const problem = describeRepoCheck(r.status, data, owner, repo);
    if (problem) throw Error(problem);
    await chrome.storage.local.remove(['archive_account', 'archive_account_pending']);
    await chrome.storage.local.set({ github_owner: owner, github_repo: repo, github_token: token, auto_sync: false, auto_sync_configured: true });
    status.className = 'status ok'; status.textContent = 'GitHub settings saved. Automatic sync is OFF.'; await refresh();
  } catch (e) { status.className = 'status err'; status.textContent = e.message; }
};

$('accountLogged').onchange = async () => {
  try {
    await chooseArchiveAccount($('accountLogged').value);
    status.className = 'status ok';
    status.textContent = 'Archive account selected.';
  } catch (error) {
    status.className = 'status err';
    status.textContent = error.message;
    await refresh();
  }
};

$('addAccount').onclick = () => {
  $('newAccountName').value = '';
  $('newAccountSection').classList.remove('hidden');
  $('newAccountName').focus();
};

$('cancelAddAccount').onclick = () => {
  $('newAccountSection').classList.add('hidden');
  $('newAccountName').value = '';
};

$('createAccount').onclick = async () => {
  try {
    await createArchiveAccount();
  } catch (error) {
    status.className = 'status err';
    status.textContent = error.message;
  }
};

$('autoSync').onchange = async () => {
  if (!selectedArchiveAccount) {
    $('autoSync').checked = false;
    status.className = 'status err';
    status.textContent = 'Select an archive account before enabling automatic sync.';
    return;
  }
  await chrome.storage.local.set({ auto_sync: $('autoSync').checked, auto_sync_configured: true });
  status.className = 'status ok';
  status.textContent = $('autoSync').checked
    ? 'Automatic sync enabled: when a Claude.ai page opens (at most once every 10 minutes), every conversation that changed since it was archived is synced. Until the archive has its first sync, only the 20 most recent are checked.'
    : 'Automatic sync disabled.';
};

$('sync').onclick = async () => {
  try {
    if (!selectedArchiveAccount) throw new Error('Select an archive account before syncing.');
    const limit = $('syncLimit').value;
    status.className = 'status'; status.textContent = `Starting sync (${limit === 'all' ? 'all conversations' : `latest ${limit}`})…`;
    setProgress({ stage: 'fetching', current: 0, total: 0 });
    await sendToClaude({ type: 'startSync', limit }, { openIfMissing: true });
  } catch (e) { status.className = 'status err'; status.textContent = e.message; }
};

$('cancel').onclick = async () => {
  if (!activeSync) return;
  $('cancel').disabled = true;
  $('progressText').textContent = 'Cancelling…';
  try {
    await sendToClaude({ type: 'cancelSync' });
  } catch {
    // If the Claude tab disappeared, also cancel any GitHub work in the service worker.
  }
  chrome.runtime.sendMessage({ type: 'cancelSync' }).catch(() => {});
};

$('clear').onclick = async () => { await chrome.storage.local.remove(['github_owner', 'github_repo', 'github_token', 'archive_account', 'archive_account_pending', 'auto_sync', 'auto_sync_configured']); status.textContent = 'GitHub settings removed from this extension.'; refresh(); };

$('copyDiagnostics').onclick = async () => {
  if (!lastDiagnostics) return;
  try {
    await navigator.clipboard.writeText(diagnosticReportText(lastDiagnostics, chrome.runtime.getManifest?.()?.version));
    status.className = 'status ok';
    status.textContent = 'Diagnostic report copied. It contains no message text, titles, file names, file contents or credentials.';
  } catch (e) {
    status.className = 'status err';
    status.textContent = `Could not copy the diagnostic report: ${e.message}`;
  }
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'syncProgress') return;
  setProgress(msg);
  if (['done', 'error', 'cancelled'].includes(msg.stage)) {
    $('lastSync').textContent = describeLastSync({ stage: msg.stage, at: new Date().toISOString(), message: msg.message || msg.error, partial: msg.partial === true });
    showSyncReport(msg.report);
    chrome.storage.local.get('last_sync_diagnostics').then((stored) => showDiagnostics(stored.last_sync_diagnostics)).catch(() => {});
  }
});
chrome.runtime.sendMessage({ type: 'getSyncState' }, (state) => { if (!chrome.runtime.lastError && state?.running) setProgress(state); });
refresh();
