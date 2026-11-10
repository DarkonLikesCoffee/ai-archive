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
// The same link with its label, in the exporter's escaping.
const LABELED_ASSET_LINK = /!?\[((?:\\.|[^\]\\])*)\]\((assets\/[^)\s]+)\)/g;

// The exporter's escaping of file names in Markdown labels
// (escapeMarkdownLabel in extension/background.js).
function exporterLabel(value) {
  return String(value || 'file')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\').replace(/\r?\n/g, ' ')
    .replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    .replace(/([*_\x60!])/g, '\\$1');
}

function finding(severity, code, path, message, extra = {}) {
  return { severity, code, path: path || null, message, ...extra };
}

// The asset links of a Markdown file, once per target, with how often each
// occurs and whether every occurrence is inside a fenced code block or inline
// code (text, not an attachment reference written by the exporter).
//
// Message content is exported verbatim, so a message can leave a code block
// unclosed. A block never spans messages: the fence state is reset at every
// message boundary the exporter writes (a `---` line, then a `## <Role>`
// heading), so links in later messages are not mistaken for code.
const ROLE_HEADING = /^## (You|Claude|[a-z][a-z0-9_-]*)\s*$/;
export function scanAssetLinks(text) {
  const links = new Map();
  let fence = null;
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      if (next < lines.length && ROLE_HEADING.test(lines[next])) { fence = null; continue; }
    }
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0].repeat(marker[1].length);
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*(`{3,}|~{3,})\s*$/.test(line)) fence = null;
      continue;
    }
    // Inline code spans on this line, so a link inside `...` counts as code.
    const codeSpans = [...line.matchAll(/`[^`]*`/g)].map((m) => [m.index, m.index + m[0].length]);
    for (const match of line.matchAll(LABELED_ASSET_LINK)) {
      const inCode = Boolean(fence) || codeSpans.some(([start, end]) => match.index >= start && match.index < end);
      const link = links.get(match[2]) || { ref: match[2], count: 0, inCode: true, label: null };
      link.count += 1;
      if (!inCode && link.label == null) link.label = match[1];
      link.inCode = link.inCode && inCode;
      links.set(match[2], link);
    }
  }
  return [...links.values()];
}

const basename = (path) => String(path).split('/').pop();
const idPrefix = (id) => String(id ?? '').slice(0, 8).toLowerCase();
const slugPrefix = (id) => String(id ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 8);
// Both exporter layouts name a conversation's attachment folder after its ID:
// legacy `assets/<first 8 characters>/`, current `assets/<id slug>-<hash>/`.
function isOwnAssetFolder(folder, id) {
  if (!id) return null;
  const name = String(folder).toLowerCase();
  return name.startsWith(idPrefix(id)) || name.startsWith(slugPrefix(id));
}
// The metadata of a conversation file, in the current comment block or the
// earliest exporter's `---` JSON front matter (as parseMetadata in github.js).
const metadataId = (text) => {
  const value = String(text ?? '').replace(/\r\n?/g, '\n');
  const m = value.match(/^<!--\s*AI_ARCHIVE_METADATA\s*\n([\s\S]*?)\n-->/) || value.match(/^---[ \t]*\n(\{[\s\S]*?\})[ \t]*\n---/);
  if (!m) return null;
  try { const meta = JSON.parse(m[1]); return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null; } catch { return null; }
};

