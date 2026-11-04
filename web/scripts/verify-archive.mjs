#!/usr/bin/env node
// Read-only integrity audit of an AI Archive GitHub repository (ROADMAP P0.1).
//
//   GITHUB_TOKEN=<read-only token> node web/scripts/verify-archive.mjs <owner>/<repo> [--branch main] [--markdown] [--hashes]
//
// --markdown also downloads every conversation file to check its attachment
// links; --hashes downloads every attachment to verify its SHA-256 and size.
// Only GET requests are made, only to api.github.com. Nothing is written,
// repaired or deleted. Exit status: 0 no errors, 1 errors found, 2 could not run.
import { auditArchive, formatAuditReport } from '../src/archiveIntegrity.js';

const API = 'https://api.github.com';
const args = process.argv.slice(2);
const repoArg = args.find((arg) => /^[^-][^/]*\/[^/]+$/.test(arg));
const branchAt = args.indexOf('--branch');
const branchArg = branchAt >= 0 ? args[branchAt + 1] : null;
const token = process.env.GITHUB_TOKEN;

if (!repoArg || !token) {
  console.error('Usage: GITHUB_TOKEN=<read-only token> node web/scripts/verify-archive.mjs <owner>/<repo> [--branch main] [--markdown] [--hashes]');
  process.exit(2);
}
const [owner, repo] = repoArg.split('/');

async function get(path) {
  const response = await fetch(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = JSON.parse(text).message || text; } catch {}
    throw new Error(`GitHub ${response.status} for ${path.split('?')[0]}: ${String(message).slice(0, 200)}`);
  }
  return JSON.parse(text);
}

async function blobBytes(sha) {
  const blob = await get(`/git/blobs/${encodeURIComponent(sha)}`);
  if (blob.encoding !== 'base64') throw new Error(`Unexpected blob encoding for ${sha}`);
  return new Uint8Array(Buffer.from(blob.content, 'base64'));
}

try {
  let ref = null;
  for (const branch of branchArg ? [branchArg] : ['main', 'master']) {
    try { ref = await get(`/git/ref/heads/${encodeURIComponent(branch)}`); break; } catch (error) {
      if (!/GitHub 404/.test(error.message)) throw error;
    }
  }
  if (!ref) throw new Error('No main or master branch found (use --branch).');
  const commit = await get(`/git/commits/${ref.object.sha}`);
  const treeResponse = await get(`/git/trees/${commit.tree.sha}?recursive=1`);
  if (treeResponse.truncated) throw new Error('GitHub truncated the repository tree; the archive is too large to audit this way.');
  const tree = treeResponse.tree;
  const shaOf = new Map(tree.filter((item) => item.type === 'blob').map((item) => [item.path, item.sha]));
  if (!shaOf.has('archive/index.json')) throw new Error('archive/index.json is not in the repository.');

  let index;
  try {
    index = JSON.parse(new TextDecoder().decode(await blobBytes(shaOf.get('archive/index.json'))));
  } catch (error) {
    index = null;
    console.error(`archive/index.json could not be parsed: ${error.message}`);
  }

  let markdown = null;
  if (args.includes('--markdown')) {
    markdown = new Map();
    for (const [path, sha] of shaOf) {
      if (path.startsWith('archive/conversations/') && path.endsWith('.md')) {
        markdown.set(path, new TextDecoder().decode(await blobBytes(sha)));
      }
    }
  }
  const readBytes = args.includes('--hashes') ? (path) => blobBytes(shaOf.get(path)) : null;

  const result = await auditArchive({ index, tree, markdown, readBytes });
  console.log(`${owner}/${repo} @ ${ref.ref} ${ref.object.sha.slice(0, 12)}`);
  console.log(formatAuditReport(result));
  process.exit(result.counts.error ? 1 : 0);
} catch (error) {
  console.error(`Could not audit the archive: ${error.message}`);
  process.exit(2);
}
