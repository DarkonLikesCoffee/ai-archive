// The archive verifier command (web/scripts/verify-archive.mjs), runnable in
// tests with a fake fetch and streams. Strictly read-only: it only issues GET
// requests to api.github.com and never writes, repairs or deletes anything.
import { auditArchive, formatAuditReport } from './archiveIntegrity.js';
import { planIndexRebuild, formatRebuildPlan } from './indexRebuild.js';
import {
  createGitHubReader, createProgress, mapLimit, sha256Hex,
  formatBytes, formatCount, formatDuration,
} from './verifierRuntime.js';

export const USAGE = 'Usage: GITHUB_TOKEN=<read-only token> node web/scripts/verify-archive.mjs <owner>/<repo> '
  + '[--branch main] [--markdown] [--hashes] [--rebuild-dry-run] [--history] [--concurrency 6] [--quiet] [--no-progress] [--json]';
// At most this many history lookups per audit (one GitHub request each).
export const MAX_HISTORY_LOOKUPS = 200;
const DEFAULT_CONCURRENCY = 6;
const MAX_CONCURRENCY = 32;

export function parseArgs(argv) {
  const options = { repo: null, branch: null, markdown: false, hashes: false, rebuild: false, history: false, concurrency: DEFAULT_CONCURRENCY, quiet: false, progress: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--branch') options.branch = argv[++i] ?? null;
    else if (arg === '--markdown') options.markdown = true;
    else if (arg === '--hashes') options.hashes = true;
    else if (arg === '--rebuild-dry-run') options.rebuild = true;
    else if (arg === '--history') options.history = true;
    else if (arg === '--concurrency') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) return { error: `--concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}.` };
      options.concurrency = value;
    } else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--no-progress') options.progress = false;
    else if (arg === '--json') options.json = true;
    else if (!arg.startsWith('-') && /^[^/]+\/[^/]+$/.test(arg) && !options.repo) options.repo = arg;
    else return { error: `Unknown argument: ${arg}` };
  }
  if (options.branch === '') return { error: '--branch needs a branch name.' };
  if (!options.repo) return { error: 'Name the repository as <owner>/<repo>.' };
  // A rebuild reads every conversation file.
  if (options.rebuild) options.markdown = true;
  return { options };
}

const ASSET_LINK = /\]\((assets\/[^)\s]+)\)/g;
const dirname = (path) => { const at = String(path).lastIndexOf('/'); return at < 0 ? '' : String(path).slice(0, at); };

