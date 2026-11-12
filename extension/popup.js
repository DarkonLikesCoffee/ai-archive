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
  $('githubIdentity').textContent = stored.github_owner || 'GitHub account not configured';
  $('githubRepository').textContent = stored.github_repo ? `Repository: ${stored.github_repo}` : '';
  $('accountHelp').textContent = account
    ? 'This profile keeps its conversations in a separate folder inside the repository.'
    : 'Choose an existing archive profile, or create a new one.';
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
  if ($('planSync')) $('planSync').disabled = activeSync || !selectedArchiveAccount;
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
  const hasReport = Boolean(record.report && (
    record.report.incomplete?.length || record.report.failed?.length || record.report.keptPrevious?.length
    || record.report.olderExtensionWrote === true
  ));
  const message = hasReport ? '' : String(record.message || '');
  const summary = message.length > 150 ? `${message.slice(0, 150)}…` : message;
  return summary ? `${label} ${when}: ${summary}` : `${label} ${when}.`;
}

// Categories from the background's sync report (older reports have none).
const FAILURE_LABELS = {
  'download-failed': 'Download from Claude failed',
  'validation-failed': "Claude's data failed a safety check",
  'over-limit': 'Too large for GitHub',
};
const MISSING_LABELS = {
  'unavailable-at-source': 'not available from Claude',
  'over-limit': 'over the upload limit',
  'upload-refused': 'refused by GitHub',
};
function missingCategoriesText(categories) {
  const labels = (Array.isArray(categories) ? categories : []).map((category) => MISSING_LABELS[category]).filter(Boolean);
  return labels.length ? `: ${labels.join(', ')}` : '';
}

function describeSyncReport(report) {
  if (!report || typeof report !== 'object') return [];
  const entries = [];
  // First and always shown: an older extension rewrote this archive after it
  // began recording original images (see olderExtensionWroteArchive).
  if (report.olderExtensionWrote === true) {
    const detectedAt = typeof report.downgradeWarning?.detected_at === 'string' ? report.downgradeWarning.detected_at : null;
    const unreadable = ['marker-unreadable', 'warning-unreadable'].includes(report.downgradeWarning?.reason);
    entries.push({ type: 'warning',
      title: unreadable ? "The archive's version marker could not be read" : 'An older AI Archive extension wrote to this archive',
      subtitle: 'Original images may have been replaced by previews',
      details: [
        unreadable
          ? 'archive/.ai-archive.json could not be read, so a warning that an older AI Archive extension wrote to this archive may have been lost. Check that file\'s repository history; original images may have been replaced by Claude\'s previews, and the originals remain in the history. Update every installed copy of the extension to 0.5.29 or later.'
          : 'An extension older than 0.5.29 rewrote the archive after it began recording original images. In conversations it re-exported, original images may have been replaced by Claude\'s previews; the originals remain in the repository history. Update every installed copy of the extension to 0.5.29 or later.',
        'This warning is shown after every sync until you acknowledge it.',
      ],
      ...(detectedAt ? { acknowledge: detectedAt } : {}) });
  }
  for (const item of Array.isArray(report.failed) ? report.failed : []) {
    entries.push({ type: 'failed', title: item.title || item.id, id: item.id,
      subtitle: `${FAILURE_LABELS[item.category] || 'Not exported'} · ${item.archived ? 'previous archive kept' : 'not in archive'}`,
      details: [item.error || 'Unknown error'] });
  }
  for (const item of Array.isArray(report.incomplete) ? report.incomplete : []) {
    entries.push({ type: 'incomplete', title: item.title || item.id, id: item.id,
      subtitle: `Conversation archived · attachments missing${missingCategoriesText(item.categories)}`,
      details: Array.isArray(item.missing) ? item.missing : [] });
  }
  for (const item of Array.isArray(report.keptPrevious) ? report.keptPrevious : []) {
    entries.push({ type: 'kept', title: item.title || item.id,
      subtitle: 'Previous archive kept · new export incomplete',
      details: Array.isArray(item.missing) ? item.missing : [] });
  }
  return entries;
}

function popupBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'unknown size';
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

// One line about attachments over the upload limit in the last sync: how many
// downloads were avoided and how many still happened (counts only).
function describeOversizedDownloads(stats) {
  if (!stats || !Number.isSafeInteger(stats.detected) || stats.detected <= 0) return '';
  const skipped = Number.isSafeInteger(stats.skipped) ? stats.skipped : 0;
  const downloaded = Number.isSafeInteger(stats.downloaded) ? stats.downloaded : 0;
  const parts = [`${skipped} not downloaded again${skipped ? ` (${popupBytes(stats.skipped_bytes)} saved)` : ''}`];
  parts.push(`${downloaded} downloaded in full${downloaded ? ` (${popupBytes(stats.downloaded_bytes)})` : ''}`);
  return `Attachments over the upload limit: ${stats.detected} — ${parts.join(', ')}.`;
}

function showSyncReport(report) {
  const panel = $('syncReport');
  if (!panel) return;
  const entries = describeSyncReport(report);
  if (!entries.length) {
    panel.replaceChildren();
    panel.classList.add('hidden');
    return;
  }
  const summary = document.createElement('div');
  summary.className = 'report-summary';
  const title = document.createElement('strong');
  title.textContent = `${entries.length} conversation${entries.length === 1 ? '' : 's'} need attention`;
  const note = document.createElement('span');
  note.textContent = 'Expand an item to see which attachment was skipped.';
  summary.append(title, note);
  const oversized = describeOversizedDownloads(report.oversized);
  if (oversized) {
    const line = document.createElement('span');
    line.className = 'report-oversized';
    line.textContent = oversized;
    summary.append(line);
  }
  const list = document.createElement('div');
  list.className = 'report-list';
  for (const entry of entries) {
    const details = document.createElement('details');
    details.className = `report-item ${entry.type}`;
    const heading = document.createElement('summary');
    const labels = document.createElement('span');
    labels.className = 'report-heading';
    const main = document.createElement('span');
    main.className = 'report-title';
    main.textContent = entry.title;
    const state = document.createElement('span');
    state.className = 'report-state';
    state.textContent = entry.subtitle;
    labels.append(main, state);
    heading.append(labels);
    details.append(heading);
    const body = document.createElement('div');
    body.className = 'report-details';
    for (const line of entry.details) {
      const row = document.createElement('div');
      row.className = 'report-detail-line';
      row.textContent = line;
      body.append(row);
    }
    if (entry.acknowledge) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'I understand';
      button.addEventListener('click', () => {
        button.disabled = true;
        chrome.runtime.sendMessage({ type: 'acknowledgeDowngradeWarning', detected_at: entry.acknowledge }, (response) => {
          button.textContent = response?.ok ? 'Acknowledged: the next sync clears this warning' : 'Could not save; try again';
          if (!response?.ok) button.disabled = false;
        });
      });
      body.append(button);
    }
    details.append(body);
    list.append(details);
  }
  panel.replaceChildren(summary, list);
  panel.classList.remove('hidden');
}

// The sanitized diagnostics the content script stored for the last sync (see
// sanitizeShape in content.js), offered for copying when there are any.
let lastDiagnostics = null;

function currentExtensionVersion() {
  try { return chrome.runtime?.getManifest?.()?.version || null; }
  catch { return null; }
}

function isCurrentDiagnosticReport(diagnostics) {
  const version = currentExtensionVersion();
  return Boolean(version
    && diagnostics?.extension_version === version
    && Array.isArray(diagnostics.items)
    && diagnostics.items.length);
}

function showDiagnostics(diagnostics) {
  lastDiagnostics = isCurrentDiagnosticReport(diagnostics) ? diagnostics : null;
  $('copyDiagnostics')?.classList.toggle('hidden', !lastDiagnostics);
}

