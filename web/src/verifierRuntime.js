// Runtime for the read-only archive verifier (web/scripts/verify-archive.mjs):
// progress reporting, bounded concurrency, and a GitHub reader with retries.
// Nothing here writes to GitHub: the reader only issues GET requests.

// ---- Formatting ----

export function formatCount(n) {
  return Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'unknown size';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

// Remaining time from the average rate so far, or null while there is too
// little data for an honest estimate (fewer than 3 items or under 2 seconds).
export function estimateRemainingMs({ done, total, elapsedMs }) {
  if (!(done >= 3) || !(elapsedMs >= 2000) || !(total > done)) return total > 0 && done >= total ? 0 : null;
  return Math.round((elapsedMs / done) * (total - done));
}

// "342 / 812 (42.1%) | 18 files/s | ETA: 26s | elapsed 19s", or with byte throughput.
export function formatProgressLine({ done, total, elapsedMs, bytes = null, unit = 'files' }) {
  const percent = total > 0 ? `${((done / total) * 100).toFixed(1)}%` : '100.0%';
  const seconds = elapsedMs / 1000;
  const parts = [`${formatCount(done)} / ${formatCount(total)} (${percent})`];
  if (seconds >= 1) {
    parts.push(bytes != null ? `${formatBytes(bytes / seconds)}/s` : `${(done / seconds).toFixed(done / seconds >= 10 ? 0 : 1)} ${unit}/s`);
  }
  const eta = estimateRemainingMs({ done, total, elapsedMs });
  if (eta != null && done < total) parts.push(`ETA: ${formatDuration(eta)}`);
  parts.push(`elapsed ${formatDuration(elapsedMs)}`);
  return parts.join(' | ');
}

// ---- Progress ----

// One refreshed line on a terminal ("\r", no ANSI codes), or a periodic line
// (every intervalMs) when output is a file or pipe. log() prints a message
// above the progress line without leaving it garbled.
export function createProgress({ stream, isTTY = false, enabled = true, intervalMs = 5000, now = () => Date.now() }) {
  let phase = null;
  let lastWidth = 0;
  let lastPrinted = 0;
  const write = (text) => { if (stream) stream.write(text); };
  const clearLine = () => {
    if (isTTY && lastWidth) { write(`\r${' '.repeat(lastWidth)}\r`); lastWidth = 0; }
  };
  const render = (force = false) => {
    if (!enabled || !phase || phase.total == null) return;
    const line = `      ${formatProgressLine({ done: phase.done, total: phase.total, elapsedMs: now() - phase.startedAt, bytes: phase.trackBytes ? phase.bytes : null, unit: phase.unit })}`;
    if (isTTY) {
      write(`\r${line}${' '.repeat(Math.max(0, lastWidth - line.length))}`);
      lastWidth = line.length;
    } else if (force || now() - lastPrinted >= intervalMs) {
      write(`${line}\n`);
      lastPrinted = now();
    }
  };
  return {
    step(label) {
      clearLine();
      if (enabled) write(`${label}\n`);
    },
    start({ total, unit = 'files', trackBytes = false }) {
      phase = { total, done: 0, bytes: 0, unit, trackBytes, startedAt: now() };
      lastPrinted = now();
      render(true);
    },
    tick({ count = 1, bytes = 0 } = {}) {
      if (!phase) return;
      phase.done += count;
      phase.bytes += bytes;
      render();
    },
    finish() {
      if (!phase) return;
      if (isTTY) { render(true); write('\n'); lastWidth = 0; } else render(true);
      phase = null;
    },
    log(message) {
      clearLine();
      write(`${message}\n`);
      render(true);
    },
    get current() { return phase ? { ...phase } : null; },
  };
}

// ---- Bounded concurrency ----

// Runs worker(item, index) with at most `limit` running at once. Results keep
// the input order. Stops scheduling new items once `signal` is aborted;
// the returned promise then rejects with an AbortError after the running ones
// settle. A worker that throws rejects the whole run (callers that want
// per-item failures catch inside the worker).
export async function mapLimit(items, limit, worker, { signal } = {}) {
  const list = [...items];
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, list.length || 1));
  let next = 0;
  let failure = null;
  const runner = async () => {
    while (!failure) {
      if (signal?.aborted) return;
      const index = next++;
      if (index >= list.length) return;
      try {
        results[index] = await worker(list[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, runner));
  if (failure) throw failure;
  if (signal?.aborted) throw abortError();
  return results;
}

export function abortError() {
  const error = new Error('The audit was interrupted.');
  error.name = 'AbortError';
  return error;
}

// ---- GitHub reader ----

const API = 'https://api.github.com';

export class GitHubReadError extends Error {
  constructor(message, { status = null, permanent = false } = {}) {
    super(message);
    this.name = 'GitHubReadError';
    this.status = status;
    this.permanent = permanent;
  }
}

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return; }
  const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
  function onAbort() { clearTimeout(timer); reject(abortError()); }
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

// Read-only GitHub client for one repository. Retries network errors, 5xx
// responses and rate limits with exponential backoff and jitter, waits for a
// primary rate-limit reset up to maxRateLimitWaitMs, and never retries other
// 4xx responses. Error messages name the request path, never the token.
export function createGitHubReader({
  owner, repo, token, fetch, signal = null,
  maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 60000, maxRateLimitWaitMs = 15 * 60 * 1000,
  sleep = defaultSleep, random = Math.random, now = () => Date.now(), onRetry = () => {},
}) {
  const stats = { requests: 0, retries: 0, bytes: 0, rateLimitWaitMs: 0 };
  const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const backoff = (attempt) => Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) * (0.5 + random() / 2);
  const describe = (path) => String(path).split('?')[0];

  async function request(path, accept) {
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw abortError();
      let response;
      try {
        stats.requests += 1;
        response = await fetch(`${base}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw abortError();
        if (attempt >= maxAttempts) throw new GitHubReadError(`Network error for ${describe(path)} after ${attempt} attempts: ${String(error?.message || error).slice(0, 200)}`);
        const wait = backoff(attempt);
        stats.retries += 1;
        onRetry({ path: describe(path), attempt, reason: 'network error', waitMs: wait });
        await sleep(wait, signal);
        continue;
      }
      if (response.ok) return response;

      const text = await response.text().catch(() => '');
      let message = text;
      try { message = JSON.parse(text).message || text; } catch {}
      message = String(message).replace(/\s+/g, ' ').slice(0, 200);
      const status = response.status;
      const header = (name) => response.headers?.get?.(name) ?? null;
      const remaining = header('x-ratelimit-remaining');
      // Absent headers must not read as 0 (Number(null) === 0).
      const retryAfterHeader = header('retry-after');
      const retryAfter = retryAfterHeader == null || String(retryAfterHeader).trim() === '' ? NaN : Number(retryAfterHeader);
      const resetHeader = header('x-ratelimit-reset');
      const reset = resetHeader == null ? NaN : Number(resetHeader);

      // Primary rate limit used up: wait for the reset, if it is close enough.
      if ((status === 403 || status === 429) && remaining === '0') {
        const wait = Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now()) + 1000 : null;
        if (wait == null || wait > maxRateLimitWaitMs) {
          throw new GitHubReadError(`GitHub API rate limit reached for ${describe(path)}${wait != null ? `; it resets in ${Math.ceil((wait - 1000) / 60000)} min` : ''}. Run the audit again later.`, { status, permanent: true });
        }
        stats.retries += 1;
        stats.rateLimitWaitMs += wait;
        onRetry({ path: describe(path), attempt, reason: 'rate limit', waitMs: wait });
        await sleep(wait, signal);
        attempt -= 1; // waiting for a reset is not a failed attempt
        continue;
      }
      // Secondary rate limit, or 429 / 5xx: retry with Retry-After or backoff.
      const secondary = status === 429 || (status === 403 && /secondary rate limit|abuse/i.test(message));
      if (secondary || status >= 500) {
        if (attempt >= maxAttempts) {
          throw new GitHubReadError(`GitHub ${status} for ${describe(path)} after ${attempt} attempts: ${message || 'no message'}`, { status });
        }
        const wait = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1000, maxRateLimitWaitMs) : backoff(attempt);
        stats.retries += 1;
        if (secondary) stats.rateLimitWaitMs += wait;
        onRetry({ path: describe(path), attempt, reason: secondary ? 'secondary rate limit' : `HTTP ${status}`, waitMs: wait });
        await sleep(wait, signal);
        continue;
      }
      // Anything else (401, 403 without rate limiting, 404, 422, ...) is permanent.
      throw new GitHubReadError(`GitHub ${status} for ${describe(path)}: ${message || 'no message'}`, { status, permanent: true });
    }
  }

  return {
    stats,
    async json(path) {
      const response = await request(path, 'application/vnd.github+json');
      const text = await response.text();
      stats.bytes += text.length;
      return JSON.parse(text);
    },
    // The bytes of a blob, verified against its Git blob ID (so a truncated or
    // altered download is never hashed as if it were the archived file).
    // Raw media type: no base64 JSON, a third fewer bytes and less memory.
    async blob(sha) {
      for (let attempt = 1; ; attempt++) {
        const response = await request(`/git/blobs/${encodeURIComponent(sha)}`, 'application/vnd.github.raw+json');
        let bytes;
        const type = String(response.headers?.get?.('content-type') || '');
        if (/json/i.test(type)) {
          const body = JSON.parse(await response.text());
          if (body?.encoding !== 'base64' || typeof body.content !== 'string') {
            throw new GitHubReadError(`GitHub returned no readable content for blob ${sha}.`, { permanent: true });
          }
          bytes = Uint8Array.from(atob(body.content.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
        } else {
          bytes = new Uint8Array(await response.arrayBuffer());
        }
        stats.bytes += bytes.byteLength;
        if (await gitBlobSha(bytes) === String(sha).toLowerCase()) return bytes;
        if (attempt >= maxAttempts) {
          throw new GitHubReadError(`The bytes downloaded for blob ${sha} do not match its ID after ${attempt} attempts.`);
        }
        stats.retries += 1;
        onRetry({ path: `/git/blobs/${sha}`, attempt, reason: 'download did not match the blob ID', waitMs: backoff(attempt) });
        await sleep(backoff(attempt), signal);
      }
    },
  };
}

export async function gitBlobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const data = new Uint8Array(header.byteLength + bytes.byteLength);
  data.set(header, 0);
  data.set(bytes, header.byteLength);
  const digest = await globalThis.crypto.subtle.digest('SHA-1', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
