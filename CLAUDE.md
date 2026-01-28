# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LibraLM Reader is an MCP App (not a traditional MCP server) that provides an EPUB/PDF reader inside Claude Desktop. It uses a hybrid architecture: server-side parsing + client-side React rendering with the MCP Apps SDK.

## Commands

```bash
# Build everything (server + UI)
npm run build

# Build components individually
npm run build:server   # TypeScript server compilation
npm run build:ui       # Vite build for React UI

# Development
npm run dev            # Watch mode

# Run the server
BOOK_PATH=/path/to/books npm run serve

# Full rebuild and run
BOOK_PATH=/path/to/books npm run start

# Test with MCP basic-host (after cloning ext-apps repo)
cd /tmp/mcp-ext-apps/examples/basic-host
SERVERS='["http://localhost:3001/mcp"]' npm run start
# Open http://localhost:8080
```

## Architecture

```
Claude Desktop → MCP App iframe → HTTP Server (port 3001) → File System
                                           ↓
                                    SQLite + JSON storage
```

### Key Components

- **src/index.ts** - MCP server factory, registers all tools and the UI resource
- **src/main.ts** - Express HTTP server with `/mcp`, `/health`, `/epub` endpoints
- **src/server/epub-engine.ts** - EPUB parsing with epub2, metadata extraction
- **src/server/pdf-engine.ts** - PDF parsing with pdfjs-dist
- **src/server/tools/** - Tool implementations (book-management.ts, annotations.ts, indexing.ts)
- **src/storage/index.ts** - SQLite for annotations, JSON for library/session
- **src/ui/reader.tsx** - Main React app using MCP Apps SDK hooks (`useApp`, `useHostStyles`)
- **src/ui/styles.css** - "Warm Academic" design system

### Tool Visibility Pattern

Tools have different visibility for app vs model:
- **App-only**: `load_book`, `get_epub_data`, `get_pdf_data`, `sync_reading_context`, annotation tools
- **Model-only**: `get_current_context`, `search_highlights`, `search_notes`, `get_book_toc`, `read_chapter`, `get_pdf_toc`, `read_pdf_page`, `get_book_index`, `save_book_index`
- **Both**: `view_library`

## Critical Technical Patterns

### CSP Workaround for EPUB/PDF Loading
Claude Desktop blocks blob URLs. Solution: Server sends files as base64 → Client converts to ArrayBuffer → Pass to react-reader (EPUB) or PDF.js (PDF).

### Reading Context Sync (Token Limit Workaround)
`updateModelContext()` has ~4000 token limit. Solution: Two-tool pattern:
1. `sync_reading_context` (app-only) - UI calls on every page turn, stores on server
2. `get_current_context` (model-only) - Claude calls when user asks about book

### Visible Text Detection
epub.js uses CSS columns for pagination. Use CFI range from `relocated` event, not viewport checks.

### Highlight Persistence
Store CFI range (EPUB) or page number (PDF) when creating highlights. For EPUBs, use `renditionReady` state to sync rendition + highlight loading timing.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `BOOK_PATH` | /path/to/books | Directory containing EPUB/PDF files |
| `DATA_PATH` | ~/.libralm | Storage for library.json, session.json, annotations.db |
| `PORT` | 3001 | HTTP server port |

## Common Pitfalls

1. Don't call rendition methods before EPUB loads ("this.resources is undefined")
2. Use `relocated` event, not `locationChanged` for page turns
3. epub.js uses horizontal pagination - vertical viewport checks don't work
4. Always store CFI range (EPUB) or page number (PDF) with annotations for navigation
5. Lazy-load covers via `get_book_cover` to avoid wasting tokens
6. PDF.js warnings break stdio mode - use bootstrap pattern (bin/cli.js)
7. Use `pdfjs-dist/legacy/build/pdf.mjs` for Node.js compatibility
