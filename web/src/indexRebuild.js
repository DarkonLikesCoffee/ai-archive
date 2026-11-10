// Dry-run reconstruction of archive/index.json from the canonical files
// (ROADMAP P0.2). It answers "what could be rebuilt, and what would be
// lost?" without writing anything. There is deliberately no apply step:
// see docs/design/index-rebuild.md for the reviewed-apply design.
//
// Fields an exporter writes to an index entry, by how a rebuild gets them:
//   exact from the Markdown metadata block: id provider account title model
//     created_at updated_at message_count
//   exact from the repository: path, content_sha256 (SHA-256 of the file),
//     assets[].path, assets[].size, assets[].sha256 (needs the file bytes)
//   approximate: assets[].name (from the link label; newlines were folded),
//     assets[].mime (guessed from the extension), preview, search_text
//     (rebuilt from rendered Markdown, not from Claude's raw message text)
//   not recoverable: exporter_version and format_version (never written to
//     Markdown; leaving them out makes the next sync re-export the
//     conversation, which is safe), incomplete[] details (only the visible
//     "not archived" notes survive, without size, SHA-256 or reason codes),
//     previews[] (only the visible "Preview only" notes survive, without the
//     Claude file UUID a later recovery needs), retained_assets[] (kept files
//     no Markdown links), assets[].variant
import { parseConversationMarkdown } from './github.js';
import { scanAssetLinks, isConversationMarkdownPath } from './archiveIntegrity.js';

export const EXACT_FIELDS = ['id', 'provider', 'account', 'title', 'model', 'created_at', 'updated_at', 'message_count', 'path', 'content_sha256'];
export const APPROXIMATE_FIELDS = ['preview', 'search_text', 'assets.name', 'assets.mime'];
export const UNRECOVERABLE_FIELDS = ['exporter_version', 'format_version', 'incomplete', 'previews', 'retained_assets'];

const NOT_ARCHIVED = /\*\*(?:Attachment not archived|Not archived):|\*\*Incomplete archive:\*\*/;
const MIME_BY_EXTENSION = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  html: 'text/html', zip: 'application/zip',
};

function dirname(path) {
  const at = String(path).lastIndexOf('/');
  return at < 0 ? '' : String(path).slice(0, at);
}

