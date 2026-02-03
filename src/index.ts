import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { viewLibrary, loadBookTool, savePosition, getBookCover, syncReadingContext, getCurrentContext } from './server/tools/book-management.js';
import { addHighlight, addNote, listAnnotations, deleteAnnotation, searchHighlights, searchNotes, addBookmark, listBookmarks, deleteBookmark, exportAnnotations, SearchHighlightsSchema, SearchNotesSchema } from './server/tools/annotations.js';
import { getBookToc, readChapter, getBookIndex, saveBookIndex, readPdfPage, getPdfToc, GetBookTocSchema, ReadChapterSchema, GetBookIndexSchema, SaveBookIndexSchema, ReadPdfPageSchema, GetPdfTocSchema } from './server/tools/indexing.js';
import {
  subscribeFeedTool, unsubscribeFeedTool, refreshFeedTool, refreshAllFeedsTool,
  listFeedsTool, getFeedArticlesTool, getArticleContentTool, markArticleReadTool,
  markAllReadTool, saveArticleTool, syncRssContextTool, getRssContextTool,
  searchRssArticlesTool, getSavedArticlesTool, listSubscriptionsTool,
  proxyImageTool,
  SearchRssArticlesSchema
} from './server/tools/rss-management.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Works both from source (index.ts) and compiled (dist/index.js)
const DIST_DIR = __filename.endsWith('.ts')
  ? path.join(__dirname, '..', 'dist', 'ui')
  : path.join(__dirname, 'ui');

