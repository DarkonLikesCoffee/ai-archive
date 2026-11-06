// Read-only integrity audit of an AI Archive repository snapshot
// (ROADMAP P0.1). It compares archive/index.json with the repository tree
// and, when given, conversation Markdown and file bytes. It never changes
// anything: it only returns findings.
//
// Input:
//   index    parsed archive/index.json
//   tree     [{ path, type, sha, size }] from GET /git/trees/<sha>?recursive=1
//   markdown optional Map(path -> text) of conversation files to check links in
//   readBytes optional async (path) -> Uint8Array, to verify SHA-256 and size
//   readDigest optional (path) -> { size, sha256 } or { error }, the same check
//             from digests computed elsewhere (bytes need not be kept)
//   unreadable optional [{ path, message }]: files that could not be read;
//             each is an error, so a failed download never passes silently
//
// Output: { findings: [{ severity, code, path, message }], counts, checked }.
// severity: 'error' (archive is inconsistent), 'warning' (worth a look).

const CONVERSATIONS_ROOT = 'archive/conversations/';
const ASSET_LINK = /\]\((assets\/[^)\s]+)\)/g;

// The exporter's escaping of file names in Markdown labels
// (escapeMarkdownLabel in extension/background.js).
function exporterLabel(value) {
  return String(value || 'file')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\').replace(/\r?\n/g, ' ')
    .replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    .replace(/([*_\x60!])/g, '\\$1');
}

function finding(severity, code, path, message) {
  return { severity, code, path: path || null, message };
}

