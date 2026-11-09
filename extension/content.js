(() => {
  const ASSET_DOWNLOAD_CONCURRENCY = 3;
  let currentAbortController = null;
  let syncing = false;
  // Oversized files the archive already recorded (conversation ID -> file
  // UUID -> { size, sha256 }), from the archive state of an "all" sync, and the
  // downloads of them that this sync skipped. See fetchAsset.
  let knownOversizedFiles = null;
  let oversizedStats = newOversizedStats();

  // Per-sync counts of downloads over the upload limit: only counts, byte
  // totals and reason codes, never names, IDs or contents.
  function newOversizedStats() {
    return { detected: 0, skipped: 0, skipped_bytes: 0, downloaded: 0, downloaded_bytes: 0, downloaded_reasons: {}, downloaded_routes: {} };
  }

  async function getOrg(signal) {
    const r = await fetch('/api/organizations', { credentials: 'include', signal });
    if (!r.ok) throw Error(`Claude organizations: ${r.status}`);
    const x = await r.json();
    if (!Array.isArray(x) || !x.length) throw Error('No Claude organization found. Make sure you are logged in.');
    return x[0].uuid;
  }

  // Claude's web app exposes an undocumented offset-based list endpoint.
  // Keep the page size at the observed 30-item default and verify the result
  // against count_all whenever that endpoint is available.
  const CONVERSATION_LIST_PAGE_SIZE = 30;
  const MAX_CONVERSATION_LIST_PAGES = 10000;

  async function conversationCount(org, signal) {
    const r = await fetch('/api/organizations/' + org + '/chat_conversations/count_all', {
      credentials: 'include',
      signal,
    });
    // Some Claude deployments may not expose count_all. In that case the list
    // is still paged until a short page is returned.
    if (r.status === 404 || r.status === 405 || r.status === 429) return null;
    if (!r.ok) throw Error('Claude conversation count: ' + r.status);

    let data;
    try {
      data = await r.json();
    } catch {
      throw new Error('Claude returned an unreadable conversation count. No archive changes were submitted to GitHub; retry the sync.');
    }
    if (!data || typeof data !== 'object' || !Number.isSafeInteger(data.count) || data.count < 0) {
      throw new Error('Claude returned an invalid conversation count. No archive changes were submitted to GitHub; retry the sync.');
    }
    return data.count;
  }

  async function list(org, signal) {
    const expectedBefore = await conversationCount(org, signal);
    const data = [];
    const seenIds = new Set();
    let offset = 0;
    let finished = false;

    for (let pageNumber = 0; pageNumber < MAX_CONVERSATION_LIST_PAGES; pageNumber++) {
      const url = '/api/organizations/' + org + '/chat_conversations?limit='
        + CONVERSATION_LIST_PAGE_SIZE + '&starred=false&offset=' + offset;
      const r = await fetch(url, { credentials: 'include', signal });
      if (!r.ok) throw Error('Claude conversations: ' + r.status);

      let page;
      try {
        page = await r.json();
      } catch {
        throw new Error('Claude returned an unreadable conversation list. No archive changes were submitted to GitHub; retry the sync.');
      }
      if (!Array.isArray(page)) {
        throw new Error('Claude returned an invalid conversation list (expected an array). No archive changes were submitted to GitHub; retry the sync.');
      }

      for (const conversation of page) {
        if (!conversation || typeof conversation !== 'object' || typeof conversation.uuid !== 'string' || !conversation.uuid.trim()) {
          throw new Error('Claude returned a conversation without a valid UUID. No archive changes were submitted to GitHub; retry the sync.');
        }
        if (seenIds.has(conversation.uuid)) {
          throw new Error('Claude returned duplicate conversation UUID "' + conversation.uuid + '" across pages. No archive changes were submitted to GitHub; retry the sync.');
        }
        seenIds.add(conversation.uuid);
        data.push(conversation);
        if (expectedBefore !== null && data.length > expectedBefore) {
          throw new Error('Claude returned more conversations than its count_all endpoint reported. No archive changes were submitted to GitHub; retry the sync.');
        }
      }

      offset += page.length;
      if (expectedBefore !== null) {
        if (data.length === expectedBefore) {
          finished = true;
          break;
        }
        // A short or empty page is not proof of completion when Claude's count
        // endpoint says there should still be more records.
        if (!page.length) {
          finished = true;
          break;
        }
      } else if (page.length < CONVERSATION_LIST_PAGE_SIZE) {
        finished = true;
        break;
      }
    }

    if (!finished) {
      throw new Error('Claude conversation pagination did not reach a verifiable end. No archive changes were submitted to GitHub; retry the sync.');
    }
    if (expectedBefore !== null && data.length !== expectedBefore) {
      throw new Error('Claude returned ' + data.length + ' of ' + expectedBefore + ' conversations reported by count_all. No archive changes were submitted to GitHub; retry the sync.');
    }

    const expectedAfter = expectedBefore === null ? null : await conversationCount(org, signal);
    if (expectedBefore !== null && expectedAfter !== null && expectedAfter !== expectedBefore) {
      throw new Error('Claude conversation count changed during pagination (' + expectedBefore + ' to ' + expectedAfter + '). No archive changes were submitted to GitHub; retry the sync.');
    }
    if (expectedAfter !== null && expectedAfter !== data.length) {
      throw new Error('Claude returned ' + data.length + ' conversations but count_all reported ' + expectedAfter + '. No archive changes were submitted to GitHub; retry the sync.');
    }

    return data;
  }

  async function full(org, id, signal) {
    const r = await fetch(`/api/organizations/${org}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`, { credentials: 'include', signal });
    if (!r.ok) throw Error(`Claude conversation ${id}: ${r.status}`);

    let data;
    try {
      data = await r.json();
    } catch {
      throw new Error(`Claude returned unreadable data for conversation "${id}". No archive changes were submitted to GitHub; retry the sync.`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Claude returned an invalid payload for conversation "${id}". No archive changes were submitted to GitHub; retry the sync.`);
    }
    if (typeof data.uuid !== 'string' || !data.uuid.trim()) {
      throw new Error(`Claude returned a conversation payload without a valid UUID for requested conversation "${id}". No archive changes were submitted to GitHub; retry the sync.`);
    }
    if (data.uuid !== id) {
      throw new Error(`Claude returned conversation "${data.uuid}" when "${id}" was requested. No archive changes were submitted to GitHub.`);
    }
    const messages = Array.isArray(data.chat_messages) ? data.chat_messages : data.messages;
    if (!Array.isArray(messages)) {
      throw new Error(`Claude returned conversation "${id}" without a valid messages array. No archive changes were submitted to GitHub; retry the sync.`);
    }
    return data;
  }

  function normalizeToolInput(input) {
    if (input == null) return null;
    if (typeof input === 'object') return input;
    if (typeof input === 'string') {
      try { return JSON.parse(input); } catch { return input; }
    }
    return String(input);
  }

  function fence(text, language = '') {
    const value = String(text ?? '');
    const longest = Math.max(2, ...value.match(/`+/g)?.map((x) => x.length) || [2]);
    const ticks = '`'.repeat(longest + 1);
    return `${ticks}${language}\n${value}\n${ticks}`;
  }

  // Closes a tool section that holds more than one fence; the web reader's
  // toolSections.js recognizes it, and GitHub hides it as an HTML comment.
  const TOOL_SECTION_END = '<!-- /tool -->';

  function renderToolUse(block) {
    const name = block.name || block.tool_name || 'tool';
    const input = normalizeToolInput(block.input);

    if (input && typeof input === 'object' && !Array.isArray(input)) {
      // The readable shortcut is lossless only when that field is the whole
      // input. Tools such as artifacts or the file editor use `command` for a
      // sub-command (create, str_replace) next to the content they write, so
      // anything richer falls through to the full JSON below.
      const fields = Object.keys(input).filter((key) => input[key] !== undefined && input[key] !== null);
      const only = fields.length === 1 ? fields[0] : null;
      if (['command', 'cmd', 'shell_command'].includes(only) && typeof input[only] === 'string') {
        return `### Claude tool: ${name}\n\n${fence(input[only], 'bash')}`;
      }
      if (only === 'code' && typeof input.code === 'string') return `### Claude tool: ${name}\n\n${fence(input.code, 'text')}`;

      // Multi-line text (artifact content, file contents, replacements) is
      // unreadable as an escaped JSON string. Give each such field its own
      // fence after the remaining metadata, and close the section with an
      // explicit marker so the web reader keeps every fence inside the tool.
      // Payload keys stay in the redacted JSON even when line-wrapped.
      const bodyKeys = fields.filter((key) => typeof input[key] === 'string'
        && input[key].includes('\n') && !/^(data|base64|bytes)$/i.test(key));
      if (bodyKeys.length) {
        const metadata = Object.fromEntries(Object.entries(input).filter(([key]) => !bodyKeys.includes(key)));
        const language = typeof input.language === 'string' && /^[\w+#.-]{1,32}$/.test(input.language)
          ? input.language
          : 'text';
        const parts = [`### Claude tool: ${name}`];
        if (Object.keys(metadata).length) parts.push(fence(stringifyContentBlock(metadata), 'json'));
        for (const key of bodyKeys) parts.push(`**${escapeReferenceLabel(key)}**`, fence(input[key], language));
        parts.push(TOOL_SECTION_END);
        return parts.join('\n\n');
      }
    }

    // Same redaction as tool results: never dump base64 payloads into Markdown.
    const serialized = typeof input === 'string' ? input : stringifyContentBlock(input ?? {});
    return `### Claude tool: ${name}\n\n${fence(serialized, 'json')}`;
  }

  // `archivedSources` holds base64 source objects whose bytes are archived
  // separately as message attachments, so the note can say where they went.
  function stringifyContentBlock(value, archivedSources = null) {
    try {
      // Claude may return the same JSON object with a different property order
      // between requests. Since this JSON is embedded in Markdown, ordinary
      // JSON.stringify() would then create a noisy archive diff. Sort object
      // keys recursively, but keep array order because it can be meaningful.
      // Shallow copies avoid duplicating large nested strings or payloads.
      // Keep a mapping to original holders so binary redaction still recognizes
      // the source objects collected by collectToolResultMedia().
      const originalBySortedObject = new WeakMap();
      return JSON.stringify(value, function (key, item) {
        const originalHolder = this && typeof this === 'object'
          ? (originalBySortedObject.get(this) || this)
          : this;

        // Avoid embedding base64 media data or other large inline payloads into
        // Markdown. Preserve metadata and make omitted data explicit.
        const base64Data = key === 'data' && originalHolder?.type === 'base64';
        if (typeof item === 'string' && /^(data|base64|bytes)$/i.test(key)
          && (item.length > 256 || base64Data)) {
          return archivedSources?.has(originalHolder)
            ? `[omitted inline payload: ${item.length} characters; archived as a message attachment]`
            : `[omitted inline payload: ${item.length} characters]`;
        }

        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const sorted = Object.create(null);
          for (const property of Object.keys(item).sort()) sorted[property] = item[property];
          originalBySortedObject.set(sorted, item);
          return sorted;
        }
        return item;
      }, 2);
    } catch {
      return String(value);
    }
  }

  // Base64 media inside a tool result (screenshots, generated charts) stays
  // redacted in the fenced result but is archived as an attachment of the
  // message. Payloads that do not decode keep the plain redaction note.
  function collectToolResultMedia(value, inline, archivedSources) {
    if (Array.isArray(value)) {
      for (const item of value) collectToolResultMedia(item, inline, archivedSources);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.source?.type === 'base64' && typeof value.source.data === 'string') {
      try {
        base64ToBytes(value.source.data);
        inline.attachments.push(value);
        archivedSources.add(value.source);
      } catch {
        // Leave it redacted; a malformed tool payload must not stop the sync.
      }
    }
    if (Array.isArray(value.content)) collectToolResultMedia(value.content, inline, archivedSources);
  }

  function renderToolResult(block, inline) {
    const parts = Array.isArray(block.content) ? block.content : [block.content];
    const archivedSources = new Set();
    const text = parts.map((x) => {
      if (typeof x === 'string') return x;
      if (x?.type === 'text' && typeof x.text === 'string') return x.text;
      if (typeof x?.text === 'string') return x.text;
      if (x && typeof x === 'object') {
        collectToolResultMedia(x, inline, archivedSources);
        return stringifyContentBlock(x, archivedSources);
      }
      return '';
    }).filter(Boolean).join('\n');
    if (!text) return '';
    const name = block.name || block.tool_name || 'tool';
    return `### Tool result: ${name}${block.is_error ? ' (error)' : ''}\n\n${fence(text, 'text')}`;
  }

  function escapeReferenceLabel(value) {
    return String(value || 'Open reference')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\\/g, '\\\\')
      .replace(/\r?\n/g, ' ')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/([*_!])/g, '\\$1')
      .replace(/\x60/g, '\\\x60')
      .trim() || 'Open reference';
  }

  function renderUnknownContentBlock(block) {
    const type = String(typeof block.type === 'string' && block.type.trim() ? block.type : 'unknown')
      .replace(/[\r\n]+/g, ' ')
      .replace(/#/g, '\\#')
      .trim() || 'unknown';
    const serialized = stringifyContentBlock(block);
    const candidateUrl = typeof block.url === 'string' ? block.url
      : (typeof block.href === 'string' ? block.href
        : (typeof block.source?.url === 'string' ? block.source.url : null));
    // Only make explicit HTTP(S) URLs clickable. Other schemes remain visible
    // as inert metadata; whitespace and angle brackets are rejected so the
    // destination cannot break out of Markdown's angle-bracket URL form.
    const safeUrl = candidateUrl && /^https?:\/\/[^\s<>]+$/i.test(candidateUrl) ? candidateUrl : null;
    if (!safeUrl) {
      return `### Claude content block: ${type}\n\n${fence(serialized || '{}', 'json')}`;
    }

    const label = escapeReferenceLabel(block.title || block.label || block.name || block.text || 'Open reference');
    const citedText = block.cited_text || block.quote || block.snippet || block.description || null;
    const reference = `### Reference: [${label}](<${safeUrl}>)`;
    const excerpt = typeof citedText === 'string' && citedText.trim()
      ? `\n\n> ${citedText.trim().replace(/\r?\n/g, '\n> ')}`
      : '';
    // Keep provider-specific IDs and offsets in the original serialized block.
    return `${reference}${excerpt}\n\n${fence(serialized || '{}', 'json')}`;
  }

  // Text blocks can carry structured citations (Anthropic API locations with
  // url/title/cited_text, or claude.ai entries whose URL lives in `details`).
  // Rendering only `text` used to drop every source, so list each distinct
  // human-meaningful source after the text. Offsets and opaque indexes are
  // omitted because they mean nothing outside Claude's own UI.
  function renderTextBlockCitations(citations) {
    if (!Array.isArray(citations)) return '';
    const sources = new Map();
    for (const citation of citations) {
      if (!citation || typeof citation !== 'object') continue;
      const details = citation.details && typeof citation.details === 'object' ? citation.details : {};
      const pick = (...keys) => {
        for (const key of keys) {
          for (const value of [citation[key], details[key]]) {
            if (typeof value === 'string' && value.trim()) return value.trim();
          }
        }
        return null;
      };
      const url = pick('url', 'href');
      const title = pick('title', 'document_title', 'source');
      const citedText = pick('cited_text', 'quote');
      if (!url && !title && !citedText) continue;

      const key = `${url || ''}|${url ? '' : (title || '')}`;
      let source = sources.get(key);
      if (!source) {
        source = { url, title, quotes: [] };
        sources.set(key, source);
      }
      if (!source.title && title) source.title = title;
      if (citedText && !source.quotes.includes(citedText)) source.quotes.push(citedText);
    }
    if (!sources.size) return '';

    const lines = [...sources.values()].map(({ url, title, quotes }) => {
      // Same rule as renderUnknownContentBlock: only HTTP(S) URLs are clickable.
      const safeUrl = url && /^https?:\/\/[^\s<>]+$/i.test(url) ? url : null;
      let line;
      if (safeUrl) line = `- [${escapeReferenceLabel(title || safeUrl)}](<${safeUrl}>)`;
      else if (url) line = `- ${escapeReferenceLabel(title || 'Source')} — ${escapeReferenceLabel(url)}`;
      else line = `- ${escapeReferenceLabel(title || 'Quoted source')}`;
      return [line, ...quotes.map((quote) => `  > ${escapeReferenceLabel(quote)}`)].join('\n');
    });
    return `Sources:\n${lines.join('\n')}`;
  }

  // A random per-conversation nonce generated after the Claude payload was
  // fetched, so no message text, tool output, or citation can contain a
  // marker that the Markdown renderer would mistake for an inline image.
  function createInlineMarkerNonce() {
    return [...crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  // `inline.blocks` receives each inline base64 block (images, audio, video,
  // documents) in the order its marker is emitted, so a marker's index is by
  // construction its position in the list that collectMessageAssets
  // materializes. A separate traversal would drift whenever the two disagree
  // about which nested content is rendered.
  function renderContentBlocks(blocks, inline = { nonce: createInlineMarkerNonce(), blocks: [], attachments: [] }) {
    if (!Array.isArray(blocks)) return '';
    return blocks.map((block) => {
      if (!block) return '';
      // Do not leak private reasoning even if a variant happens to expose a
      // generic text/content property as well as the usual thinking field.
      if (block.type === 'thinking') return '';
      if (block.type === 'text') {
        return [block.text || '', renderTextBlockCitations(block.citations)].filter(Boolean).join('\n\n');
      }
      if (block.type === 'tool_use') return renderToolUse(block);
      if (block.type === 'tool_result') return renderToolResult(block, inline);
      // Any block carrying its bytes as a base64 source is archived as a file
      // and replaced by a marker, so payloads never enter the Markdown.
      if (block.source?.type === 'base64' && typeof block.source.data === 'string') {
        inline.blocks.push(block);
        return `[[AI_ARCHIVE_INLINE_ASSET:${inline.nonce}:${inline.blocks.length - 1}]]`;
      }
      // Preserve common plain-text shapes directly for readability. A block
      // may carry both a text field and nested content (for example a
      // document with embedded images); render both rather than dropping
      // the nested blocks.
      if (typeof block.text === 'string') {
        const nested = Array.isArray(block.content) ? renderContentBlocks(block.content, inline) : '';
        return [block.text, nested].filter(Boolean).join('\n\n');
      }
      if (typeof block.content === 'string') return block.content;
      if (Array.isArray(block.content)) return renderContentBlocks(block.content, inline);
      // Unknown/non-text blocks used to disappear silently. Preserve their type
      // and metadata so citations, media markers, and future block types remain
      // visible to the reader rather than making the transcript look complete.
      return renderUnknownContentBlock(block);
    }).filter(Boolean).join('\n\n');
  }

  function safeAssetName(name, fallback = 'file') {
    const value = String(name || fallback)
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 120);
    return value || fallback;
  }

  function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const normalized = String(value || '').replace(/\s+/g, '');
    let binary;
    try {
      binary = atob(normalized);
    } catch {
      throw new Error('Claude returned an invalid base64 inline content block.');
    }
    if (!binary.length) throw new Error('Claude returned an empty base64 inline content block.');
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  async function sha256Bytes(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Run only a small number of network tasks at once. Results stay in input
  // order, and after the first failure no new tasks are scheduled; workers
  // already in flight are allowed to settle before the error is propagated.
  async function mapWithConcurrency(items, concurrency, mapper, signal) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let firstError = null;

    async function worker() {
      while (!firstError) {
        if (signal?.aborted) {
          firstError = new DOMException('Sync cancelled', 'AbortError');
          return;
        }

        const index = nextIndex++;
        if (index >= items.length) return;

        try {
          results[index] = await mapper(items[index], index);
        } catch (error) {
          if (!firstError) firstError = error;
          return;
        }
      }
    }

    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (firstError) throw firstError;
    if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
    return results;
  }

  // The largest file GitHub's API is asked to take: a blob request of 40 MiB
  // of JSON holds base64 for about 30 MiB. Must match MAX_ARCHIVED_FILE_BYTES
  // in background.js. Larger files are never base64-encoded or transferred;
  // the background records them as not archived, with their name and size.
  const MAX_BLOB_REQUEST_BYTES = 40 * 1024 * 1024;
  const MAX_ARCHIVED_FILE_BYTES = Math.floor((MAX_BLOB_REQUEST_BYTES - 64) / 4) * 3;

  // Do not duplicate raw binary data in message metadata. The rendered message
  // and the separately materialized asset already preserve the user-visible
  // content; background asset matching only needs paths, names and tool inputs.
  //
  // Binary payloads are recognized by their field name (data/base64/bytes, as
  // Anthropic sources use), by a data: URL anywhere in a string, or by shape:
  // a long run made only of base64 characters (no spaces, dots or other
  // punctuation that text, paths and file names contain) wherever it is
  // nested, since Claude tools and MCP servers use many field names for it.
  const BINARY_KEY = /^(data|base64|bytes)$/i;
  const LONG_BASE64_CHARS = 4096;
  const EMBEDDED_DATA_URL = /data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,[A-Za-z0-9+/=\r\n]{256,}/gi;

  function looksLikeBase64Payload(value) {
    if (value.length < LONG_BASE64_CHARS) return false;
    // Only the first characters are scanned for speed; a payload must also
    // end like one. Text that merely starts with a long token is kept.
    const head = value.slice(0, LONG_BASE64_CHARS);
    const tail = value.slice(-256);
    return /^[A-Za-z0-9+/_-]+$/.test(head.replace(/\r?\n/g, '')) && /^[A-Za-z0-9+/_=\r\n-]+$/.test(tail);
  }

  function redactBinaryString(value, key = '') {
    if (BINARY_KEY.test(key) && value.length > 256) {
      return `[omitted binary payload: ${value.length} characters]`;
    }
    if (/^data:[^,]+;base64,/i.test(value)) {
      return `[omitted inline binary payload: ${value.length} characters]`;
    }
    if (looksLikeBase64Payload(value)) {
      return `[omitted binary payload: ${value.length} characters]`;
    }
    if (value.length > 256 && /;base64,/i.test(value)) {
      return value.replace(EMBEDDED_DATA_URL, (match) => `[omitted inline binary payload: ${match.length} characters]`);
    }
    return value;
  }

  function metadataForAssetMatching(value, key = '', seen = new WeakSet()) {
    if (typeof value === 'string') return redactBinaryString(value, key);
    if (!value || typeof value !== 'object') return value;
    // JSON from Claude has no cycles; this only keeps a malformed object
    // graph from recursing forever.
    if (seen.has(value)) return '[omitted repeated reference]';
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => metadataForAssetMatching(item, key, seen));
      return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
        childKey,
        metadataForAssetMatching(child, childKey, seen),
      ]));
    } finally {
      seen.delete(value);
    }
  }

  // Every string in a value, without building one serialized copy of it.
  function someString(value, predicate, seen = new WeakSet()) {
    if (typeof value === 'string') return predicate(value);
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      if (someString(child, predicate, seen)) return true;
    }
    return false;
  }

  // Lower-cased text used to find sandbox paths and file names a message
  // mentions. Built once per message from its binary-free form, so inline
  // base64 images are neither serialized again nor searched for each file.
  const messageHaystacks = new WeakMap();
  function messageHaystack(message) {
    if (!message || typeof message !== 'object') return '';
    let haystack = messageHaystacks.get(message);
    if (haystack === undefined) {
      haystack = JSON.stringify(metadataForAssetMatching(message)).toLowerCase();
      messageHaystacks.set(message, haystack);
    }
    return haystack;
  }

  // Oversized assets are represented by metadata and a "Not archived" note in
  // the GitHub worker; their base64 bytes are never built or transferred.
  function archivedAssetBase64(buffer) {
    return buffer.byteLength > MAX_ARCHIVED_FILE_BYTES ? '' : bytesToBase64(buffer);
  }

  // The archive's record of an oversized file of this conversation, by the
  // file's Claude UUID, or null.
  function knownOversizedFile(conversationId, fileUuid) {
    if (!knownOversizedFiles || !conversationId || !fileUuid) return null;
    return knownOversizedFiles.get(String(conversationId))?.get(String(fileUuid)) || null;
  }

  // A file the archive already recorded as over the upload limit (its UUID,
  // exact size and SHA-256, from an earlier full download) is not downloaded
  // again only when this response proves it is still exactly that size before
  // its body is read: HTTP 200, no content or transfer coding that would make
  // Content-Length differ from the file size, no range, an exact decimal
  // Content-Length equal to the recorded size, and no other size Claude
  // declares that disagrees. Anything missing or ambiguous means a normal
  // download. The file is still left out of the archive either way.
  //
  // Returns null when the download may be skipped, otherwise why not:
  //   no-archive-state  no archive state for this sync (Latest N, or unreadable)
  //   no-file-id        the file has no Claude file UUID to match a record by
  //   ambiguous-file-id several different file UUIDs name this sandbox path
  //   not-recorded      the archive has no oversized record for this file yet
  //   size-unconfirmed  the response does not state the size unambiguously
  //   size-changed      the stated size differs from the recorded one
  function oversizedSkipBlocker(response, known, declaredSize, { hasFileId, fileIdAmbiguous }) {
    if (!knownOversizedFiles) return 'no-archive-state';
    if (fileIdAmbiguous) return 'ambiguous-file-id';
    if (!hasFileId) return 'no-file-id';
    if (!known || !(known.size > MAX_ARCHIVED_FILE_BYTES)) return 'not-recorded';
    const header = (name) => response.headers?.get?.(name) ?? null;
    const encoding = String(header('content-encoding') ?? 'identity').trim().toLowerCase();
    const length = String(header('content-length') ?? '').trim();
    if (response.status !== 200 || encoding !== 'identity' || header('content-range') != null || !/^\d{1,16}$/.test(length)) {
      return 'size-unconfirmed';
    }
    if (Number(length) !== known.size || (declaredSize != null && Number(declaredSize) !== known.size)) return 'size-changed';
    return null;
  }

  // `route` names the download path for the counters only: message-url,
  // files-api, sandbox-path or sandbox-list.
  async function fetchAsset(url, name, mime, signal, { conversationId = null, fileUuid = null, fileIdAmbiguous = false, declaredSize = null, route = 'message-url' } = {}) {
    const known = knownOversizedFile(conversationId, fileUuid);
    const label = safeAssetName(name);
    if (!url) {
      throw new Error(`Cannot download attachment "${label}": no download URL was provided.`);
    }
    try {
      const r = await fetch(url, { credentials: 'include', signal });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      const blocker = oversizedSkipBlocker(r, known, declaredSize, { hasFileId: Boolean(conversationId && fileUuid), fileIdAmbiguous });
      if (!blocker) {
        try { await r.body?.cancel?.(); } catch {}
        oversizedStats.detected += 1;
        oversizedStats.skipped += 1;
        // The recorded size; a few kilobytes may still arrive before the cancel.
        oversizedStats.skipped_bytes += known.size;
        // The same identity as the earlier full download, still with no bytes:
        // it is noted as not archived exactly as before.
        return {
          name: label,
          mime: mime || r.headers.get('content-type') || 'application/octet-stream',
          base64: '',
          size: known.size,
          sha256: known.sha256,
        };
      }
      const buffer = await r.arrayBuffer();
      if (!buffer.byteLength) throw new Error('the download returned an empty file');
      if (buffer.byteLength > MAX_ARCHIVED_FILE_BYTES) {
        oversizedStats.detected += 1;
        oversizedStats.downloaded += 1;
        oversizedStats.downloaded_bytes += buffer.byteLength;
        oversizedStats.downloaded_reasons[blocker] = (oversizedStats.downloaded_reasons[blocker] || 0) + 1;
        oversizedStats.downloaded_routes[route] = (oversizedStats.downloaded_routes[route] || 0) + 1;
      }
      return {
        name: label,
        mime: mime || r.headers.get('content-type') || 'application/octet-stream',
        base64: archivedAssetBase64(buffer),
        size: buffer.byteLength,
        sha256: await sha256Bytes(buffer),
      };
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw Object.assign(new Error(`Failed to download attachment "${label}": ${e?.message || 'network error'}.`), { status: e?.status, category: 'download-failed' });
    }
  }

  // A download Claude answers with 404/410 is gone, not temporarily failing:
  // retrying cannot recover it. Such a file is archived as a visible "not
  // archived" note (and the conversation marked incomplete) instead of
  // keeping the whole conversation out of the archive. Any other failure
  // (network, 5xx, 403, 429) skips the conversation so a later sync retries it.
  // A size Claude states for a file (several key names are seen), or null.
  function declaredFileSize(file) {
    for (const key of ['size_bytes', 'file_size', 'size']) {
      if (Number.isSafeInteger(file?.[key]) && file[key] >= 0) return file[key];
    }
    return null;
  }

  const UNAVAILABLE_STATUSES = new Set([404, 410]);
  const isUnavailable = (error) => UNAVAILABLE_STATUSES.has(error?.status);

  // Claude gives some uploads only as a sandbox path ("file_kind": "blob",
  // "path": "/mnt/user-data/uploads/…", no URL; seen on a real account). The
  // sandbox file list and download endpoint may use the path with or without
  // the "/mnt/user-data/" prefix, so paths are compared in both forms.
  const SANDBOX_ROOT = /^\/?mnt\/user-data\//i;
  const sandboxRelativePath = (path) => String(path || '').replace(/\\/g, '/').replace(SANDBOX_ROOT, '').replace(/^\/+/, '').toLowerCase();
  function sandboxPathForms(path) {
    const value = String(path || '').trim();
    if (!value) return [];
    return [...new Set([value, value.replace(SANDBOX_ROOT, '').replace(/^\/+/, '')])].filter(Boolean);
  }

  // Signs that Claude's tools may have written files into the conversation's
  // sandbox: a file-oriented tool call or a sandbox path in the active lineage.
  function mayHaveSandboxFiles(messages) {
    for (const message of messages) {
      for (const block of (Array.isArray(message?.content) ? message.content : [])) {
        if (block?.type === 'tool_use' && /file|bash|str_replace|present/i.test(String(block.name || ''))) return true;
      }
    }
    // Checked string by string: serializing the whole lineage would copy every
    // inline base64 image of the conversation into one (possibly enormous)
    // string just to search it.
    return someString(messages, (value) => /\/mnt\/(?:user-data|data)\//.test(value));
  }

  function sandboxFileIsReferenced(file, messages, allFiles, directAssets = []) {
    const sourcePath = String(file?.path || '').replace(/\\/g, '/').toLowerCase();
    if (!sourcePath) return false;
    const basename = sourcePath.split('/').pop();
    const sameNameCount = allFiles.filter((other) => {
      const otherPath = String(other?.path || '').replace(/\\/g, '/').toLowerCase();
      return otherPath && otherPath.split('/').pop() === basename;
    }).length;

    return messages.some((message) => {
      const serialized = messageHaystack(message || {});
      // A full path is unambiguous even when two files share a basename.
      if (serialized.includes(sourcePath)) return true;
      // Basename fallback is safe only when it uniquely identifies one sandbox file.
      if (sameNameCount !== 1 || basename.length <= 1 || !serialized.includes(basename)) return false;

      // If a directly downloaded message attachment has the same name, a
      // basename mention may refer to that attachment instead of this sandbox
      // file, so it is not archived on the name alone...
      const collisions = directAssets.filter(({ asset }) => String(asset?.name || '').toLowerCase() === basename);
      if (!collisions.length) return true;
      // ...except the original of that very upload: Claude keeps a user's
      // upload in the sandbox's uploads folder under its file name, while the
      // message file can be a preview (a pasted image is served as WebP under
      // the .png name). A name is not an identity, so the original is
      // downloaded too; a copy with the same name and the same bytes is then
      // dropped by content in collectMessageAssets, so identical files are
      // still stored once.
      return /^uploads\//.test(sandboxRelativePath(file?.path))
        && collisions.some(({ message: owner }) => owner?.sender === 'human');
    });
  }

  // Returns { assets, listStatus }. Claude answers the file list with 404 for a
  // conversation that has no sandbox (observed on a real account: the same
  // endpoint succeeds for other conversations of the same organization), so
  // 404 is an empty list here; the caller decides whether files may be missing.
  async function fetchSandboxFiles(org, conversationId, messages, directAssets, signal, incomplete = [], sandboxInfo = {}) {
    const endpoint = `/api/organizations/${org}/conversations/${conversationId}/wiggle/list-files`;
    let r;
    try {
      r = await fetch(endpoint, { credentials: 'include', signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw Object.assign(new Error(`Could not list Claude sandbox files for conversation "${conversationId}": ${e?.message || 'network error'}.`), { category: 'download-failed' });
    }
    sandboxInfo.sandbox_list_status = r.status;
    if (!r.ok) {
      // The shape of Claude's error body (for diagnostics; never its text).
      try { sandboxInfo.sandbox_list_body = sanitizeShape(await r.json()); } catch {}
    }
    if (r.status === 404) return { assets: [], listStatus: 404 };
    if (!r.ok) {
      throw Object.assign(new Error(`Could not list Claude sandbox files for conversation "${conversationId}" (HTTP ${r.status}).`), { category: 'download-failed' });
    }

    let data;
    try {
      data = await r.json();
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new Error(`Claude returned an unreadable sandbox file list for conversation "${conversationId}".`);
    }
    if (!Array.isArray(data?.files_metadata)) {
      throw new Error(`Claude returned an invalid sandbox file list for conversation "${conversationId}".`);
    }

    sandboxInfo.sandbox_list_count = data.files_metadata.length;
    sandboxInfo.sandbox_list_files = sanitizeShape(data.files_metadata);
    for (const file of data.files_metadata) {
      if (!file?.path) {
        throw new Error(`Claude returned sandbox file metadata without a path for conversation "${conversationId}".`);
      }
    }

    // The sandbox is conversation-wide and can contain outputs left by abandoned
    // Claude branches. Only download files explicitly referenced by the active
    // lineage; never archive unrelated files merely because they remain in the sandbox.
    const activeFiles = data.files_metadata.filter((file) =>
      sandboxFileIsReferenced(file, messages, data.files_metadata, directAssets)
    );

    const downloaded = await mapWithConcurrency(
      activeFiles,
      ASSET_DOWNLOAD_CONCURRENCY,
      async (file) => {
        const url = `/api/organizations/${org}/conversations/${conversationId}/wiggle/download-file?path=${encodeURIComponent(file.path)}`;
        let asset;
        try {
          const identity = sandboxFileIdentity(file.path, messages);
          asset = await fetchAsset(url, file.path.split('/').pop() || file.path, file.content_type, signal, {
            conversationId,
            fileUuid: identity.fileUuid,
            fileIdAmbiguous: identity.ambiguous,
            declaredSize: declaredFileSize(file),
            route: 'sandbox-list',
          });
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          if (isUnavailable(e)) {
            incomplete.push({ kind: 'sandbox-file', name: file.path, reason: `Claude returned HTTP ${e.status} for this file's download` });
            return null;
          }
          throw Object.assign(new Error(`Failed to download sandbox file "${file.path}": ${e?.message || 'download error'}`), { category: 'download-failed' });
        }
        return { ...asset, source_path: file.path, source: 'sandbox' };
      },
      signal,
    );
    return { assets: downloaded.filter(Boolean), listStatus: r.status };
  }

  // The Claude file UUID of a listed sandbox file, taken before it is
  // downloaded from the same place the archive records it from afterwards
  // (collectMessageAssets links a sandbox file to the message file entry whose
  // `path` is exactly its path): the active lineage's `files` entries naming
  // this exact path, in either path form. Never a file name. Only one distinct
  // UUID counts; several are ambiguous and none is no identity.
  function sandboxFileIdentity(path, messages) {
    const target = sandboxRelativePath(path);
    if (!target) return { fileUuid: null, ambiguous: false };
    const uuids = new Set();
    for (const message of Array.isArray(messages) ? messages : []) {
      for (const entry of Array.isArray(message?.files) ? message.files : []) {
        if (!entry?.path || sandboxRelativePath(entry.path) !== target) continue;
        const id = entry.file_uuid || entry.uuid;
        if (typeof id === 'string' && id) uuids.add(id);
      }
    }
    return uuids.size === 1 ? { fileUuid: [...uuids][0], ambiguous: false } : { fileUuid: null, ambiguous: uuids.size > 1 };
  }

  function isReplyExcerptAttachment(file) {
    const name = String(file?.file_name || file?.name || '').trim().toLowerCase();
    return name === 'excerpt_from_previous_claude_message.txt' || name.startsWith('excerpt_from_previous_claude_message.');
  }

  async function collectMessageAssets(org, conversationId, messages, signal, inlineByMessage = new Map(), incomplete = [], sandboxInfo = {}, sandboxSupported = true) {
    const assets = [];
    const seen = new Set();
    const messageAssetFingerprints = new Set();
    const messageScopedFingerprints = new WeakMap();
    const messageScopedHashes = new WeakMap();
    const hashesForMessage = (message) => {
      let hashes = messageScopedHashes.get(message);
      if (!hashes) {
        hashes = new Set();
        messageScopedHashes.set(message, hashes);
      }
      return hashes;
    };
    const fingerprintsForMessage = (message) => {
      let fingerprints = messageScopedFingerprints.get(message);
      if (!fingerprints) {
        fingerprints = new Set();
        messageScopedFingerprints.set(message, fingerprints);
      }
      return fingerprints;
    };

    // Collect and deduplicate tasks before starting downloads, then process
    // them with a small concurrency limit while preserving message/file order.
    const directTasks = [];
    const directTasksByKey = new Map();
    const filesWithoutDownloadUrl = [];
    for (const message of messages) {
      for (const file of (Array.isArray(message.files) ? message.files : [])) {
        const name = file.file_name || file.name || `file-${file.file_uuid || file.uuid || directTasks.length + 1}`;
        const url = file?.preview_asset?.url || file?.preview_url || file?.document_asset?.url;
        if (!url) {
          filesWithoutDownloadUrl.push({ message, file, name });
          continue;
        }
        const fileId = file.file_uuid || file.uuid || null;
        const identity = fileId ? `id:${fileId}` : `name:${name}`;
        const key = `${identity}|${url}`;
        const messageId = message.uuid || message.id || null;
        const existingTask = directTasksByKey.get(key);
        if (existingTask) {
          if (messageId && !existingTask.messageExternalIds.includes(messageId)) {
            existingTask.messageExternalIds.push(messageId);
          }
          if (!existingTask.messageReferences.includes(message)) {
            existingTask.messageReferences.push(message);
          }
          continue;
        }

        const task = {
          message,
          file,
          url,
          name,
          messageExternalIds: messageId ? [messageId] : [],
          messageReferences: [message],
        };
        directTasksByKey.set(key, task);
        directTasks.push(task);
      }
    }

    const directAssets = await mapWithConcurrency(
      directTasks,
      ASSET_DOWNLOAD_CONCURRENCY,
      async ({ message, file, url, name, messageExternalIds, messageReferences }) => {
        try {
          const asset = await fetchAsset(url, name, file.mime_type || file.content_type || file.file_type, signal, {
            conversationId, fileUuid: file.file_uuid || file.uuid || null,
            declaredSize: declaredFileSize(file),
          });
          return { asset, message, file, messageExternalIds, messageReferences };
        } catch (e) {
          if (!isUnavailable(e)) throw e;
          // Handled like a file without a URL: the sandbox may still hold it.
          for (const referenced of messageReferences) {
            filesWithoutDownloadUrl.push({ message: referenced, file, name, reason: `Claude returned HTTP ${e.status} for its download` });
          }
          return null;
        }
      },
      signal,
    );

    for (const { asset, message, file, messageExternalIds, messageReferences } of directAssets.filter(Boolean)) {
      const messageId = message.uuid || message.id || null;
      const linkedMessageIds = messageExternalIds.length
        ? messageExternalIds
        : (messageId ? [messageId] : []);
      assets.push({
        ...asset,
        source: 'message',
        file_uuid: file.file_uuid || file.uuid || null,
        message_external_id: messageId,
        ...(linkedMessageIds.length ? { message_external_ids: linkedMessageIds } : {}),
      });
      const nameKey = String(asset.name || '').toLowerCase();
      const fingerprint = `${nameKey}|${asset.sha256}`;
      messageAssetFingerprints.add(fingerprint);
      // The shared download is associated with every source message, so also
      // deduplicate its extracted-content representation independently for each.
      for (const referencedMessage of messageReferences) {
        fingerprintsForMessage(referencedMessage).add(fingerprint);
        hashesForMessage(referencedMessage).add(asset.sha256);
      }
    }

    // Upgraded Claude workspaces no longer expose the legacy Wiggle sandbox.
    // Their file outputs are represented by message-level Files API metadata;
    // querying /wiggle/list-files for them returns a misleading 404 and marks
    // otherwise successfully exported conversations as incomplete. Keep the
    // legacy sandbox path for conversations that still advertise Wiggle.
    const { assets: sandbox, listStatus } = sandboxSupported
      ? await fetchSandboxFiles(org, conversationId, messages, directAssets.filter(Boolean), signal, incomplete, sandboxInfo)
      : { assets: [], listStatus: null };
    if (sandboxSupported && listStatus === 404 && mayHaveSandboxFiles(messages)) {
      incomplete.push({ kind: "sandbox", reason: "Claude returned HTTP 404 for this conversation's file list, so files created by Claude's tools may be missing" });
    }
    for (const asset of sandbox) {
      const key = `${asset.source_path}|${asset.sha256}`;
      const nameKey = String(asset.name || '').toLowerCase();
      if (seen.has(key)) continue;

      // A name is not a unique file identity: Claude can produce the same
      // basename in different folders with different contents. Deduplicate a
      // sandbox copy only when a message asset already has both the same name
      // and the same content hash.
      if (nameKey && messageAssetFingerprints.has(`${nameKey}|${asset.sha256}`)) continue;

      seen.add(key);
      assets.push(asset);
    }

    // Some document uploads are represented only as attachments[].extracted_content.
    // Preserve those as downloadable text files instead of dumping their contents
    // into the conversation. Reply excerpts are intentionally NOT materialized: they
    // are displayed inline as quoted context immediately before the user's message.
    for (const message of messages) {
      for (const attachment of (Array.isArray(message.attachments) ? message.attachments : [])) {
        if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
        if (!attachment?.extracted_content || isReplyExcerptAttachment(attachment)) continue;
        const name = String(attachment.file_name || attachment.name || 'attachment.txt');
        const nameKey = name.toLowerCase();
        const text = String(attachment.extracted_content);
        const buffer = new TextEncoder().encode(text).buffer;
        const hash = await sha256Bytes(buffer);
        if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
        const messageId = message.uuid || message.id || null;
        const fingerprint = `${nameKey}|${hash}`;
        const scopedFingerprints = fingerprintsForMessage(message);

        // The same extracted file can be exposed both as a real message asset
        // and as extracted text. Deduplicate only within the same message and
        // only when the bytes match; filenames alone are not unique identities.
        if (scopedFingerprints.has(fingerprint)) continue;

        assets.push({
          name,
          mime: attachment.file_type || 'text/plain',
          base64: archivedAssetBase64(buffer),
          size: buffer.byteLength,
          sha256: hash,
          source: 'attachment-extracted',
          attachment_name: name,
          message_external_id: messageId,
        });
        scopedFingerprints.add(fingerprint);
        hashesForMessage(message).add(hash);
      }
    }

    // Inline base64 blocks are sometimes present in Claude's message content
    // without a corresponding message.files entry. Materialize those bytes as
    // normal assets so the Markdown renderer can embed images and link the rest.
    const inlineExtensions = {
      'image/avif': 'avif',
      'image/bmp': 'bmp',
      'image/gif': 'gif',
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/svg+xml': 'svg',
      'image/webp': 'webp',
      'audio/aac': 'aac',
      'audio/flac': 'flac',
      'audio/mp4': 'm4a',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'audio/webm': 'webm',
      'video/mp4': 'mp4',
      'video/ogg': 'ogv',
      'video/quicktime': 'mov',
      'video/webm': 'webm',
      'application/pdf': 'pdf',
    };
    for (const message of messages) {
      // Exactly the blocks renderContentBlocks emitted markers for, in marker
      // order, followed by tool-result media archived as plain attachments
      // (index null: no marker, no inline position). Media inside tool input
      // or thinking blocks is redacted or omitted and is not collected.
      const inline = inlineByMessage.get(message) || { blocks: [], attachments: [] };
      const entries = [
        ...inline.blocks.map((block, index) => ({ block, index })),
        ...inline.attachments.map((block) => ({ block, index: null })),
      ];
      for (const { block, index } of entries) {
        if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
        const source = block.source;
        const bytes = base64ToBytes(source.data);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const hash = await sha256Bytes(buffer);
        if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
        const hashes = hashesForMessage(message);
        const messageId = message.uuid || message.id || null;
        const existingAsset = assets.find((asset) => {
          if (asset.sha256 !== hash) return false;
          const associatedIds = Array.isArray(asset.message_external_ids) && asset.message_external_ids.length
            ? asset.message_external_ids
            : (asset.message_external_id ? [asset.message_external_id] : []);
          return messageId && associatedIds.includes(messageId);
        });
        // Marker indices restart in every message, and an asset can be shared
        // by several messages, so record which message each position belongs to.
        const addPosition = (asset) => {
          if (index === null) return;
          const positions = Array.isArray(asset.inline_positions) ? asset.inline_positions : [];
          if (!positions.some((position) => position.message_external_id === messageId && position.index === index)) {
            asset.inline_positions = [...positions, { message_external_id: messageId, index }];
          }
        };
        if (hashes.has(hash)) {
          if (existingAsset) addPosition(existingAsset);
          continue;
        }

        // The same inline bytes already archived for another message: link this
        // message to that file instead of storing a second copy.
        const sharedInline = messageId && assets.find((asset) =>
          (asset.source === 'message-content' || asset.source === 'tool-result') && asset.sha256 === hash);
        if (sharedInline) {
          const linkedIds = Array.isArray(sharedInline.message_external_ids) && sharedInline.message_external_ids.length
            ? sharedInline.message_external_ids
            : [sharedInline.message_external_id];
          sharedInline.message_external_ids = [...linkedIds, messageId];
          addPosition(sharedInline);
          hashes.add(hash);
          continue;
        }

        const sourceMime = typeof source.media_type === 'string'
          ? source.media_type.toLowerCase().split(';')[0].trim()
          : '';
        // Image blocks keep their historical PNG fallback and names, so
        // already-archived inline images keep the same asset paths.
        const mime = block.type === 'image'
          ? (sourceMime.startsWith('image/') ? sourceMime : 'image/png')
          : (sourceMime || 'application/octet-stream');
        const kind = ['image', 'audio', 'video'].find((prefix) => mime.startsWith(`${prefix}/`)) || 'file';
        const extension = inlineExtensions[mime] || (kind === 'image' ? 'img' : 'bin');
        // Non-image blocks such as documents can carry a title; keep it as
        // the filename rather than losing it with the replaced block.
        const titled = block.type !== 'image' && typeof block.title === 'string' && block.title.trim()
          ? safeAssetName(block.title)
          : null;
        const name = titled
          ? (titled.toLowerCase().endsWith(`.${extension}`) ? titled : `${titled}.${extension}`)
          : `inline-${kind}-${hash.slice(0, 12)}.${extension}`;
        assets.push({
          name,
          mime,
          base64: archivedAssetBase64(buffer),
          size: bytes.byteLength,
          sha256: hash,
          source: index === null ? 'tool-result' : 'message-content',
          message_external_id: messageId,
          ...(index === null ? {} : { inline_positions: [{ message_external_id: messageId, index }] }),
        });
        hashes.add(hash);
      }
    }

    // A listed message file with no URL (or whose download Claude answered with
    // 404/410) is not necessarily lost: Claude may expose its extracted text or
    // include it in the conversation sandbox. If neither source yielded a
    // matching asset, it is recorded as not archived: the conversation shows a
    // note in its place and is marked incomplete, so it is never mistaken for
    // a complete archive and later syncs retry it.
    const byPathCache = new Map();
    const filesApiAssetCache = new Map();
    for (const { message, file, name, reason } of filesWithoutDownloadUrl) {
      const messageId = message.uuid || message.id || null;
      const fileId = file.file_uuid || file.uuid || null;
      const nameKeys = new Set([
        String(name || '').toLowerCase(),
        safeAssetName(name).toLowerCase(),
      ]);
      const scopedAssets = assets.filter((asset) => {
        const associatedIds = Array.isArray(asset.message_external_ids) && asset.message_external_ids.length
          ? asset.message_external_ids
          : (asset.message_external_id ? [asset.message_external_id] : []);
        return messageId && associatedIds.includes(messageId);
      });
      const scopedMatch = scopedAssets.some((asset) => {
        if (fileId && asset.file_uuid) return String(asset.file_uuid) === String(fileId);
        return nameKeys.has(String(asset.name || '').toLowerCase());
      });

      const messageData = messageHaystack(message);
      const sandboxCandidates = assets.filter((asset) => {
        if (asset.source !== 'sandbox') return false;
        const basename = String(asset.source_path || '').replace(/\\/g, '/').split('/').pop() || asset.name || '';
        return nameKeys.has(String(asset.name || '').toLowerCase())
          || nameKeys.has(String(basename).toLowerCase());
      });
      const sandboxMatch = sandboxCandidates.some((asset) => {
        const sourcePath = String(asset.source_path || '').replace(/\\/g, '/').toLowerCase();
        return (sourcePath && messageData.includes(sourcePath)) || sandboxCandidates.length === 1;
      });
      // The file entry names its sandbox path: a listed file with that exact
      // path is this file, even when Claude stored it under another name.
      const filePath = sandboxRelativePath(file?.path);
      const pathAsset = filePath ? assets.find((asset) => asset.source === 'sandbox' && sandboxRelativePath(asset.source_path) === filePath) : null;
      if (pathAsset) {
        // Link it to this file, so it is shown where it was attached.
        pathAsset.file_uuid ??= fileId;
        pathAsset.message_external_ids = [...new Set([...(pathAsset.message_external_ids || []), ...(messageId ? [messageId] : [])])];
        pathAsset.message_external_id ??= messageId;
        continue;
      }
      if (scopedMatch || sandboxMatch) continue;

      const attempts = [];
      let downloaded = null;

      // Some Claude uploads are marked as Files API blobs and have neither a
      // preview/document URL nor a sandbox path. Independent Claude.ai exporters
      // report this same-origin download route for those blobs:
      // /api/organizations/{org}/files/{file_uuid}/contents.
      // Keep this as a guarded read-only GET; 404/410 preserves the existing
      // incomplete-attachment behavior. The endpoint is undocumented and must
      // still be validated against a live account.
      const downloadSource = String(file?.download_source || '').toLowerCase().replace(/-/g, '_');
      const fileApiId = file.file_uuid || file.uuid || null;
      if (file?.file_kind === 'blob' && downloadSource === 'files_api' && fileApiId) {
        const cached = filesApiAssetCache.get(String(fileApiId));
        if (cached) {
          if (messageId && !cached.message_external_ids.includes(messageId)) {
            cached.message_external_ids.push(messageId);
          }
          const fingerprint = `${String(cached.name || '').toLowerCase()}|${cached.sha256}`;
          messageAssetFingerprints.add(fingerprint);
          fingerprintsForMessage(message).add(fingerprint);
          hashesForMessage(message).add(cached.sha256);
          continue;
        }

        const url = `/api/organizations/${encodeURIComponent(org)}/files/${encodeURIComponent(fileApiId)}/contents`;
        try {
          downloaded = await fetchAsset(url, name, file.mime_type || file.content_type || file.file_type || null, signal, {
            conversationId, fileUuid: fileApiId, route: 'files-api',
            declaredSize: declaredFileSize(file),
          });
          const linked = {
            ...downloaded,
            source: 'message',
            file_uuid: fileApiId,
            message_external_id: messageId,
            message_external_ids: messageId ? [messageId] : [],
          };
          filesApiAssetCache.set(String(fileApiId), linked);
          assets.push(linked);
          const fingerprint = `${String(linked.name || '').toLowerCase()}|${linked.sha256}`;
          messageAssetFingerprints.add(fingerprint);
          fingerprintsForMessage(message).add(fingerprint);
          hashesForMessage(message).add(linked.sha256);
          continue;
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          if (!isUnavailable(e)) {
            throw Object.assign(new Error(`Failed to download Claude file "${safeAssetName(name)}": ${e?.message || 'download error'}`), { category: 'download-failed' });
          }
          attempts.push({ via: 'files-api', status: e.status });
          downloaded = null;
        }
      }

      // Not in the file list: download it by the path the file entry gives,
      // through the same sandbox endpoint, when this conversation has a sandbox.
      if (filePath && listStatus !== 404) {
        downloaded = byPathCache.get(filePath) || null;
        for (const candidate of downloaded ? [] : sandboxPathForms(file.path)) {
          const url = `/api/organizations/${org}/conversations/${conversationId}/wiggle/download-file?path=${encodeURIComponent(candidate)}`;
          try {
            downloaded = await fetchAsset(url, name, file.mime_type || file.content_type || null, signal, {
              conversationId, fileUuid: fileId, route: 'sandbox-path',
              declaredSize: declaredFileSize(file),
            });
            attempts.push({ via: 'sandbox-path', form: candidate.startsWith('/') ? 'absolute' : 'relative', status: 200 });
            byPathCache.set(filePath, downloaded);
            break;
          } catch (e) {
            if (e?.name === 'AbortError') throw e;
            // A 4xx means this path form is not served; 5xx or network errors
            // keep the conversation out of this sync, so a later sync retries.
            if (!(e?.status >= 400 && e?.status < 500)) throw e;
            attempts.push({ via: 'sandbox-path', form: candidate.startsWith('/') ? 'absolute' : 'relative', status: e.status });
          }
        }
      }
      if (downloaded) {
        const existing = assets.find((asset) => asset.source === 'message-path' && asset.sha256 === downloaded.sha256 && asset.file_uuid === fileId);
        if (existing) {
          if (messageId && !existing.message_external_ids.includes(messageId)) existing.message_external_ids.push(messageId);
        } else {
          assets.push({
            ...downloaded,
            source: 'message-path',
            source_path: file.path,
            file_uuid: fileId,
            message_external_id: messageId,
            message_external_ids: messageId ? [messageId] : [],
          });
        }
        continue;
      }
      sandboxInfo.unarchived_files ??= [];
      sandboxInfo.unarchived_files.push({ message_id: messageId, file: sanitizeShape(file), attempts });
      incomplete.push({ kind: 'attachment', message_external_id: messageId, file_uuid: fileId, name, reason: reason || 'Claude did not provide a download link for this file' });
    }
    return assets;
  }

  function selectActiveLineage(data) {
    const raw = Array.isArray(data?.chat_messages) ? data.chat_messages : (Array.isArray(data?.messages) ? data.messages : []);
    const leaf = data?.current_leaf_message_uuid;
    const conversationLabel = String(data?.name || data?.uuid || 'Untitled conversation');
    const byId = new Map();

    // Message IDs are the only reliable way to validate branch ancestry and
    // connect exported assets to their source messages. Never silently omit
    // malformed nodes or choose one of two duplicate IDs.
    for (const [index, message] of raw.entries()) {
      if (!message || typeof message !== 'object' || Array.isArray(message)
        || typeof message.uuid !== 'string' || !message.uuid.trim()) {
        throw new Error(
          `Cannot safely export Claude conversation "${conversationLabel}": message at position ${index + 1} does not have a valid UUID. No archive changes were submitted to GitHub.`,
        );
      }
      if (byId.has(message.uuid)) {
        throw new Error(
          `Cannot safely export Claude conversation "${conversationLabel}": message UUID "${message.uuid}" appears more than once. No archive changes were submitted to GitHub.`,
        );
      }
      byId.set(message.uuid, message);
    }

    // Some API responses do not include a leaf pointer. In that case retain
    // every message, but only after validating every node above.
    if (!leaf) return raw;

    let current = byId.get(leaf);
    if (!current) {
      throw new Error(
        `Cannot safely export Claude conversation "${conversationLabel}": current_leaf_message_uuid "${leaf}" was not found in the retrieved messages. No archive changes were submitted to GitHub.`,
      );
    }

    const root = '00000000-0000-4000-8000-000000000000';
    const chain = [];
    const seen = new Set();
    while (current) {
      if (seen.has(current.uuid)) {
        throw new Error(
          `Cannot safely export Claude conversation "${conversationLabel}": the active message lineage contains a cycle or an invalid message ID. No archive changes were submitted to GitHub.`,
        );
      }
      seen.add(current.uuid);
      chain.push(current);

      const parent = current.parent_message_uuid;
      if (parent === root) break;
      if (typeof parent !== 'string' || !parent.trim()) {
        throw new Error(
          `Cannot safely export Claude conversation "${conversationLabel}": message "${current.uuid}" has no parent_message_uuid, so the active lineage cannot be verified back to the root. No archive changes were submitted to GitHub.`,
        );
      }

      const parentMessage = byId.get(parent);
      if (!parentMessage) {
        throw new Error(
          `Cannot safely export Claude conversation "${conversationLabel}": parent message "${parent}" for message "${current.uuid}" was not found in the retrieved messages. No archive changes were submitted to GitHub.`,
        );
      }
      current = parentMessage;
    }

    chain.reverse();
    return chain;
  }

  // The background renders a reply excerpt from its extracted text, but any
  // other attachment's extracted text is archived as a text asset (see
  // collectMessageAssets) and also stays in the message metadata used for
  // matching. A third copy in the message's attachment list is not needed.
  function transferAttachment(attachment) {
    if (!attachment || typeof attachment !== 'object') return attachment;
    if (typeof attachment.extracted_content !== 'string' || !attachment.extracted_content) {
      return metadataForAssetMatching(attachment);
    }
    const { extracted_content: text, ...rest } = attachment;
    // A reply excerpt is quoted text the user selected; it is rendered from
    // here and is kept verbatim even if it happens to look like base64.
    if (isReplyExcerptAttachment(attachment)) return { ...metadataForAssetMatching(rest), extracted_content: text };
    return {
      ...metadataForAssetMatching(rest),
      extracted_content: `[archived as an attachment file: ${text.length} characters]`,
    };
  }

  async function normalize(c, org, signal, sandboxInfo = {}) {
    const raw = selectActiveLineage(c);
    const inlineMarkerNonce = createInlineMarkerNonce();
    const inlineByMessage = new Map();
    const messages = raw.map((m, i) => {
      const inline = { nonce: inlineMarkerNonce, blocks: [], attachments: [] };
      const content = Array.isArray(m.content)
        ? renderContentBlocks(m.content, inline)
        : (typeof m.text === 'string' ? m.text : '');
      inlineByMessage.set(m, inline);
      return {
        external_id: m.uuid || m.id || `${i}`,
        role: m.sender === 'human' ? 'user' : m.sender || 'assistant',
        content: content || '',
        source_created_at: m.created_at || null,
        metadata: metadataForAssetMatching(m),
        files: Array.isArray(m.files) ? m.files.map((file) => metadataForAssetMatching(file)) : [],
        attachments: Array.isArray(m.attachments) ? m.attachments.map(transferAttachment) : [],
      };
    });

    // Files that could not be archived; rendered as visible notes and recorded
    // in the index so the conversation is retried by later syncs.
    const incomplete = [];
    const sandboxSupported = c.workspace_upgraded !== true && c.is_wiggle_enabled !== false;
    const assets = await collectMessageAssets(org, c.uuid, raw, signal, inlineByMessage, incomplete, sandboxInfo, sandboxSupported);
    return {
      external_id: c.uuid,
      title: c.name || 'Untitled conversation',
      model: c.model || null,
      source_created_at: c.created_at || null,
      source_updated_at: c.updated_at || c.created_at || null,
      message_count: messages.length,
      metadata: { source: 'claude', current_leaf_message_uuid: c.current_leaf_message_uuid || null },
      inline_marker_nonce: inlineMarkerNonce,
      messages,
      assets,
      incomplete,
    };
  }

  function conversationDate(c) {
    return new Date(c.updated_at || c.created_at || 0).getTime() || 0;
  }

  // Incremental sync: ask the background which conversations are already
  // archived completely by the current exporter. Any failure (no settings,
  // GitHub unavailable, an older background) means a full fetch, as before;
  // its reason is passed on so the sync outcome can say why nothing was
  // skipped as unchanged.
  function getArchivedState() {
    return new Promise((resolve) => {
      const failed = (reason) => resolve({ state: null, error: String(reason || 'unknown error').slice(0, 300) });
      try {
        chrome.runtime.sendMessage({ type: 'getArchiveState' }, (response) => {
          if (chrome.runtime.lastError) {
            failed(chrome.runtime.lastError.message || 'the extension did not answer');
            return;
          }
          if (response?.ok === false && response.blocksSync === true) {
            resolve({ state: null, error: String(response.error || 'the archive cannot be synced').slice(0, 600), blocksSync: true });
            return;
          }
          if (!response?.ok || !Array.isArray(response.conversations)) {
            failed(response?.error || 'the extension returned no archive state');
            return;
          }
          const oversized = new Map();
          for (const item of Array.isArray(response.oversized) ? response.oversized : []) {
            if (!item || !/^[0-9a-f]{64}$/.test(String(item.sha256)) || !Number.isSafeInteger(item.size) || !item.id || !item.file_uuid) continue;
            if (!oversized.has(String(item.id))) oversized.set(String(item.id), new Map());
            oversized.get(String(item.id)).set(String(item.file_uuid), { size: item.size, sha256: String(item.sha256) });
          }
          resolve({ state: new Map(response.conversations.map((entry) => [String(entry.id), entry.updated_at])), oversized, error: null });
        });
      } catch (error) {
        failed(error?.message || error);
      }
    });
  }

  function sendProgress(payload) {
    chrome.runtime.sendMessage({ type: 'syncProgress', ...payload }).catch(() => {});
  }

  // `automatic`: a sync started by the "sync when Claude opens" setting. With
  // an existing archive it checks every conversation incrementally; without
  // one (first use, or the archive state cannot be read) it only takes the
  // latest AUTO_SYNC_LIMIT, so it never starts a full first import by itself.
  // ---- Sanitized diagnostics (popup: "Copy diagnostic report") ----
  // For conversations that were not archived completely, record the *shape*
  // of Claude's responses: keys, types, counts, HTTP statuses, and structural
  // values such as "type" or "file_kind". Message text, titles, file names,
  // file contents and URL query strings (where signed tokens could be) are
  // never recorded; IDs inside values become {uuid}.
  const DIAGNOSTIC_VALUE_KEYS = new Set(['type', 'sender', 'kind', 'file_kind', 'mime_type', 'content_type', 'file_type', 'media_type', 'encoding', 'stop_reason', 'download_source', 'file_variant', 'platform', 'input_mode', 'error_visibility']);
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  function sanitizePathLike(value) {
    const match = value.match(/^(https?:\/\/[^/?#]+)?([^?#]*)/i);
    const origin = match[1] || '';
    const path = match[2].split('/').map((segment) => {
      if (!segment) return segment;
      if (/^[0-9a-f-]{36}$/i.test(segment)) return '{uuid}';
      if (/^[a-z_-]{1,24}$/.test(segment)) return segment;
      const extension = segment.match(/\.([a-z0-9]{1,5})$/i);
      return extension ? `<name>.${extension[1].toLowerCase()}` : `<segment:${segment.length}>`;
    }).join('/');
    return `${origin}${path}${/[?#]/.test(value) ? '?<query removed>' : ''}`;
  }

  function sanitizeShape(value, key = '', depth = 0) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (DIAGNOSTIC_VALUE_KEYS.has(key) && value.length <= 60 && /^[\w.\/+-]+$/.test(value)) return value;
      if (/^(https?:\/\/|\/)/i.test(value) && value.length <= 2048) return sanitizePathLike(value);
      if (/^[0-9a-f-]{36}$/i.test(value)) return '{uuid}';
      return `<string:${value.length}>`;
    }
    if (depth >= 6) return '<nested>';
    if (Array.isArray(value)) {
      const items = value.slice(0, 5).map((item) => sanitizeShape(item, key, depth + 1));
      return value.length > 5 ? [...items, `<+${value.length - 5} more>`] : items;
    }
    if (typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sanitizeShape(value[k], k, depth + 1)]));
    }
    return `<${typeof value}>`;
  }

  // Quoted parts of an error message can be titles or file names.
  const sanitizeError = (message) => String(message || '').replace(/"[^"]*"/g, (quoted) => (/^"[0-9a-f-]{36}"$/i.test(quoted) ? quoted : '"<redacted>"')).slice(0, 400);
  const fileExtension = (name) => (String(name || '').match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toLowerCase() || null;

  function diagnosticFor(conversationId, payload, outcome, details) {
    const messages = Array.isArray(payload?.chat_messages) ? payload.chat_messages : (Array.isArray(payload?.messages) ? payload.messages : []);
    const hasFiles = (m) => ['files', 'files_v2', 'attachments'].some((k) => Array.isArray(m?.[k]) && m[k].length);
    // Messages named by a problem are always included, beyond the cap.
    const problemIds = new Set([...(details.problems || []).map((p) => p.message_id), ...(details.unarchived_files || []).map((f) => f.message_id)].filter(Boolean));
    const withFiles = messages.filter(hasFiles);
    const shown = withFiles.filter((m, i) => i < 30 || problemIds.has(m?.uuid));

    // Claude emits tool_use and tool_result in separate transcript messages.
    // Index the full conversation so diagnostics for a file-bearing message
    // can include the matching call/result pair without exposing raw IDs.
    const toolRefs = new Map();
    const toolUses = new Map();
    let toolRefNumber = 0;
    for (const message of messages) {
      for (const block of (Array.isArray(message?.content) ? message.content : [])) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          toolRefs.set(block.id, `tool-${++toolRefNumber}`);
          toolUses.set(block.id, block);
        }
      }
    }
    const toolResults = new Map();
    for (const message of messages) {
      for (const block of (Array.isArray(message?.content) ? message.content : [])) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const results = toolResults.get(block.tool_use_id) || [];
          results.push(block);
          toolResults.set(block.tool_use_id, results);
        }
      }
    }

    return {
      conversation_id: conversationId,
      outcome,
      ...details,
      conversation_keys: payload && typeof payload === 'object' ? Object.keys(payload).sort() : null,
      // Only true/false values (for example is_wiggle_enabled).
      conversation_flags: payload && typeof payload === 'object'
        ? Object.fromEntries(Object.keys(payload).sort().filter((k) => typeof payload[k] === 'boolean').map((k) => [k, payload[k]]))
        : null,
      message_count: messages.length,
      messages_with_files_total: withFiles.length,
      // Messages carrying files, where attachment problems come from.
      messages_with_files: shown.map((m) => {
        const ownToolBlocks = (Array.isArray(m?.content) ? m.content : [])
          .filter((block) => block?.type === 'tool_use' || block?.type === 'tool_result');
        const relatedToolBlocks = [];
        const seenToolBlocks = new Set();
        const addToolBlock = (block) => {
          if (!block || seenToolBlocks.has(block)) return;
          seenToolBlocks.add(block);
          relatedToolBlocks.push(block);
        };
        for (const block of ownToolBlocks) {
          if (block.type === 'tool_result') addToolBlock(toolUses.get(block.tool_use_id));
          addToolBlock(block);
          if (block.type === 'tool_use') {
            for (const result of (toolResults.get(block.id) || [])) addToolBlock(result);
          }
        }
        const toolBlocks = relatedToolBlocks.slice(0, 20);
        return {
          message_id: typeof m?.uuid === 'string' ? m.uuid : null,
          sender: sanitizeShape(m?.sender, 'sender'),
          keys: Object.keys(m || {}).sort(),
          content_block_types: Array.isArray(m?.content) ? m.content.map((block) => sanitizeShape(block?.type, 'type')) : [],
          tool_names: [...new Set(toolBlocks
            .filter((block) => block?.type === 'tool_use' && /^[a-z0-9_.-]{1,48}$/i.test(String(block.name || '')))
            .map((block) => block.name))],
          // Preserve sanitized tool calls/results related to this file-bearing
          // message, even when Claude places the call and result separately.
          tool_blocks: toolBlocks.map((block) => ({
            type: sanitizeShape(block.type, 'type'),
            ...(block.type === 'tool_use' && toolRefs.has(block.id) ? { tool_ref: toolRefs.get(block.id) } : {}),
            ...(block.type === 'tool_result' && toolRefs.has(block.tool_use_id) ? { tool_ref: toolRefs.get(block.tool_use_id) } : {}),
            ...(typeof block.name === 'string' && /^[a-z0-9_.-]{1,48}$/i.test(block.name) ? { name: block.name } : {}),
            ...(block.input && typeof block.input === 'object' ? {
              input_keys: Object.keys(block.input).sort(),
              input_shape: sanitizeShape(block.input),
            } : {}),
            ...(block.content !== undefined ? { content_shape: sanitizeShape(block.content) } : {}),
            ...(typeof block.is_error === 'boolean' ? { is_error: block.is_error } : {}),
          })),
          files: sanitizeShape(m?.files),
          files_v2: sanitizeShape(m?.files_v2),
          attachments: sanitizeShape(m?.attachments),
        };
      }),
    };
  }

  // Why a conversation could not be exported in this sync:
  //   download-failed    Claude did not deliver a file or file list (network,
  //                      5xx, 403, 429); a later sync retries
  //   validation-failed  Claude's data failed a safety check (unreadable or
  //                      inconsistent conversation, lineage or IDs)
  //   export-failed      anything else (for example preparing the transfer)
  function exportFailureCategory(error) {
    if (error?.category === 'download-failed') return 'download-failed';
    if (/^(Claude returned|Cannot safely export)/.test(String(error?.message || ''))) return 'validation-failed';
    return 'export-failed';
  }

  function storeDiagnostics(items, { oversized = null } = {}) {
    try {
      const version = chrome.runtime?.getManifest?.()?.version || null;
      return chrome.storage?.local?.set?.({
        last_sync_diagnostics: {
          at: new Date().toISOString(),
          extension_version: version,
          items: items.slice(0, 30),
          // Aggregate counts only (see newOversizedStats).
          ...(oversized?.detected ? { oversized_downloads: { ...oversized, downloaded_reasons: { ...oversized.downloaded_reasons }, downloaded_routes: { ...oversized.downloaded_routes } } } : {}),
        },
      })?.catch?.(() => {}) || Promise.resolve();
    } catch {
      // Diagnostics are best effort and never affect the sync.
      return Promise.resolve();
    }
  }

  async function runSync(limit = 'all', { automatic = false } = {}) {
    if (syncing) return;
    syncing = true;
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;
    try {
      // A report belongs to one sync attempt only. Clear the previous report
      // before any network work, so early failures cannot leave stale details.
      await storeDiagnostics([]);
      sendProgress({ stage: 'fetching', current: 0, total: 0, selected: limit });
      const org = await getOrg(signal);
      let listData = await list(org, signal);
      listData = [...listData].sort((a, b) => conversationDate(b) - conversationDate(a));
      // "All conversations" (manual or automatic) does not download conversations
      // whose archived copy is complete and whose Claude update time has not
      // changed; they stay exactly as archived. An explicit "Latest N" sync always
      // re-downloads those N, which is how a user forces a refresh.
      const archivedState = limit === 'all' ? await getArchivedState() : null;
      // The archive itself must be fixed first (for example a missing index):
      // every sync would fail, so do not download anything.
      if (archivedState?.blocksSync) throw new Error(archivedState.error);
      const archived = archivedState?.state || null;
      knownOversizedFiles = archivedState?.oversized || null;
      oversizedStats = newOversizedStats();
      const archiveStateError = archivedState?.error ? sanitizeError(archivedState.error) : null;
      if (signal.aborted) throw new DOMException('Sync cancelled', 'AbortError');
      if (automatic && !(archived && archived.size)) limit = String(AUTO_SYNC_LIMIT);
      const candidates = limit === 'all' ? listData : listData.slice(0, Number(limit));
      const unchangedIds = [];
      const selected = candidates.filter((c) => {
        const current = c.updated_at || c.created_at || null;
        if (archived && current && archived.get(String(c.uuid)) === current) {
          unchangedIds.push(c.uuid);
          return false;
        }
        return true;
      });
      const total = selected.length;
      sendProgress({ stage: 'fetching', current: 0, total, selected: limit });

      // One conversation that cannot be exported safely (a malformed payload, an
      // attachment that will not download, a message too large to serialize)
      // must not block every other conversation. It is left out of this sync,
      // so its archived copy stays exactly as it was, and the completion
      // message names it. Cancellation still stops everything, and if nothing
      // could be exported the sync fails.
      const skipped = [];
      const diagnostics = [];
      let firstExportError = null;
      // The transfer starts before fetching, so a busy extension is reported
      // at once instead of after every conversation has been downloaded.
      const transfer = await createTransferSession(signal);
      let result;
      try {
        for (let i = 0; i < selected.length; i++) {
          if (signal.aborted) throw new DOMException('Sync cancelled', 'AbortError');
          transfer.assertUsable();
          let payload = null;
          let prepared = null;
          const sandboxInfo = {};
          try {
            payload = await full(org, selected[i].uuid, signal);
            const conversation = await normalize(payload, org, signal, sandboxInfo);
            if (signal.aborted) throw new DOMException('Sync cancelled', 'AbortError');
            prepared = transfer.prepare(conversation);
            // Files over the upload limit are downloaded, but the background
            // leaves them out of the archive, so they are reported here too:
            // otherwise a sync whose only problem is an oversized file stores an
            // empty report and the popup offers no diagnostic report.
            const oversized = (Array.isArray(conversation.assets) ? conversation.assets : [])
              .filter((asset) => Number(asset?.size) > MAX_ARCHIVED_FILE_BYTES);
            if (conversation.incomplete.length || oversized.length) {
              diagnostics.push(diagnosticFor(selected[i].uuid, payload, 'incomplete', {
                problems: [
                  ...conversation.incomplete.map((item) => ({
                    kind: item.kind,
                    reason: item.reason,
                    message_id: item.message_external_id || null,
                    file_extension: fileExtension(item.name),
                  })),
                  ...oversized.map((asset) => ({
                    kind: 'attachment',
                    reason: 'over the upload limit',
                    message_id: asset.message_external_id || asset.message_external_ids?.[0] || null,
                    file_extension: fileExtension(asset.name),
                    size: Number(asset.size),
                    limit: MAX_ARCHIVED_FILE_BYTES,
                  })),
                ],
                ...sandboxInfo,
              }));
            }
          } catch (e) {
            if (e?.name === 'AbortError' || signal.aborted) throw e;
            diagnostics.push(diagnosticFor(selected[i].uuid, payload, 'failed', { error: sanitizeError(e?.message || e), category: exportFailureCategory(e), ...sandboxInfo }));
            firstExportError ??= e;
            skipped.push({
              id: selected[i].uuid,
              title: selected[i].name || selected[i].uuid,
              error: String(e?.message || e),
              category: exportFailureCategory(e),
            });
          }
          payload = null;
          // A failure while handing a prepared conversation over is not a
          // problem of this conversation: the transfer is no longer complete,
          // so the whole sync stops and nothing is published.
          if (prepared) await transfer.sendConversation(prepared);
          prepared = null;
          sendProgress({ stage: 'fetching', current: i + 1, total, selected: limit });
        }
        await storeDiagnostics(diagnostics, { oversized: oversizedStats });
        if (!transfer.conversationCount && firstExportError) throw firstExportError;

        if (signal.aborted) throw new DOMException('Sync cancelled', 'AbortError');
        sendProgress({ stage: 'preparing', current: 0, total, selected: limit });
        // Every conversation is already in the background; this stage makes
        // the final handoff explicit.
        sendProgress({ stage: 'preparing', current: total, total, selected: limit });
        if (signal.aborted) throw new DOMException('Sync cancelled', 'AbortError');
        // Keep the content-script lock until the background sync has actually
        // finished; otherwise another startSync message can trigger a second fetch
        // while the first batch is still being committed to GitHub.
        result = await transfer.finish({
          skipped, unchangedIds, fullList: limit === 'all', listed: listData.length,
          ...(archiveStateError ? { archiveStateError } : {}),
          ...(oversizedStats.skipped ? { oversizedDownloadsSkipped: oversizedStats.skipped } : {}),
          ...(oversizedStats.detected ? { oversizedStats: { ...oversizedStats, downloaded_reasons: { ...oversizedStats.downloaded_reasons }, downloaded_routes: { ...oversizedStats.downloaded_routes } } } : {}),
        });
      } catch (e) {
        await transfer.abort();
        throw e;
      }
      if (!result?.ok && !result?.cancelled) {
        sendProgress({ stage: 'error', error: result?.error || 'No response' });
      }
    } catch (e) {
      if (e.name === 'AbortError') sendProgress({ stage: 'cancelled', message: 'Sync cancelled.' });
      else sendProgress({ stage: 'error', error: e.message });
    } finally {
      syncing = false;
      currentAbortController = null;
      knownOversizedFiles = null;
    }
  }

  // "Automatically sync when Claude opens": when the user enabled it in the
  // popup and GitHub is configured, start one sync of the most recently
  // updated conversations as this page loads. Several Claude tabs or reloads
  // share one throttle so they do not start a sync each.
  const AUTO_SYNC_LIMIT = 20;
  const AUTO_SYNC_MIN_INTERVAL_MS = 10 * 60 * 1000;

  // ---- Handing conversations to the background worker ----
  //
  // Each conversation is handed to the background as soon as it has been
  // fetched and normalized, then released, so the Claude tab never holds the
  // whole account (and every attachment of it) at once. The transfer is a
  // stream of JSON records sent in bounded batches:
  //   {conversation_index, message_count, conversation}  conversation header
  //   {conversation_index, message}                      one message
  // Each record is serialized on its own, so the largest JSON string built is
  // one message, never a conversation or the archive. Attachment bytes never
  // enter that JSON: they follow as base64 in separate bounded chunks, which
  // the background checks against each file's size and SHA-256. The background
  // publishes nothing until the final syncNormalized message confirms every
  // conversation, message and attachment arrived.
  //
  // Chrome rejects extension messages over 64 MiB. A chunk of 8M characters
  // stays under the limit even if every character needed escaping as several
  // bytes.
  const HANDOFF_CHUNK_CHARS = 8 * 1024 * 1024;
  // Chrome stops an idle extension service worker after about 30 seconds, and
  // downloading one conversation's attachments can take longer than that.
  const TRANSFER_KEEPALIVE_MS = 15 * 1000;

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) reject(Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  // Serializes a normalized conversation into transfer records before any of
  // it is sent, so a conversation that cannot be serialized is left out of the
  // sync (and reported) without leaving half of it in the background.
  function prepareConversationTransfer(conversation, conversationIndex) {
    const id = String(conversation?.external_id || conversationIndex + 1);
    const assets = Array.isArray(conversation?.assets) ? conversation.assets : [];
    const payloads = [];
    const headerAssets = assets.map((asset, assetIndex) => {
      const { base64, ...rest } = asset && typeof asset === 'object' ? asset : {};
      const payload = typeof base64 === 'string' ? base64 : '';
      const size = Number(rest.size) || Math.floor(payload.length * 3 / 4);
      // Oversized files carry no bytes; the background still receives their
      // name, size and hash and renders a visible "Not archived" note.
      const transferable = payload.length > 0 && size <= MAX_ARCHIVED_FILE_BYTES;
      if (transferable) payloads.push({ assetIndex, base64: payload });
      return { ...rest, base64: '', payload_chars: transferable ? payload.length : 0 };
    });
    const { messages: rawMessages, assets: _assets, ...header } = conversation || {};
    const messages = Array.isArray(rawMessages) ? rawMessages : [];

    const records = [];
    const serialize = (value, what) => {
      let text;
      try {
        text = JSON.stringify(value);
      } catch (error) {
        throw new Error(`Could not prepare ${what} of conversation "${id}" for the extension: ${String(error?.message || error)}. This conversation was left out of the sync; its archived copy, if any, was kept.`);
      }
      if (typeof text !== 'string') {
        throw new Error(`Could not prepare ${what} of conversation "${id}" for the extension. This conversation was left out of the sync; its archived copy, if any, was kept.`);
      }
      records.push(text);
    };
    serialize({
      conversation_index: conversationIndex,
      message_count: messages.length,
      conversation: { ...header, assets: headerAssets },
    }, 'the metadata');
    for (const [messageIndex, message] of messages.entries()) {
      serialize({ conversation_index: conversationIndex, message },
        `message ${messageIndex + 1} of ${messages.length} ("${message?.external_id || messageIndex + 1}")`);
    }
    return { id, records, payloads };
  }

  async function createTransferSession(signal) {
    const transferId = createInlineMarkerNonce();
    let lostError = null;
    let finishing = false;
    let keepAlive = null;
    let batchParts = [];
    let batchLength = 2; // '[' and ']'
    let batchIndex = 0;
    let sentConversations = 0;

    const started = await sendRuntimeMessage({ type: 'syncTransferStart', transferId, protocol: 2 });
    if (!started?.ok) {
      throw new Error(started?.error || 'The extension could not prepare the sync transfer. Nothing was published; sync again.');
    }

    if (typeof setInterval === 'function') {
      keepAlive = setInterval(() => {
        sendRuntimeMessage({ type: 'syncTransferKeepAlive', transferId }).then((response) => {
          if (!response?.ok && !finishing) {
            lostError ??= new Error(response?.error || 'The extension stopped receiving this sync. Nothing was published; sync again.');
          }
        }, (error) => {
          if (!finishing) {
            lostError ??= new Error(`The extension stopped receiving this sync (${String(error?.message || error)}). Nothing was published; sync again.`);
          }
        });
      }, TRANSFER_KEEPALIVE_MS);
    }
    const stopKeepAlive = () => {
      if (keepAlive !== null) clearInterval(keepAlive);
      keepAlive = null;
    };

    function assertUsable() {
      if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
      if (lostError) throw lostError;
    }

    async function send(message, fallbackError) {
      assertUsable();
      const response = await sendRuntimeMessage({ ...message, transferId });
      if (!response?.ok) throw new Error(response?.error || fallbackError);
      return response;
    }

    async function sendBatch(text) {
      const totalChunks = Math.max(1, Math.ceil(text.length / HANDOFF_CHUNK_CHARS));
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        await send({
          type: 'syncTransferBatchChunk',
          batchIndex,
          chunkIndex,
          totalChunks,
          totalChars: text.length,
          data: text.slice(chunkIndex * HANDOFF_CHUNK_CHARS, (chunkIndex + 1) * HANDOFF_CHUNK_CHARS),
        }, 'The extension did not accept a sync batch. Nothing was published; sync again.');
      }
      batchIndex++;
    }

    async function flushBatch() {
      if (!batchParts.length) return;
      const text = '[' + batchParts.join(',') + ']';
      batchParts = [];
      batchLength = 2;
      await sendBatch(text);
    }

    async function queueRecord(record) {
      if (record.length + 2 > HANDOFF_CHUNK_CHARS) {
        // One large message travels as its own batch, split into chunks.
        await flushBatch();
        await sendBatch('[' + record + ']');
        return;
      }
      if (batchParts.length && batchLength + record.length + 1 > HANDOFF_CHUNK_CHARS) await flushBatch();
      batchLength += record.length + (batchParts.length ? 1 : 0);
      batchParts.push(record);
    }

    async function sendAsset(conversationIndex, assetIndex, base64) {
      const totalChunks = Math.max(1, Math.ceil(base64.length / HANDOFF_CHUNK_CHARS));
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        await send({
          type: 'syncTransferAssetChunk',
          conversationIndex,
          assetIndex,
          chunkIndex,
          totalChunks,
          totalChars: base64.length,
          data: base64.slice(chunkIndex * HANDOFF_CHUNK_CHARS, (chunkIndex + 1) * HANDOFF_CHUNK_CHARS),
        }, 'The extension did not accept an attachment chunk. Nothing was published; sync again.');
      }
    }

    return {
      transferId,
      get conversationCount() { return sentConversations; },
      assertUsable,
      prepare(conversation) {
        return prepareConversationTransfer(conversation, sentConversations);
      },
      async sendConversation(prepared) {
        const conversationIndex = sentConversations;
        for (const record of prepared.records) await queueRecord(record);
        prepared.records = null;
        if (prepared.payloads.length) {
          // A conversation's attachments follow its own records.
          await flushBatch();
          for (const payload of prepared.payloads) {
            await sendAsset(conversationIndex, payload.assetIndex, payload.base64);
            payload.base64 = '';
          }
        }
        sentConversations++;
      },
      async finish(metadata) {
        await flushBatch();
        assertUsable();
        finishing = true;
        try {
          return await sendRuntimeMessage({
            type: 'syncNormalized',
            transferId,
            conversationCount: sentConversations,
            metadata,
          });
        } finally {
          stopKeepAlive();
        }
      },
      async abort() {
        finishing = true;
        stopKeepAlive();
        try { await sendRuntimeMessage({ type: 'syncTransferAbort', transferId }); } catch {}
      },
    };
  }

  async function maybeAutoSync() {
    let stored;
    try {
      stored = await chrome.storage.local.get([
        'auto_sync', 'auto_sync_last_started_at', 'github_owner', 'github_repo', 'github_token',
      ]);
    } catch {
      return;
    }
    if (stored.auto_sync !== true || !stored.github_owner || !stored.github_repo || !stored.github_token) return;
    const now = Date.now();
    if (now - Number(stored.auto_sync_last_started_at || 0) < AUTO_SYNC_MIN_INTERVAL_MS) return;
    await chrome.storage.local.set({ auto_sync_last_started_at: now });
    runSync('all', { automatic: true });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'startSync') {
      runSync(msg.limit || 'all');
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'cancelSync') {
      currentAbortController?.abort();
      sendResponse({ ok: true });
      return false;
    }
  });
  maybeAutoSync().catch(() => {});
})();