function unescapeLabel(label) {
  return String(label).replace(/\\(.)/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// One conversation file -> the index entry a rebuild could produce, or why not.
export async function rebuildIndexEntry({ path, markdown, tree = [], readBytes = null, readDigest = null }) {
  const parsed = parseConversationMarkdown(markdown);
  const missing = ['id', 'provider', 'account'].filter((field) => typeof parsed[field] !== 'string' || !parsed[field]);
  if (missing.length) {
    return { path, entry: null, problems: [`no ${missing.join('/')} in the metadata block: identity cannot be rebuilt from this file`] };
  }
  const blobs = new Map(tree.filter((item) => item?.type === 'blob').map((item) => [item.path, item]));
  const problems = [];
  const assets = [];
  const seen = new Set();
  // Attachment references only: the exporter never writes one inside a code
  // block or inline code, so links there are quoted text (see scanAssetLinks).
  // A link into the conversation's own attachment folder to a file that exists
  // is the exporter's even when an unclosed code block in the message makes
  // it look like code; both layouts name that folder after the conversation ID.
  const ownFolder = (ref) => {
    const folder = String(ref).split('/')[1]?.toLowerCase() || '';
    const id = String(parsed.id || '').toLowerCase();
    return Boolean(id) && (folder.startsWith(id.slice(0, 8)) || folder.startsWith(id.replace(/[^a-z0-9]+/g, '-').slice(0, 8)));
  };
  for (const link of scanAssetLinks(markdown)) {
    if (link.inCode && !(ownFolder(link.ref) && blobs.has(`${dirname(path)}/${link.ref}`))) continue;
    const match = [null, link.label ?? '', link.ref];
    const assetPath = `${dirname(path)}/${match[2]}`;
    if (seen.has(assetPath)) continue;
    seen.add(assetPath);
    const blob = blobs.get(assetPath);
    if (!blob) {
      problems.push(`links to ${match[2]}, which is not in the repository`);
      continue;
    }
    const extension = assetPath.split('.').pop().toLowerCase();
    const asset = { path: assetPath, sha256: null, size: blob.size ?? null, mime: MIME_BY_EXTENSION[extension] || 'application/octet-stream', name: unescapeLabel(match[1]) };
    if (typeof readDigest === 'function') {
      const digest = await readDigest(assetPath);
      if (digest && !digest.error) {
        asset.sha256 = digest.sha256;
        asset.size = digest.size;
      } else {
        problems.push(`${match[2]} could not be read, so its hash was not rebuilt`);
      }
    } else if (typeof readBytes === 'function') {
      const bytes = await readBytes(assetPath);
      asset.sha256 = await sha256Hex(bytes);
      asset.size = bytes.byteLength;
    }
    assets.push(asset);
  }
  const contents = parsed.messages.map((message) => message.content);
  const entry = {
    id: parsed.id,
    provider: parsed.provider,
    account: parsed.account,
    path,
    title: parsed.title || 'Untitled conversation',
    model: parsed.model ?? null,
    created_at: parsed.created_at ?? null,
    updated_at: parsed.updated_at ?? parsed.created_at ?? null,
    message_count: Number.isFinite(parsed.message_count) ? parsed.message_count : parsed.messages.length,
    assets,
    preview: String(contents.find(Boolean) || '').slice(0, 300),
    search_text: [parsed.title, ...contents].join('\n').slice(0, 250000),
    content_sha256: await sha256Hex(String(markdown)),
  };
  // A rebuild cannot know which files were missing, only that the file says so.
  const flaggedIncomplete = NOT_ARCHIVED.test(String(markdown));
  return { path, entry, flaggedIncomplete, problems };
}

const identity = (entry) => `${entry?.provider}:${entry?.account}:${entry?.id}`;

// Compares a rebuild of every conversation file with the current index.
// Returns a plan; it never writes, repairs or deletes.
export async function planIndexRebuild({ index, tree, markdown, readBytes = null, readDigest = null }) {
  const current = new Map((Array.isArray(index?.conversations) ? index.conversations : []).map((entry) => [identity(entry), entry]));
  const plan = { rebuilt: 0, unchanged: [], differs: [], onlyInFiles: [], onlyInIndex: [], unreadable: [], lostIfApplied: [] };
  const rebuiltKeys = new Set();
  const byConversation = new Map();
  for (const entry of current.values()) {
    const key = `${entry?.provider}:${entry?.id}`;
    byConversation.set(key, [...(byConversation.get(key) || []), entry]);
  }
  for (const [path, text] of markdown) {
    // Attachments that happen to be Markdown are not conversations.
    if (!isConversationMarkdownPath(path)) continue;
    const result = await rebuildIndexEntry({ path, markdown: text, tree, readBytes, readDigest });
    if (!result.entry) {
      plan.unreadable.push({ path, problems: result.problems });
      continue;
    }
    plan.rebuilt += 1;
    const key = identity(result.entry);
    rebuiltKeys.add(key);
    const existing = current.get(key);
    if (!existing) {
      // The same provider conversation may already be indexed under another
      // account (profile): adding this file would index a second copy.
      const indexedUnder = (byConversation.get(`${result.entry.provider}:${result.entry.id}`) || [])
        .filter((entry) => entry.account !== result.entry.account).map((entry) => ({ account: entry.account, path: entry.path }));
      plan.onlyInFiles.push({ key, path, problems: result.problems, ...(indexedUnder.length ? { indexedUnder } : {}) });
      continue;
    }
    const fields = EXACT_FIELDS.filter((field) => JSON.stringify(existing[field] ?? null) !== JSON.stringify(result.entry[field] ?? null));
    const assetKey = (asset) => `${asset.path}|${asset.size}${readBytes || readDigest ? `|${asset.sha256}` : ''}`;
    const before = (existing.assets || []).map(assetKey).sort().join();
    const after = result.entry.assets.map(assetKey).sort().join();
    if (before !== after) fields.push('assets');
    const lost = UNRECOVERABLE_FIELDS.filter((field) => existing[field] != null && !(Array.isArray(existing[field]) && !existing[field].length));
    if (lost.length) plan.lostIfApplied.push({ key, fields: lost });
    if (fields.length || result.problems.length) plan.differs.push({ key, path, fields, problems: result.problems });
    else plan.unchanged.push(key);
  }
  for (const [key, entry] of current) {
    if (!rebuiltKeys.has(key)) plan.onlyInIndex.push({ key, path: entry?.path ?? null });
  }
  return plan;
}

export function formatRebuildPlan(plan) {
  const lines = [
    `Index rebuild dry run (nothing was written): ${plan.rebuilt} conversation file(s) rebuilt; `
      + `${plan.unchanged.length} match the index, ${plan.differs.length} differ, ${plan.onlyInFiles.length} are missing from the index, `
      + `${plan.onlyInIndex.length} index entries were not rebuilt, ${plan.unreadable.length} file(s) could not be rebuilt.`,
  ];
  for (const item of plan.differs) lines.push(`DIFFERS ${item.path}: ${[...item.fields, ...item.problems].join('; ')}`);
  for (const item of plan.onlyInFiles) {
    lines.push(`NOT IN INDEX ${item.path}${item.indexedUnder ? ` (already indexed under ${item.indexedUnder.map((e) => `account "${e.account}"`).join(', ')}; adding it would index a second copy)` : ''}`);
  }
  for (const item of plan.onlyInIndex) lines.push(`NOT REBUILT ${item.path ?? item.key}: no readable conversation file has this identity`);
  for (const item of plan.unreadable) lines.push(`UNREADABLE ${item.path}: ${item.problems.join('; ')}`);
  if (plan.lostIfApplied.length) {
    lines.push(`${plan.lostIfApplied.length} entr${plan.lostIfApplied.length === 1 ? 'y' : 'ies'} would lose ${[...new Set(plan.lostIfApplied.flatMap((item) => item.fields))].join(', ')}; their next sync would re-export them.`);
  }
  return lines.join('\n');
}
