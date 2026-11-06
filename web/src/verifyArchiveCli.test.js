import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runVerifier, parseArgs } from './verifyArchiveCli.js';
import { auditArchive } from './archiveIntegrity.js';

// Synthetic archive only: no real conversation text or identifiers.
const ROOT = 'archive/conversations/claude/personal';
const gitSha = (bytes) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function makeArchive({ conversations = 3, corrupt = false } = {}) {
  const files = new Map();
  const entries = [];
  const shared = Buffer.from('a logo used by every conversation');
  for (let i = 0; i < conversations; i++) {
    const own = Buffer.from(`attachment bytes of conversation ${i}`);
    const md = `${ROOT}/C${i}--conv-${i}.md`;
    files.set(md, Buffer.from(`# C${i}\n\n![logo.png](assets/conv-${i}/logo.png)\n[own.txt](assets/conv-${i}/own.txt)\n`));
    files.set(`${ROOT}/assets/conv-${i}/logo.png`, shared);
    files.set(`${ROOT}/assets/conv-${i}/own.txt`, own);
    entries.push({ id: `conv-${i}`, provider: 'claude', account: 'personal', path: md, assets: [
      { path: `${ROOT}/assets/conv-${i}/logo.png`, sha256: sha256(shared), size: shared.length, name: 'logo.png' },
      { path: `${ROOT}/assets/conv-${i}/own.txt`, sha256: sha256(own), size: own.length, name: 'own.txt' },
    ] });
  }
  if (corrupt) {
    files.set(`${ROOT}/assets/conv-1/own.txt`, Buffer.from('changed bytes of conversation 1')); // hash and size
    files.delete(`${ROOT}/assets/conv-2/own.txt`); // missing
  }
  files.set('archive/index.json', Buffer.from(JSON.stringify({ version: 2, conversations: entries })));
  return { files, index: { version: 2, conversations: entries } };
}

