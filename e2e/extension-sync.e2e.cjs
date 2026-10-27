// Real-browser end-to-end check of the extension: the unpacked extension runs
// in Chromium (popup, content script on claude.ai, service worker), with
// claude.ai and the GitHub API replaced by in-process fakes. The fake GitHub
// implements the Contents and Git Data endpoints the extension uses and keeps
// a real commit history, so the published archive can be inspected.
//
// Requires Playwright with a Chromium browser (not part of CI). Run:
//   node e2e/extension-sync.e2e.cjs
// Optionally also open the synced archive in the web viewer:
//   cd web && npm run build && npx vite preview --port 4317 --strictPort &
//   VIEWER_URL=http://localhost:4317/ node e2e/extension-sync.e2e.cjs
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const extensionDir = path.resolve(__dirname, '..', 'extension');
const OWNER = 'me';
const REPO = 'archive';
const TOKEN = 'good-token';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

// ---- Fake GitHub: blobs, flat trees, commits and one branch ref. ----
function createFakeGitHub() {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const refs = new Map();
  const requests = [];
  const failures = [];
  const sha = (value) => crypto.createHash('sha1').update(value).digest('hex');
  const putBlob = (buffer) => { const id = sha(Buffer.concat([Buffer.from('blob'), buffer])); blobs.set(id, buffer); return id; };
  const putTree = (entries) => { const id = sha(`tree${JSON.stringify([...entries].sort())}`); trees.set(id, new Map(entries)); return id; };
  const putCommit = (tree, parents, message) => { const id = sha(`commit${tree}${parents.join()}${message}${commits.size}`); commits.set(id, { sha: id, tree: { sha: tree }, parents: parents.map((p) => ({ sha: p })), message }); return id; };
  const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

  function handle(method, url, body, token) {
    requests.push(`${method} ${url.pathname}`);
    if (token !== TOKEN) return json(401, { message: 'Bad credentials' });
    const failure = failures.find((f) => f.method === method && url.pathname.endsWith(f.pathSuffix) && f.times > 0);
    if (failure) { failure.times -= 1; return json(failure.status, { message: 'Injected failure' }); }

    const prefix = `/repos/${OWNER}/${REPO}`;
    if (url.pathname === prefix) return json(200, { full_name: `${OWNER}/${REPO}`, permissions: { push: true } });
    if (!url.pathname.startsWith(prefix)) return json(404, { message: 'Not Found' });
    const p = url.pathname.slice(prefix.length);
    let m;
    if (method === 'GET' && (m = p.match(/^\/git\/ref\/heads\/(.+)$/))) {
      if (!refs.size) return json(409, { message: 'Git Repository is empty.' });
      const head = refs.get(m[1]);
      return head ? json(200, { ref: `refs/heads/${m[1]}`, object: { sha: head } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'PATCH' && (m = p.match(/^\/git\/refs\/heads\/(.+)$/))) {
      const current = refs.get(m[1]);
      if (!commits.has(body.sha)) return json(422, { message: 'Object does not exist' });
      let walk = commits.get(body.sha); let fastForward = false;
      while (walk) { if (walk.sha === current) { fastForward = true; break; } walk = walk.parents[0] && commits.get(walk.parents[0].sha); }
      if (!fastForward && !body.force) return json(422, { message: 'Update is not a fast forward' });
      refs.set(m[1], body.sha);
      return json(200, { ref: `refs/heads/${m[1]}`, object: { sha: body.sha } });
    }
    if (method === 'GET' && (m = p.match(/^\/git\/commits\/([0-9a-f]+)$/))) return commits.has(m[1]) ? json(200, commits.get(m[1])) : json(404, { message: 'Not Found' });
    if (method === 'GET' && (m = p.match(/^\/git\/trees\/([0-9a-f]+)$/))) {
      const tree = trees.get(m[1]);
      if (!tree) return json(404, { message: 'Not Found' });
      return json(200, { sha: m[1], truncated: false, tree: [...tree].map(([file, id]) => ({ path: file, mode: '100644', type: 'blob', sha: id })) });
    }
    if (method === 'GET' && (m = p.match(/^\/git\/blobs\/([0-9a-f]+)$/))) return blobs.has(m[1]) ? json(200, { sha: m[1], encoding: 'base64', content: blobs.get(m[1]).toString('base64') }) : json(404, { message: 'Not Found' });
    if (method === 'POST' && p === '/git/blobs') {
      if (!refs.size) return json(409, { message: 'Git Repository is empty.' });
      return json(201, { sha: putBlob(Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8')) });
    }
    if (method === 'POST' && p === '/git/trees') {
      const entries = new Map(body.base_tree ? trees.get(body.base_tree) : []);
      for (const entry of body.tree) {
        if (entry.sha === null) entries.delete(entry.path);
        else if (!blobs.has(entry.sha)) return json(422, { message: `Missing blob ${entry.sha}` });
        else entries.set(entry.path, entry.sha);
      }
      return json(201, { sha: putTree([...entries]) });
    }
    if (method === 'POST' && p === '/git/commits') {
      if (!trees.has(body.tree)) return json(422, { message: 'Missing tree' });
      return json(201, { sha: putCommit(body.tree, body.parents || [], body.message) });
    }
    if ((m = p.match(/^\/contents\/(.+)$/))) {
      const file = m[1].split('/').map(decodeURIComponent).join('/');
      if (method === 'PUT') {
        if (refs.size) return json(422, { message: 'Only the initial commit is supported by this fake' });
        const tree = putTree([[file, putBlob(Buffer.from(body.content, 'base64'))]]);
        refs.set('main', putCommit(tree, [], body.message));
        return json(201, { content: { path: file } });
      }
      const branch = url.searchParams.get('ref') || 'main';
      const head = refs.get(branch);
      const id = head && trees.get(commits.get(head).tree.sha).get(file);
      if (!id) return json(404, { message: 'Not Found' });
      return json(200, { type: 'file', path: file, sha: id, encoding: 'base64', content: blobs.get(id).toString('base64') });
    }
    return json(404, { message: `Fake GitHub does not implement ${method} ${p}` });
  }

  return {
    handle,
    requests,
    failures,
    head: () => refs.get('main'),
    commitCount() { let n = 0; let c = commits.get(refs.get('main')); while (c) { n++; c = c.parents[0] && commits.get(c.parents[0].sha); } return n; },
    files() {
      const head = refs.get('main');
      if (!head) return {};
      return Object.fromEntries([...trees.get(commits.get(head).tree.sha)].map(([file, id]) => [file, blobs.get(id)]));
    },
  };
}

// ---- Fake claude.ai: one organization and a mutable conversation list. ----
const ORG = 'org-1';
const BIG_FILES = [];
const ROOT = '00000000-0000-4000-8000-000000000000';
const claudeConversations = new Map();
function addConversation(id, title, updatedAt, turns, extra = {}) {
  const chat_messages = [];
  let parent = ROOT;
  turns.forEach(([sender, text, files], i) => {
    const uuid = `${id}-m${i}`;
    chat_messages.push({ uuid, parent_message_uuid: parent, sender, created_at: updatedAt, content: [{ type: 'text', text }], files: files || [], attachments: [] });
    parent = uuid;
  });
  claudeConversations.set(id, { uuid: id, name: title, created_at: '2026-10-01T00:00:00Z', updated_at: updatedAt, model: 'claude-test', current_leaf_message_uuid: parent, chat_messages, ...extra });
}
addConversation('conv-a', 'Trip planning', '2026-10-20T10:00:00Z', [
  ['human', 'Plan a weekend in Lisbon', [{ file_uuid: 'img-1', file_name: 'map.png', file_kind: 'image', preview_url: '/api/fake-assets/map.png' }]],
  ['assistant', 'Day one: Alfama and the castle.'],
]);
addConversation('conv-b', 'SQL question', '2026-10-21T10:00:00Z', [
  ['human', 'What does LEFT JOIN do?'],
  ['assistant', 'It keeps every row from the left table.'],
]);

function handleClaude(url) {
  const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.pathname === '/api/organizations') return json([{ uuid: ORG }]);
  if (url.pathname === `/api/organizations/${ORG}/chat_conversations`) {
    return json([...claudeConversations.values()]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(({ uuid, name, created_at, updated_at }) => ({ uuid, name, created_at, updated_at })));
  }
  let m = url.pathname.match(new RegExp(`^/api/organizations/${ORG}/chat_conversations/([^/]+)$`));
  if (m) return claudeConversations.has(m[1]) ? json(claudeConversations.get(m[1])) : { status: 404, body: 'not found' };
  if (/\/wiggle\/list-files$/.test(url.pathname)) return json({ files_metadata: [] });
  const big = url.pathname.match(/^\/api\/fake-assets\/big-(\d+)\.bin$/);
  if (big && BIG_FILES[Number(big[1])]) return { status: 200, contentType: 'application/octet-stream', body: BIG_FILES[Number(big[1])] };
  if (url.pathname === '/api/fake-assets/map.png') return { status: 200, contentType: 'image/png', body: PNG };
  if (url.pathname.startsWith('/api/')) return { status: 404, body: 'not found' };
  return { status: 200, contentType: 'text/html', body: '<!doctype html><title>Claude</title><p>Fake claude.ai</p>' };
}

(async () => {
  const github = createFakeGitHub();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-archive-e2e-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const errors = [];
  try {
    await context.route('https://api.github.com/**', async (route) => {
      const request = route.request();
      const token = (request.headers().authorization || '').replace(/^Bearer /, '');
      let body = null;
      try { body = request.postData() ? JSON.parse(request.postData()) : null; } catch {}
      await route.fulfill(github.handle(request.method(), new URL(request.url()), body, token));
    });
    await context.route('https://claude.ai/**', (route) => route.fulfill(handleClaude(new URL(route.request().url()))));

    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(worker.url()).host;

    const claude = await context.newPage();
    claude.on('pageerror', (e) => errors.push(`claude: ${e}`));
    await claude.goto('https://claude.ai/new');

    const popup = await context.newPage();
    popup.on('pageerror', (e) => errors.push(`popup: ${e}`));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const status = () => popup.locator('#status').textContent();

    // Setup: a rejected token is explained and nothing is saved.
    await popup.fill('#owner', OWNER);
    await popup.fill('#repo', REPO);
    await popup.fill('#token', 'wrong-token');
    await popup.click('#save');
    await popup.waitForFunction(() => /401/.test(document.querySelector('#status').textContent));
    check('popup explains a rejected token', /rejected the token \(401\)/.test(await status()), await status());
    check('a rejected token is not saved', await popup.locator('#setup').isVisible());

    await popup.fill('#token', TOKEN);
    await popup.click('#save');
    await popup.waitForFunction(() => /saved/.test(document.querySelector('#status').textContent));
    check('popup saves working GitHub settings', await popup.locator('#logged').isVisible(), await status());

    // The popup is open as a tab here, so it is the active tab; Sync finds the
    // claude.ai tab itself, exactly as when the popup is opened from another tab.
    async function syncAll(limit = 'all') {
      await popup.evaluate(() => { document.querySelector('#lastSync').textContent = ''; });
      await popup.selectOption('#syncLimit', limit);
      await popup.click('#sync');
      await popup.waitForFunction(() => /^Last sync/.test(document.querySelector('#lastSync').textContent), null, { timeout: 120000 });
      return popup.locator('#lastSync').textContent();
    }

    // First sync into an empty repository.
    let last = await syncAll();
    let files = github.files();
    const mdPaths = Object.keys(files).filter((file) => file.endsWith('.md'));
    const assetPaths = Object.keys(files).filter((file) => file.includes('/assets/'));
    check('first sync reports success in the popup', /^Last sync just now: Sync complete: 2 conversations changed in 1 GitHub commit\./.test(last), last);
    check('empty repository is initialized, then one sync commit', github.commitCount() === 2, `commits=${github.commitCount()}`);
    check('both conversations are published as Markdown', mdPaths.length === 2, mdPaths.join(', '));
    const index = JSON.parse(files['archive/index.json']);
    check('index lists both conversations', index.conversations.length === 2 && index.conversations.every((c) => c.exporter_version === 1));
    const tripPath = mdPaths.find((file) => files[file].toString().includes('Lisbon'));
    const trip = tripPath ? files[tripPath].toString() : '';
    check('Markdown keeps both turns', trip.includes('## You') && trip.includes('Day one: Alfama'));
    check('image attachment is archived byte-for-byte', assetPaths.length === 1 && files[assetPaths[0]].equals(PNG), assetPaths.join(', '));
    check('Markdown embeds the archived image', assetPaths.length === 1 && trip.includes(`](${path.posix.relative(path.posix.dirname(tripPath), assetPaths[0])}`), trip.match(/!\[[^\]]*\]\([^)]*\)/)?.[0]);

    // Nothing changed: incremental sync downloads nothing and commits nothing.
    const headAfterFirst = github.head();
    const detailRequestsBefore = github.requests.length;
    last = await syncAll();
    check('unchanged archive needs no commit', github.head() === headAfterFirst && /already up to date/i.test(last), last);
    check('unchanged sync publishes nothing to GitHub', !github.requests.slice(detailRequestsBefore).some((r) => /^(POST|PATCH|PUT) /.test(r)));

    // A conversation changes in Claude: only it is re-exported.
    addConversation('conv-b', 'SQL question', '2026-10-26T10:00:00Z', [
      ['human', 'What does LEFT JOIN do?'],
      ['assistant', 'It keeps every row from the left table.'],
      ['human', 'And RIGHT JOIN?'],
      ['assistant', 'The mirror image: every row from the right table.'],
    ]);
    last = await syncAll();
    files = github.files();
    const sql = Object.entries(files).find(([file, content]) => file.endsWith('.md') && content.toString().includes('LEFT JOIN'));
    check('changed conversation syncs in one new commit', github.commitCount() === 3 && /1 conversation changed in 1 GitHub commit/.test(last) && /1 unchanged/i.test(last), last);
    check('the new turns are in the archive', sql && sql[1].toString().includes('mirror image'));

    // GitHub keeps failing while building the tree: nothing is published,
    // and the failure is shown as the last sync.
    addConversation('conv-a', 'Trip planning', '2026-10-27T10:00:00Z', [['human', 'Plan a weekend in Porto'], ['assistant', 'Start at Ribeira.']]);
    const headBeforeFailure = github.head();
    const requestsBeforeFailure = github.requests.length;
    github.failures.push({ method: 'POST', pathSuffix: '/git/trees', status: 500, times: 3 });
    last = await syncAll();
    check('a failing GitHub sync publishes nothing', github.head() === headBeforeFailure);
    check('popup shows the failed sync', /^Last sync failed just now: GitHub 500/.test(last), last);
    const treeAttempts = github.requests.slice(requestsBeforeFailure).filter((r) => r === `POST /repos/${OWNER}/${REPO}/git/trees`).length;
    check('tree creation was retried before giving up', treeAttempts === 3, `tree POSTs=${treeAttempts}`);

    // Retrying after the outage succeeds.
    last = await syncAll();
    check('retry after the outage publishes the change', github.commitCount() === 4 && /1 conversation changed/.test(last), last);
    files = github.files();
    check('the image that left the conversation is removed', !Object.keys(files).some((file) => file.includes('/assets/')), Object.keys(files).join(', '));

    // Reopening the popup shows the stored outcome of the last sync.
    await popup.reload();
    await popup.waitForFunction(() => document.querySelector('#lastSync').textContent.length > 0);
    check('reopened popup remembers the last sync', /^Last sync just now: Sync complete/.test(await popup.locator('#lastSync').textContent()));

    // With no claude.ai tab open, Sync opens one in the background and syncs.
    await claude.close();
    addConversation('conv-c', 'New idea', '2026-10-27T11:00:00Z', [['human', 'Name a cat'], ['assistant', 'Miso.']]);
    last = await syncAll();
    const claudeTabs = context.pages().filter((p) => p.url().startsWith('https://claude.ai/'));
    check('Sync without a Claude tab opens one and syncs', claudeTabs.length === 1 && github.commitCount() === 5 && /1 conversation changed/.test(last), `tabs=${claudeTabs.length} ${last}`);

    if (process.env.VIEWER_URL) {
      const viewer = await context.newPage();
      viewer.on('pageerror', (e) => errors.push(`viewer: ${e}`));
      await viewer.addInitScript(([owner, repo, token]) => localStorage.setItem('ai_archive_github_v3', JSON.stringify({ owner, repo, token })), [OWNER, REPO, TOKEN]);
      await viewer.goto(process.env.VIEWER_URL);
      await viewer.waitForSelector('.conversation');
      check('viewer lists the synced conversations', (await viewer.locator('.conversation').count()) === 3);
      await viewer.locator('.conversation', { hasText: 'SQL question' }).click();
      await viewer.waitForSelector('.message');
      check('viewer shows the synced turns', (await viewer.locator('.message').count()) === 4);
    }

    // Chrome caps one extension message at 64 MiB; a sync carrying ~100 MB of
    // base64 attachments must still go through, byte for byte.
    for (let i = 0; i < 3; i++) {
      const bytes = crypto.randomBytes(25 * 1024 * 1024);
      BIG_FILES.push(bytes);
      addConversation(`conv-big-${i}`, `Large file ${i}`, `2026-10-27T12:0${i}:00Z`, [
        ['human', `Here is file ${i}`, [{ file_uuid: `big-${i}`, file_name: `big-${i}.bin`, preview_url: `/api/fake-assets/big-${i}.bin` }]],
        ['assistant', 'Received.'],
      ]);
    }
    const commitsBeforeBig = github.commitCount();
    last = await syncAll();
    files = github.files();
    const bigPaths = Object.keys(files).filter((file) => /big-\d\.bin$/.test(file)).sort();
    check('a sync larger than one extension message (3 × 25 MB) publishes in one commit',
      github.commitCount() === commitsBeforeBig + 1 && /3 conversations changed in 1 GitHub commit/.test(last), last);
    check('large attachments are archived byte for byte',
      bigPaths.length === 3 && bigPaths.every((file) => BIG_FILES.some((bytes) => files[file].equals(bytes))), bigPaths.join(', '));

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