// ============================================================================
// Server Factory
// ============================================================================

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'libralm-reader',
    version: '2.0.0',
  });

  // Resource URI for the reader UI
  const resourceUri = 'ui://libralm-reader/reader.html';

  // ========================================================================
  // Book Management Tools
  // ========================================================================

  // Main tool with UI - view_library opens the reader interface
  registerAppTool(
    server,
    'view_library',
    {
      title: 'View Library',
      description: `Opens the LibraLM Reader UI showing all books in your library.

IMPORTANT: When the user asks about what they're currently reading, what's on the page, or has questions about their book content, use the get_current_context tool to retrieve the current book title, author, reading position, and the visible page content.`,
      inputSchema: {},
      _meta: { ui: { resourceUri } },
    },
    async () => {
      return viewLibrary();
    }
  );

  // App-only tool for loading a book
  registerAppTool(
    server,
    'load_book',
    {
      title: 'Load Book',
      description: 'Loads a book and returns its metadata and table of contents.',
      inputSchema: {
        path: z.string().describe('Path to the book file'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { path: string }) => {
      return loadBookTool(args);
    }
  );

  // App-only tool for saving position
  registerAppTool(
    server,
    'save_position',
    {
      title: 'Save Position',
      description: 'Saves the current reading position for a book.',
      inputSchema: {
        bookId: z.string().describe('Book ID'),
        chapterIndex: z.number().describe('Current chapter index'),
        scrollPosition: z.number().describe('Scroll position (0-1)'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { bookId: string; chapterIndex: number; scrollPosition: number }) => {
      return savePosition(args);
    }
  );

  // App-only tool for getting book covers (fetched lazily by UI)
  registerAppTool(
    server,
    'get_book_cover',
    {
      title: 'Get Book Cover',
      description: 'Returns the cover image for a specific book.',
      inputSchema: {
        bookId: z.string().describe('Book ID'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { bookId: string }) => {
      return getBookCover(args);
    }
  );

  // App-only tool for syncing reading context (called by UI on page changes)
  registerAppTool(
    server,
    'sync_reading_context',
    {
      title: 'Sync Reading Context',
      description: 'Syncs the current reading context from the UI. Called on every page change.',
      inputSchema: {
        bookId: z.string().describe('Book ID'),
        title: z.string().describe('Book title'),
        author: z.string().describe('Book author'),
        position: z.string().describe('Position info (e.g., "Page 5 of 20, 25%")'),
        visibleText: z.string().describe('Currently visible text on the page'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { bookId: string; title: string; author: string; position: string; visibleText: string }) => {
      return syncReadingContext(args);
    }
  );

  // Model-only tool for getting current BOOK reading context
  server.registerTool('get_current_context', {
    description: `Returns what the user is currently reading in the BOOK reader (EPUB/PDF only).

IMPORTANT: This tool is for BOOKS only, not RSS articles!
If the model context shows "--- RSS MODE ---", use get_rss_context instead.

Returns:
- Book title and author
- Current position (page number and percentage)
- The visible text content on the current page

Use when:
- User is reading a BOOK (not RSS)
- User asks about book content they're reading`,
    inputSchema: z.object({}),
  }, async () => {
    return getCurrentContext();
  });

  // ========================================================================
  // Annotation Tools
  // ========================================================================

  // App-only tool for adding highlights (called by UI)
  registerAppTool(
    server,
    'add_highlight',
    {
      title: 'Add Highlight',
      description: 'Adds a highlight to the current book.',
      inputSchema: {
        bookId: z.string().optional().describe('Book ID (uses current book if not provided)'),
        chapterIndex: z.number().optional().describe('Chapter index (uses current chapter if not provided)'),
        text: z.string().describe('The highlighted text'),
        color: z.enum(['yellow', 'green', 'blue', 'pink']).optional().describe('Highlight color'),
        cfiRange: z.string().optional().describe('EPUB CFI range for navigation'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { bookId?: string; chapterIndex?: number; text: string; color?: 'yellow' | 'green' | 'blue' | 'pink'; cfiRange?: string }) => {
      return addHighlight(args);
    }
  );

  // App-only tool for adding notes (called by UI)
  registerAppTool(
    server,
    'add_note',
    {
      title: 'Add Note',
      description: 'Adds a note to the current book.',
      inputSchema: {
        bookId: z.string().optional().describe('Book ID (uses current book if not provided)'),
        chapterIndex: z.number().optional().describe('Chapter index (uses current chapter if not provided)'),
        text: z.string().describe('The note content'),
        quote: z.string().optional().describe('Optional quote the note is attached to'),
        cfiRange: z.string().optional().describe('EPUB CFI range for navigation'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { bookId?: string; chapterIndex?: number; text: string; quote?: string; cfiRange?: string }) => {
      return addNote(args);
    }
  );

  // App-only tool for loading annotations when book opens
  registerAppTool(
    server,
    'list_annotations',
    {
      title: 'List Annotations',
      description: 'Lists all highlights and notes for a book.',
      inputSchema: {
        bookId: z.string().optional().describe('Book ID (uses current book if not provided)'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { bookId?: string }) => {
      return listAnnotations(args);
    }
  );

  // App-only tool for deleting annotations
  registerAppTool(
    server,
    'delete_annotation',
    {
      title: 'Delete Annotation',
      description: 'Deletes a highlight, note, or bookmark by ID.',
      inputSchema: {
        id: z.string().describe('Annotation ID'),
        type: z.enum(['highlight', 'note', 'bookmark']).describe('Type of annotation'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { id: string; type: 'highlight' | 'note' | 'bookmark' }) => {
      return deleteAnnotation(args);
    }
  );

  // ========================================================================
  // Bookmark Tools (App-only)
  // ========================================================================

  registerAppTool(
    server,
    'add_bookmark',
    {
      title: 'Add Bookmark',
      description: 'Adds a bookmark to the current reading position.',
      inputSchema: {
        bookId: z.string().describe('Book ID'),
        chapterIndex: z.number().describe('Chapter index to bookmark'),
        title: z.string().optional().describe('Optional title for the bookmark'),
        cfiRange: z.string().optional().describe('EPUB CFI for exact position'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { bookId: string; chapterIndex: number; title?: string; cfiRange?: string }) => {
      return addBookmark(args);
    }
  );

  registerAppTool(
    server,
    'list_bookmarks',
    {
      title: 'List Bookmarks',
      description: 'Lists all bookmarks for a book.',
      inputSchema: {
        bookId: z.string().describe('Book ID'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { bookId: string }) => {
      return listBookmarks(args);
    }
  );

  // ========================================================================
  // Export Tool (App-only)
  // ========================================================================

  registerAppTool(
    server,
    'export_annotations',
    {
      title: 'Export Annotations',
      description: 'Exports all annotations (highlights, notes, bookmarks) for a book as Markdown or JSON.',
      inputSchema: {
        bookId: z.string().describe('Book ID'),
        format: z.enum(['markdown', 'json']).optional().describe('Export format (default: markdown)'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { bookId: string; format?: 'markdown' | 'json' }) => {
      return exportAnnotations({ bookId: args.bookId, format: args.format || 'markdown' });
    }
  );

  // ========================================================================
  // Model-Only Search Tools (for Claude to query annotations)
  // ========================================================================

  // Search highlights - model only
  server.registerTool('search_highlights', {
    description: `Search through the user's book highlights. Use this when the user asks about their highlights, wants to find specific highlighted passages, or asks what they've marked in their books.

Parameters:
- bookId (optional): Filter to a specific book. Omit to search all books.
- searchText (optional): Search within highlighted text (case-insensitive).
- color (optional): Filter by highlight color (yellow, green, blue, pink).
- limit (optional): Max results to return (default 50).

Example queries this tool handles:
- "What have I highlighted?"
- "Show me my green highlights"
- "Find highlights mentioning 'democracy'"`,
    inputSchema: SearchHighlightsSchema,
  }, async (args) => {
    return searchHighlights(args);
  });

  // Search notes - model only
  server.registerTool('search_notes', {
    description: `Search through the user's book notes. Use this when the user asks about their notes, wants to find specific annotations, or asks what thoughts they've recorded while reading.

Parameters:
- bookId (optional): Filter to a specific book. Omit to search all books.
- searchText (optional): Search within note text or quoted passages (case-insensitive).
- limit (optional): Max results to return (default 50).

Example queries this tool handles:
- "What notes have I taken?"
- "Find my notes about the main character"
- "Show me all my reading notes"`,
    inputSchema: SearchNotesSchema,
  }, async (args) => {
    return searchNotes(args);
  });

  // ========================================================================
  // Claude-Powered Book Reading & Indexing Tools
  // ========================================================================
  //
  // WORKFLOW for answering questions about book content:
  // 1. First check if a semantic index exists: get_book_index(bookTitle)
  // 2. If no index, use get_book_toc to see chapters, then read_chapter to read key chapters
  // 3. After reading, save your analysis with save_book_index for future queries
  // 4. Answer the user's question from your reading/index
  //

  // Get table of contents for a book - model only
  server.registerTool('get_book_toc', {
    description: `Get the table of contents for a book, showing all chapters and their lengths.

WHEN TO USE: Use this when the user asks about a book's content and you need to understand its structure before reading specific chapters.

RECOMMENDED WORKFLOW:
1. First call get_book_index to check if you've already analyzed this book
2. If no index exists, call get_book_toc to see the chapter list
3. Read key chapters with read_chapter (start with intro/conclusion, then topic-specific chapters)
4. Save your analysis with save_book_index for future queries
5. Answer the user's question

Parameters:
- bookId: The book title (e.g., "Life 3.0") or ID. Partial title matches work.

Returns:
- List of chapters with indices, titles, and content lengths
- Whether a semantic index already exists for this book`,
    inputSchema: GetBookTocSchema,
  }, async (args) => {
    return getBookToc(args);
  });

  // Read a specific chapter - model only (supports progressive reading)
  server.registerTool('read_chapter', {
    description: `Read content from a specific chapter, with optional pagination for large chapters.

Use this tool to:
- Analyze chapter content in depth
- Extract key themes and concepts
- Find specific information
- Build a semantic index of the book

Parameters:
- bookId: The book title (e.g., "Life 3.0") or ID. Partial title matches work.
- chapterIndex: The chapter index (0-based) from get_book_toc
- offset: (optional) Character position to start reading from. Use this to continue reading large chapters.
- limit: (optional) Maximum characters to return (1000-50000). For chapters >50k chars, defaults to 30k.

**Progressive Reading:** For large chapters (see char counts in get_book_toc), the response will include:
- How many characters were read and how many remain
- The nextOffset value to continue reading

Example workflow for a 180k char chapter:
1. read_chapter(bookId, chapterIndex) → returns first 30k chars, nextOffset=30000
2. read_chapter(bookId, chapterIndex, offset=30000) → returns next 30k, nextOffset=60000
3. Continue until hasMore=false

This prevents filling up context with huge chapters. Read strategically!`,
    inputSchema: ReadChapterSchema,
  }, async (args) => {
    return readChapter(args);
  });

  // Get saved semantic index - model only
  server.registerTool('get_book_index', {
    description: `CHECK THIS FIRST before reading a book. Retrieve a previously saved semantic index.

Semantic indexes contain your analysis of the book: themes, key topics, chapter summaries, important quotes, etc.
If an index exists, you can answer questions without re-reading chapters.

ALWAYS call this first when the user asks about a book's content.

Parameters:
- bookId: The book title (e.g., "Life 3.0") or ID. Partial title matches work.

Returns:
- If index exists: Full analysis with themes, summaries, key topics
- If no index: Instructions to create one using get_book_toc and read_chapter`,
    inputSchema: GetBookIndexSchema,
  }, async (args) => {
    return getBookIndex(args);
  });

  // Save semantic index - model only
  server.registerTool('save_book_index', {
    description: `Save a semantic index after analyzing a book.

After reading and analyzing chapters, use this tool to save your analysis for future reference.
This allows you to answer questions about the book later without re-reading it.

Parameters:
- bookId: The book title (e.g., "Life 3.0") or ID. Partial title matches work.
- indexData: Your analysis containing:
  - themes: Major themes in the book
  - keyTopics: Key topics with chapter locations and summaries
  - chapterSummaries: Summary for each chapter
  - overallSummary: Overall book summary
  - importantQuotes: Notable quotes with context

Tell the user you're saving the index so they understand this is a one-time analysis that will speed up future queries.`,
    inputSchema: SaveBookIndexSchema,
  }, async (args) => {
    return saveBookIndex(args);
  });

  // ========================================================================
  // PDF-Specific Reading Tools (Model-Only)
  // ========================================================================

  // Read PDF page(s) - model only
  server.registerTool('read_pdf_page', {
    description: `Read text content from specific page(s) in a PDF book.

Use this tool to:
- Read PDF content page by page
- Analyze specific pages in depth
- Build a semantic index of a PDF

Parameters:
- bookId: The book title (e.g., "AI Book") or ID. Partial title matches work.
- pageNumber: The page number to read (1-based, e.g., 1 for first page)
- pageCount: Optional number of consecutive pages to read (max 10, default 1)

Returns the full text content of the requested page(s). For PDFs without a table of contents, consider reading pages 1-5 for introduction, then jumping to specific pages based on content.`,
    inputSchema: ReadPdfPageSchema,
  }, async (args) => {
    return readPdfPage(args);
  });

  // Get PDF table of contents - model only
  server.registerTool('get_pdf_toc', {
    description: `Get the table of contents (outline/bookmarks) for a PDF book.

Use this tool to understand a PDF's structure before reading specific pages. Note that many PDFs don't have embedded outlines - in that case, you'll need to explore the content by reading pages directly.

Parameters:
- bookId: The book title (e.g., "AI Book") or ID. Partial title matches work.

Returns:
- PDF metadata (title, author, page count)
- Outline/bookmarks with page numbers (if available)
- Whether a semantic index already exists for this book`,
    inputSchema: GetPdfTocSchema,
  }, async (args) => {
    return getPdfToc(args);
  });

  // App-only tool for getting EPUB as base64
  registerAppTool(
    server,
    'get_epub_data',
    {
      title: 'Get EPUB Data',
      description: 'Returns the EPUB file content as base64 for embedding.',
      inputSchema: {
        path: z.string().describe('Path to the EPUB file'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { path: string }) => {
      const bookPath = args.path;

      if (!fs.existsSync(bookPath)) {
        throw new Error(`Book not found: ${bookPath}`);
      }

      const buffer = fs.readFileSync(bookPath);
      const base64 = buffer.toString('base64');

      return {
        content: [{ type: 'text' as const, text: 'EPUB data loaded.' }],
        structuredContent: {
          base64,
          mimeType: 'application/epub+zip',
          size: buffer.length,
        },
      };
    }
  );

  // App-only tool for getting PDF as base64
  registerAppTool(
    server,
    'get_pdf_data',
    {
      title: 'Get PDF Data',
      description: 'Returns the PDF file content as base64 for embedding.',
      inputSchema: {
        path: z.string().describe('Path to the PDF file'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { path: string }) => {
      const bookPath = args.path;

      if (!fs.existsSync(bookPath)) {
        throw new Error(`Book not found: ${bookPath}`);
      }

      const buffer = fs.readFileSync(bookPath);
      const base64 = buffer.toString('base64');

      return {
        content: [{ type: 'text' as const, text: 'PDF data loaded.' }],
        structuredContent: {
          base64,
          mimeType: 'application/pdf',
          size: buffer.length,
        },
      };
    }
  );

  // ========================================================================
  // RSS Feed Management Tools
  // ========================================================================

  // App-only: Subscribe to a new feed
  registerAppTool(
    server,
    'subscribe_feed',
    {
      title: 'Subscribe to Feed',
      description: 'Subscribe to a new RSS/Atom feed.',
      inputSchema: {
        url: z.string().url().describe('RSS/Atom feed URL to subscribe to'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { url: string }) => {
      return subscribeFeedTool(args);
    }
  );

  // App-only: Unsubscribe from a feed
  registerAppTool(
    server,
    'unsubscribe_feed',
    {
      title: 'Unsubscribe from Feed',
      description: 'Unsubscribe from an RSS feed.',
      inputSchema: {
        feedId: z.string().describe('Feed ID to unsubscribe from'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { feedId: string }) => {
      return unsubscribeFeedTool(args);
    }
  );

  // App-only: Refresh a single feed
  registerAppTool(
    server,
    'refresh_feed',
    {
      title: 'Refresh Feed',
      description: 'Refresh a single RSS feed to get new articles.',
      inputSchema: {
        feedId: z.string().describe('Feed ID to refresh'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { feedId: string }) => {
      return refreshFeedTool(args);
    }
  );

  // App-only: Refresh all feeds
  registerAppTool(
    server,
    'refresh_all_feeds',
    {
      title: 'Refresh All Feeds',
      description: 'Refresh all subscribed RSS feeds.',
      inputSchema: {},
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async () => {
      return refreshAllFeedsTool();
    }
  );

  // App-only: List feeds
  registerAppTool(
    server,
    'list_feeds',
    {
      title: 'List Feeds',
      description: 'List all subscribed RSS feeds with unread counts.',
      inputSchema: {},
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async () => {
      return listFeedsTool();
    }
  );

  // App-only: Get articles for a feed
  registerAppTool(
    server,
    'get_feed_articles',
    {
      title: 'Get Feed Articles',
      description: 'Get articles for a feed or all feeds.',
      inputSchema: {
        feedId: z.string().optional().describe('Feed ID (omit for all feeds)'),
        unreadOnly: z.boolean().optional().describe('Only show unread articles'),
        savedOnly: z.boolean().optional().describe('Only show saved articles'),
        limit: z.number().optional().describe('Max articles to return (default 50)'),
        offset: z.number().optional().describe('Offset for pagination'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { feedId?: string; unreadOnly?: boolean; savedOnly?: boolean; limit?: number; offset?: number }) => {
      return getFeedArticlesTool(args);
    }
  );

  // App-only: Get full article content
  registerAppTool(
    server,
    'get_article_content',
    {
      title: 'Get Article Content',
      description: 'Get the full content of an RSS article.',
      inputSchema: {
        articleId: z.string().describe('Article ID'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { articleId: string }) => {
      return getArticleContentTool(args);
    }
  );

  // App-only: Mark article read/unread
  registerAppTool(
    server,
    'mark_article_read',
    {
      title: 'Mark Article Read',
      description: 'Mark an RSS article as read or unread.',
      inputSchema: {
        articleId: z.string().describe('Article ID'),
        isRead: z.boolean().describe('Mark as read (true) or unread (false)'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { articleId: string; isRead: boolean }) => {
      return markArticleReadTool(args);
    }
  );

  // App-only: Mark all articles in feed as read
  registerAppTool(
    server,
    'mark_all_read',
    {
      title: 'Mark All Read',
      description: 'Mark all articles in a feed as read.',
      inputSchema: {
        feedId: z.string().describe('Feed ID'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { feedId: string }) => {
      return markAllReadTool(args);
    }
  );

  // App-only: Toggle article saved state
  registerAppTool(
    server,
    'save_article',
    {
      title: 'Save Article',
      description: 'Toggle saved/starred state for an article.',
      inputSchema: {
        articleId: z.string().describe('Article ID'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { articleId: string }) => {
      return saveArticleTool(args);
    }
  );

  // App-only: Sync RSS reading context
  registerAppTool(
    server,
    'sync_rss_context',
    {
      title: 'Sync RSS Context',
      description: 'Sync the current RSS article context from the UI.',
      inputSchema: {
        articleId: z.string().describe('Article ID'),
        feedTitle: z.string().describe('Feed title'),
        articleTitle: z.string().describe('Article title'),
        author: z.string().optional().describe('Article author'),
        pubDate: z.string().optional().describe('Publication date'),
        content: z.string().describe('Article content (visible text)'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { articleId: string; feedTitle: string; articleTitle: string; author?: string; pubDate?: string; content: string }) => {
      return syncRssContextTool(args);
    }
  );

  // App-only: Proxy external images (bypass CSP)
  registerAppTool(
    server,
    'proxy_image',
    {
      title: 'Proxy Image',
      description: 'Fetch an external image and return as base64 data URL (bypasses CSP).',
      inputSchema: {
        url: z.string().url().describe('External image URL to proxy'),
      },
      _meta: { ui: { resourceUri, visibility: ['app'] } },
    },
    async (args: { url: string }) => {
      return proxyImageTool(args);
    }
  );

  // Model-only: Get current RSS context
  server.registerTool('get_rss_context', {
    description: `Returns what the user is currently reading in the RSS READER (for RSS articles/feeds).

CRITICAL: ALWAYS call this tool FIRST before answering any question about "this article", "what am I reading", or the current article content. The user may have switched to a different article since your last check. DO NOT assume based on previous conversation - always verify with this tool.

IMPORTANT: Use this tool when the model context shows "--- RSS MODE ---".
Do NOT use get_current_context for RSS - that tool is for BOOKS only.

Parameters:
- articleId (optional): The article ID from the model context. If provided, fetches directly from database.

Returns:
- Feed and article title
- Author and publication date
- The full article content

ALWAYS use this tool to check before:
- Answering "what is this article about?"
- Summarizing the article
- Discussing article content
- ANY question that relates to the current article

Example: If context shows 'Article ID: abc123', call get_rss_context with articleId="abc123"`,
    inputSchema: z.object({
      articleId: z.string().optional().describe('Article ID from the model context (e.g., "Article ID: xxx")'),
    }),
  }, async (args: { articleId?: string }) => {
    return getRssContextTool(args.articleId);
  });

  // Model-only: Search RSS articles
  server.registerTool('search_rss_articles', {
    description: `Search through the user's RSS articles. Use this when the user asks to find articles or search their feeds.

Parameters:
- query: Search text
- feedId (optional): Limit to specific feed
- limit (optional): Max results (default 50)

Example queries:
- "Find articles about AI"
- "Search for posts about programming"`,
    inputSchema: SearchRssArticlesSchema,
  }, async (args) => {
    return searchRssArticlesTool(args);
  });

  // Model-only: Get saved articles
  server.registerTool('get_saved_articles', {
    description: `Get the user's saved/starred RSS articles. Use when the user asks about their saved or bookmarked articles.`,
    inputSchema: z.object({}),
  }, async () => {
    return getSavedArticlesTool();
  });

  // Model-only: List RSS subscriptions
  server.registerTool('list_subscriptions', {
    description: `List all RSS feeds the user is subscribed to. Use when the user asks what feeds they follow or about their subscriptions.`,
    inputSchema: z.object({}),
  }, async () => {
    return listSubscriptionsTool();
  });

  // ========================================================================
  // UI Resource
  // ========================================================================

  registerAppResource(
    server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const uiPath = path.join(DIST_DIR, 'index.html');

      let content: string;
      if (fs.existsSync(uiPath)) {
        content = fs.readFileSync(uiPath, 'utf-8');
      } else {
        content = `<!DOCTYPE html>
<html>
<head>
  <title>LibraLM Reader</title>
  <style>
    body {
      font-family: system-ui;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      background: #faf8f5;
      color: #2c2416;
    }
  </style>
</head>
<body>
  <div>
    <h1>LibraLM Reader</h1>
    <p>UI not built. Run: npm run build:ui</p>
  </div>
</body>
</html>`;
      }

      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: content,
          },
        ],
      };
    }
  );

  return server;
}