// Old extension versions wrote diagnostics without a version. Clear those
// records on upgrade instead of surfacing an unrelated report indefinitely.
async function loadDiagnostics(diagnostics) {
  const version = currentExtensionVersion();
  if (diagnostics && version && diagnostics.extension_version !== version) {
    try { await chrome.storage.local.remove('last_sync_diagnostics'); } catch {}
    showDiagnostics(null);
    return;
  }
  showDiagnostics(diagnostics);
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
  if ($('planSync')) $('planSync').disabled = activeSync || !selectedArchiveAccount;
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
  await loadDiagnostics(s.last_sync_diagnostics);
  await showCopyPlan();
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

// A plan-only full sync: everything a real "All conversations" sync does,
// except that nothing is written to GitHub (see sync's planOnly).
$('planSync').onclick = async () => {
  try {
    if (!selectedArchiveAccount) throw new Error('Select an archive account before planning a sync.');
    status.className = 'status'; status.textContent = 'Planning a full sync: nothing will be written to GitHub…';
    setProgress({ stage: 'fetching', current: 0, total: 0 });
    await sendToClaude({ type: 'startSync', limit: 'all', planOnly: true }, { openIfMissing: true });
  } catch (e) { status.className = 'status err'; status.textContent = e.message; }
};

$('copyPlan').onclick = async () => {
  try {
    const { last_sync_plan: stored } = await chrome.storage.local.get('last_sync_plan');
    if (!stored?.plan) throw new Error('There is no plan report yet.');
    await navigator.clipboard.writeText(JSON.stringify(stored, null, 2));
    status.className = 'status ok';
    status.textContent = 'Plan report copied. It contains conversation titles and file paths; keep it private.';
  } catch (e) {
    status.className = 'status err';
    status.textContent = `Could not copy the plan report: ${e.message}`;
  }
};

async function showCopyPlan() {
  try {
    const { last_sync_plan: stored } = await chrome.storage.local.get('last_sync_plan');
    $('copyPlan')?.classList.toggle('hidden', !stored?.plan);
  } catch {}
}

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

async function disconnectGithubSettings() {
  await chrome.storage.local.remove([
    'github_owner', 'github_repo', 'github_token',
    'archive_account', 'archive_account_pending',
    'auto_sync', 'auto_sync_configured',
    'last_sync', 'last_sync_diagnostics',
  ]);
  selectedArchiveAccount = '';
  knownArchiveAccounts = [];
  showSyncReport(null);
  lastDiagnostics = null;
  showDiagnostics(null);
  $('lastSync').textContent = '';
  $('githubIdentity').textContent = 'Not connected';
  $('githubRepository').textContent = '';
  status.className = 'status ok';
  status.textContent = 'GitHub settings and previous sync reports removed from this extension.';
  await refresh();
}

$('clear').onclick = async () => {
  try {
    await disconnectGithubSettings();
  } catch (error) {
    status.className = 'status err';
    status.textContent = `Could not disconnect GitHub settings: ${error?.message || String(error)}`;
  }
};

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
  if (msg.stage === 'fetching' && Number(msg.current) === 0) {
    showDiagnostics(null);
  }
  if (['done', 'error', 'cancelled'].includes(msg.stage)) {
    $('lastSync').textContent = describeLastSync({ stage: msg.stage, at: new Date().toISOString(), message: msg.message || msg.error, partial: msg.partial === true, report: msg.report });
    showSyncReport(msg.report);
    chrome.storage.local.get('last_sync_diagnostics').then((stored) => loadDiagnostics(stored.last_sync_diagnostics)).catch(() => showDiagnostics(null));
    showCopyPlan();
  }
});
chrome.runtime.sendMessage({ type: 'getSyncState' }, (state) => { if (!chrome.runtime.lastError && state?.running) setProgress(state); });
refresh();