// Conversation files are the Markdown files of an account folder; a `.md`
// file under `assets/` is an attachment (for example a README Claude wrote).
export function isConversationMarkdownPath(path) {
  return String(path).startsWith(CONVERSATIONS_ROOT) && String(path).endsWith('.md') && !String(path).includes('/assets/');
}
// A folder or account name made of one repeated character (aaaaaaaaaa): not
// an exporter ID, most likely sample or test data.
const placeholderSegment = (path) => String(path).split('/').slice(2, -1).find((segment) => /^(.)\1{5,}$/.test(segment)) || null;
const missingCategory = (item) => (item?.too_large ? (item.github_rejected ? 'refused by GitHub' : 'over the upload limit') : 'not available from Claude');

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

  // Records only extension 0.5.29 or later writes, without the marker every
  // such version writes with them: an older extension rewrote the index since,
  // and may have replaced original images with previews (see
  // olderExtensionWroteArchive in extension/background.js).
  const originalFirst = index.conversations.some((entry) => entry && (
    (Array.isArray(entry.assets) && entry.assets.some((asset) => asset?.variant === 'original' || asset?.variant === 'preview'))
    || Array.isArray(entry.preview_only) || Array.isArray(entry.retained_assets)));
  if (originalFirst && index.requires_extension == null) {
    findings.push(finding('warning', 'older-extension-wrote', 'archive/index.json', 'The index records original and preview images but not "requires_extension", which every extension that writes those records adds: an extension older than 0.5.29 has rewritten the index since. In conversations it re-exported, original images may have been replaced by previews; the originals remain in the repository history.'));
  }

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
    // A preview kept next to its original must name one of this entry's
    // assets; a preview-only image must be an indexed asset with no original.
    const assetPaths = new Set((Array.isArray(entry.assets) ? entry.assets : []).map((asset) => asset?.path).filter(Boolean));
    for (const asset of Array.isArray(entry.assets) ? entry.assets : []) {
      if (asset?.preview_of != null && !assetPaths.has(asset.preview_of)) {
        findings.push(finding('warning', 'preview-of-missing', asset.path ?? entry.path, `A preview in ${label} names its original as ${asset.preview_of}, which is not one of the conversation's indexed attachments.`));
      }
    }
    for (const item of Array.isArray(entry.preview_only) ? entry.preview_only : []) {
      const asset = (entry.assets || []).find((candidate) => candidate?.path === item?.path);
      if (!asset) {
        findings.push(finding('warning', 'preview-only-unlisted', item?.path ?? entry.path, `${label} lists a preview-only image that is not one of its indexed attachments.`));
      } else if (asset.preview_of) {
        findings.push(finding('warning', 'preview-only-has-original', item.path, `${label} lists this image as preview-only, but its original is archived (${asset.preview_of}).`));
      }
    }
    // Earlier image files a re-export kept instead of deleting (usually
    // Claude's previews replaced by originals): referenced, not linked.
    for (const kept of Array.isArray(entry.retained_assets) ? entry.retained_assets : []) {
      if (typeof kept?.path !== 'string' || !kept.path) continue;
      claim(kept.path, label, 'asset');
      if (!blobs.has(kept.path)) {
        findings.push(finding('warning', 'retained-asset-missing', kept.path, `A file the index lists as kept from an earlier export of ${label} is not in the repository.`));
      }
    }
    if (Array.isArray(entry.incomplete) && entry.incomplete.length) {
      const listed = entry.incomplete.slice(0, 5).map((item) => `${item?.name || item?.kind || 'file'} (${missingCategory(item)})`).join('; ');
      findings.push(finding('warning', 'conversation-incomplete', entry.path,
        `${label} was archived with ${entry.incomplete.length} file(s) missing; every sync retries it: ${listed}${entry.incomplete.length > 5 ? '; …' : ''}.`,
        { missing: entry.incomplete.map((item) => ({ name: item?.name || null, category: missingCategory(item) })) }));
    }
  });

  // Files by name and indexed assets by blob, to explain missing and
  // unreferenced files (diagnostics only: nothing is matched or repaired).
  const pathsByName = new Map();
  for (const path of blobs.keys()) {
    if (path.startsWith(CONVERSATIONS_ROOT)) pathsByName.set(basename(path), [...(pathsByName.get(basename(path)) || []), path]);
  }
  const indexedAssetByBlob = new Map();
  for (const [path] of expectedAssets) {
    const sha = blobs.get(path)?.sha;
    if (sha && !indexedAssetByBlob.has(sha)) indexedAssetByBlob.set(sha, path);
  }
  const entryByPath = new Map(index.conversations.filter((e) => e && typeof e.path === 'string').map((e) => [e.path, e]));

  const linkedFromMarkdown = new Map();
  if (markdown instanceof Map) {
    for (const [path, text] of markdown) {
      if (!isConversationMarkdownPath(path)) continue;
      checked.markdownFiles += 1;
      const ownerId = entryByPath.get(path)?.id ?? metadataId(text)?.id ?? null;
      for (const link of scanAssetLinks(text)) {
        const target = `${dirname(path)}/${link.ref}`;
        linkedFromMarkdown.set(target, path);
        if (blobs.has(target)) continue;
        const folder = link.ref.split('/')[1] || '';
        const own = isOwnAssetFolder(folder, ownerId);
        const times = link.count > 1 ? ` (${link.count} times)` : '';
        const candidates = (pathsByName.get(basename(link.ref)) || []).filter((candidate) => candidate !== target);
        const prefix = basename(link.ref).match(/^([0-9a-f]{8})-/)?.[1] || null;
        const sameHash = prefix ? candidates.filter((candidate) => String(expectedAssets.get(candidate)?.sha256 || '').startsWith(prefix)) : [];
        const elsewhere = candidates.length
          ? ` A file with the same name exists at ${candidates.slice(0, 3).join(', ')}${candidates.length > 3 ? ', …' : ''}${sameHash.length ? `; the index records a SHA-256 starting with ${prefix} for it, as the name does, so it is very likely the same file` : ''}.`
          : ' No file with that name exists anywhere under archive/conversations/.';
        const extra = { target: link.ref, occurrences: link.count, in_code: link.inCode, own_folder: own, candidates: candidates.slice(0, 10) };
        if (own !== false && !link.inCode) {
          findings.push(finding('error', 'link-broken', path, `Links to ${link.ref}${times}, which is not in the repository.${elsewhere}`, extra));
        } else {
          const why = [
            link.inCode ? 'every occurrence is inside a code block or inline code' : null,
            own === false ? `it points to another conversation's attachment folder (assets/${folder}/), which the exporter never writes` : null,
          ].filter(Boolean).join(', and ');
          findings.push(finding('warning', 'link-unresolved-quoted', path, `Mentions ${link.ref}${times}, which is not in the repository; ${why}, so it is most likely Markdown quoted in the conversation text rather than one of its attachments.${elsewhere}`, extra));
        }
      }
    }
  }

  const identityKey = (meta) => `${meta?.provider ?? '?'}:${meta?.account ?? '?'}:${meta?.id ?? '?'}`;
  for (const path of blobs.keys()) {
    if (!path.startsWith(CONVERSATIONS_ROOT) || referenced.has(path)) continue;
    let kind;
    let detail;
    const placeholder = placeholderSegment(path);
    if (path.endsWith('.md') && !path.includes('/assets/')) {
      const meta = markdown instanceof Map && markdown.has(path) ? metadataId(markdown.get(path)) : null;
      const indexed = meta ? identities.get(identityKey(meta)) : null;
      const elsewhere = meta && !indexed ? index.conversations.filter((e) => e && e.provider === meta.provider && String(e.id) === String(meta.id) && e.account !== meta.account) : [];
      if (indexed) { kind = 'duplicate-conversation'; detail = `An older copy of a conversation the index lists at ${indexed.path} (for example left by a rename).`; }
      else if (elsewhere.length) {
        kind = 'indexed-under-other-account';
        detail = `The same ${meta.provider} conversation (${meta.id}) is indexed under ${elsewhere.map((e) => `account "${e.account}" at ${e.path}`).join(' and ')}; this copy belongs to account "${meta.account}", which the index does not list.`;
      }
      else if (meta?.id) { kind = 'conversation-not-indexed'; detail = `Conversation ${identityKey(meta)} is not in the index; a rebuild dry run (--rebuild-dry-run) shows what indexing it would add.`; }
      else if (markdown instanceof Map) { kind = 'markdown-not-indexed'; detail = 'Its identity cannot be read (no metadata block).'; }
      else { kind = 'markdown-not-indexed'; detail = 'Run with --markdown to classify it.'; }
    } else if (linkedFromMarkdown.has(path)) {
      kind = 'linked-not-indexed';
      const copy = indexedAssetByBlob.get(blobs.get(path)?.sha);
      detail = `Linked from ${linkedFromMarkdown.get(path)}, but not listed among that conversation's attachments in the index.${copy ? ` The same bytes are archived and indexed at ${copy}.` : ' Its bytes are not indexed anywhere else.'}`;
    } else if (indexedAssetByBlob.has(blobs.get(path)?.sha)) {
      kind = 'duplicate-copy';
      detail = `The same bytes are archived and indexed at ${indexedAssetByBlob.get(blobs.get(path).sha)}.`;
    } else {
      const folder = path.split('/assets/')[1]?.split('/')[0] || '';
      // The legacy layout named folders after the first 8 characters of a
      // Claude conversation UUID: 8 hexadecimal characters.
      kind = placeholder ? 'placeholder' : /^[0-9a-f]{8}$/i.test(folder) ? 'legacy-layout' : 'orphaned';
      const owner = kind === 'legacy-layout' ? index.conversations.find((e) => idPrefix(e?.id) === folder.toLowerCase()) : null;
      detail = kind === 'legacy-layout'
        ? `In a legacy attachment folder (assets/${folder}/, the 8-character layout used before 2026-10-26)${owner ? ` of conversation ${owner.id}, which the index now lists at ${owner.path}` : ''}; usually left behind when its conversation was re-exported.`
        : kind === 'placeholder' ? '' : 'Neither the index nor any Markdown file references it.';
    }
    if (placeholder) detail = `${detail ? `${detail} ` : ''}Its path contains "${placeholder}", which is not an ID the exporter writes: most likely sample or test data.`.trim();
    findings.push(finding('warning', 'file-unreferenced', path, `In the repository but not referenced by the index. ${detail}`.trim(), { kind, ...(placeholder ? { placeholder } : {}) }));
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
  const summary = summarizeUnreferenced(result.findings);
  return [head, ...(summary.length ? ['', 'Unreferenced files by kind and folder:', ...summary.map((line) => `  ${line}`), ''] : []), ...lines].join('\n');
}

