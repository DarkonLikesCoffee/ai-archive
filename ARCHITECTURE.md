# AI Archive — architecture and technical map

## Overview

AI Archive separates collection, canonical storage and presentation:

```text
Claude.ai (current provider)
        |
        v
Chromium Manifest V3 extension
  - content.js: provider API access, discovery, fetch, normalization
  - background.js: sync lifecycle, validation, GitHub API, atomic publication
  - popup.html / popup.js: settings, progress, controls, diagnostics
        |
        v
GitHub archive repository
  - archive/conversations/<provider>/<account>/*.md
  - archive/conversations/<provider>/<account>/assets/*
  - archive/index.json (derived navigation/search index)
        |
        v
React + Vite viewer
  - reads index and Markdown from GitHub
  - resolves and caches attachment assets
  - search, reader, navigation, statistics, print
```

This map is a conceptual guide. Verify current functions and imports before changing code.

## Main code areas

### Extension

- `extension/content.js`: talks to Claude's web application APIs, paginates conversations, fetches full conversation payloads, discovers and downloads assets, normalizes content and transfers work to the background service worker.
- `extension/background.js`: owns sync state, receives and validates transferred data, manages GitHub settings and API requests, builds Git objects, updates the branch ref and records diagnostics.
- `extension/popup.html` and `extension/popup.js`: user controls and sync status.
- `extension/manifest.json`: Manifest V3 permissions, host permissions and entry points.
- `extension/*.test.js`: extension unit/regression tests.

### Archive contract

- `docs/archive-format-v1.md` is authoritative for canonical Markdown, identity, attachment references, index semantics and compatibility.
- Conversation Markdown is canonical.
- Attachments are normal Git repository files.
- `archive/index.json` is derived/rebuildable navigation and search state.
- Provider identity is scoped by provider and account.

### Web viewer

- `web/src/main.jsx`: React application, settings, list, reader and UI composition.
- `web/src/github.js`: GitHub reads, index/conversation/asset loading and request resilience.
- `web/src/markdownRenderer.js`, `web/src/toolSections.js`, `web/src/attachmentSecurity.js`: Markdown/tool parsing and safe attachment rendering.
- `web/src/assetCache.js`: content-hash keyed browser cache.
- `web/src/archiveSearch.js`, `web/src/archiveStats.js`, `web/src/listOrder.js`, `web/src/outline.js`, `web/src/route.js`, `web/src/shortcuts.js`: viewer features and supporting pure logic.
- `web/src/*.test.js`: viewer unit/regression tests.
- `web/e2e/viewer.e2e.cjs`: browser-level viewer checks.

### End-to-end tests

- `e2e/extension-sync.e2e.cjs`: runs the extension in Chromium with simulated Claude and GitHub services. Valuable for deterministic sync behavior; not proof of live API compatibility.
- Live Claude account verification must be done manually by the user. Never use real private conversation content as a public fixture.

## Data flow and trust boundaries

1. Claude API responses are untrusted, undocumented provider input.
2. The content script validates and normalizes conversation/message structures and extracts attachment bytes.
3. The extension background validates transfer ordering, message/asset completeness, hashes and sizes.
4. GitHub blobs/trees/commits are prepared before the branch ref is updated.
5. The index points to canonical Markdown and asset files; it must not become the sole copy of content.
6. The viewer reads repository content, renders untrusted Markdown safely and fetches assets only from trusted GitHub hosts.

## Critical invariants

- No silent loss of messages, tool fields, unknown blocks or attachment bytes.
- Preserve active branch semantics.
- Never replace a known-good complete archive entry with an incomplete export.
- Never publish partial transfer data.
- Never send a GitHub Authorization header to a host outside the explicit trusted allowlist.
- Keep Markdown rendering safe against HTML/script injection and unsafe URL protocols.
- Keep old archive formats readable; document migrations.
- Never treat mock-based tests as live provider verification.

## Test commands

- `node --test extension/*.test.js`
- `cd web && npm test`
- `cd web && npm run build`
- `node e2e/extension-sync.e2e.cjs`
- Viewer E2E: inspect `web/e2e/viewer.e2e.cjs` and `web/README.md` for its expected server/environment setup.

## Current known risks

- Claude endpoints are undocumented and may change.
- Upgraded Claude workspaces have had distinct file handling; the latest known test removed a misleading retired-Wiggle 404, but actual generated-file presence still needs user verification.
- GitHub's Git history retains prior blobs after files are removed from the current tree; repository size can grow over time.
- Simulated-service E2E tests do not validate live Claude response changes.
- The current provider adapter boundary is incomplete; do not assume all shared logic is already provider-neutral.
