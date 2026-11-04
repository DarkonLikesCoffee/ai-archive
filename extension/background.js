// AI Archive background service worker.
// Sync state lives here so the popup can open/close without losing progress.
const API = 'https://api.github.com';
const BLOB_UPLOAD_CONCURRENCY = 4;
const SEARCH_TEXT_ENCODING = 'gzip-base64';
// Bump whenever the exported Markdown or assets for an unchanged Claude
// conversation would differ (content.js rendering or background.js output).
// Incremental sync only skips conversations archived by the current version,
// so a bump re-exports every conversation once on its next sync.
const EXPORTER_VERSION = 1;
let activeGitHubSettings = null;
let syncAbortController = null;
let cancelRequested = false;
let syncRunning = false;
let lastSyncState = { stage: 'idle' };
// The fetching phase runs in the Claude tab's content script. Remember its
// progress so a reopened popup still shows the running sync and can cancel
// it. Content progress older than this is treated as finished (for example
// when the Claude tab was closed mid-fetch).
const CONTENT_PROGRESS_STALE_MS = 5 * 60 * 1000;
const CONTENT_ACTIVE_STAGES = ['fetching', 'preparing'];
let contentSyncState = null;
let pendingTransfer = null;

function contentSyncRunning() {
  return Boolean(contentSyncState
    && CONTENT_ACTIVE_STAGES.includes(contentSyncState.stage)
    && Date.now() - contentSyncState.at <= CONTENT_PROGRESS_STALE_MS);
}

async function settings() {
  return chrome.storage.local.get(['github_owner', 'github_repo', 'github_token', 'archive_account']);
}

// Keep the outcome of the most recent sync (manual or automatic) in storage,
// so the popup can show it after the service worker restarts or when the
// sync ran unattended.
const FINAL_SYNC_STAGES = ['done', 'error', 'cancelled'];

function rememberLastSync(payload) {
  if (!FINAL_SYNC_STAGES.includes(payload?.stage)) return;
  const record = {
    stage: payload.stage,
    at: new Date(Date.now()).toISOString(),
    message: String(payload.message || payload.error || ''),
    changed: Number.isFinite(payload.changed) ? payload.changed : null,
    commit: payload.commit || null,
    partial: payload.partial === true,
    ...(payload.report ? { report: payload.report } : {}),
  };
  try {
    chrome.storage?.local?.set?.({ last_sync: record })?.catch?.(() => {});
  } catch {
    // Storage is best effort; the live progress UI does not depend on it.
  }
}

function broadcast(payload) {
  lastSyncState = { ...payload };
  rememberLastSync(payload);
  chrome.runtime.sendMessage({ type: 'syncProgress', ...payload }).catch(() => {});
}

function assertNotCancelled() {
  if (cancelRequested) throw new Error('__SYNC_CANCELLED__');
}

// Five attempts back off for about 15 seconds in total (1 + 2 + 4 + 8 s,
// each with +/-25% jitter so parallel uploads do not retry in lockstep). A
// short GitHub incident is ridden out; a request GitHub keeps failing (for
// example one it cannot process within its own time limit) still fails, and
// is reported with the operation that failed.
const GITHUB_MAX_ATTEMPTS = 5;
const GITHUB_RETRY_BASE_DELAY_MS = 1000;
const GITHUB_MAX_RETRY_AFTER_MS = 60000;
// The new archive tree is built in chained requests of at most this many
// entries (each request starts from the tree the previous one returned), so
// a large sync never asks GitHub to build thousands of paths in one request.
// Trees are content-addressed: the result is identical to a single request,
// and a retried request cannot change it.
const TREE_BATCH_SIZE = 100;