const KIND_LABELS = {
  'duplicate-conversation': 'older copies of indexed conversations',
  'indexed-under-other-account': 'copies of conversations indexed under another account',
  'conversation-not-indexed': 'conversations missing from the index',
  'markdown-not-indexed': 'Markdown files not in the index',
  'linked-not-indexed': 'attachments linked from Markdown but not indexed',
  'duplicate-copy': 'duplicate copies of indexed attachments',
  'legacy-layout': 'files in legacy attachment folders',
  placeholder: 'files under placeholder-looking names (likely sample or test data)',
  orphaned: 'files nothing references',
};

// Counts of file-unreferenced findings per kind, then per top folder below
// archive/conversations/<provider>/, so dozens of warnings read as a few causes.
export function summarizeUnreferenced(findings) {
  const byKind = new Map();
  for (const item of findings) {
    if (item.code !== 'file-unreferenced') continue;
    const kind = item.kind || 'orphaned';
    const folder = String(item.path).split('/').slice(0, item.path.includes('/assets/') ? 6 : 4).join('/');
    const folders = byKind.get(kind) || new Map();
    folders.set(folder, (folders.get(folder) || 0) + 1);
    byKind.set(kind, folders);
  }
  const lines = [];
  for (const [kind, folders] of [...byKind].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const total = [...folders.values()].reduce((a, b) => a + b, 0);
    lines.push(`${total} ${KIND_LABELS[kind] || kind}:`);
    for (const [folder, count] of [...folders].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10)) {
      lines.push(`  ${count} in ${folder}/`);
    }
    if (folders.size > 10) lines.push(`  … and ${folders.size - 10} more folders`);
  }
  return lines;
}