function fakeGitHub(files, { failures = {}, delayMs = 0, onBlob = null, history = {} } = {}) {
  const blobs = new Map([...files.values()].map((bytes) => [gitSha(bytes), bytes]));
  const tree = [...files].map(([path, bytes]) => ({ path, type: 'blob', sha: gitSha(bytes), size: bytes.length }));
  const stats = { blobRequests: new Map(), active: 0, peak: 0, methods: new Set(), urls: [] };
  const fetch = async (url, init = {}) => {
    stats.methods.add(init.method || 'GET');
    stats.urls.push(url);
    if (init.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const path = new URL(url).pathname.replace('/repos/o/r', '');
    const reply = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300, status,
      headers: { get: (name) => ({ 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json', ...headers })[name.toLowerCase()] ?? null },
      text: async () => (body instanceof Uint8Array ? new TextDecoder().decode(body) : JSON.stringify(body)),
      arrayBuffer: async () => (body instanceof Uint8Array ? body.slice().buffer : new ArrayBuffer(0)),
    });
    if (path === '/git/ref/heads/main') return reply(200, { ref: 'refs/heads/main', object: { sha: 'c'.repeat(40) } });
    if (path.startsWith('/git/ref/heads/')) return reply(404, { message: 'Not Found' });
    if (path.startsWith('/git/commits/')) return reply(200, { tree: { sha: 't'.repeat(40) } });
    if (path.startsWith('/git/trees/')) return reply(200, { truncated: false, tree });
    if (path === '/commits') {
      const filePath = new URL(url).searchParams.get('path');
      stats.historyPaths = [...(stats.historyPaths || []), filePath];
      return reply(200, history[filePath] || []);
    }
    const m = path.match(/^\/git\/blobs\/([0-9a-f]+)$/);
    if (m) {
      const sha = m[1];
      stats.blobRequests.set(sha, (stats.blobRequests.get(sha) || 0) + 1);
      stats.active += 1; stats.peak = Math.max(stats.peak, stats.active);
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        onBlob?.(sha);
        const plan = failures[sha];
        if (plan?.length) {
          const next = plan.shift();
          return reply(next.status, { message: next.message || 'Injected failure' }, next.headers || {});
        }
        return blobs.has(sha) ? reply(200, new Uint8Array(blobs.get(sha))) : reply(404, { message: 'Not Found' });
      } finally { stats.active -= 1; }
    }
    return reply(404, { message: 'Not Found' });
  };
  return { fetch, stats, tree };
}

const stream = () => { const chunks = []; return { write: (t) => { chunks.push(t); }, get text() { return chunks.join(''); } }; };
async function run(files, argv, extra = {}) {
  const gh = fakeGitHub(files, extra.github);
  const stdout = stream(); const stderr = stream();
  const status = await runVerifier({
    argv: ['o/r', ...argv], env: { GITHUB_TOKEN: 'ghp_TESTTOKENTESTTOKENTESTTOKEN' }, fetch: gh.fetch, stdout, stderr,
    sleep: async () => {}, signal: extra.signal ?? null, stderrIsTTY: false,
  });
  return { status, stdout: stdout.text, stderr: stderr.text, gh };
}

test('options: old flags keep working and new ones are validated', () => {
  assert.deepEqual(parseArgs(['o/r', '--branch', 'main', '--markdown', '--hashes']).options,
    { repo: 'o/r', branch: 'main', markdown: true, hashes: true, rebuild: false, history: false, concurrency: 6, quiet: false, progress: true, json: false });
  assert.equal(parseArgs(['o/r', '--history']).options.history, true);
  assert.equal(parseArgs(['o/r', '--rebuild-dry-run']).options.markdown, true, 'a rebuild implies --markdown');
  assert.equal(parseArgs(['o/r', '--concurrency', '12']).options.concurrency, 12);
  assert.match(parseArgs(['o/r', '--concurrency', '0']).error, /from 1 to 32/);
  assert.match(parseArgs(['o/r', '--concurrency', '500']).error, /from 1 to 32/);
  assert.match(parseArgs(['o/r', '--bogus']).error, /Unknown argument/);
});

test('a clean archive passes; every unique blob is downloaded once, at most N at a time, with GET only', async () => {
  const { files } = makeArchive({ conversations: 12 });
  const result = await run(files, ['--branch', 'main', '--markdown', '--hashes', '--concurrency', '3'], { github: { delayMs: 3 } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Archive integrity: 0 error\(s\), 0 warning\(s\); 12 conversations, 24 attachments, 12 Markdown files and 24 file hashes checked\./);
  assert.ok(result.gh.stats.peak <= 3, `peak concurrency ${result.gh.stats.peak}`);
  assert.ok(result.gh.stats.peak >= 2, 'downloads actually run in parallel');
  assert.ok([...result.gh.stats.blobRequests.values()].every((n) => n === 1), 'no blob is downloaded twice');
  const logoSha = gitSha(Buffer.from('a logo used by every conversation'));
  assert.equal(result.gh.stats.blobRequests.get(logoSha), 1, 'the logo shared by 12 paths is downloaded once');
  assert.deepEqual([...result.gh.stats.methods], ['GET'], 'strictly read-only');
  assert.match(result.stdout, /Files hashed: +24/);
  assert.match(result.stderr, /\[1\/4\] Fetching repository tree\.\.\. DONE/);
  assert.match(result.stderr, /\[3\/4\] Checking Markdown files\.\.\.\n {6}\d/);
  assert.match(result.stderr, /12 \/ 12 \(100\.0%\)/);
  assert.equal(result.stderr.includes('ghp_TESTTOKEN'), false);
  assert.equal(result.stdout.includes('ghp_TESTTOKEN'), false);
});

test('findings are exactly those of the existing audit, in a deterministic order', async () => {
  const { files, index } = makeArchive({ conversations: 4, corrupt: true });
  const tree = [...files].map(([path, bytes]) => ({ path, type: 'blob', sha: gitSha(bytes), size: bytes.length }));
  const markdown = new Map([...files].filter(([p]) => p.endsWith('.md')).map(([p, b]) => [p, b.toString('utf8')]));
  const reference = await auditArchive({ index, tree, markdown, readBytes: async (p) => new Uint8Array(files.get(p)) });
  for (const concurrency of ['1', '6']) {
    const result = await run(files, ['--markdown', '--hashes', '--json', '--concurrency', concurrency], { github: { delayMs: 1 } });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.findings, reference.findings, `concurrency ${concurrency}`);
    assert.deepEqual(report.counts, reference.counts);
  }
  const text = await run(files, ['--markdown', '--hashes']);
  assert.match(text.stderr, /MISMATCH archive\/conversations\/claude\/personal\/assets\/conv-1\/own\.txt/, 'reported as it happens');
});

test('without --hashes no attachment is downloaded; without --markdown no conversation file is', async () => {
  const { files } = makeArchive({ conversations: 3 });
  const plain = await run(files, []);
  assert.equal(plain.status, 0);
  assert.equal(plain.gh.stats.blobRequests.size, 1, 'only archive/index.json');
  assert.match(plain.stderr, /\[3\/4\] Checking Markdown files\.\.\. SKIPPED/);
  assert.match(plain.stderr, /\[4\/4\] Verifying attachments\.\.\. SKIPPED/);
  const mdOnly = await run(files, ['--markdown']);
  assert.equal(mdOnly.gh.stats.blobRequests.size, 1 + 3);
});

test('a file that fails to download is reported against that file only, and the rest is still checked', async () => {
  const { files } = makeArchive({ conversations: 3 });
  const own1 = gitSha(files.get(`${ROOT}/assets/conv-1/own.txt`));
  const md2 = gitSha(files.get(`${ROOT}/C2--conv-2.md`));
  const failures = {
    [own1]: Array.from({ length: 5 }, () => ({ status: 502, message: 'Server Error' })),
    [md2]: [{ status: 404, message: 'Not Found' }],
  };
  const result = await run(files, ['--markdown', '--hashes', '--json'], { github: { failures } });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  const unreadable = report.findings.filter((f) => f.code === 'file-unreadable').map((f) => f.path);
  assert.deepEqual(unreadable, [`${ROOT}/C2--conv-2.md`, `${ROOT}/assets/conv-1/own.txt`]);
  assert.equal(report.checked.hashedFiles, 5, 'the other five attachments were hashed');
  assert.equal(report.checked.markdownFiles, 2);
  assert.equal(report.stats.failures, 2);
  assert.equal(report.stats.retries, 4, 'a 502 is retried within its budget; a 404 is not retried');
  assert.equal(result.gh.stats.blobRequests.get(md2), 1);
  assert.match(result.stderr, /ERROR archive\/conversations\/claude\/personal\/assets\/conv-1\/own\.txt: GitHub 502 .* after 5 attempts/);
});

test('rate-limit and transient responses during the audit are waited out and the result is complete', async () => {
  const { files } = makeArchive({ conversations: 2 });
  const own0 = gitSha(files.get(`${ROOT}/assets/conv-0/own.txt`));
  const failures = { [own0]: [
    { status: 429, message: 'slow down', headers: { 'retry-after': '1' } },
    { status: 403, message: 'You have exceeded a secondary rate limit' },
    { status: 503 },
  ] };
  const result = await run(files, ['--hashes', '--json'], { github: { failures } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.stats.retries, 3);
  assert.equal(report.checked.hashedFiles, 4);
});

test('--json writes only JSON to stdout; progress stays on stderr, or nowhere with --quiet', async () => {
  const { files } = makeArchive({ conversations: 2 });
  const result = await run(files, ['--hashes', '--json']);
  const report = JSON.parse(result.stdout);
  assert.equal(report.repository, 'o/r');
  assert.equal(report.branch, 'main');
  assert.equal(report.interrupted, false);
  assert.deepEqual(Object.keys(report.stats).sort(), ['attachments', 'bytes_downloaded', 'conversations', 'elapsed_ms', 'failures', 'files_hashed', 'history_lookups', 'markdown_files', 'requests', 'retries']);
  assert.ok(report.stats.bytes_downloaded > 0);
  assert.match(result.stderr, /Verifying attachments/);
  const quiet = await run(files, ['--hashes', '--json', '--quiet']);
  assert.equal(quiet.stderr, '');
  JSON.parse(quiet.stdout);
  const noProgress = await run(files, ['--hashes', '--no-progress']);
  assert.match(noProgress.stderr, /\[4\/4\] Verifying attachments\.\.\./);
  assert.doesNotMatch(noProgress.stderr, /\(100\.0%\)/);
});

test('an interrupted audit stops scheduling, reports what was and was not checked, and exits 130 with no findings', async () => {
  const { files } = makeArchive({ conversations: 20 });
  const controller = new AbortController();
  let seen = 0;
  const result = await run(files, ['--hashes', '--json', '--concurrency', '2'], {
    signal: controller.signal,
    github: { delayMs: 2, onBlob: () => { seen += 1; if (seen === 6) controller.abort(); } },
  });
  assert.equal(result.status, 130);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.interrupted, true);
  assert.equal('findings' in summary, false, 'an incomplete audit never claims a result');
  assert.ok(summary.remaining > 0);
  assert.ok(summary.checked.attachments < 40);
  assert.ok(result.gh.stats.blobRequests.size <= 9, `no new downloads after the interrupt (${result.gh.stats.blobRequests.size})`);
  assert.match(result.stderr, /Interrupted after .* not checked\. No findings are reported for an incomplete audit\. Nothing in the archive was changed\./);
});

test('a rebuild dry run uses the downloaded data and still writes nothing', async () => {
  const { files } = makeArchive({ conversations: 2 });
  const result = await run(files, ['--rebuild-dry-run', '--hashes']);
  assert.match(result.stdout, /Index rebuild dry run \(nothing was written\)/);
  assert.deepEqual([...result.gh.stats.methods], ['GET']);
});


test('--history tells a removed file from one never uploaded, and who wrote an unreferenced file, read-only', async () => {
  const { files } = makeArchive({ conversations: 1 });
  const md = `${ROOT}/C0--conv-0.md`;
  // One link to an attachment that was removed, one to a file never uploaded.
  files.set(md, Buffer.concat([files.get(md), Buffer.from('![a](assets/conv-0/removed.png)\n![b](assets/conv-0/never.png)\n')]));
  files.set('archive/conversations/claude/aaaaaaaaaa/Test.md', Buffer.from('# test'));
  const history = {
    [`${ROOT}/assets/conv-0/removed.png`]: [{ sha: 'd'.repeat(40), commit: { message: 'Sync 2 AI conversations\n\nbody', author: { date: '2026-10-20T10:00:00Z' } } }],
    'archive/conversations/claude/aaaaaaaaaa/Test.md': [{ sha: 'e'.repeat(40), commit: { message: 'Add test conversation', author: { date: '2026-10-01T10:00:00Z' } } }],
  };
  const result = await run(files, ['--markdown', '--history', '--json'], { github: { history } });
  const report = JSON.parse(result.stdout);
  const byTarget = Object.fromEntries(report.findings.filter((f) => f.target).map((f) => [f.target, f]));
  assert.match(byTarget['assets/conv-0/removed.png'].message, /History: last changed by commit dddddddddddd \(2026-10-20\) "Sync 2 AI conversations", most likely its removal; the file can be read from that commit's parent\./);
  assert.equal(byTarget['assets/conv-0/removed.png'].history.last_commit, 'd'.repeat(40));
  assert.match(byTarget['assets/conv-0/never.png'].message, /History: it was never on this branch, so it was never uploaded here\./);
  const placeholder = report.findings.find((f) => f.path === 'archive/conversations/claude/aaaaaaaaaa/Test.md');
  assert.match(placeholder.message, /History: last written by commit eeeeeeeeeeee \(2026-10-01\) "Add test conversation"\./);
  assert.equal(report.stats.history_lookups, 3);
  assert.deepEqual([...result.gh.stats.methods], ['GET'], 'history lookups are read-only too');
  assert.ok(result.gh.stats.urls.filter((u) => u.includes('/commits?')).every((u) => /sha=main&path=/.test(u)));
});