function dirname(path) {
  const at = String(path).lastIndexOf('/');
  return at < 0 ? '' : String(path).slice(0, at);
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function auditArchive({ index, tree, markdown = null, readBytes = null, readDigest = null, unreadable = [] } = {}) {
  const findings = [];
  const checked = { conversations: 0, assets: 0, markdownFiles: 0, hashedFiles: 0 };

  if (!index || typeof index !== 'object' || !Array.isArray(index.conversations)) {
    findings.push(finding('error', 'index-malformed', 'archive/index.json', 'The index has no conversations array.'));
    return summarize(findings, checked);
  }
  const blobs = new Map((Array.isArray(tree) ? tree : [])
    .filter((item) => item?.type === 'blob' && typeof item.path === 'string')
    .map((item) => [item.path, item]));

  const identities = new Map();
  const pathOwners = new Map();
  const referenced = new Set(['archive/index.json']);
  const expectedAssets = new Map();

  // Two conversations sharing a Markdown file is an error. Older archives can
  // legitimately share an asset path between conversations whose IDs
  // normalized to the same directory (see sync() in the extension), so a
  // shared asset is only a warning.
  const claim = (path, owner, kind) => {
    const previous = pathOwners.get(path);
    if (previous && previous !== owner) {
      findings.push(kind === 'asset'
        ? finding('warning', 'asset-shared', path, `Referenced by more than one conversation (${previous} and ${owner}).`)
        : finding('error', 'path-shared', path, `Referenced by more than one conversation (${previous} and ${owner}).`));
    }
    pathOwners.set(path, owner);
    referenced.add(path);
  };

  index.conversations.forEach((entry, position) => {
    checked.conversations += 1;
    if (!entry || typeof entry !== 'object') {
      findings.push(finding('error', 'entry-malformed', null, `Index entry ${position} is not an object.`));
      return;
    }
    const label = `${entry.provider ?? '?'}:${entry.account ?? '?'}:${entry.id ?? '?'}`;
    for (const field of ['id', 'provider', 'account', 'path']) {
      if (typeof entry[field] !== 'string' || !entry[field]) {
        findings.push(finding('error', 'entry-missing-field', entry.path, `Index entry ${position} (${label}) has no "${field}".`));
      }
    }
    if (identities.has(label)) {
      findings.push(finding('error', 'identity-duplicate', entry.path, `Conversation ${label} appears more than once in the index.`));
    }
    identities.set(label, entry);

    if (typeof entry.path === 'string' && entry.path) {
      claim(entry.path, label, 'conversation');
      if (!blobs.has(entry.path)) {
        findings.push(finding('error', 'conversation-missing', entry.path, `The Markdown file of ${label} is not in the repository.`));
      }
    }
    if (entry.assets != null && !Array.isArray(entry.assets)) {
      findings.push(finding('error', 'entry-malformed', entry.path, `The assets of ${label} are not a list.`));
    }
    for (const asset of Array.isArray(entry.assets) ? entry.assets : []) {
      checked.assets += 1;
      if (typeof asset?.path !== 'string' || !asset.path) {
        findings.push(finding('error', 'asset-malformed', entry.path, `An asset of ${label} has no path.`));
        continue;
      }
      // The same file may be listed twice by one conversation; not by two.
      claim(asset.path, label, 'asset');
      expectedAssets.set(asset.path, asset);
      const blob = blobs.get(asset.path);
      if (!blob) {
        findings.push(finding('error', 'asset-missing', asset.path, `An attachment of ${label} is not in the repository.`));
      } else if (blob.size != null && asset.size != null && Number(blob.size) !== Number(asset.size)) {
        findings.push(finding('error', 'asset-size-mismatch', asset.path, `The index records ${asset.size} bytes; the repository file has ${blob.size}.`));
      }
    }
    if (Array.isArray(entry.incomplete) && entry.incomplete.length) {
      findings.push(finding('warning', 'conversation-incomplete', entry.path, `${label} was archived with ${entry.incomplete.length} file(s) missing; every sync retries it.`));
    }
  });

  for (const path of blobs.keys()) {
    if (path.startsWith(CONVERSATIONS_ROOT) && !referenced.has(path)) {
      findings.push(finding('warning', 'file-unreferenced', path, 'In the repository but not referenced by the index (orphaned, or written by another tool).'));
    }
  }

  if (markdown instanceof Map) {
    for (const [path, text] of markdown) {
      checked.markdownFiles += 1;
      for (const match of String(text ?? '').matchAll(ASSET_LINK)) {
        const target = `${dirname(path)}/${match[1]}`;
        if (!blobs.has(target)) {
          findings.push(finding('error', 'link-broken', path, `Links to ${match[1]}, which is not in the repository.`));
        }
      }
    }
  }

  // Every file the index records as not archived must be visibly noted in
  // its conversation, so nobody reading the Markdown mistakes it for archived.
  if (markdown instanceof Map) {
    for (const entry of index.conversations) {
      if (!entry || !Array.isArray(entry.incomplete) || !markdown.has(entry.path)) continue;
      const text = String(markdown.get(entry.path) ?? '');
      for (const item of entry.incomplete) {
        // Other kinds are noted at the top without a file name.
        if (!item?.name || !['attachment', 'sandbox-file'].includes(item.kind ?? 'attachment')) continue;
        const label = exporterLabel(item.name);
        const noted = item.kind === 'sandbox-file'
          ? text.includes(`${label} was not archived`)
          : text.includes(`**Not archived: ${label}**`) || text.includes(`**Attachment not archived: ${label}**`);
        if (!noted) {
          findings.push(finding('error', 'incomplete-note-missing', entry.path, `The index records "${item.name}" as not archived, but the conversation has no note saying so.`));
        }
      }
    }
  }

  for (const item of Array.isArray(unreadable) ? unreadable : []) {
    findings.push(finding('error', 'file-unreadable', item.path, `Could not be read from GitHub, so it was not checked: ${item.message}`));
  }

  if (typeof readBytes === 'function' || typeof readDigest === 'function') {
    for (const [path, asset] of expectedAssets) {
      if (!blobs.has(path) || typeof asset.sha256 !== 'string') continue;
      let digest;
      if (typeof readDigest === 'function') {
        digest = await readDigest(path);
        if (!digest || digest.error) {
          // Reported once through `unreadable` when the caller lists it there.
          if (!(Array.isArray(unreadable) && unreadable.some((item) => item.path === path))) {
            findings.push(finding('error', 'file-unreadable', path, `Could not be read from GitHub, so it was not checked: ${digest?.error || 'no data'}`));
          }
          continue;
        }
      } else {
        const bytes = await readBytes(path);
        digest = { size: bytes.byteLength, sha256: await sha256Hex(bytes) };
      }
      checked.hashedFiles += 1;
      if (asset.size != null && digest.size !== Number(asset.size)) {
        findings.push(finding('error', 'asset-size-mismatch', path, `The index records ${asset.size} bytes; the file has ${digest.size}.`));
      }
      if (digest.sha256 !== asset.sha256.toLowerCase()) {
        findings.push(finding('error', 'asset-hash-mismatch', path, 'The file\'s SHA-256 does not match the index.'));
      }
    }
  }

  return summarize(findings, checked);
}

function summarize(findings, checked) {
  const counts = { error: 0, warning: 0 };
  for (const item of findings) counts[item.severity] += 1;
  return { findings, counts, checked };
}

// One line per finding, errors first, for a human-readable report.
export function formatAuditReport(result) {
  const order = { error: 0, warning: 1 };
  const lines = [...result.findings]
    .sort((a, b) => order[a.severity] - order[b.severity] || String(a.path).localeCompare(String(b.path)))
    .map((item) => `${item.severity.toUpperCase()} ${item.code} ${item.path ?? '-'}: ${item.message}`);
  const head = `Archive integrity: ${result.counts.error} error(s), ${result.counts.warning} warning(s); `
    + `${result.checked.conversations} conversations, ${result.checked.assets} attachments, `
    + `${result.checked.markdownFiles} Markdown files and ${result.checked.hashedFiles} file hashes checked.`;
  return [head, ...lines].join('\n');
}
