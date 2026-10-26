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
    return r.json();
  }

  async function full(org, id, signal) {
    const r = await fetch(`/api/organizations/${org}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`, { credentials: 'include', signal });
    if (!r.ok) throw Error(`Claude conversation ${id}: ${r.status}`);
    return r.json();
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

  function renderToolResult(block) {
    const parts = Array.isArray(block.content) ? block.content : [block.content];
    const text = parts.map((x) => {
      if (typeof x === 'string') return x;
      if (x?.type === 'text' && typeof x.text === 'string') return x.text;
      if (typeof x?.text === 'string') return x.text;
      if (x && typeof x === 'object') return JSON.stringify(x, null, 2);
      return '';
    }).filter(Boolean).join('\n');
    if (!text) return '';
    const name = block.name || block.tool_name || 'tool';
    return `### Tool result: ${name}${block.is_error ? ' (error)' : ''}\n\n${fence(text, 'text')}`;
  }

  function renderContentBlocks(blocks) {
    if (!Array.isArray(blocks)) return '';
    return blocks.map((block) => {
      if (!block) return '';
      if (block.type === 'text') return block.text || '';
      if (block.type === 'tool_use') return renderToolUse(block);
      if (block.type === 'tool_result') return renderToolResult(block);
      // Preserve quote/reference/citation-like blocks instead of silently dropping them.
      if (typeof block.text === 'string') return block.text;
      if (typeof block.content === 'string') return block.content;
      if (Array.isArray(block.content)) return renderContentBlocks(block.content);
      if (block.type === 'thinking' && typeof block.thinking === 'string') return '';
      return '';
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

  async function fetchSandboxFiles(org, conversationId, signal) {
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

    return mapWithConcurrency(
      data.files_metadata,
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
    for (const message of messages) {
      for (const file of (Array.isArray(message.files) ? message.files : [])) {
        const url = file?.preview_asset?.url || file?.preview_url || file?.document_asset?.url;
        if (!url) continue;
        const name = file.file_name || file.name || `file-${file.file_uuid || file.uuid || directTasks.length + 1}`;
        const key = `${file.file_uuid || file.uuid || name}|${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        directTasks.push({ message, file, url, name });
      }
    }

    const directAssets = await mapWithConcurrency(
      directTasks,
      ASSET_DOWNLOAD_CONCURRENCY,
      async ({ message, file, url, name }) => {
        const asset = await fetchAsset(url, name, file.mime_type || file.content_type || file.file_type, signal);
        return { asset, message, file };
      },
      signal,
    );

    for (const { asset, message, file } of directAssets) {
      const messageId = message.uuid || message.id || null;
      assets.push({ ...asset, source: 'message', file_uuid: file.file_uuid || file.uuid || null, message_external_id: messageId });
      const nameKey = String(asset.name || '').toLowerCase();
      messageAssetFingerprints.add(`${nameKey}|${asset.sha256}`);
      fingerprintsForMessage(message).add(`${nameKey}|${asset.sha256}`);
    }

    // The sandbox contains the original uploads and files generated by Claude's tools.
    const sandbox = await fetchSandboxFiles(org, conversationId, signal);
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
        if (!attachment?.extracted_content || isReplyExcerptAttachment(attachment)) continue;
        const name = String(attachment.file_name || attachment.name || 'attachment.txt');
        const nameKey = name.toLowerCase();
        const text = String(attachment.extracted_content);
        const buffer = new TextEncoder().encode(text).buffer;
        const hash = await sha256Bytes(buffer);
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
      }
    }
    return assets;
  }

  function selectActiveLineage(data) {
    const raw = Array.isArray(data?.chat_messages) ? data.chat_messages : (Array.isArray(data?.messages) ? data.messages : []);
    const leaf = data?.current_leaf_message_uuid;
    if (!leaf) return raw;

    const conversationLabel = String(data?.name || data?.uuid || 'Untitled conversation');
    const byId = new Map();
    for (const message of raw) {
      if (!message?.uuid) continue;
      if (byId.has(message.uuid)) {
        throw new Error(
          `Cannot safely export Claude conversation "${conversationLabel}": message UUID "${message.uuid}" appears more than once. No archive changes were submitted to GitHub.`,
        );
      }
      byId.set(message.uuid, message);
    }

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
      if (!current.uuid || seen.has(current.uuid)) {
        throw new Error(
          `Cannot safely export Claude conversation "${conversationLabel}": the active message lineage contains a cycle or an invalid message ID. No archive changes were submitted to GitHub.`,
        );
      }
      seen.add(current.uuid);
      chain.push(current);

      const parent = current.parent_message_uuid;
      if (!parent || parent === root) break;

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
        conversations.push(await normalize(await full(org, selected[i].uuid, signal), org, signal));
        sendProgress({ stage: 'fetching', current: i + 1, total, selected: limit });
      }

      sendProgress({ stage: 'preparing', current: 0, total, selected: limit });
      // Data is already normalized above; this stage exists to make the handoff explicit.
      sendProgress({ stage: 'preparing', current: total, total, selected: limit });
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
