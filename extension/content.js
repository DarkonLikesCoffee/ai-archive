(() => {
  const ASSET_DOWNLOAD_CONCURRENCY = 3;
  let currentAbortController = null;
  let syncing = false;

  async function getOrg(signal) {
    const r = await fetch('/api/organizations', { credentials: 'include', signal });
    if (!r.ok) throw Error(`Claude organizations: ${r.status}`);
    const x = await r.json();
    if (!Array.isArray(x) || !x.length) throw Error('No Claude organization found. Make sure you are logged in.');
    return x[0].uuid;
  }

  async function list(org, signal) {
    const r = await fetch(`/api/organizations/${org}/chat_conversations`, { credentials: 'include', signal });
    if (!r.ok) throw Error(`Claude conversations: ${r.status}`);

    let data;
    try {
      data = await r.json();
    } catch {
      throw new Error('Claude returned an unreadable conversation list. No archive changes were submitted to GitHub; retry the sync.');
    }
    if (!Array.isArray(data)) {
      throw new Error('Claude returned an invalid conversation list (expected an array). No archive changes were submitted to GitHub; retry the sync.');
    }

    const seenIds = new Set();
    for (const conversation of data) {
      if (!conversation || typeof conversation !== 'object' || typeof conversation.uuid !== 'string' || !conversation.uuid.trim()) {
        throw new Error('Claude returned a conversation without a valid UUID. No archive changes were submitted to GitHub; retry the sync.');
      }
      if (seenIds.has(conversation.uuid)) {
        throw new Error(`Claude returned duplicate conversation UUID "${conversation.uuid}". No archive changes were submitted to GitHub; retry the sync.`);
      }
      seenIds.add(conversation.uuid);
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
      return JSON.stringify(value, function (key, item) {
        // Avoid embedding base64 media data or other large inline payloads into
        // Markdown. Preserve metadata and make omitted data explicit.
        const base64Data = key === 'data' && this?.type === 'base64';
        if (typeof item === 'string' && /^(data|base64|bytes)$/i.test(key)
          && (item.length > 256 || base64Data)) {
          return archivedSources?.has(this)
            ? `[omitted inline payload: ${item.length} characters; archived as a message attachment]`
            : `[omitted inline payload: ${item.length} characters]`;
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
      throw new Error('Claude returned an invalid base64 inline content block. Sync stopped before anything was sent to GitHub.');
    }
    if (!binary.length) throw new Error('Claude returned an empty base64 inline content block. Sync stopped before anything was sent to GitHub.');
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

  async function fetchAsset(url, name, mime, signal) {
    const label = safeAssetName(name);
    if (!url) {
      throw new Error(`Cannot download attachment "${label}": no download URL was provided.`);
    }
    try {
      const r = await fetch(url, { credentials: 'include', signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buffer = await r.arrayBuffer();
      if (!buffer.byteLength) throw new Error('the download returned an empty file');
      return {
        name: label,
        mime: mime || r.headers.get('content-type') || 'application/octet-stream',
        base64: bytesToBase64(buffer),
        size: buffer.byteLength,
        sha256: await sha256Bytes(buffer),
      };
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new Error(`Failed to download attachment "${label}": ${e?.message || 'network error'}. Sync stopped before anything was sent to GitHub; retry the sync.`);
    }
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
      const serialized = JSON.stringify(message || {}).toLowerCase();
      // A full path is unambiguous even when two files share a basename.
      if (serialized.includes(sourcePath)) return true;
      // Basename fallback is safe only when it uniquely identifies one sandbox file.
      if (sameNameCount !== 1 || basename.length <= 1 || !serialized.includes(basename)) return false;

      // If a directly downloaded message attachment has the same name, a
      // basename mention may refer to that attachment instead of this sandbox
      // file. Include the sandbox copy only when the exact path was cited above.
      const collidesWithDirectAsset = directAssets.some(({ asset }) =>
        String(asset?.name || '').toLowerCase() === basename
      );
      return !collidesWithDirectAsset;
    });
  }

  async function fetchSandboxFiles(org, conversationId, messages, directAssets, signal) {
    const endpoint = `/api/organizations/${org}/conversations/${conversationId}/wiggle/list-files`;
    let r;
    try {
      r = await fetch(endpoint, { credentials: 'include', signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new Error(`Could not list Claude sandbox files for conversation "${conversationId}": ${e?.message || 'network error'}. Sync stopped before anything was sent to GitHub; retry the sync.`);
    }
    if (!r.ok) {
      throw new Error(`Could not list Claude sandbox files for conversation "${conversationId}" (HTTP ${r.status}). Sync stopped before anything was sent to GitHub; retry the sync.`);
    }

    let data;
    try {
      data = await r.json();
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new Error(`Claude returned an unreadable sandbox file list for conversation "${conversationId}". Sync stopped before anything was sent to GitHub; retry the sync.`);
    }
    if (!Array.isArray(data?.files_metadata)) {
      throw new Error(`Claude returned an invalid sandbox file list for conversation "${conversationId}". Sync stopped before anything was sent to GitHub; retry the sync.`);
    }

    for (const file of data.files_metadata) {
      if (!file?.path) {
        throw new Error(`Claude returned sandbox file metadata without a path for conversation "${conversationId}". Sync stopped before anything was sent to GitHub.`);
      }
    }

    // The sandbox is conversation-wide and can contain outputs left by abandoned
    // Claude branches. Only download files explicitly referenced by the active
    // lineage; never archive unrelated files merely because they remain in the sandbox.
    const activeFiles = data.files_metadata.filter((file) =>
      sandboxFileIsReferenced(file, messages, data.files_metadata, directAssets)
    );

    return mapWithConcurrency(
      activeFiles,
      ASSET_DOWNLOAD_CONCURRENCY,
      async (file) => {
        const url = `/api/organizations/${org}/conversations/${conversationId}/wiggle/download-file?path=${encodeURIComponent(file.path)}`;
        let asset;
        try {
          asset = await fetchAsset(url, file.path.split('/').pop() || file.path, file.content_type, signal);
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          throw new Error(`Failed to download sandbox file "${file.path}": ${e?.message || 'download error'}`);
        }
        return { ...asset, source_path: file.path, source: 'sandbox' };
      },
      signal,
    );
  }

  function isReplyExcerptAttachment(file) {
    const name = String(file?.file_name || file?.name || '').trim().toLowerCase();
    return name === 'excerpt_from_previous_claude_message.txt' || name.startsWith('excerpt_from_previous_claude_message.');
  }

  async function collectMessageAssets(org, conversationId, messages, signal, inlineByMessage = new Map()) {
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
        const asset = await fetchAsset(url, name, file.mime_type || file.content_type || file.file_type, signal);
        return { asset, message, file, messageExternalIds, messageReferences };
      },
      signal,
    );

    for (const { asset, message, file, messageExternalIds, messageReferences } of directAssets) {
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

    // The sandbox contains the original uploads and files generated by Claude's tools.
    const sandbox = await fetchSandboxFiles(org, conversationId, messages, directAssets, signal);
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
          base64: bytesToBase64(buffer),
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
          base64: bytesToBase64(buffer),
          size: bytes.byteLength,
          sha256: hash,
          source: index === null ? 'tool-result' : 'message-content',
          message_external_id: messageId,
          ...(index === null ? {} : { inline_positions: [{ message_external_id: messageId, index }] }),
        });
        hashes.add(hash);
      }
    }

    // A listed message file with no URL is not necessarily lost: Claude may
    // expose its extracted text or include it in the conversation sandbox.
    // But if neither source yielded a matching asset, failing safely is better
    // than claiming the conversation was archived completely.
    for (const { message, file, name } of filesWithoutDownloadUrl) {
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

      const messageData = JSON.stringify(message).toLowerCase();
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

      if (!scopedMatch && !sandboxMatch) {
        throw new Error(
          `Cannot safely export Claude conversation "${conversationId}": attachment "${name}" has no downloadable URL and no matching archiveable file was found. Sync stopped before anything was sent to GitHub; retry or inspect the attachment in Claude.`,
        );
      }
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

  async function normalize(c, org, signal) {
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
        metadata: m,
        files: Array.isArray(m.files) ? m.files : [],
        attachments: Array.isArray(m.attachments) ? m.attachments : [],
      };
    });

    const assets = await collectMessageAssets(org, c.uuid, raw, signal, inlineByMessage);
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
    };
  }

  function conversationDate(c) {
    return new Date(c.updated_at || c.created_at || 0).getTime() || 0;
  }

  function sendProgress(payload) {
    chrome.runtime.sendMessage({ type: 'syncProgress', ...payload }).catch(() => {});
  }

  async function runSync(limit = 'all') {
    if (syncing) return;
    syncing = true;
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;
    try {
      sendProgress({ stage: 'fetching', current: 0, total: 0, selected: limit });
      const org = await getOrg(signal);
      let listData = await list(org, signal);
      listData = [...listData].sort((a, b) => conversationDate(b) - conversationDate(a));
      const selected = limit === 'all' ? listData : listData.slice(0, Number(limit));
      const total = selected.length;
      sendProgress({ stage: 'fetching', current: 0, total, selected: limit });

      const conversations = [];
      // One conversation that cannot be exported safely (a malformed payload, an
      // attachment that will not download) must not block every other
      // conversation. It is left out of this sync, so its archived copy stays
      // exactly as it was, and the completion message names it. Cancellation
      // still stops everything, and if nothing could be exported the sync fails.
      const skipped = [];
      let firstExportError = null;
      for (let i = 0; i < selected.length; i++) {
        if (signal.aborted) throw new DOMException('Sync cancelled', 'AbortError');
        try {
          const conversation = await normalize(await full(org, selected[i].uuid, signal), org, signal);
          if (signal.aborted) throw new DOMException('Sync cancelled', 'AbortError');
          conversations.push(conversation);
        } catch (e) {
          if (e?.name === 'AbortError' || signal.aborted) throw e;
          firstExportError ??= e;
          skipped.push({
            id: selected[i].uuid,
            title: selected[i].name || selected[i].uuid,
            error: String(e?.message || e),
          });
        }
        sendProgress({ stage: 'fetching', current: i + 1, total, selected: limit });
      }
      if (!conversations.length && firstExportError) throw firstExportError;

      if (signal.aborted) throw new DOMException('Sync cancelled', 'AbortError');
      sendProgress({ stage: 'preparing', current: 0, total, selected: limit });
      // Data is already normalized above; this stage exists to make the handoff explicit.
      sendProgress({ stage: 'preparing', current: total, total, selected: limit });
      if (signal.aborted) throw new DOMException('Sync cancelled', 'AbortError');
      // Keep the content-script lock until the background sync has actually
      // finished; otherwise another startSync message can trigger a second fetch
      // while the first batch is still being committed to GitHub.
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'syncNormalized', conversations, skipped }, (response) => {
          if (chrome.runtime.lastError) {
            reject(Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        });
      });
      if (!result?.ok && !result?.cancelled) {
        sendProgress({ stage: 'error', error: result?.error || 'No response' });
      }
    } catch (e) {
      if (e.name === 'AbortError') sendProgress({ stage: 'cancelled', message: 'Sync cancelled.' });
      else sendProgress({ stage: 'error', error: e.message });
    } finally {
      syncing = false;
      currentAbortController = null;
    }
  }

  // "Automatically sync when Claude opens": when the user enabled it in the
  // popup and GitHub is configured, start one sync of the most recently
  // updated conversations as this page loads. Several Claude tabs or reloads
  // share one throttle so they do not start a sync each.
  const AUTO_SYNC_LIMIT = 20;
  const AUTO_SYNC_MIN_INTERVAL_MS = 10 * 60 * 1000;

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
    runSync(String(AUTO_SYNC_LIMIT));
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