// Only requests whose repetition cannot change the archive are retried:
// reads, and Git object creation (blobs and trees are content-addressed; a
// duplicate commit object stays unreferenced). The branch ref update and the
// empty-repository Contents PUT are never retried; the ref update has its own
// outcome verification in sync().
function isRetryableGitHubRequest(path, method) {
  if (method === 'GET') return true;
  return method === 'POST' && /^\/git\/(blobs|trees|commits)$/.test(path);
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || cancelRequested) {
      reject(new Error('__SYNC_CANCELLED__'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('__SYNC_CANCELLED__'));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

// Which GitHub operation a request belongs to, so a failure says where the
// sync stopped. Never includes paths or file names (they can carry titles).
function gitHubOperation(path, method) {
  const p = String(path || '');
  if (method === 'PATCH' && p.startsWith('/git/refs/')) return 'publishing the sync commit (branch update)';
  if (method === 'GET' && p.startsWith('/git/ref/')) return 'reading the branch head';
  if (method === 'GET' && p.startsWith('/git/commits/')) return 'reading the branch commit';
  if (method === 'GET' && p.startsWith('/git/trees/')) return 'reading the archive file list';
  if (method === 'GET' && p.startsWith('/git/blobs/')) return 'reading a file from the archive';
  if (method === 'GET' && p.startsWith('/contents/')) return 'reading the archive index';
  if (method === 'POST' && p === '/git/blobs') return 'uploading a file';
  if (method === 'POST' && p === '/git/trees') return 'building the archive tree';
  if (method === 'POST' && p === '/git/commits') return 'creating the sync commit';
  if (method === 'PUT' && p.startsWith('/contents/')) return 'initializing the repository';
  return `${method} request`;
}

function isCancellation(error) {
  return error?.name === 'AbortError' || error?.message === '__SYNC_CANCELLED__';
}

function annotateOperation(error, operation, attempts = 1) {
  if (!error || isCancellation(error) || !operation || error.operation) return error;
  try {
    error.operation = operation;
    error.attempts = attempts;
    error.message = `${String(error.message || error)} [while ${operation}${attempts > 1 ? `; failed ${attempts} attempts` : ''}]`;
  } catch {
    // A frozen error keeps its own message.
  }
  return error;
}

function backoffMs(attempt) {
  return Math.round(GITHUB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
}

function retryAfterMs(response) {
  const value = Number(response?.headers?.get?.('retry-after'));
  return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
}

// Error messages keep the "GitHub <status>:" prefix that callers match on
// (for example an expected 404 for a missing branch or file).
// Never let a credential reach an error message, the popup or storage.
function redactSecrets(text, token = '') {
  let value = String(text ?? '');
  if (token && token.length >= 8) value = value.split(token).join('<token>');
  return value
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '<token>')
    .replace(/(authorization|bearer|token)(["']?\s*[:=]\s*["']?|\s+)[A-Za-z0-9_.\-]{16,}/gi, '$1$2<token>');
}

// GitHub's own explanation from an error body, bounded and on one line.
function gitHubMessage(text, token) {
  let message = '';
  try {
    const body = JSON.parse(text);
    message = String(body?.message || '');
    const details = Array.isArray(body?.errors) ? body.errors.map((item) => (typeof item === 'string' ? item : item?.message || item?.code || '')).filter(Boolean) : [];
    if (details.length) message += ` (${details.join('; ')})`;
  } catch {
    message = String(text || '');
  }
  message = redactSecrets(message, token).replace(/\s+/g, ' ').trim();
  return message.length > 600 ? `${message.slice(0, 600)}…` : message;
}

// GitHub answers a request body it will not process with HTTP 422 "Sorry, your
// input was too large to process" (seen for a blob on a real account); a proxy
// may answer 413. Other 422 responses are validation errors and stay errors.
function isInputTooLarge(status, message) {
  return status === 413 || (status === 422 && /input was too large to process/i.test(String(message || '')));
}

function gitHubError(response, text, s) {
  const message = gitHubMessage(text, s?.github_token);
  const status = response.status;
  const tagged = (error) => Object.assign(error, { status, githubMessage: message, inputTooLarge: isInputTooLarge(status, message) });
  const remaining = response.headers?.get?.('x-ratelimit-remaining');
  const reset = Number(response.headers?.get?.('x-ratelimit-reset'));
  if (status === 401) {
    return tagged(new Error('GitHub 401: GitHub rejected the access token. Update the token in the extension popup. Nothing was published.'));
  }
  if ((status === 403 || status === 429) && remaining === '0') {
    const when = Number.isFinite(reset) && reset > 0 ? ` it resets at ${new Date(reset * 1000).toISOString()}.` : ' try again later.';
    return tagged(new Error(`GitHub ${status}: GitHub API rate limit reached;${when} Nothing was published; sync again after that.`));
  }
  if (status === 403 && !/rate limit/i.test(message)) {
    return tagged(new Error(`GitHub 403: GitHub denied access to ${s.github_owner}/${s.github_repo}. The token needs read and write access to repository contents. Nothing was published. (${message.slice(0, 200)})`));
  }
  return tagged(new Error(`GitHub ${status}: ${message || 'no error message'}`));
}

async function gh(path, opts = {}, allowAfterCancel = false) {
  if (!allowAfterCancel) assertNotCancelled();
  // `signal` lets the sync transfer cancel its own uploads; it is not a
  // fetch option of its own here.
  const { signal: requestSignal, ...fetchOptions } = opts;
  opts = fetchOptions;
  const s = activeGitHubSettings || await settings();
  if (!s.github_owner || !s.github_repo || !s.github_token) throw Error('Configure GitHub settings in the extension popup first.');
  const headers = {
    Authorization: `Bearer ${s.github_token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const controller = syncAbortController;
  const signal = allowAfterCancel ? undefined : (requestSignal || controller?.signal);
  const method = String(opts.method || 'GET').toUpperCase();
  const retryable = isRetryableGitHubRequest(path, method);
  const operation = gitHubOperation(path, method);

  for (let attempt = 1; ; attempt++) {
    let r;
    try {
      r = await fetch(`${API}/repos/${encodeURIComponent(s.github_owner)}/${encodeURIComponent(s.github_repo)}${path}`, {
        ...opts,
        headers,
        signal,
      });
    } catch (error) {
      // Network failures (not cancellation) are transient for safe requests.
      if (error?.name === 'AbortError') throw error;
      if (!retryable || attempt >= GITHUB_MAX_ATTEMPTS) throw annotateOperation(error, operation, attempt);
      await waitForRetry(backoffMs(attempt), signal);
      if (!allowAfterCancel) assertNotCancelled();
      continue;
    }
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : null;

    const error = gitHubError(r, text, s);
    const exhausted = r.headers?.get?.('x-ratelimit-remaining') === '0';
    const secondaryLimit = (r.status === 403 || r.status === 429) && !exhausted
      && (r.status === 429 || /secondary rate limit/i.test(text));
    const transient = [500, 502, 503, 504].includes(r.status) || secondaryLimit;
    const wait = retryAfterMs(r) ?? backoffMs(attempt);
    if (!retryable || !transient || attempt >= GITHUB_MAX_ATTEMPTS || wait > GITHUB_MAX_RETRY_AFTER_MS) {
      throw annotateOperation(error, operation, attempt);
    }
    await waitForRetry(wait, signal);
    if (!allowAfterCancel) assertNotCancelled();
  }
}

async function getRef() {
  for (const branch of ['main', 'master']) {
    try {
      return await gh(`/git/ref/heads/${branch}`);
    } catch (e) {
      // A repository with no initial commit can return either 404 or 409
      // ("Git Repository is empty"). Treat both as an empty/no-ref repo.
      const message = String(e?.message || '').toLowerCase();
      if (message.includes('github 404') || message.includes('github 409') || message.includes('empty')) continue;
      throw e;
    }
  }
  return null;
}

async function getFile(path, ref) {
  try {
    return await gh(`/contents/${pathEncode(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
  } catch (e) {
    if (String(e?.message || '').startsWith('GitHub 404')) return null;
    throw e;
  }
}

function base64DecodeContent(content) {
  const binary = atob(content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function pathEncode(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function slugify(value) {
  return String(value || 'personal')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'personal';
}

function filenameSlug(value) {
  const normalized = String(value || 'Untitled conversation')
    .normalize('NFKC')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 90)
    .replace(/[-.]+$/g, '');
  return normalized || 'Untitled-conversation';
}

function stableHash(value) {
  const text = String(value ?? '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function conversationPath(c, provider, accountSlug) {
  const externalId = String(c.external_id || 'unknown');
  // Titles and short ID prefixes are not unique. Include a normalized portion
  // of the full ID plus a stable hash so punctuation-normalized IDs also remain
  // distinct, while keeping the filename at a predictable length.
  const idSlug = filenameSlug(externalId).slice(0, 70);
  const idSuffix = stableHash(externalId);
  return `archive/conversations/${provider}/${accountSlug}/${filenameSlug(c.title)}--${idSlug}-${idSuffix}.md`;
}

function escapeMd(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function conversationMetadata(c, provider, account) {
  return {
    id: c.external_id,
    provider,
    account,
    title: c.title || 'Untitled conversation',
    model: c.model || null,
    created_at: c.source_created_at || null,
    updated_at: c.source_updated_at || c.source_created_at || null,
    message_count: c.message_count || c.messages.length,
  };
}

function assetPath(c, asset, provider, accountSlug, usedPaths) {
  const base = filenameSlug(asset.name || 'file');
  const hash = String(asset.sha256 || '').slice(0, 8) || 'asset';
  let name = `${hash}-${base}`;
  // Use the full, path-safe conversation ID as the directory identity.
  // An 8-character prefix can collide across conversations and let one sync
  // overwrite or delete an asset still referenced by another conversation.
  // Asset directories need the same collision resistance as Markdown paths.
  // Slug-only IDs such as "conversation/a" and "conversation:a" normalize to
  // the same directory and could otherwise overwrite or delete each other's files.
  const externalId = String(c.external_id || 'unknown');
  const conversationAssetId = `${filenameSlug(externalId).slice(0, 70)}-${stableHash(externalId)}`;
  let path = `archive/conversations/${provider}/${accountSlug}/assets/${conversationAssetId}/${name}`;
  let n = 2;
  while (usedPaths.has(path)) {
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    name = `${hash}-${stem}-${n}${ext}`;
    path = `archive/conversations/${provider}/${accountSlug}/assets/${conversationAssetId}/${name}`;
    n += 1;
  }
  usedPaths.add(path);
  return path;
}

function isImageAsset(asset) {
  const mime = String(asset?.mime || '').toLowerCase().split(';')[0].trim();
  if (mime.startsWith('image/')) return true;
  const name = String(asset?.name || '').toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(name);
}

function escapeMarkdownLabel(value) {
  return String(value || 'file')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, ' ')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/([*_\x60!])/g, '\\$1');
}

// Files reach GitHub through the Git blob REST endpoint as base64 inside a
// JSON body: {"content":"<base64>","encoding":"base64"}. The documented blob
// ceiling is 100 MB, but GitHub rejects request bodies well below that with
// HTTP 422 "Sorry, your input was too large to process", and documents no
// exact request limit. So the limit is set on the request, conservatively:
// 40 MiB of JSON, which holds a file of up to 30 MiB (base64 adds a third).
// Claude itself accepts uploads up to 30 MB, so ordinary attachments fit.
// A larger file is left out with a visible note and the conversation is
// marked incomplete; it is never uploaded only to be rejected.
const MAX_BLOB_REQUEST_BYTES = 40 * 1024 * 1024;
const BLOB_REQUEST_OVERHEAD_BYTES = 64;
const MAX_ARCHIVED_FILE_BYTES = Math.floor((MAX_BLOB_REQUEST_BYTES - BLOB_REQUEST_OVERHEAD_BYTES) / 4) * 3;

// archive/index.json is uploaded as one blob, so it shares the request limit.
// Warn well before it is reached (see docs/TECHNICAL_AUDIT.md, finding 1).
const INDEX_WARN_BYTES = 20 * 1024 * 1024;

const base64RequestBytes = (size) => 4 * Math.ceil(Number(size) / 3) + BLOB_REQUEST_OVERHEAD_BYTES;

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'unknown size';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

// An attachment GitHub's API cannot take: why, in words for the archive and
// the popup. `remote` is GitHub's own refusal (HTTP 422/413); otherwise the
// size check refused it before any request was made.
function tooLargeReason(size, { remote = null } = {}) {
  if (remote) {
    return `GitHub rejected the upload as too large to process (HTTP ${remote.status}: "${String(remote.message || '').slice(0, 160)}")`;
  }
  return `larger than the ${formatBytes(MAX_ARCHIVED_FILE_BYTES)} AI Archive can upload through GitHub's API`;
}

class BlobTooLargeError extends Error {
  constructor(message, { remote = null } = {}) {
    super(message);
    this.name = 'BlobTooLargeError';
    this.remote = remote;
  }
}

// UTF-8 size of a string, stopping as soon as it passes `limit`.
// The commit message counts conversations whose archived copy changed, not
// files: one conversation can add, update or delete many attachments.
function syncCommitMessage(conversationCount, assetCount) {
  if (!conversationCount) return 'Update AI Archive index';
  const conversations = `Sync ${conversationCount} AI conversation${conversationCount === 1 ? '' : 's'}`;
  return assetCount ? `${conversations} (${assetCount} asset${assetCount === 1 ? '' : 's'})` : conversations;
}

// Whether a Markdown file's blob request ({"content": "...", "encoding":
// "utf-8"}, with JSON escapes) would be over the upload limit.
function markdownTooLargeForUpload(markdown) {
  const text = String(markdown ?? '');
  // An escape is at most six bytes per character.
  if (text.length * 6 + BLOB_REQUEST_OVERHEAD_BYTES <= MAX_BLOB_REQUEST_BYTES) return false;
  return utf8LengthExceeds(JSON.stringify(text), MAX_BLOB_REQUEST_BYTES - BLOB_REQUEST_OVERHEAD_BYTES);
}

function utf8LengthExceeds(text, limit) {
  const value = String(text ?? '');
  if (value.length * 3 <= limit) return false;
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) { bytes += 4; i++; }
    else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}

function assetByteSize(raw) {
  const size = Number(raw?.size);
  return Number.isFinite(size) && size > 0 ? size : Math.floor(String(raw?.base64 || '').length * 3 / 4);
}

function assetMarkdown(asset, path) {
  const label = escapeMarkdownLabel(asset.name || 'file');
  if (asset.omitted) {
    return `**Not archived: ${label}** (${formatBytes(assetByteSize(asset))}; ${escapeMd(asset.omit_reason || tooLargeReason(assetByteSize(asset)))})`;
  }
  const rel = `assets/${String(path).split('/assets/').pop()}`;
  if (isImageAsset(asset)) return `![${label}](${rel})`;
  return `[${label}](${rel})`;
}

function isReplyExcerptAttachment(file) {
  const name = String(file?.file_name || file?.name || '').trim().toLowerCase();
  return name === 'excerpt_from_previous_claude_message.txt' || name.startsWith('excerpt_from_previous_claude_message.');
}

// Matching runs for every asset/message pair (and every inline marker), so
// serialize each message's metadata once instead of once per comparison.
const messageHaystacks = new WeakMap();
function messageHaystack(message) {
  let haystack = messageHaystacks.get(message);
  if (haystack === undefined) {
    haystack = JSON.stringify(message.metadata || message).toLowerCase();
    messageHaystacks.set(message, haystack);
  }
  return haystack;
}

function assetMatchesMessage(asset, message, allAssets = []) {
  if (!asset || !message) return false;
  const messageId = message.external_id || message.uuid || message.id || null;

  // Message IDs on a directly collected asset are authoritative. One file can
  // be referenced from multiple messages; retain all of those associations
  // without letting a matching basename attach it to unrelated messages.
  const scopedMessageIds = Array.isArray(asset.message_external_ids) && asset.message_external_ids.length
    ? asset.message_external_ids
    : (asset.message_external_id ? [asset.message_external_id] : []);
  if (scopedMessageIds.length && messageId) {
    return scopedMessageIds.includes(messageId);
  }

  const fileIds = new Set();
  const names = new Set();
  for (const file of (message.files || [])) {
    if (file?.file_uuid) fileIds.add(String(file.file_uuid));
    if (file?.uuid) fileIds.add(String(file.uuid));
    if (file?.file_name) names.add(String(file.file_name).toLowerCase());
    if (file?.name) names.add(String(file.name).toLowerCase());
  }
  for (const attachment of (message.attachments || [])) {
    if (attachment?.file_uuid) fileIds.add(String(attachment.file_uuid));
    if (attachment?.uuid) fileIds.add(String(attachment.uuid));
    if (attachment?.file_name) names.add(String(attachment.file_name).toLowerCase());
    if (attachment?.name) names.add(String(attachment.name).toLowerCase());
  }

  // When Claude provides IDs, a different ID is a mismatch even if filenames
  // happen to be the same. Only use filename fallback when the message has no IDs.
  if (asset.file_uuid && fileIds.size) {
    return fileIds.has(String(asset.file_uuid));
  }

  // A full sandbox path is the strongest available association for generated files.
  const haystack = messageHaystack(message);
  const sourcePath = String(asset.source_path || '').replace(/\\/g, '/').toLowerCase();
  const baseName = String(asset.name || '').toLowerCase();
  if (sourcePath && haystack.includes(sourcePath)) return true;

  // If multiple sandbox files share a basename, matching the basename alone is
  // ambiguous. Require an explicit path reference rather than attaching each
  // same-named file to every message that mentions the filename.
  const sourceBaseName = sourcePath.split('/').pop() || baseName;
  const ambiguousSandboxName = Boolean(asset.source_path) && allAssets.some((other) =>
    other !== asset &&
    other.source_path &&
    (String(other.source_path).replace(/\\/g, '/').split('/').pop() || String(other.name || '')).toLowerCase() === sourceBaseName
  );
  if (ambiguousSandboxName) return false;

  if (baseName && names.has(baseName)) return true;
  if (baseName.length > 1 && haystack.includes(baseName)) return true;
  return false;
}

function findMessageAssets(message, allAssets) {
  return allAssets.filter((asset) => assetMatchesMessage(asset, message, allAssets));
}

function attachmentAssetForMessage(message, descriptor, name, assetMap, matchedAssets, allAssets) {
  const id = descriptor?.file_uuid || descriptor?.uuid || null;
  if (id) {
    const byId = assetMap.get(`id:${id}`);
    if (byId && assetMatchesMessage(byId, message, allAssets)) return byId;
    return matchedAssets.find((asset) => String(asset.file_uuid || '') === String(id)) || null;
  }

  const nameKey = String(name || '').toLowerCase();
  const namedMatches = matchedAssets.filter((asset) => String(asset.name || '').toLowerCase() === nameKey);
  if (namedMatches.length === 1) return namedMatches[0];

  // A global filename lookup is only safe for legacy/unscoped assets. For
  // message-scoped assets it can attach the first same-named file to later
  // messages, even though findMessageAssets correctly identified another file.
  const fallback = name ? assetMap.get(`name:${name}`) : null;
  if (fallback && !fallback.message_external_id && !fallback.file_uuid && namedMatches.length === 0) {
    return fallback;
  }
  return null;
}

// Inline image marker indices restart in every message, and one asset can be
// shared by several messages, so positions are only meaningful together with
// the message they were recorded for.
function inlineIndicesForMessage(asset, message) {
  const messageId = message?.external_id || message?.uuid || message?.id || null;
  if (!messageId || !Array.isArray(asset?.inline_positions)) return [];
  return asset.inline_positions
    .filter((position) => position?.message_external_id === messageId)
    .map((position) => position.index);
}

// Inline image markers carry the conversation's random nonce (see
// content.js), so text that merely looks like a marker is never replaced.
const INLINE_ASSET_MARKER = /\[\[AI_ARCHIVE_INLINE_ASSET:([0-9a-f]{32}):(\d+)\]\]/g;

function isOwnInlineMarker(c, nonce) {
  return typeof c?.inline_marker_nonce === 'string' && nonce === c.inline_marker_nonce;
}

// Search text and previews are stored in index.json; keep this sync's
// internal markers out of them.
function contentWithoutInlineMarkers(c, content) {
  return String(content || '').replace(INLINE_ASSET_MARKER, (marker, nonce) => (isOwnInlineMarker(c, nonce) ? '' : marker));
}

// What the content script could not archive for a conversation (see
// collectMessageAssets in content.js), reduced to plain fields.
function incompleteItems(c) {
  return (Array.isArray(c?.incomplete) ? c.incomplete : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      kind: String(item.kind || 'attachment'),
      ...(item.name ? { name: String(item.name) } : {}),
      ...(item.message_external_id ? { message_external_id: String(item.message_external_id) } : {}),
      ...(item.file_uuid ? { file_uuid: String(item.file_uuid) } : {}),
      reason: String(item.reason || 'not archived').replace(/\s+/g, ' ').slice(0, 300),
      // Files too large for GitHub's API: their identity, so the next sync
      // knows the same bytes without uploading them again.
      ...(item.too_large === true ? { too_large: true } : {}),
      ...(item.too_large === true && /^[0-9a-f]{64}$/i.test(String(item.sha256 || '')) ? { sha256: String(item.sha256).toLowerCase() } : {}),
      ...(item.too_large === true && Number.isSafeInteger(item.size) ? { size: item.size } : {}),
      ...(item.too_large === true && item.github_rejected === true ? { github_rejected: true } : {}),
    }));
}

// The popup's short description of one missing file.
// Sync-report wording only; the Markdown note and the index keep their text.
// An oversized file was never sent: it is over AI Archive's own request-based
// limit, not refused by GitHub. Near the limit both round to "30.0 MiB", so
// exact byte counts are shown instead.
function missingLabel(item) {
  const name = item.name || 'files created by tools';
  if (!item.too_large) return name;
  if (item.github_rejected) return `${name} (${formatBytes(item.size)}, refused by GitHub as too large to process)`;
  const size = formatBytes(item.size);
  const limit = formatBytes(MAX_ARCHIVED_FILE_BYTES);
  return size === limit
    ? `${name} (${Number(item.size).toLocaleString('en-US')} bytes, over AI Archive's ${MAX_ARCHIVED_FILE_BYTES.toLocaleString('en-US')}-byte upload limit)`
    : `${name} (${size}, over AI Archive's ${limit} upload limit)`;
}

function notArchivedMarkdown(item) {
  return `**Attachment not archived: ${escapeMarkdownLabel(item.name || 'file')}** (${escapeMd(item.reason)})`;
}

function attachmentMarkdown(message, assetMap, allAssets, missing = []) {
  const parts = [];
  const assets = findMessageAssets(message, allAssets);
  const used = new Set();

  const addAsset = (asset) => {
    // Inline content-block images are rendered at their original position in
    // this message body, so do not repeat them in its trailing attachment list.
    // Other messages sharing the asset still list it as a normal attachment.
    if (!asset || used.has(asset.path) || inlineIndicesForMessage(asset, message).length) return;
    used.add(asset.path);
    parts.push(assetMarkdown(asset, asset.path));
  };

  for (const file of (message.files || [])) {
    const name = file?.file_name || file?.name || null;
    const asset = attachmentAssetForMessage(message, file, name, assetMap, assets, allAssets);
    if (asset) {
      addAsset(asset);
      continue;
    }
    // A file Claude listed but the exporter could not archive stays visible
    // where it was attached, instead of disappearing from the conversation.
    const messageId = String(message.external_id || message.uuid || message.id || '');
    const fileId = String(file?.file_uuid || file?.uuid || '');
    const gone = missing.find((item) => item.kind === 'attachment' && item.message_external_id === messageId
      && (item.file_uuid ? item.file_uuid === fileId : item.name === name));
    if (gone) parts.push(notArchivedMarkdown(gone));
  }

  for (const attachment of (message.attachments || [])) {
    const name = attachment?.file_name || attachment?.name || 'attachment';
    const nameKey = String(name).toLowerCase();

    // Claude uses this synthetic attachment when the user replies to selected text
    // from an earlier Claude message. Keep the excerpt inline, before the user's
    // actual reply, instead of treating it as a downloadable file.
    if (isReplyExcerptAttachment(attachment)) {
      const excerpt = String(attachment.extracted_content || '').trim();
      if (excerpt) {
        parts.push(`**Attachment: ${name}**\n\n${fenceMarkdown(excerpt)}`);
      } else {
        parts.push(`**Attachment: ${name}**`);
      }
      continue;
    }

    const asset = attachmentAssetForMessage(message, attachment, name, assetMap, assets, allAssets);
    if (asset) {
      addAsset(asset);
    } else if (!assets.some((candidate) => String(candidate.name || '').toLowerCase() === nameKey)) {
      // Do not inline extracted file contents. If Claude exposes only an extraction,
      // the content-side collector materializes it as a text asset before rendering.
      // If multiple same-named assets are legitimately associated with this message,
      // let the loop below render each one rather than showing a misleading placeholder.
      parts.push(`**Attachment: ${escapeMarkdownLabel(name)}**`);
    }
  }

  // Include generated sandbox files associated with this message even when Claude
  // did not expose a corresponding message.files/attachments entry.
  for (const asset of assets) addAsset(asset);
  return parts.join('\n\n');
}

function fenceMarkdown(text, language = '') {
  const value = String(text ?? '');
  const longest = Math.max(2, ...value.match(/`+/g)?.map((x) => x.length) || [2]);
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${language}\n${value}\n${ticks}`;
}

function conversationMarkdown(c, provider, account, assetMap, allAssets) {
  const metadata = conversationMetadata(c, provider, account);
  const missing = incompleteItems(c);
  // Files that belong to the conversation rather than to one message.
  const notices = missing.filter((item) => item.kind !== 'attachment')
    .map((item) => `> **Incomplete archive:** ${item.kind === 'sandbox-file' ? `${escapeMarkdownLabel(item.name || 'a file')} was not archived (${escapeMd(item.reason)})` : escapeMd(item.reason)}.`);
  const sections = c.messages.map((m) => {
    const role = m.role === 'user'
      ? 'You'
      : m.role === 'assistant'
        ? provider[0].toUpperCase() + provider.slice(1)
        : m.role;
    const attachments = attachmentMarkdown(m, assetMap, allAssets, missing);
    const content = String(m.content || '').replace(INLINE_ASSET_MARKER, (marker, nonce, rawIndex) => {
      // Marker-shaped text from the conversation itself stays verbatim.
      if (!isOwnInlineMarker(c, nonce)) return marker;
      const imageIndex = Number(rawIndex);
      const image = allAssets.find((asset) =>
        inlineIndicesForMessage(asset, m).includes(imageIndex)
        && assetMatchesMessage(asset, m, allAssets)
      );
      // Never publish an internal marker or guess another file for it.
      if (!image) {
        throw new Error(`Cannot safely export "${c.title || c.external_id}": inline image ${imageIndex} in message "${m.external_id}" has no archived asset. No archive changes were published.`);
      }
      return assetMarkdown(image, image.path);
    });

    // User attachments/reply excerpts are shown before the user's message, matching
    // Claude's UI. Claude-generated files stay with the Claude response that produced
    // or referenced them, rather than being dumped into a trailing Files section.
    const body = role === 'You'
      ? [attachments, content].filter(Boolean).join('\n\n')
      : [content, attachments].filter(Boolean).join('\n\n');
    return `## ${role}\n\n${body}\n`;
  });

  const metadataJson = JSON.stringify(metadata, null, 2).replace(/--/g, '-\\u002d');
  const hiddenMetadata = `<!-- AI_ARCHIVE_METADATA\n${metadataJson}\n-->`;
  const noticeBlock = notices.length ? `${notices.join('\n>\n')}\n\n` : '';
  return `${hiddenMetadata}\n\n# ${escapeMd(c.title || 'Untitled conversation')}\n\n${noticeBlock}${sections.join('\n---\n\n')}`;
}

function normalizeAssetList(c, provider, accountSlug) {
  const usedPaths = new Set();
  const byKey = new Map();
  const assets = [];
  const omissions = [];
  for (const raw of (c.assets || [])) {
    if (!raw?.sha256) continue;
    const size = assetByteSize(raw);
    const omitted = size > MAX_ARCHIVED_FILE_BYTES;
    // The content script intentionally leaves base64 empty for files over
    // GitHub's limit. Their size/hash metadata is enough to render the note.
    // An asset staged during the transfer carries the SHA of the Git blob that
    // already holds its bytes instead of the bytes themselves.
    // An asset GitHub refused keeps no bytes either; it must still be listed,
    // noted and reported, never dropped silently.
    if (!raw.base64 && !raw.blob_sha && !raw.upload_error && !omitted) continue;
    const path = assetPath(c, raw, provider, accountSlug, usedPaths);
    const asset = {
      ...raw,
      path,
      encoding: 'base64',
      base64: omitted ? '' : (raw.base64 || ''),
      ...(omitted ? { omitted: true, size } : {}),
    };
    if (omitted) delete asset.blob_sha;
    // Within the size limit, but GitHub refused it (or refused these exact
    // bytes in an earlier sync): left out with GitHub's reason.
    if (!omitted && raw.upload_error) {
      asset.omitted = true;
      asset.size = size;
      asset.base64 = '';
      asset.omit_reason = String(raw.upload_error.reason || tooLargeReason(size));
      delete asset.blob_sha;
    }
    if (asset.omitted) {
      asset.omit_reason ??= tooLargeReason(size);
      omissions.push({
        kind: 'attachment',
        name: String(raw.name || 'file'),
        ...(raw.message_external_id || raw.message_external_ids?.[0] ? { message_external_id: String(raw.message_external_id || raw.message_external_ids[0]) } : {}),
        ...(raw.file_uuid ? { file_uuid: String(raw.file_uuid) } : {}),
        reason: `${formatBytes(size)}; ${asset.omit_reason}`,
        too_large: true,
        sha256: String(raw.sha256),
        size,
        ...(raw.upload_error?.github_rejected ? { github_rejected: true } : {}),
      });
    }
    assets.push(asset);
    if (raw.file_uuid) byKey.set(`id:${raw.file_uuid}`, asset);
    if (raw.name && !byKey.has(`name:${raw.name}`)) byKey.set(`name:${raw.name}`, asset);
    if (raw.source_path) byKey.set(`source:${raw.source_path}`, asset);
  }
  return { assets, byKey, omissions };
}

function indexEntry(c, path, provider, account, assets) {
  const contents = c.messages.map((m) => contentWithoutInlineMarkers(c, m.content));
  return {
    id: c.external_id,
    provider,
    account,
    path,
    title: c.title || 'Untitled conversation',
    model: c.model || null,
    created_at: c.source_created_at || null,
    updated_at: c.source_updated_at || c.source_created_at || null,
    message_count: c.message_count || c.messages.length,
    assets: assets.filter((a) => !a.omitted).map((a) => ({ path: a.path, sha256: a.sha256, size: a.size, mime: a.mime, name: a.name })),
    format_version: 4,
    exporter_version: EXPORTER_VERSION,
    // Present only when files could not be archived; such a conversation is
    // never treated as unchanged, so every sync retries it.
    ...(incompleteItems(c).length ? { incomplete: incompleteItems(c) } : {}),
    preview: String(contents.find(Boolean) || '').slice(0, 300),
    search_text: [c.title, ...contents].join('\n').slice(0, 250000),
  };
}

async function compressSearchText(text) {
  if (typeof CompressionStream !== 'function' || typeof Blob !== 'function' || typeof Response !== 'function') {
    return null;
  }
  const stream = new Blob([String(text ?? '')]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Throws BlobTooLargeError, without sending anything, for a body over the
// request limit, and when GitHub refuses the body as too large. Any other
// failure (including other 422 validation errors) is thrown unchanged.
async function createBlob(content, encoding = 'utf-8', signal = undefined) {
  const body = JSON.stringify({ content, encoding });
  if (utf8LengthExceeds(body, MAX_BLOB_REQUEST_BYTES)) {
    throw new BlobTooLargeError(`the upload request would be over ${formatBytes(MAX_BLOB_REQUEST_BYTES)}`);
  }
  try {
    return await gh('/git/blobs', { method: 'POST', body, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (error?.inputTooLarge) {
      throw new BlobTooLargeError(error.message, { remote: { status: error.status, message: error.githubMessage } });
    }
    throw error;
  }
}

// GitHub's low-level Git Database endpoints (blobs/trees/commits) reject
// completely empty repositories with 409 "Git Repository is empty".
// Seed the repository with a harmless file first so the normal Git Database
// workflow can be used for the actual sync. This is only needed once.
async function initializeEmptyRepository() {
  onProgressSafe({ stage: 'initializing-repo', current: 0, total: 1, message: 'Initializing the empty GitHub repository…' });
  const seed = btoa('This file is created automatically by AI Archive.\n');
  await gh('/contents/.ai-archive-init', {
    method: 'PUT',
    body: JSON.stringify({
      message: 'Initialize AI Archive repository',
      content: seed,
    }),
  });
  onProgressSafe({ stage: 'initializing-repo', current: 1, total: 1, message: 'GitHub repository initialized.' });
}

let activeProgressCallback = null;
function onProgressSafe(payload) {
  activeProgressCallback?.(payload);
}

const listTitles = (items, describe, limit = 5) => {
  const shown = items.slice(0, limit).map(describe).join('; ');
  return items.length > limit ? `${shown}; and ${items.length - limit} more` : shown;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// One sentence per outcome other than "written", so a partial sync is never
// mistaken for a complete one. `report` lists every conversation by ID.
function syncReportSummary(report) {
  let text = '';
  if (report.listed != null) text += ` Claude listed ${plural(report.listed, 'conversation', 'conversations')}.`;
  if (report.unchanged) text += ` ${plural(report.unchanged, 'unchanged conversation was', 'unchanged conversations were')} not downloaded again.`;
  if (report.oversizedDownloadsSkipped) {
    text += ` ${plural(report.oversizedDownloadsSkipped, 'attachment over the upload limit was', 'attachments over the upload limit were')} not downloaded again: Claude reported the exact size already recorded in the archive.`;
  }
  if (report.archiveStateError) {
    text += report.fullList
      ? ` The archive state could not be read (${report.archiveStateError}), so every conversation was downloaded again instead of skipping unchanged ones.`
      : ` The archive state could not be read (${report.archiveStateError}), so this automatic sync checked only the latest conversations.`;
  }
  const describeFailure = (item) => `"${item.title || item.id}" (${String(item.error || 'unknown error').slice(0, 160)})`;
  const failedNew = report.failed.filter((item) => !item.archived);
  const failedKept = report.failed.filter((item) => item.archived);
  if (failedNew.length) text += ` ${plural(failedNew.length, 'conversation', 'conversations')} could not be exported and ${failedNew.length === 1 ? 'is' : 'are'} not in the archive yet: ${listTitles(failedNew, describeFailure)}.`;
  if (failedKept.length) text += ` ${plural(failedKept.length, 'conversation', 'conversations')} could not be exported; ${failedKept.length === 1 ? 'its' : 'their'} previously archived ${failedKept.length === 1 ? 'copy was' : 'copies were'} kept: ${listTitles(failedKept, describeFailure)}.`;
  if (report.failed.length) text += ` The next sync retries ${report.failed.length === 1 ? 'it' : 'them'}.`;
  if (report.incomplete.length) {
    text += ` ${plural(report.incomplete.length, 'conversation was', 'conversations were')} archived with files missing (marked "not archived" in the conversation and retried by every sync): ${listTitles(report.incomplete, (item) => `"${item.title || item.id}" (${item.missing.join(', ')})`)}.`;
  }
  if (report.keptPrevious.length) {
    text += ` ${plural(report.keptPrevious.length, 'conversation was', 'conversations were')} not updated because the new export is missing files that are already archived; the archived ${report.keptPrevious.length === 1 ? 'copy was' : 'copies were'} kept: ${listTitles(report.keptPrevious, (item) => `"${item.title || item.id}"`)}.`;
  }
  return text;
}

// Read the branch head, its full tree, and archive/index.json exactly as a
// sync sees them. Shared by sync() and the incremental-sync archive state.
async function loadArchiveIndex(ref) {
  const branch = ref ? ref.ref.split('/').pop() : 'main';
  let index = { version: 2, updated_at: new Date().toISOString(), conversations: [] };
  const indexFile = ref ? await getFile('archive/index.json', branch) : null;
  if (indexFile) {
    let indexContent = indexFile.content;
    // The GitHub Contents API omits file content for larger files and reports
    // encoding "none". Never interpret that response as a missing index: a
    // limited sync would then publish an index containing only selected chats.
    if (typeof indexContent !== 'string' || (!indexContent && indexFile.sha)) {
      if (!indexFile.sha) {
        throw new Error('GitHub returned no readable content or blob SHA for archive/index.json. No archive changes were published.');
      }
      const blob = await gh(`/git/blobs/${encodeURIComponent(indexFile.sha)}`);
      if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') {
        throw new Error('GitHub could not return the full archive/index.json blob. No archive changes were published.');
      }
      indexContent = blob.content;
    }

    let parsedIndex;
    try {
      parsedIndex = JSON.parse(base64DecodeContent(indexContent));
    } catch {
      // Never silently replace a corrupt index with a partial one. The index is
      // the web app's navigation/search catalogue; rebuilding it from a limited
      // sync could make every unselected conversation disappear from the UI.
      throw new Error('archive/index.json is invalid JSON. Restore or repair it before syncing; no archive changes were published.');
    }
    if (!parsedIndex || !Array.isArray(parsedIndex.conversations)) {
      throw new Error('archive/index.json has an invalid structure. Expected a conversations array; no archive changes were published.');
    }
    index = parsedIndex;
  }

  return index;
}

async function loadArchiveSnapshot() {
  let ref = await getRef();
  assertNotCancelled();
  let branch = ref ? ref.ref.split('/').pop() : 'main';
  let baseCommit = ref ? await gh(`/git/commits/${ref.object.sha}`) : null;
  let baseTree = baseCommit ? await gh(`/git/trees/${baseCommit.tree.sha}?recursive=1`) : null;
  if (baseTree?.truncated) {
    throw new Error('The GitHub archive tree is too large to verify safely. No archive changes were published.');
  }
  let existingPaths = new Set((baseTree?.tree || []).map((item) => item.path));

  const index = await loadArchiveIndex(ref);
  return { ref, branch, baseCommit, baseTree, existingPaths, index };
}

// Builds the sync's tree from `entries` in chained requests of at most
// TREE_BATCH_SIZE entries. Each request starts from the tree the previous one
// returned, so applying the batches in order equals applying them at once.
async function createTreeInBatches(entries, baseTreeSha, onBatch) {
  let base = baseTreeSha || null;
  let tree = null;
  const batches = Math.max(1, Math.ceil(entries.length / TREE_BATCH_SIZE));
  for (let batch = 0; batch < batches; batch++) {
    assertNotCancelled();
    const payload = { tree: entries.slice(batch * TREE_BATCH_SIZE, (batch + 1) * TREE_BATCH_SIZE) };
    if (base) payload.base_tree = base;
    tree = await gh('/git/trees', { method: 'POST', body: JSON.stringify(payload) });
    if (typeof tree?.sha !== 'string' || !tree.sha) {
      throw new Error('GitHub did not return a tree SHA while building the archive tree.');
    }
    base = tree.sha;
    onBatch?.(batch + 1, batches);
  }
  return tree;
}

// Reads the tree that is about to be committed and checks that it holds
// exactly what this sync wrote and deleted, and every file the next index
// references. Nothing is published if GitHub built anything else.
async function verifySyncTree(treeSha, entries, requiredPaths) {
  const tree = await gh(`/git/trees/${encodeURIComponent(treeSha)}?recursive=1`);
  if (!tree || tree.truncated || !Array.isArray(tree.tree)) {
    throw new Error('The new GitHub archive tree is too large to verify safely. No archive changes were published.');
  }
  const blobs = new Map(tree.tree.filter((item) => item?.type === 'blob').map((item) => [item.path, item.sha]));
  const wrong = [];
  for (const entry of entries) {
    if (entry.sha === null ? blobs.has(entry.path) : blobs.get(entry.path) !== entry.sha) wrong.push(entry.path);
  }
  for (const path of requiredPaths) {
    if (!blobs.has(path)) wrong.push(path);
  }
  if (wrong.length) {
    const unique = [...new Set(wrong)];
    throw new Error(`Archive integrity check failed: the tree GitHub built does not match this sync for ${unique.length} file(s) (${unique.slice(0, 3).join(', ')}). No archive changes were published; sync again.`);
  }
}

// After a full sync, archived conversations that Claude.ai did not list at
// all were either deleted there or missing from an incomplete list. Their
// archived copies are kept either way; say so instead of staying silent.
function unlistedSummary(count) {
  if (!count) return '';
  return ` ${count} archived conversation${count === 1 ? ' was' : 's were'} not returned by Claude.ai in this full sync (deleted there, or Claude's list was incomplete); ${count === 1 ? 'its archived copy was' : 'their archived copies were'} kept.`;
}

// For incremental sync: the conversations of this account whose archived copy
// is complete (every referenced file exists on the branch) and was written by
// the current exporter. Only these may be skipped as unchanged.
async function archiveAccounts() {
  const s = await settings();
  if (!s.github_owner || !s.github_repo || !s.github_token) {
    throw Error('Configure GitHub settings in the extension popup first.');
  }
  const ref = await getRef();
  const index = await loadArchiveIndex(ref);
  const names = new Set(
    index.conversations
      .filter((entry) => entry?.provider === 'claude' && typeof entry.account === 'string')
      .map((entry) => entry.account.trim())
      .filter(Boolean),
  );
  return [...names].sort((a, b) => a.localeCompare(b));
}

async function archiveState() {
  return (await archiveSyncState()).conversations;
}

// The archive state for an incremental sync: the conversations that may be
// skipped (see archiveState), and the oversized files this account's archive
// recorded with the identity of an earlier full download, so the Claude tab
// can avoid downloading them again (see canSkipOversizedDownload in content.js).
async function archiveSyncState() {
  if (!syncRunning) cancelRequested = false;
  const s = await settings();
  if (!s.github_owner || !s.github_repo || !s.github_token) throw Error('Configure GitHub settings in the extension popup first.');
  const account = s.archive_account?.trim() || 'personal';
  const { index, existingPaths } = await loadArchiveSnapshot();
  const oversized = [];
  for (const entry of index.conversations) {
    if (entry?.provider !== 'claude' || entry.account !== account || entry.id == null) continue;
    for (const item of Array.isArray(entry.incomplete) ? entry.incomplete : []) {
      if (item?.too_large !== true || item.github_rejected === true || typeof item.file_uuid !== 'string' || !item.file_uuid) continue;
      if (!/^[0-9a-f]{64}$/.test(String(item.sha256)) || !Number.isSafeInteger(item.size) || item.size <= MAX_ARCHIVED_FILE_BYTES) continue;
      oversized.push({ id: String(entry.id), file_uuid: item.file_uuid, size: item.size, sha256: item.sha256 });
    }
  }
  const conversations = index.conversations
    .filter((entry) => entry?.provider === 'claude' && entry.account === account
      && entry.exporter_version === EXPORTER_VERSION && entry.updated_at
      && !(Array.isArray(entry.incomplete) && entry.incomplete.length)
      && [entry.path, ...(Array.isArray(entry.assets) ? entry.assets.map((asset) => asset?.path) : [])]
        .every((path) => path && existingPaths.has(path)))
    .map((entry) => ({ id: entry.id, updated_at: entry.updated_at }));
  return { conversations, oversized };
}

async function sync(conversations, onProgress, skipped = [], { fullList = false, unchangedIds = [], listed = null, archiveStateError = null, oversizedDownloadsSkipped = 0 } = {}) {
  const unchanged = Array.isArray(unchangedIds) ? unchangedIds.map(String) : [];
  const failedItems = Array.isArray(skipped) ? skipped : [];
  const report = {
    listed: fullList && Number.isFinite(listed) ? listed : null,
    ...(Number.isSafeInteger(oversizedDownloadsSkipped) && oversizedDownloadsSkipped > 0 ? { oversizedDownloadsSkipped } : {}),
    ...(typeof archiveStateError === 'string' && archiveStateError ? { archiveStateError: archiveStateError.slice(0, 300), fullList } : {}),
    committed: [],
    unchanged: unchanged.length,
    incomplete: [],
    failed: [],
    keptPrevious: [],
  };
  let skippedNote = '';
  syncRunning = true;
  cancelRequested = false;
  syncAbortController = new AbortController();
  activeProgressCallback = onProgress;
  // Set just before the branch ref update. A failure before it cannot have
  // changed the archive: blobs, trees and commits are unreferenced until then.
  let publishing = false;
  try {
    const s = await settings();
    // Keep a consistent settings snapshot for this sync and avoid a storage read
    // for every blob request when exporting large archives.
    activeGitHubSettings = s;
    const account = s.archive_account?.trim() || 'personal';
    const accountSlug = slugify(account);
    const provider = 'claude';
    let { ref, branch, baseCommit, baseTree, existingPaths, index } = await loadArchiveSnapshot();

    const map = new Map(index.conversations.map((x) => [`${x.provider}:${x.account}:${x.id}`, x]));
    report.failed = failedItems.map((item) => ({
      id: String(item.id),
      title: String(item.title || item.id),
      error: String(item.error || 'unknown error').slice(0, 300),
      archived: map.has(`${provider}:${account}:${item.id}`),
    }));
    if (fullList) {
      const listed = new Set([
        ...conversations.map((c) => String(c.external_id)),
        ...(Array.isArray(skipped) ? skipped.map((item) => String(item.id)) : []),
        ...unchanged,
      ]);
      const unlisted = index.conversations.filter((x) => x.provider === provider && x.account === account && !listed.has(String(x.id)));
      report.unlisted = unlisted.length;
    }
    let changes = [];
    let changedConversations = 0;
    let assetWrites = 0;
    let indexNeedsUpdate = false;
    const total = conversations.length;

    // Attachments still held as bytes (a sync into a brand-new repository, or
    // one handed over without the streaming upload) are uploaded before the
    // Markdown is written, so one GitHub cannot take is noted in the
    // conversation instead of failing the commit. Bytes already archived are
    // reused, never uploaded again.
    const unstaged = conversations.flatMap((c) => (Array.isArray(c?.assets) ? c.assets : []))
      .filter((asset) => asset?.sha256 && asset.base64 && !asset.blob_sha && !asset.upload_error);
    if (unstaged.length) {
      if (!ref) {
        await initializeEmptyRepository();
        assertNotCancelled();
        ({ ref, branch, baseCommit, baseTree, existingPaths, index } = await loadArchiveSnapshot());
        if (!ref) throw Error('GitHub repository was initialized but no branch could be found.');
      }
      const context = uploadContextFromSnapshot({ baseTree, index });
      let next = 0;
      let firstStageError = null;
      let staged = 0;
      onProgress?.({ stage: 'uploading', current: 0, total: unstaged.length, changed: 0, message: 'Uploading attachments…' });
      const stageWorker = async () => {
        while (!firstStageError) {
          const asset = unstaged[next++];
          if (!asset) return;
          try {
            assertNotCancelled();
            // Identical bytes in several conversations are uploaded once.
            await stageAssetUpload(context, asset, asset.base64, syncAbortController?.signal);
            assertNotCancelled();
            if (asset.blob_sha || asset.upload_error) asset.base64 = '';
            onProgress?.({ stage: 'uploading', current: ++staged, total: unstaged.length, changed: 0, message: 'Uploading attachments…' });
          } catch (error) {
            firstStageError ??= error;
            return;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(BLOB_UPLOAD_CONCURRENCY, unstaged.length) }, () => stageWorker()));
      if (firstStageError) throw firstStageError;
    }

    for (let i = 0; i < total; i++) {
      assertNotCancelled();
      const c = conversations[i];
      const path = conversationPath(c, provider, accountSlug);
      const normalizedAssets = normalizeAssetList(c, provider, accountSlug);
      // A file too large for GitHub's API is not archived: the conversation
      // says so where the file was, is reported as incomplete, and is
      // checked again by every later sync.
      if (normalizedAssets.omissions.length) {
        const recorded = Array.isArray(c.incomplete) ? c.incomplete : [];
        c.incomplete = [...recorded, ...normalizedAssets.omissions];
      }
      const markdown = conversationMarkdown(c, provider, account, normalizedAssets.byKey, normalizedAssets.assets);
      const key = `${provider}:${account}:${c.external_id}`;
      const previous = map.get(key);
      // A transcript GitHub's API cannot take would fail the commit of every
      // other conversation too. Leave this one out, keep its archived copy,
      // and say why; attachments are separate files and do not count.
      if (markdownTooLargeForUpload(markdown)) {
        report.failed.push({
          id: String(c.external_id),
          title: c.title || String(c.external_id),
          error: `its Markdown transcript (${formatBytes(markdown.length)} or more) is over the ${formatBytes(MAX_BLOB_REQUEST_BYTES)} upload limit for GitHub's API`,
          archived: Boolean(previous),
        });
        onProgress?.({ stage: 'checking', current: i + 1, total, changed: changedConversations });
        continue;
      }
      const entry = indexEntry(c, path, provider, account, normalizedAssets.assets);
      const rawSearchText = entry.search_text;
      entry.search_text_sha256 = await sha256(rawSearchText);
      const compressedSearchText = await compressSearchText(rawSearchText);
      if (compressedSearchText !== null) {
        entry.search_text_encoding = SEARCH_TEXT_ENCODING;
        entry.search_text_gzip = compressedSearchText;
        delete entry.search_text;
      } else {
        entry.search_text_encoding = 'plain';
      }
      entry.content_sha256 = await sha256(markdown);
      const previousAssets = Array.isArray(previous?.assets) ? previous.assets : [];
      const missingItems = incompleteItems(c);
      // Never let an incomplete export replace an archived copy that has files
      // the new export lacks: keep the archived copy until a complete export.
      if (missingItems.length && previous) {
        const exportedPaths = new Set(entry.assets.map((asset) => asset.path));
        if (previousAssets.some((asset) => asset?.path && !exportedPaths.has(asset.path))) {
          report.keptPrevious.push({ id: String(c.external_id), title: c.title || String(c.external_id) });
          onProgress?.({ stage: 'checking', current: i + 1, total, changed: changedConversations });
          continue;
        }
      }
      if (missingItems.length) {
        report.incomplete.push({ id: String(c.external_id), title: c.title || String(c.external_id), missing: missingItems.map(missingLabel) });
      }
      if (JSON.stringify(previous?.incomplete || []) !== JSON.stringify(entry.incomplete || [])) indexNeedsUpdate = true;
      const currentAssetSignature = JSON.stringify(entry.assets);
      const previousAssetSignature = JSON.stringify(previousAssets);
      const searchCacheChanged = previous?.search_text_encoding !== entry.search_text_encoding
        || previous?.search_text_sha256 !== entry.search_text_sha256
        || (entry.search_text_encoding === SEARCH_TEXT_ENCODING && typeof previous?.search_text_gzip !== 'string');
      if (searchCacheChanged) indexNeedsUpdate = true;
      // Record the exporter version even when the Markdown is unchanged, so
      // the next sync can skip this conversation incrementally.
      if (previous?.exporter_version !== EXPORTER_VERSION) indexNeedsUpdate = true;
      const changed = !previous
        || previous.updated_at !== entry.updated_at
        || previous.message_count !== entry.message_count
        || previous.title !== entry.title
        || previous.path !== path
        || previous.format_version !== 4
        || previous.content_sha256 !== entry.content_sha256
        || previousAssetSignature !== currentAssetSignature
        || !existingPaths.has(path)
        || previousAssets.some((asset) => asset?.path && !existingPaths.has(asset.path));

      if (changed) {
        changedConversations += 1;
        report.committed.push({ id: String(c.external_id), title: c.title || String(c.external_id) });
      }
      if (changed && previous?.path && previous.path !== path) {
        changes.push({ path: previous.path, delete: true });
      }

      const currentAssetPaths = new Set(entry.assets.map((a) => a.path));
      for (const oldAsset of previousAssets) {
        if (oldAsset?.path && !currentAssetPaths.has(oldAsset.path)) {
          changes.push({ path: oldAsset.path, delete: true });
        }
      }

      map.set(key, entry);
      if (changed) {
        changes.push({ path, content: markdown, encoding: 'utf-8' });
        for (const asset of normalizedAssets.assets) {
          if (asset.omitted) continue;
          const previousAsset = previousAssets.find((a) => a.path === asset.path && a.sha256 === asset.sha256);
          if (!previousAsset || !existingPaths.has(asset.path)) {
            assetWrites += 1;
            changes.push(asset.blob_sha
              ? { path: asset.path, sha: asset.blob_sha }
              : { path: asset.path, content: asset.base64, encoding: 'base64' });
          }
        }
      }
      onProgress?.({ stage: 'checking', current: i + 1, total, changed: changedConversations });
    }

    skippedNote = syncReportSummary(report) + unlistedSummary(report.unlisted || 0);

    // Migrate older entries too, so a limited sync compacts the complete cache
    // instead of leaving large uncompressed search strings in untouched entries.
    for (const [key, archived] of map) {
      if (typeof archived.search_text !== 'string') continue;

      const searchTextSha256 = archived.search_text_sha256 || await sha256(archived.search_text);
      const compressedSearchText = await compressSearchText(archived.search_text);
      if (compressedSearchText !== null) {
        const compacted = {
          ...archived,
          search_text_sha256: searchTextSha256,
          search_text_encoding: SEARCH_TEXT_ENCODING,
          search_text_gzip: compressedSearchText,
        };
        delete compacted.search_text;
        map.set(key, compacted);
        indexNeedsUpdate = true;
      } else {
        const metadataChanged = archived.search_text_sha256 !== searchTextSha256
          || archived.search_text_encoding !== 'plain';
        map.set(key, {
          ...archived,
          search_text_sha256: searchTextSha256,
          search_text_encoding: 'plain',
        });
        if (metadataChanged) indexNeedsUpdate = true;
      }
    }

    const nextIndex = {
      version: 2,
      updated_at: new Date().toISOString(),
      conversations: [...map.values()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')),
    };

    // A path can be shared by older archives whose conversation IDs normalized
    // to the same asset directory. Never delete a path that any entry in the
    // next index still references, even when the selected conversation dropped it.
    const referencedPaths = new Set(nextIndex.conversations.flatMap((archived) => [
      archived.path,
      ...(Array.isArray(archived.assets) ? archived.assets.map((asset) => asset?.path) : []),
    ]).filter(Boolean));
    const plannedWritesBeforeCleanup = new Set(changes.filter((change) => !change.delete).map((change) => change.path));
    const seenDeletes = new Set();
    changes = changes.filter((change) => {
      if (!change.delete) return true;
      if (referencedPaths.has(change.path) || plannedWritesBeforeCleanup.has(change.path)) return false;
      if (seenDeletes.has(change.path)) return false;
      seenDeletes.add(change.path);
      return true;
    });

    // Do not publish an index that points to files missing from GitHub. Missing
    // files for selected conversations are repaired by the planned writes above;
    // missing files for unselected conversations require syncing those conversations.
    const plannedWrites = new Set(changes.filter((change) => !change.delete).map((change) => change.path));
    const plannedDeletes = new Set(changes.filter((change) => change.delete).map((change) => change.path));
    for (const archived of nextIndex.conversations) {
      const requiredPaths = [archived.path, ...(Array.isArray(archived.assets) ? archived.assets.map((asset) => asset?.path) : [])].filter(Boolean);
      const missing = requiredPaths.filter((requiredPath) =>
        plannedDeletes.has(requiredPath)
          ? !plannedWrites.has(requiredPath)
          : !existingPaths.has(requiredPath) && !plannedWrites.has(requiredPath)
      );
      if (missing.length) {
        throw new Error(`Archive integrity check failed: ${missing.length} file(s) referenced by "${archived.title || archived.id}" are missing from GitHub (${missing.slice(0, 3).join(', ')}). Sync that conversation to repair it; no archive changes were published.`);
      }
    }

    // An empty repository has no ref/base tree. GitHub will reject /git/blobs
    // with 409 until the repository has its first commit, so initialize it
    // before using the Git Database API.
    if (!ref) {
      await initializeEmptyRepository();
      assertNotCancelled();
      ref = await getRef();
      if (!ref) throw Error('GitHub repository was initialized but no branch could be found.');
      branch = ref.ref.split('/').pop();
      baseCommit = await gh(`/git/commits/${ref.object.sha}`);
      baseTree = await gh(`/git/trees/${baseCommit.tree.sha}?recursive=1`);
      if (baseTree?.truncated) {
        throw new Error('The GitHub archive tree is too large to verify safely. No archive changes were published.');
      }
      existingPaths = new Set((baseTree?.tree || []).map((item) => item.path));
    }

    // The index is one blob carrying every conversation's search text; record
    // its size so growth is visible before it reaches the request limit.
    const indexJson = JSON.stringify(nextIndex, null, 2);
    const indexBytes = new TextEncoder().encode(indexJson).byteLength;
    report.index_bytes = indexBytes;
    const indexNote = indexBytes >= INDEX_WARN_BYTES
      ? ` The archive index (archive/index.json) is ${formatBytes(indexBytes)}; syncs will stop working when it nears ${formatBytes(MAX_BLOB_REQUEST_BYTES)}, the most GitHub's API accepts in one request.`
      : '';

    // A sync that left any conversation out, or archived one with files
    // missing, is partial: the popup says so instead of "complete".
    const partial = report.failed.length > 0 || report.incomplete.length > 0 || report.keptPrevious.length > 0;
    const outcome = { report, partial };
    if (changedConversations === 0 && !indexNeedsUpdate && ref) {
      const head = partial ? 'Sync finished with problems: no archived conversation changed, so no GitHub commit was made.' : 'Everything is already up to date. No GitHub commit was needed.';
      onProgress?.({ stage: 'done', total, changed: 0, commit: null, message: `${head}${skippedNote}${indexNote}`, ...outcome });
      return { total, changed: 0, commit: null, skipped: skipped.length, ...outcome };
    }

    const completionMessage = (partial ? 'Sync finished with problems: ' : 'Sync complete: ') + (changedConversations === 0
      ? 'the search cache was compacted; no conversation Markdown changed in 1 GitHub commit.'
      : `${changedConversations} conversation${changedConversations === 1 ? '' : 's'} changed in 1 GitHub commit.`) + skippedNote + indexNote;

    // Fail before uploading anything when the index cannot be uploaded at all.
    if (utf8LengthExceeds(JSON.stringify({ content: indexJson, encoding: 'utf-8' }), MAX_BLOB_REQUEST_BYTES)) {
      throw new Error(`The archive index (archive/index.json) would be ${formatBytes(indexBytes)}, more than the ${formatBytes(MAX_BLOB_REQUEST_BYTES)} GitHub's API accepts in one request. No archive changes were published. The archive is intact, but it needs a smaller index format before it can be updated; please report this.`);
    }

    const treeEntries = new Array(changes.length);
    const uploadTotal = changes.filter((x) => !x.delete).length + 1;
    onProgress?.({ stage: 'uploading', current: 0, total: uploadTotal, changed: changedConversations });
    let uploaded = 0;
    let nextChangeIndex = 0;
    let firstUploadError = null;

    // Blob writes are independent, so upload a small bounded batch in parallel.
    // Keep tree entries indexed by the original change order so path updates and
    // deletions remain deterministic in the final tree payload.
    async function uploadWorker() {
      while (true) {
        if (firstUploadError) return;
        const i = nextChangeIndex++;
        if (i >= changes.length) return;
        const change = changes[i];
        try {
          assertNotCancelled();
          if (change.delete) {
            treeEntries[i] = { path: change.path, mode: '100644', type: 'blob', sha: null };
            continue;
          }

          // Attachment bytes uploaded while the transfer was received.
          const blob = change.sha ? { sha: change.sha } : await createBlob(change.content, change.encoding || 'utf-8');
          assertNotCancelled();
          treeEntries[i] = { path: change.path, mode: '100644', type: 'blob', sha: blob.sha };
          uploaded += 1;
          onProgress?.({ stage: 'uploading', current: uploaded, total: uploadTotal, changed: changedConversations });
        } catch (error) {
          if (!firstUploadError) firstUploadError = error;
          return;
        }
      }
    }

    const workerCount = Math.min(BLOB_UPLOAD_CONCURRENCY, Math.max(1, changes.length));
    await Promise.all(Array.from({ length: workerCount }, () => uploadWorker()));
    if (firstUploadError) throw firstUploadError;
    assertNotCancelled();
    assertNotCancelled();
    const indexBlob = await createBlob(indexJson);
    treeEntries.push({ path: 'archive/index.json', mode: '100644', type: 'blob', sha: indexBlob.sha });
    onProgress?.({ stage: 'uploading', current: uploadTotal, total: uploadTotal, changed: changedConversations });

    onProgress?.({ stage: 'creating-tree', current: 0, total: Math.max(1, Math.ceil(treeEntries.length / TREE_BATCH_SIZE)), changed: changedConversations });
    const tree = await createTreeInBatches(treeEntries, baseTree?.sha, (current, batches) => {
      onProgress?.({ stage: 'creating-tree', current, total: batches, changed: changedConversations });
    });
    await verifySyncTree(tree.sha, treeEntries, referencedPaths);
    assertNotCancelled();

    onProgress?.({ stage: 'creating-commit', current: 0, total: 1, changed: changedConversations });
    const commit = await gh('/git/commits', {
      method: 'POST',
      body: JSON.stringify({
        message: syncCommitMessage(changedConversations, assetWrites),
        tree: tree.sha,
        ...(baseCommit ? { parents: [baseCommit.sha] } : {}),
      }),
    });
    onProgress?.({ stage: 'creating-commit', current: 1, total: 1, changed: changedConversations });

    onProgress?.({ stage: 'finalizing', current: 0, total: 1, changed: changedConversations });

    // The tree and commit were built against baseCommit. If someone else pushed
    // during this sync, do not try to publish a sibling commit over their update.
    // The non-force PATCH below remains the final race guard between this check
    // and the ref update itself.
    const latestRef = await gh(`/git/ref/heads/${branch}`);
    if (baseCommit && latestRef?.object?.sha !== baseCommit.sha) {
      throw new Error('The GitHub branch changed during this sync. Nothing was published; run sync again to include the latest archive.');
    }
    publishing = true;
    try {
      await gh(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
    } catch (publishError) {
      // A timeout or cancellation can happen after GitHub accepted the PATCH but
      // before the response reaches this client. Verify the branch head without
      // the aborted sync signal before reporting cancellation or failure.
      let observedRef;
      try {
        observedRef = await gh(`/git/ref/heads/${branch}`, {}, true);
      } catch (verificationError) {
        const error = new Error(
          `The GitHub ref update returned an error and its outcome could not be verified. Check the "${branch}" branch on GitHub before retrying. Update error: ${String(publishError?.message || publishError)}. Verification error: ${String(verificationError?.message || verificationError)}`,
        );
        error.name = 'PublicationUncertainError';
        throw error;
      }

      if (observedRef?.object?.sha === commit.sha) {
        // The server committed the ref update despite the lost/aborted response.
        // Report success rather than incorrectly telling the user it was cancelled.
        onProgress?.({
          stage: 'done',
          current: 1,
          total: 1,
          changed: changedConversations,
          commit: commit.sha,
          message: `${completionMessage} The response to the final update was interrupted, but GitHub confirms the commit is published.`,
          ...outcome,
        });
        return { total, changed: changedConversations, commit: commit.sha, skipped: skipped.length, ...outcome };
      }

      if (baseCommit && observedRef?.object?.sha === baseCommit.sha) {
        // The original head is still present, so the attempted update did not
        // become visible. Preserve the original error (including cancellation).
        // The update itself is not repeated automatically: a new sync rebuilds
        // and re-verifies everything against the then-current branch.
        if (!isCancellation(publishError)) {
          try {
            publishError.message = `${String(publishError.message || publishError)} GitHub confirms the "${branch}" branch is unchanged: nothing was published; sync again.`;
          } catch {}
        }
        throw publishError;
      }

      const error = new Error(
        `The GitHub ref update returned an error and the branch now points to a different commit. The sync commit may or may not have been published before another update; inspect the "${branch}" branch history before retrying. Update error: ${String(publishError?.message || publishError)}`,
      );
      error.name = 'PublicationUncertainError';
      throw error;
    }

    onProgress?.({ stage: 'done', current: 1, total: 1, changed: changedConversations, commit: commit.sha, message: completionMessage, ...outcome });
    return { total, changed: changedConversations, commit: commit.sha, skipped: skipped.length, ...outcome };
  } catch (error) {
    // Say plainly that a failure before the branch update left the archive as
    // it was, so a GitHub error mid-sync is not mistaken for possible data loss.
    if (!publishing && !isCancellation(error) && error instanceof Error && !/published/i.test(String(error.message))) {
      try {
        error.message = `${error.message} Nothing was published; the archive on GitHub is unchanged. Sync again to retry.`;
      } catch {}
    }
    throw error;
  } finally {
    syncRunning = false;
    syncAbortController = null;
    activeProgressCallback = null;
    activeGitHubSettings = null;
  }
}

// ---- Receiving a sync from the Claude tab (see createTransferSession in content.js) ----
//
// The content script streams JSON records in ordered, chunked batches: one
// header per conversation, then each of its messages, then each attachment's
// base64 in separate chunks. Every step is checked here: a missing,
// duplicated, reordered or altered chunk, message, conversation or file fails
// the whole transfer, and nothing is published until syncNormalized confirms
// the counts. Attachments are checked against their size and SHA-256 and,
// when the archive repository can take blobs, uploaded as unreferenced Git
// blobs at once, so the worker holds one attachment at a time rather than
// every attachment of the sync. Such a blob is only published by the final
// commit; an abandoned transfer leaves nothing on the branch.
const TRANSFER_STALE_MS = 2 * 60 * 1000;
const TRANSFER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TRANSFER_RETRY = 'Nothing was published; sync again.';
let runningTransferId = null;

class TransferError extends Error {}

function transferLostResponse() {
  return {
    ok: false,
    error: `The extension is no longer receiving this sync (it was cancelled, replaced by a newer sync, or the extension's background worker restarted). ${TRANSFER_RETRY}`,
  };
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function failTransfer(transfer, error) {
  if (pendingTransfer === transfer) pendingTransfer = null;
  try { transfer?.abortController?.abort(); } catch {}
  return { ok: false, error };
}

// The pending transfer this message belongs to. A message for any other
// transfer (an older sync, another tab) is refused without touching the
// transfer that is actually running.
function transferFor(msg) {
  const transfer = pendingTransfer;
  if (!transfer || transfer.mode !== 'stream' || typeof msg.transferId !== 'string' || transfer.id !== msg.transferId) return null;
  transfer.lastActivity = Date.now();
  return transfer;
}

function startTransfer(msg, sender) {
  if (syncRunning) {
    return { ok: false, error: 'Another archive sync is already running. Nothing was published; try again after it finishes.' };
  }
  if (typeof msg.transferId !== 'string' || !TRANSFER_ID.test(msg.transferId)
    || (msg.metadata != null && !plainObject(msg.metadata))) {
    return { ok: false, error: `The sync transfer could not be initialized safely. ${TRANSFER_RETRY}` };
  }
  const tabId = sender?.tab?.id ?? null;
  const existing = pendingTransfer;
  // A transfer still active in another tab is not replaced. One left behind
  // by a closed or reloaded tab (or this same tab) is.
  if (existing && existing.id !== msg.transferId && existing.tabId !== tabId
    && Date.now() - existing.lastActivity < TRANSFER_STALE_MS) {
    return { ok: false, error: 'Another Claude tab is already handing a sync to the extension. Nothing was published; wait for it to finish, or cancel it, then sync again.' };
  }
  if (existing) failTransfer(existing, null);
  // A cancel from an earlier sync must not stop this one's uploads.
  cancelRequested = false;
  pendingTransfer = {
    id: msg.transferId,
    mode: 'stream',
    tabId,
    lastActivity: Date.now(),
    abortController: new AbortController(),
    metadata: plainObject(msg.metadata) ? msg.metadata : null,
    conversations: [],
    current: null,
    nextBatchIndex: 0,
    currentBatch: null,
    currentAsset: null,
    busy: false,
    uploads: null,
    stats: { uploaded: 0, reused: 0, kept: 0 },
  };
  return { ok: true };
}

function describeConversation(c, index) {
  return `"${String(c?.external_id || `#${index + 1}`).slice(0, 80)}"`;
}

// Throws unless the conversation received last is complete.
function finishCurrentConversation(transfer) {
  const current = transfer.current;
  if (!current) return;
  const c = transfer.conversations[current.index];
  if (c.messages.length !== current.expectedMessages) {
    throw new TransferError(`conversation ${describeConversation(c, current.index)} arrived with ${c.messages.length} of ${current.expectedMessages} messages`);
  }
  if (transfer.currentAsset || current.pendingAssets.size) {
    throw new TransferError(`${current.pendingAssets.size} attachment(s) of conversation ${describeConversation(c, current.index)} did not arrive`);
  }
  for (const asset of c.assets) delete asset.payload_chars;
  transfer.current = null;
}

function beginConversation(transfer, record) {
  finishCurrentConversation(transfer);
  const index = transfer.conversations.length;
  const header = record.conversation;
  if (record.conversation_index !== index || !plainObject(header)
    || !Number.isSafeInteger(record.message_count) || record.message_count < 0
    || header.messages !== undefined || (header.assets !== undefined && !Array.isArray(header.assets))) {
    throw new TransferError(`conversation ${index + 1} arrived out of order or malformed`);
  }
  const assets = Array.isArray(header.assets) ? header.assets : [];
  const pendingAssets = new Set();
  for (const [assetIndex, asset] of assets.entries()) {
    if (!plainObject(asset) || !Number.isSafeInteger(asset.payload_chars) || asset.payload_chars < 0
      || (asset.base64 !== undefined && asset.base64 !== '') || asset.blob_sha !== undefined) {
      throw new TransferError(`attachment ${assetIndex + 1} of conversation ${describeConversation(header, index)} has invalid metadata`);
    }
    asset.base64 = '';
    if (asset.payload_chars > 0) pendingAssets.add(assetIndex);
  }
  transfer.conversations.push({ ...header, assets, messages: [] });
  transfer.current = { index, expectedMessages: record.message_count, pendingAssets };
}

function addMessage(transfer, record) {
  const current = transfer.current;
  const c = current && transfer.conversations[current.index];
  if (!current || record.conversation_index !== current.index || !plainObject(record.message)
    || c.messages.length >= current.expectedMessages) {
    throw new TransferError(`a message arrived out of order or for an unexpected conversation (record for conversation ${Number(record.conversation_index) + 1})`);
  }
  c.messages.push(record.message);
}

function applyRecords(transfer, records) {
  if (!Array.isArray(records) || !records.length) throw new TransferError('a batch was empty or malformed');
  for (const record of records) {
    if (!plainObject(record)) throw new TransferError('a batch contained a malformed record');
    if ('conversation' in record) beginConversation(transfer, record);
    else if ('message' in record) addMessage(transfer, record);
    else throw new TransferError('a batch contained an unknown record');
  }
}

function validChunkNumbers(msg) {
  return Number.isSafeInteger(msg.chunkIndex) && msg.chunkIndex >= 0
    && Number.isSafeInteger(msg.totalChunks) && msg.totalChunks > 0
    && msg.chunkIndex < msg.totalChunks
    && Number.isSafeInteger(msg.totalChars) && msg.totalChars >= 0
    && typeof msg.data === 'string';
}

function receiveBatchChunk(msg) {
  const transfer = transferFor(msg);
  if (!transfer) return transferLostResponse();
  if (transfer.busy || transfer.currentAsset || !validChunkNumbers(msg)
    || !Number.isSafeInteger(msg.batchIndex) || msg.batchIndex !== transfer.nextBatchIndex) {
    return failTransfer(transfer, `The conversation batches reached the extension out of order. ${TRANSFER_RETRY}`);
  }
  if (msg.chunkIndex === 0) {
    if (transfer.currentBatch) {
      return failTransfer(transfer, `A conversation batch was interrupted. ${TRANSFER_RETRY}`);
    }
    transfer.currentBatch = { totalChunks: msg.totalChunks, totalChars: msg.totalChars, chunks: [], chars: 0 };
  }
  const batch = transfer.currentBatch;
  if (!batch || batch.totalChunks !== msg.totalChunks || batch.totalChars !== msg.totalChars
    || msg.chunkIndex !== batch.chunks.length || batch.chars + msg.data.length > batch.totalChars) {
    return failTransfer(transfer, `The conversation batch was incomplete or out of order. ${TRANSFER_RETRY}`);
  }
  batch.chunks.push(msg.data);
  batch.chars += msg.data.length;
  if (batch.chunks.length < batch.totalChunks) return { ok: true };

  try {
    if (batch.chars !== batch.totalChars) throw new TransferError('a batch arrived with the wrong length');
    let records;
    try {
      records = JSON.parse(batch.chunks.join(''));
    } catch {
      throw new TransferError('a batch could not be decoded');
    }
    transfer.currentBatch = null;
    applyRecords(transfer, records);
    transfer.nextBatchIndex++;
  } catch (error) {
    const detail = error instanceof TransferError ? ` (${error.message})` : '';
    return failTransfer(transfer, `A conversation batch could not be decoded safely${detail}. ${TRANSFER_RETRY}`);
  }
  return { ok: true };
}

// Which archived files already hold which bytes (so they are not uploaded
// again), and which bytes GitHub already refused as too large (so they are
// not sent again only to be refused).
function uploadContextFromSnapshot({ baseTree, index }) {
  const treeBlobs = new Map((baseTree?.tree || [])
    .filter((item) => item?.type === 'blob' && typeof item.path === 'string' && typeof item.sha === 'string')
    .map((item) => [item.path, item]));
  const knownBlobs = new Map();
  const rejected = new Map();
  for (const entry of (Array.isArray(index?.conversations) ? index.conversations : [])) {
    for (const asset of (Array.isArray(entry?.assets) ? entry.assets : [])) {
      const item = treeBlobs.get(asset?.path);
      if (!item || typeof asset.sha256 !== 'string') continue;
      // The tree's own size guards against a file changed outside AI Archive.
      if (item.size != null && Number(item.size) !== Number(asset.size)) continue;
      knownBlobs.set(`${asset.sha256}:${Number(asset.size)}`, item.sha);
    }
    for (const item of (Array.isArray(entry?.incomplete) ? entry.incomplete : [])) {
      if (item?.too_large === true && item.github_rejected === true && typeof item.sha256 === 'string' && Number.isSafeInteger(item.size)) {
        // Stored as "<size>; <reason>" (see normalizeAssetList).
        const reason = String(item.reason || '').replace(/^[^;]*;\s*/, '');
        rejected.set(`${item.sha256}:${item.size}`, { reason: reason || 'GitHub rejected the upload as too large to process' });
      }
    }
  }
  return { knownBlobs, rejected };
}

// Uploads one attachment's bytes, or records why it cannot be archived.
// Afterwards the asset carries `blob_sha` (uploaded now or already in the
// archive) or `upload_error` (too large for GitHub's API); its base64 is no
// longer needed either way. Any other GitHub failure is thrown, naming the
// attachment, and stops the sync without publishing.
async function stageAssetUpload(context, asset, base64, signal) {
  const size = Number(asset.size);
  const key = `${asset.sha256}:${size}`;
  const known = context.knownBlobs.get(key);
  if (known) {
    asset.blob_sha = known;
    return 'reused';
  }
  if (size > MAX_ARCHIVED_FILE_BYTES) {
    asset.upload_error = { reason: tooLargeReason(size) };
    return 'too-large';
  }
  const refused = context.rejected.get(key);
  if (refused) {
    asset.upload_error = { reason: refused.reason, github_rejected: true };
    return 'too-large';
  }
  let blob;
  try {
    blob = await createBlob(base64, 'base64', signal);
  } catch (error) {
    if (error instanceof BlobTooLargeError) {
      asset.upload_error = {
        reason: error.remote ? tooLargeReason(size, { remote: error.remote }) : tooLargeReason(size),
        ...(error.remote ? { github_rejected: true } : {}),
      };
      if (error.remote) context.rejected.set(key, { reason: asset.upload_error.reason });
      return 'too-large';
    }
    if (error?.message === '__SYNC_CANCELLED__' || error?.name === 'AbortError') throw error;
    throw Object.assign(new Error(`Attachment "${String(asset.name || 'file').slice(0, 120)}" (${formatBytes(size)}) could not be uploaded to GitHub: ${String(error?.message || error)}`), { cause: error });
  }
  if (typeof blob?.sha !== 'string' || !blob.sha) {
    throw new Error(`GitHub did not return a blob SHA for attachment "${String(asset.name || 'file').slice(0, 120)}". Nothing was published; sync again.`);
  }
  asset.blob_sha = blob.sha;
  context.knownBlobs.set(key, blob.sha);
  return 'uploaded';
}

function base64Bytes(base64) {
  let binary;
  try {
    binary = atob(base64);
  } catch {
    throw new TransferError('its data is not valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Loaded once per transfer: which archived files already hold which bytes,
// so unchanged attachments are not uploaded again. Null means attachments
// stay in memory until sync() (no GitHub settings, or an empty repository
// that cannot take blobs before its first commit).
function transferUploadContext(transfer) {
  transfer.uploads ??= (async () => {
    const s = await settings();
    if (!s.github_owner || !s.github_repo || !s.github_token) return null;
    const snapshot = await loadArchiveSnapshot();
    if (!snapshot.ref) return null;
    return uploadContextFromSnapshot(snapshot);
  })();
  return transfer.uploads;
}

async function stageAsset(transfer, asset, base64) {
  const context = await transferUploadContext(transfer);
  if (pendingTransfer !== transfer) return;
  if (!context) {
    asset.base64 = base64;
    transfer.stats.kept++;
    return;
  }
  const outcome = await stageAssetUpload(context, asset, base64, transfer.abortController.signal);
  transfer.stats[outcome] = (transfer.stats[outcome] || 0) + 1;
}

function receiveAssetChunk(msg) {
  const transfer = transferFor(msg);
  if (!transfer) return transferLostResponse();
  const current = transfer.current;
  const c = current && transfer.conversations[current.index];
  if (transfer.busy || transfer.currentBatch || !validChunkNumbers(msg)
    || !Number.isSafeInteger(msg.conversationIndex) || !Number.isSafeInteger(msg.assetIndex)
    || !current || msg.conversationIndex !== current.index
    || c.messages.length !== current.expectedMessages) {
    return failTransfer(transfer, `The attachment chunks reached the extension out of order. ${TRANSFER_RETRY}`);
  }
  const asset = c.assets[msg.assetIndex];
  if (msg.chunkIndex === 0) {
    if (transfer.currentAsset) {
      return failTransfer(transfer, `An attachment transfer was interrupted. ${TRANSFER_RETRY}`);
    }
    if (!asset || !current.pendingAssets.has(msg.assetIndex) || msg.totalChars !== asset.payload_chars) {
      return failTransfer(transfer, `The attachment metadata was missing, did not match, or was already received. ${TRANSFER_RETRY}`);
    }
    transfer.currentAsset = { assetIndex: msg.assetIndex, totalChunks: msg.totalChunks, chunks: [], chars: 0 };
  }
  const receiving = transfer.currentAsset;
  if (!receiving || receiving.assetIndex !== msg.assetIndex || receiving.totalChunks !== msg.totalChunks
    || msg.totalChars !== asset?.payload_chars || msg.chunkIndex !== receiving.chunks.length
    || receiving.chars + msg.data.length > asset.payload_chars) {
    return failTransfer(transfer, `The attachment chunks were incomplete or out of order. ${TRANSFER_RETRY}`);
  }
  receiving.chunks.push(msg.data);
  receiving.chars += msg.data.length;
  if (receiving.chunks.length < receiving.totalChunks) return { ok: true };

  transfer.busy = true;
  transfer.currentAsset = null;
  const label = `"${String(asset.name || 'file').slice(0, 120)}"`;
  return (async () => {
    try {
      if (receiving.chars !== asset.payload_chars) throw new TransferError('it arrived with the wrong length');
      let base64 = receiving.chunks.join('');
      receiving.chunks = null;
      const bytes = base64Bytes(base64);
      if (asset.size == null) asset.size = bytes.byteLength;
      if (bytes.byteLength !== Number(asset.size)) {
        throw new TransferError(`it arrived with ${bytes.byteLength} bytes instead of ${Number(asset.size)}`);
      }
      if (await sha256Hex(bytes) !== String(asset.sha256 || '').toLowerCase()) {
        throw new TransferError('its contents do not match the checksum taken when it was downloaded');
      }
      if (pendingTransfer !== transfer) return transferLostResponse();
      await stageAsset(transfer, asset, base64);
      base64 = null;
      if (pendingTransfer !== transfer) return transferLostResponse();
      current.pendingAssets.delete(msg.assetIndex);
      return { ok: true };
    } catch (error) {
      if (pendingTransfer !== transfer) return transferLostResponse();
      if (error?.message === '__SYNC_CANCELLED__' || error?.name === 'AbortError') {
        return failTransfer(transfer, 'Sync cancelled. Nothing was published.');
      }
      const message = error instanceof TransferError
        ? `Attachment ${label} could not be received safely: ${error.message}. ${TRANSFER_RETRY}`
        : `${String(error?.message || error)}${/Nothing was published/.test(String(error?.message)) ? '' : ` ${TRANSFER_RETRY}`}`;
      return failTransfer(transfer, message);
    } finally {
      transfer.busy = false;
    }
  })();
}

// Returns the complete sync payload of a finished transfer, or throws.
function completeTransfer(msg) {
  const transfer = pendingTransfer;
  if (!transfer || transfer.id !== msg.transferId) throw new TransferError('no transfer with this ID is being received');
  pendingTransfer = null;
  if (transfer.mode === 'legacy') {
    if (transfer.chunks.length !== transfer.total) throw new TransferError('chunks are missing');
    return JSON.parse(transfer.chunks.join(''));
  }
  if (transfer.busy || transfer.currentBatch || transfer.currentAsset) throw new TransferError('a batch or attachment was still being received');
  finishCurrentConversation(transfer);
  if (!Number.isSafeInteger(msg.conversationCount) || msg.conversationCount !== transfer.conversations.length) {
    throw new TransferError(`${transfer.conversations.length} of ${Number.isSafeInteger(msg.conversationCount) ? msg.conversationCount : 'an unknown number of'} conversations arrived`);
  }
  const metadata = plainObject(msg.metadata) ? msg.metadata : (transfer.metadata || {});
  return {
    skipped: Array.isArray(metadata.skipped) ? metadata.skipped : [],
    unchangedIds: Array.isArray(metadata.unchangedIds) ? metadata.unchangedIds : [],
    fullList: metadata.fullList === true,
    listed: Number.isFinite(metadata.listed) ? metadata.listed : null,
    archiveStateError: typeof metadata.archiveStateError === 'string' ? metadata.archiveStateError.slice(0, 300) : null,
    oversizedDownloadsSkipped: Number.isSafeInteger(metadata.oversizedDownloadsSkipped) && metadata.oversizedDownloadsSkipped > 0 ? metadata.oversizedDownloadsSkipped : 0,
    conversations: transfer.conversations,
  };
}

const TRANSFER_MESSAGES = {
  syncTransferStart: (msg, sender) => startTransfer(msg, sender),
  syncTransferBatchChunk: (msg) => receiveBatchChunk(msg),
  syncTransferAssetChunk: (msg) => receiveAssetChunk(msg),
  syncTransferKeepAlive: (msg) => {
    if (transferFor(msg)) return { ok: true };
    // The final handoff is being published to GitHub.
    if (syncRunning && runningTransferId && msg.transferId === runningTransferId) return { ok: true };
    return transferLostResponse();
  },
  syncTransferAbort: (msg) => {
    if (pendingTransfer?.id === msg.transferId) failTransfer(pendingTransfer, null);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'syncProgress' && sender?.tab) {
    const { type, ...progress } = msg;
    contentSyncState = { ...progress, tabId: sender.tab.id, at: Date.now() };
    // Failures before the GitHub phase (for example Claude's list) end here.
    rememberLastSync(progress);
    return false;
  }
  if (msg.type === 'getArchiveAccounts') {
    archiveAccounts()
      .then((accounts) => sendResponse({ ok: true, accounts }))
      .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }
  if (msg.type === 'getArchiveState') {
    archiveSyncState()
      .then(({ conversations, oversized }) => sendResponse({ ok: true, conversations, oversized }))
      .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }
  if (msg.type === 'getSyncState') {
    if (!syncRunning && contentSyncRunning()) {
      const { at, tabId, ...progress } = contentSyncState;
      sendResponse({ running: true, ...progress });
    } else {
      sendResponse({ running: syncRunning, ...lastSyncState });
    }
    return false;
  }
  if (msg.type === 'cancelSync') {
    // The popup may have been reopened on another tab: stop the fetch in the
    // Claude tab that is actually running it.
    if (contentSyncRunning() && contentSyncState.tabId != null) {
      try { chrome.tabs?.sendMessage?.(contentSyncState.tabId, { type: 'cancelSync' })?.catch?.(() => {}); } catch {}
      contentSyncState = { ...contentSyncState, stage: 'cancelled' };
    }
    cancelRequested = true;
    syncAbortController?.abort();
    // Stop uploads of a sync still being received; the content script is
    // cancelled too and publishes nothing.
    if (pendingTransfer) failTransfer(pendingTransfer, null);
    broadcast({ stage: 'cancelled', message: 'Sync cancelled.' });
    sendResponse({ ok: true });
    return false;
  }
  if (Object.hasOwn(TRANSFER_MESSAGES, msg.type)) {
    let result;
    try {
      result = TRANSFER_MESSAGES[msg.type](msg, sender);
    } catch (error) {
      result = failTransfer(pendingTransfer, `The sync transfer failed: ${String(error?.message || error)} ${TRANSFER_RETRY}`);
    }
    if (result && typeof result.then === 'function') {
      result.then(sendResponse, (error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }
    sendResponse(result);
    return false;
  }
  if (msg.type === 'syncTransferChunk') {
    // Backward-compatible receiver for the previous whole-payload chunk format.
    if (msg.index === 0) {
      if (pendingTransfer && pendingTransfer.id !== msg.transferId && pendingTransfer.mode === 'stream') {
        sendResponse(transferLostResponse());
        return false;
      }
      pendingTransfer = { id: msg.transferId, mode: 'legacy', total: msg.total, chunks: [] };
    }
    if (!pendingTransfer || pendingTransfer.mode !== 'legacy' || pendingTransfer.id !== msg.transferId || pendingTransfer.total !== msg.total
      || msg.index !== pendingTransfer.chunks.length || typeof msg.data !== 'string') {
      if (pendingTransfer?.mode === 'legacy') pendingTransfer = null;
      sendResponse({ ok: false, error: 'The sync data reached the extension out of order. Nothing was published; sync again.' });
      return false;
    }
    pendingTransfer.chunks.push(msg.data);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'syncNormalized') {
    // A content script can finish collecting data before the GitHub sync has
    // completed. Ignore duplicate handoffs rather than creating competing
    // commits against the same branch head.
    if (syncRunning) {
      if (msg.transferId != null && pendingTransfer?.id === msg.transferId) failTransfer(pendingTransfer, null);
      sendResponse({ ok: true, alreadyRunning: true });
      return false;
    }

    let payload = msg;
    if (msg.transferId != null) {
      try {
        payload = completeTransfer(msg);
      } catch (error) {
        const detail = error instanceof TransferError ? ` (${error.message})` : '';
        const message = `The sync data did not fully reach the extension${detail}; it may have restarted. Nothing was published; sync again.`;
        broadcast({ stage: 'error', error: message });
        sendResponse({ ok: false, error: message });
        return false;
      }
      runningTransferId = msg.transferId;
    }

    // The content script's fetching phase is over; from here the GitHub sync
    // reports progress. Leaving its last "fetching" state behind would make a
    // reopened popup show a finished sync as still running.
    contentSyncState = null;
    sync(payload.conversations, broadcast, Array.isArray(payload.skipped) ? payload.skipped : [], {
      fullList: payload.fullList === true,
      unchangedIds: Array.isArray(payload.unchangedIds) ? payload.unchangedIds : [],
      listed: Number.isFinite(payload.listed) ? payload.listed : null,
      archiveStateError: typeof payload.archiveStateError === 'string' ? payload.archiveStateError : null,
      oversizedDownloadsSkipped: Number.isSafeInteger(payload.oversizedDownloadsSkipped) ? payload.oversizedDownloadsSkipped : 0,
    })
      .finally(() => {
        if (runningTransferId === msg.transferId) runningTransferId = null;
      })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((e) => {
        if (e.name === 'AbortError' || e.message === '__SYNC_CANCELLED__') {
          broadcast({ stage: 'cancelled', message: 'Sync cancelled.' });
          sendResponse({ ok: false, cancelled: true });
        } else {
          broadcast({ stage: 'error', error: e.message });
          sendResponse({ ok: false, error: e.message });
        }
      });
    return true;
  }
});
