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

  function renderToolUse(block) {
    const name = block.name || block.tool_name || 'tool';
    const input = normalizeToolInput(block.input);

    if (input && typeof input === 'object') {
      const command = input.command || input.cmd || input.shell_command;
      if (typeof command === 'string') return `### Claude tool: ${name}\n\n${fence(command, 'bash')}`;
      if (typeof input.code === 'string') return `### Claude tool: ${name}\n\n${fence(input.code, 'text')}`;
    }

    const serialized = typeof input === 'string' ? input : JSON.stringify(input ?? {}, null, 2);
    return `### Claude tool: ${name}\n\n${fence(serialized, 'json')}`;
  }

  function stringifyContentBlock(value) {
    try {
      return JSON.stringify(value, function (key, item) {
        // Avoid embedding base64 media data or other large inline payloads into
        // Markdown. Preserve metadata and make omitted data explicit.
        const base64Data = key === 'data' && this?.type === 'base64';
        if (typeof item === 'string' && /^(data|base64|bytes)$/i.test(key)
          && (item.length > 256 || base64Data)) {
          return `[omitted inline payload: ${item.length} characters]`;
        }
        return item;
      }, 2);
    } catch {
      return String(value);
    }
  }

  function renderToolResult(block) {
    const parts = Array.isArray(block.content) ? block.content : [block.content];
    const text = parts.map((x) => {
      if (typeof x === 'string') return x;
      if (x?.type === 'text' && typeof x.text === 'string') return x.text;
      if (typeof x?.text === 'string') return x.text;
      if (x && typeof x === 'object') return stringifyContentBlock(x);
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

  function renderContentBlocks(blocks, inlineContentState = { imageIndex: 0, mediaIndex: 0 }) {
    if (!Array.isArray(blocks)) return '';
    return blocks.map((block) => {
      if (!block) return '';
      // Do not leak private reasoning even if a variant happens to expose a
      // generic text/content property as well as the usual thinking field.
      if (block.type === 'thinking') return '';
      if (block.type === 'text') return block.text || '';
      if (block.type === 'tool_use') return renderToolUse(block);
      if (block.type === 'tool_result') return renderToolResult(block);
      if (block.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string') {
        const index = inlineContentState.imageIndex++;
        return `[[AI_ARCHIVE_INLINE_IMAGE:${index}]]`;
      }
      if (inlineMediaKind(block)) {
        const index = inlineContentState.mediaIndex++;
        return `[[AI_ARCHIVE_INLINE_MEDIA:${index}]]`;
      }
      // Preserve common plain-text shapes directly for readability.
      if (typeof block.text === 'string') return block.text;
      if (typeof block.content === 'string') return block.content;
      if (Array.isArray(block.content)) return renderContentBlocks(block.content, inlineContentState);
      // Unknown/non-text blocks used to disappear silently. Preserve their type
      // and metadata so citations, media markers, and future block types remain
      // visible to the reader rather than making the transcript look complete.
      return renderUnknownContentBlock(block);
    }).filter(Boolean).join('\\n\\n');
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
      throw new Error('Claude returned an invalid base64 image content block.');
    }
    if (!binary.length) throw new Error('Claude returned an empty base64 image content block.');
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function inlineMediaKind(block) {
    if (!block || !block.source || block.source.type !== 'base64' || typeof block.source.data !== 'string') return null;
    if (block.type === 'image') return null;
    const mediaType = String(block.source.media_type || '').toLowerCase().split(';')[0].trim();
    if (mediaType.startsWith('audio/')) return 'audio';
    if (mediaType.startsWith('video/')) return 'video';
    const type = String(block.type || '').toLowerCase();
    if (['audio', 'input_audio', 'output_audio'].includes(type)) return 'audio';
    if (type === 'video') return 'video';
    return null;
  }

  function collectInlineMediaBlocks(value, result = []) {
    if (Array.isArray(value)) {
      for (const item of value) collectInlineMediaBlocks(item, result);
      return result;
    }
    if (!value || typeof value !== 'object') return result;
    // Tool input/results are rendered as fenced text, not inline message media.
    if (value.type === 'tool_result' || value.type === 'tool_use') return result;
    if (inlineMediaKind(value)) result.push(value);
    if (Array.isArray(value.content)) collectInlineMediaBlocks(value.content, result);
    return result;
  }

  function collectInlineImageBlocks(value, result = []) {
    if (Array.isArray(value)) {
      for (const item of value) collectInlineImageBlocks(item, result);
      return result;
    }
    if (!value || typeof value !== 'object') return result;
    // These block types are rendered as fenced tool input/results, not as
    // inline message content, so their nested images must not receive markers
    // that the Markdown renderer cannot resolve in their original position.
    if (value.type === 'tool_result' || value.type === 'tool_use') return result;
    if (value.type === 'image' && value.source?.type === 'base64'
      && typeof value.source.data === 'string') {
      result.push(value);
    }
    if (Array.isArray(value.content)) collectInlineImageBlocks(value.content, result);
    return result;
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

  async function collectMessageAssets(org, conversationId, messages, signal) {
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

    // Inline base64 image blocks may appear without a corresponding message.files entry.
    // Materialize them as normal assets so Markdown can embed them in place.
    const imageExtensions = {
      'image/avif': 'avif',
      'image/bmp': 'bmp',
      'image/gif': 'gif',
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/svg+xml': 'svg',
      'image/webp': 'webp',
    };
    for (const message of messages) {
      const imageBlocks = collectInlineImageBlocks(message.content);
      for (let index = 0; index < imageBlocks.length; index++) {
        if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
        const block = imageBlocks[index];
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
        if (hashes.has(hash)) {
          if (existingAsset) {
            const indices = Array.isArray(existingAsset.inline_image_indices) ? existingAsset.inline_image_indices : [];
            if (!indices.includes(index)) existingAsset.inline_image_indices = [...indices, index];
          }
          continue;
        }

        const mime = typeof source.media_type === 'string' && source.media_type.startsWith('image/')
          ? source.media_type
          : 'image/png';
        const extension = imageExtensions[mime] || 'img';
        assets.push({
          name: `inline-image-${hash.slice(0, 12)}.${extension}`,
          mime,
          base64: bytesToBase64(buffer),
          size: bytes.byteLength,
          sha256: hash,
          source: 'message-content',
          message_external_id: messageId,
          inline_image_indices: [index],
        });
        hashes.add(hash);
      }
    }

    // Audio/video may also be returned as base64 content blocks rather than as
    // downloadable message.files. Preserve their bytes as assets and place a
    // Markdown link at the original position in the message text.
    const mediaExtensions = {
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
    };
    for (const message of messages) {
      const mediaBlocks = collectInlineMediaBlocks(message.content);
      for (let index = 0; index < mediaBlocks.length; index++) {
        if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
        const block = mediaBlocks[index];
        const source = block.source;
        const kind = inlineMediaKind(block);
        const bytes = base64ToBytes(source.data);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const hash = await sha256Bytes(buffer);
        if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
        const sourceMime = String(source.media_type || '').toLowerCase().split(';')[0].trim();
        const mime = sourceMime.startsWith(`${kind}/`) ? sourceMime : 'application/octet-stream';
        const extension = mediaExtensions[mime] || kind;
        const messageId = message.uuid || message.id || null;
        const existingAsset = assets.find((asset) => {
          if (asset.sha256 !== hash) return false;
          const assetMime = String(asset.mime || '').toLowerCase().split(';')[0].trim();
          if (!assetMime.startsWith(`${kind}/`)) return false;
          const associatedIds = Array.isArray(asset.message_external_ids) && asset.message_external_ids.length
            ? asset.message_external_ids
            : (asset.message_external_id ? [asset.message_external_id] : []);
          return messageId && associatedIds.includes(messageId);
        });
        if (existingAsset) {
          const indices = Array.isArray(existingAsset.inline_media_indices) ? existingAsset.inline_media_indices : [];
          if (!indices.includes(index)) existingAsset.inline_media_indices = [...indices, index];
          continue;
        }

        assets.push({
          name: `inline-${kind}-${hash.slice(0, 12)}.${extension}`,
          mime,
          base64: bytesToBase64(buffer),
          size: bytes.byteLength,
          sha256: hash,
          source: 'message-content',
          message_external_id: messageId,
          inline_media_indices: [index],
        });
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
    const messages = raw.map((m, i) => {
      const content = Array.isArray(m.content)
        ? renderContentBlocks(m.content)
        : (typeof m.text === 'string' ? m.text : '');
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

    const assets = await collectMessageAssets(org, c.uuid, raw, signal);
    return {
      external_id: c.uuid,
      title: c.name || 'Untitled conversation',
      model: c.model || null,
      source_created_at: c.created_at || null,
      source_updated_at: c.updated_at || c.created_at || null,
      message_count: messages.length,
      metadata: { source: 'claude', current_leaf_message_uuid: c.current_leaf_message_uuid || null },
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
      for (let i = 0; i < selected.length; i++) {
        if (signal.aborted) throw new DOMException('Sync cancelled', 'AbortError');
        const conversation = await normalize(await full(org, selected[i].uuid, signal), org, signal);
        if (signal.aborted) throw new DOMException('Sync cancelled', 'AbortError');
        conversations.push(conversation);
        sendProgress({ stage: 'fetching', current: i + 1, total, selected: limit });
      }

      if (signal.aborted) throw new DOMException('Sync cancelled', 'AbortError');
      sendProgress({ stage: 'preparing', current: 0, total, selected: limit });
      // Data is already normalized above; this stage exists to make the handoff explicit.
      sendProgress({ stage: 'preparing', current: total, total, selected: limit });
      if (signal.aborted) throw new DOMException('Sync cancelled', 'AbortError');
      // Keep the content-script lock until the background sync has actually
      // finished; otherwise another startSync message can trigger a second fetch
      // while the first batch is still being committed to GitHub.
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'syncNormalized', conversations }, (response) => {
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
})();
