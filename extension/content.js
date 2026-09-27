(() => {
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

  async function fetchAsset(url, name, mime = 'application/octet-stream', signal) {
    if (!url) return null;
    try {
      const r = await fetch(url, { credentials: 'include', signal });
      if (!r.ok) return null;
      const buffer = await r.arrayBuffer();
      if (!buffer.byteLength) return null;
      return {
        name: safeAssetName(name),
        mime: mime || r.headers.get('content-type') || 'application/octet-stream',
        base64: bytesToBase64(buffer),
        size: buffer.byteLength,
        sha256: await sha256Bytes(buffer),
      };
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      return null;
    }
  }

  async function fetchSandboxFiles(org, conversationId, signal) {
    try {
      const r = await fetch(`/api/organizations/${org}/conversations/${conversationId}/wiggle/list-files`, {
        credentials: 'include', signal,
      });
      if (!r.ok) return [];
      const data = await r.json();
      const files = Array.isArray(data?.files_metadata) ? data.files_metadata : [];
      const out = [];
      for (const file of files) {
        if (!file?.path) continue;
        const url = `/api/organizations/${org}/conversations/${conversationId}/wiggle/download-file?path=${encodeURIComponent(file.path)}`;
        const asset = await fetchAsset(url, file.path.split('/').pop(), file.content_type, signal);
        if (asset) {
          out.push({ ...asset, source_path: file.path, source: 'sandbox' });
        }
      }
      return out;
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      return [];
    }
  }

  function isReplyExcerptAttachment(file) {
    const name = String(file?.file_name || file?.name || '').trim().toLowerCase();
    return name === 'excerpt_from_previous_claude_message.txt' || name.startsWith('excerpt_from_previous_claude_message.');
  }

  async function collectMessageAssets(org, conversationId, messages, signal) {
    const assets = [];
    const seen = new Set();
    const seenNames = new Set();

    // First collect the real binary/image assets exposed directly by messages.
    for (const message of messages) {
      for (const file of (Array.isArray(message.files) ? message.files : [])) {
        const url = file?.preview_asset?.url || file?.preview_url || file?.document_asset?.url;
        if (!url) continue;
        const name = file.file_name || file.name || `file-${file.file_uuid || file.uuid || assets.length + 1}`;
        const key = `${file.file_uuid || file.uuid || name}|${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const asset = await fetchAsset(url, name, file.mime_type || file.content_type || file.file_type, signal);
        if (asset) {
          assets.push({ ...asset, source: 'message', file_uuid: file.file_uuid || file.uuid || null, message_external_id: message.uuid || message.id || null });
          seenNames.add(String(name).toLowerCase());
        }
      }
    }

    // The sandbox contains the original uploads and files generated by Claude's tools.
    const sandbox = await fetchSandboxFiles(org, conversationId, signal);
    for (const asset of sandbox) {
      const key = `${asset.source_path}|${asset.sha256}`;
      const nameKey = String(asset.name || '').toLowerCase();
      if (seen.has(key)) continue;
      if (nameKey && seenNames.has(nameKey)) continue;
      seen.add(key);
      if (nameKey) seenNames.add(nameKey);
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
        if (seenNames.has(nameKey)) continue;
        const text = String(attachment.extracted_content);
        const buffer = new TextEncoder().encode(text).buffer;
        assets.push({
          name,
          mime: attachment.file_type || 'text/plain',
          base64: bytesToBase64(buffer),
          size: buffer.byteLength,
          sha256: await sha256Bytes(buffer),
          source: 'attachment-extracted',
          attachment_name: name,
          message_external_id: message.uuid || message.id || null,
        });
        seenNames.add(nameKey);
      }
    }
    return assets;
  }

  function selectActiveLineage(data) {
    const raw = Array.isArray(data?.chat_messages) ? data.chat_messages : (Array.isArray(data?.messages) ? data.messages : []);
    const leaf = data?.current_leaf_message_uuid;
    if (!leaf) return raw;
    const byId = new Map(raw.filter((m) => m?.uuid).map((m) => [m.uuid, m]));
    let current = byId.get(leaf);
    if (!current) return raw;

    const root = '00000000-0000-4000-8000-000000000000';
    const chain = [];
    const seen = new Set();
    while (current?.uuid && !seen.has(current.uuid)) {
      seen.add(current.uuid);
      chain.push(current);
      const parent = current.parent_message_uuid;
      if (!parent || parent === root) break;
      current = byId.get(parent);
      if (!current) break;
    }
    chain.reverse();
    return chain.length ? chain : raw;
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
      chrome.runtime.sendMessage({ type: 'syncNormalized', conversations }, (r) => {
        if (chrome.runtime.lastError) {
          sendProgress({ stage: 'error', error: chrome.runtime.lastError.message });
          return;
        }
        if (!r?.ok && !r?.cancelled) sendProgress({ stage: 'error', error: r?.error || 'No response' });
      });
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