// Returns the exit status: 0 no errors, 1 errors found, 2 could not run, 130 interrupted.
export async function runVerifier({ argv, env, fetch, stdout, stderr, stderrIsTTY = false, signal = null, now = () => Date.now(), sleep, progressIntervalMs = 5000 }) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    stderr.write(`${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  const options = parsed.options;
  const token = env.GITHUB_TOKEN;
  if (!token) {
    stderr.write(`Set GITHUB_TOKEN to a read-only token.\n${USAGE}\n`);
    return 2;
  }
  const [owner, repo] = options.repo.split('/');
  const startedAt = now();
  const showSteps = !options.quiet;
  const progress = createProgress({ stream: stderr, isTTY: stderrIsTTY, enabled: showSteps && options.progress, intervalMs: progressIntervalMs, now });
  const say = (line) => { if (showSteps) progress.log(line); };
  const stepStart = (label) => { if (showSteps) stderr.write(`${label}`); };
  const stepEnd = (text) => { if (showSteps) stderr.write(`${text}\n`); };
  const reader = createGitHubReader({
    owner, repo, token, fetch, signal, now, ...(sleep ? { sleep } : {}),
    onRetry: ({ path, reason, waitMs }) => {
      if (waitMs >= 10000 || /rate limit/.test(reason)) say(`      waiting ${formatDuration(waitMs)} before retrying ${path} (${reason})`);
    },
  });
  const counts = { markdown: { done: 0, total: 0 }, attachments: { done: 0, total: 0 } };
  const unreadable = [];
  const reportError = (path, message) => {
    unreadable.push({ path, message });
    if (!options.quiet) progress.log(`ERROR ${path}: ${message}`);
  };

  if (showSteps) stderr.write(`AI Archive Integrity Checker\nRepository: ${owner}/${repo}\n`);
  let branchName = options.branch;
  try {
    // [1/4] The branch head and its full tree.
    let ref = null;
    for (const branch of options.branch ? [options.branch] : ['main', 'master']) {
      try { ref = await reader.json(`/git/ref/heads/${encodeURIComponent(branch)}`); branchName = branch; break; } catch (error) {
        if (error?.status !== 404) throw error;
      }
    }
    if (!ref) throw new Error(options.branch ? `Branch "${options.branch}" was not found.` : 'No main or master branch found (use --branch).');
    if (showSteps) stderr.write(`Branch: ${branchName}\n\n`);
    stepStart('[1/4] Fetching repository tree... ');
    const commit = await reader.json(`/git/commits/${encodeURIComponent(ref.object.sha)}`);
    const treeResponse = await reader.json(`/git/trees/${encodeURIComponent(commit.tree.sha)}?recursive=1`);
    if (treeResponse.truncated) throw new Error('GitHub truncated the repository tree; the archive is too large to audit this way.');
    const tree = treeResponse.tree;
    const shaOf = new Map(tree.filter((item) => item.type === 'blob').map((item) => [item.path, String(item.sha).toLowerCase()]));
    stepEnd(`DONE (${formatCount(shaOf.size)} files)`);

    // [2/4] archive/index.json.
    stepStart('[2/4] Checking index... ');
    if (!shaOf.has('archive/index.json')) throw new Error('archive/index.json is not in the repository.');
    let index = null;
    try {
      index = JSON.parse(new TextDecoder().decode(await reader.blob(shaOf.get('archive/index.json'))));
      stepEnd(`DONE (${formatCount(Array.isArray(index?.conversations) ? index.conversations.length : 0)} conversations)`);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      stepEnd('FAILED');
      if (error instanceof SyntaxError) say(`archive/index.json could not be parsed: ${error.message}`);
      else throw error;
    }

    // [3/4] Conversation Markdown: every unique blob once, at most N at a time.
    let markdown = null;
    const markdownPaths = [...shaOf.keys()].filter((path) => path.startsWith('archive/conversations/') && path.endsWith('.md'));
    if (options.markdown) {
      const shas = [...new Set(markdownPaths.map((path) => shaOf.get(path)))];
      counts.markdown.total = markdownPaths.length;
      if (showSteps) stderr.write('[3/4] Checking Markdown files...\n');
      progress.start({ total: markdownPaths.length, unit: 'files' });
      const textBySha = new Map();
      const pathsBySha = new Map();
      for (const path of markdownPaths) pathsBySha.set(shaOf.get(path), [...(pathsBySha.get(shaOf.get(path)) || []), path]);
      await mapLimit(shas, options.concurrency, async (sha) => {
        const paths = pathsBySha.get(sha);
        try {
          const bytes = await reader.blob(sha);
          textBySha.set(sha, new TextDecoder().decode(bytes));
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          for (const path of paths) reportError(path, error.message);
        }
        counts.markdown.done += paths.length;
        progress.tick({ count: paths.length });
      }, { signal });
      progress.finish();
      // Tree order, not completion order, so results are deterministic.
      markdown = new Map(markdownPaths.filter((path) => textBySha.has(shaOf.get(path))).map((path) => [path, textBySha.get(shaOf.get(path))]));
    } else if (showSteps) {
      stderr.write('[3/4] Checking Markdown files... SKIPPED (use --markdown)\n');
    }

    // [4/4] Attachment bytes: every unique blob once; only its size and
    // SHA-256 are kept, never the bytes.
    let readDigest = null;
    if (options.hashes) {
      const expected = new Map();
      for (const entry of Array.isArray(index?.conversations) ? index.conversations : []) {
        for (const asset of Array.isArray(entry?.assets) ? entry.assets : []) {
          if (typeof asset?.path === 'string' && typeof asset.sha256 === 'string' && shaOf.has(asset.path)) {
            expected.set(asset.path, [...(expected.get(asset.path) || []), asset]);
          }
        }
      }
      const targets = new Set(expected.keys());
      // A rebuild hashes the files the Markdown links to as well.
      if (options.rebuild && markdown) {
        for (const [path, text] of markdown) {
          for (const match of text.matchAll(ASSET_LINK)) {
            const target = `${dirname(path)}/${match[1]}`;
            if (shaOf.has(target)) targets.add(target);
          }
        }
      }
      const targetPaths = [...shaOf.keys()].filter((path) => targets.has(path));
      const pathsBySha = new Map();
      for (const path of targetPaths) pathsBySha.set(shaOf.get(path), [...(pathsBySha.get(shaOf.get(path)) || []), path]);
      counts.attachments.total = targetPaths.length;
      if (showSteps) stderr.write('[4/4] Verifying attachments...\n');
      progress.start({ total: targetPaths.length, unit: 'files', trackBytes: true });
      const digestBySha = new Map();
      await mapLimit([...pathsBySha.keys()], options.concurrency, async (sha) => {
        const paths = pathsBySha.get(sha);
        let bytesRead = 0;
        try {
          const bytes = await reader.blob(sha);
          bytesRead = bytes.byteLength;
          const digest = { size: bytes.byteLength, sha256: await sha256Hex(bytes) };
          digestBySha.set(sha, digest);
          // Report a mismatch as soon as it is known; the final report repeats it.
          if (!options.quiet) {
            for (const path of paths) {
              for (const asset of expected.get(path) || []) {
                if (asset.sha256.toLowerCase() !== digest.sha256 || (asset.size != null && Number(asset.size) !== digest.size)) {
                  progress.log(`MISMATCH ${path}: its bytes do not match the size or SHA-256 the index records`);
                }
              }
            }
          }
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          digestBySha.set(sha, { error: error.message });
          for (const path of paths) reportError(path, error.message);
        }
        counts.attachments.done += paths.length;
        progress.tick({ count: paths.length, bytes: bytesRead });
      }, { signal });
      progress.finish();
      readDigest = (path) => (shaOf.has(path) ? digestBySha.get(shaOf.get(path)) ?? null : null);
    } else if (showSteps) {
      stderr.write('[4/4] Verifying attachments... SKIPPED (use --hashes)\n');
    }

    // The checks themselves: the same audit as before, on the data read above.
    // Code-point order: the same on every machine, whatever its locale.
    const sortedUnreadable = [...unreadable].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const result = await auditArchive({ index, tree, markdown, readDigest, unreadable: sortedUnreadable });
    const plan = options.rebuild ? await planIndexRebuild({ index, tree, markdown, readDigest }) : null;

    // Read-only history of missing link targets and unreferenced files: was a
    // missing file ever on the branch (recoverable) or never uploaded, and
    // which commit wrote an unreferenced one?
    let historyLookups = 0;
    if (options.history) {
      const targets = [];
      for (const item of result.findings) {
        if ((item.code === 'link-broken' || item.code === 'link-unresolved-quoted') && item.target) {
          targets.push({ item, path: `${dirname(item.path)}/${item.target}`, present: false });
        } else if (item.code === 'file-unreferenced') {
          targets.push({ item, path: item.path, present: true });
        }
      }
      const selected = targets.slice(0, MAX_HISTORY_LOOKUPS);
      if (showSteps) stderr.write(`[+] Looking up history for ${formatCount(selected.length)} file(s)${targets.length > selected.length ? ` (first ${MAX_HISTORY_LOOKUPS} of ${formatCount(targets.length)})` : ''}...\n`);
      if (!selected.length && showSteps) stderr.write('      nothing to look up\n');
      if (selected.length) progress.start({ total: selected.length, unit: 'lookups' });
      await mapLimit(selected, options.concurrency, async (target) => {
        try {
          const commits = await reader.json(`/commits?sha=${encodeURIComponent(branchName)}&path=${encodeURIComponent(target.path)}&per_page=1`);
          const last = Array.isArray(commits) ? commits[0] : null;
          target.item.history = last
            ? { path: target.path, last_commit: String(last.sha), date: last.commit?.author?.date || last.commit?.committer?.date || null, message: String(last.commit?.message || '').split('\n')[0].slice(0, 120) }
            : { path: target.path, last_commit: null };
          const when = last ? `${String(last.sha).slice(0, 12)}${target.item.history.date ? ` (${target.item.history.date.slice(0, 10)})` : ''} "${target.item.history.message}"` : '';
          target.item.message += !last
            ? (target.present ? ' History: no commit on this branch touched it (unexpected for a file on it).' : ' History: it was never on this branch, so it was never uploaded here.')
            : (target.present ? ` History: last written by commit ${when}.` : ` History: last changed by commit ${when}, most likely its removal; the file can be read from that commit's parent.`);
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          target.item.history = { path: target.path, error: error.message };
          target.item.message += ` History: could not be looked up (${error.message}).`;
        }
        historyLookups += 1;
        progress.tick();
      }, { signal });
      if (selected.length) progress.finish();
    }
    const stats = {
      conversations: Array.isArray(index?.conversations) ? index.conversations.length : 0,
      attachments: result.checked.assets,
      markdown_files: result.checked.markdownFiles,
      files_hashed: result.checked.hashedFiles,
      bytes_downloaded: reader.stats.bytes,
      requests: reader.stats.requests,
      history_lookups: historyLookups,
      retries: reader.stats.retries,
      failures: sortedUnreadable.length,
      elapsed_ms: now() - startedAt,
    };
    if (options.json) {
      stdout.write(`${JSON.stringify({
        repository: `${owner}/${repo}`, branch: branchName, commit: ref.object.sha, interrupted: false,
        options: { markdown: options.markdown, hashes: options.hashes, rebuild: options.rebuild, history: options.history, concurrency: options.concurrency },
        counts: result.counts, checked: result.checked, findings: result.findings,
        ...(plan ? { rebuild: plan } : {}), stats,
      }, null, 2)}\n`);
    } else {
      stdout.write(`\n${owner}/${repo} @ refs/heads/${branchName} ${ref.object.sha.slice(0, 12)}\n${formatAuditReport(result)}\n`);
      if (plan) stdout.write(`\n${formatRebuildPlan(plan)}\n`);
      stdout.write(`\n${formatStats(stats)}\n`);
    }
    return result.counts.error ? 1 : 0;
  } catch (error) {
    progress.finish();
    if (error?.name === 'AbortError') {
      const remaining = (counts.markdown.total - counts.markdown.done) + (counts.attachments.total - counts.attachments.done);
      const summary = {
        repository: `${owner}/${repo}`, branch: branchName, interrupted: true,
        checked: { markdown_files: counts.markdown.done, attachments: counts.attachments.done },
        remaining, failures: unreadable.length, elapsed_ms: now() - startedAt,
      };
      if (options.json) stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      stderr.write(`\nInterrupted after ${formatDuration(summary.elapsed_ms)}: ${formatCount(counts.markdown.done)} of ${formatCount(counts.markdown.total)} Markdown files and ${formatCount(counts.attachments.done)} of ${formatCount(counts.attachments.total)} attachments read; ${formatCount(remaining)} not checked. No findings are reported for an incomplete audit. Nothing in the archive was changed.\n`);
      return 130;
    }
    stderr.write(`\nCould not audit the archive: ${String(error?.message || error)}\n`);
    return 2;
  }
}

export function formatStats(stats) {
  return [
    `Conversations checked: ${formatCount(stats.conversations)}`,
    `Attachments checked:   ${formatCount(stats.attachments)}`,
    `Markdown files read:   ${formatCount(stats.markdown_files)}`,
    `Files hashed:          ${formatCount(stats.files_hashed)}`,
    `Downloaded:            ${formatBytes(stats.bytes_downloaded)} in ${formatCount(stats.requests)} requests`,
    `Retries:               ${formatCount(stats.retries)}`,
    `Failures:              ${formatCount(stats.failures)}`,
    `Elapsed:               ${formatDuration(stats.elapsed_ms)}`,
  ].join('\n');
}
