const $ = (id) => document.getElementById(id);
const status = $('status');
let activeSync = false;

async function settings() { return chrome.storage.local.get(['github_owner', 'github_repo', 'github_token', 'archive_account', 'auto_sync']); }

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
  $('sync').disabled = activeSync;
  if (msg.stage === 'error') status.className = 'status err';
  else if (msg.stage === 'done' || msg.stage === 'cancelled') status.className = 'status ok';
}

async function refresh() {
  const s = await settings();
  $('owner').value = s.github_owner || GITHUB_OWNER || '';
  $('repo').value = s.github_repo || GITHUB_REPO || '';
  $('accountSetup').value = s.archive_account || 'personal';
  $('accountLogged').value = s.archive_account || 'personal';
  $('autoSync').checked = s.auto_sync === true;
  if (s.github_token) {
    $('setup').classList.add('hidden'); $('logged').classList.remove('hidden');
    $('accountText').textContent = `GitHub: ${s.github_owner}/${s.github_repo} · account: ${s.archive_account || 'personal'}`;
  } else {
    $('setup').classList.remove('hidden'); $('logged').classList.add('hidden');
  }
}

async function sendToClaude(message) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url?.startsWith('https://claude.ai/')) throw Error('Open a Claude.ai tab first.');
  return new Promise((resolve, reject) => chrome.tabs.sendMessage(tab.id, message, (r) => {
    if (chrome.runtime.lastError) reject(Error('Refresh the Claude.ai tab, then try again.'));
    else resolve(r);
  }));
}

$('save').onclick = async () => {
  try {
    const owner = $('owner').value.trim(), repo = $('repo').value.trim(), token = $('token').value.trim(), account = $('accountSetup').value.trim() || 'personal';
    if (!owner || !repo || !token) throw Error('Owner, repository and token are required.');
    status.className = 'status'; status.textContent = 'Checking GitHub…';
    const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!r.ok) throw Error(`GitHub rejected the settings (${r.status}).`);
    await chrome.storage.local.set({ github_owner: owner, github_repo: repo, github_token: token, archive_account: account, auto_sync: false, auto_sync_configured: true });
    status.className = 'status ok'; status.textContent = 'GitHub settings saved. Automatic sync is OFF.'; await refresh();
  } catch (e) { status.className = 'status err'; status.textContent = e.message; }
};

$('accountLogged').onchange = async () => {
  const account = $('accountLogged').value.trim() || 'personal';
  await chrome.storage.local.set({ archive_account: account });
  $('accountText').textContent = `GitHub: ${(await settings()).github_owner}/${(await settings()).github_repo} · account: ${account}`;
};

$('autoSync').onchange = async () => {
  await chrome.storage.local.set({ auto_sync: $('autoSync').checked, auto_sync_configured: true });
  status.className = 'status ok'; status.textContent = $('autoSync').checked ? 'Automatic sync enabled.' : 'Automatic sync disabled.';
};

$('sync').onclick = async () => {
  try {
    const limit = $('syncLimit').value;
    status.className = 'status'; status.textContent = `Starting sync (${limit === 'all' ? 'all conversations' : `latest ${limit}`})…`;
    setProgress({ stage: 'fetching', current: 0, total: 0 });
    await sendToClaude({ type: 'startSync', limit });
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

$('clear').onclick = async () => { await chrome.storage.local.remove(['github_owner', 'github_repo', 'github_token', 'archive_account', 'auto_sync', 'auto_sync_configured']); status.textContent = 'GitHub settings removed from this extension.'; refresh(); };

chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'syncProgress') setProgress(msg); });
chrome.runtime.sendMessage({ type: 'getSyncState' }, (state) => { if (!chrome.runtime.lastError && state?.running) setProgress(state); });
refresh();
