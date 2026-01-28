import { z } from 'zod';
import * as path from 'path';
import * as os from 'os';
import { getStorage } from '../../storage/index.js';
import { extractBookText, isPdf, isEpub } from '../epub-engine.js';
import { extractPdfText, extractPdfPageText, extractPdfPagesText, loadPdf } from '../pdf-engine.js';

// ============================================================================
// Schemas
// ============================================================================

export const GetBookTocSchema = z.object({
  bookId: z.string().describe('Book ID or title (partial match supported)'),
});

export const ReadChapterSchema = z.object({
  bookId: z.string().describe('Book ID or title (partial match supported)'),
  chapterIndex: z.number().describe('Chapter index (0-based)'),
  offset: z.number().min(0).optional().describe('Character offset to start reading from (default 0)'),
  limit: z.number().min(1000).max(50000).optional().describe('Maximum characters to return (default: all, max 50000 for large chapters)'),
});

export const GetBookIndexSchema = z.object({
  bookId: z.string().describe('Book ID or title (partial match supported)'),
});

export const SaveBookIndexSchema = z.object({
  bookId: z.string().describe('Book ID or title (partial match supported)'),
  indexData: z.object({
    themes: z.array(z.string()).optional().describe('Major themes in the book'),
    keyTopics: z.array(z.object({
      topic: z.string(),
      chapters: z.array(z.number()).describe('Chapter indices where this topic appears'),
      summary: z.string().optional(),
    })).optional().describe('Key topics and where they appear'),
    chapterSummaries: z.array(z.object({
      chapterIndex: z.number(),
      title: z.string(),
      summary: z.string(),
      keyPoints: z.array(z.string()).optional(),
    })).optional().describe('Summaries for each chapter'),
    overallSummary: z.string().optional().describe('Overall book summary'),
    importantQuotes: z.array(z.object({
      text: z.string(),
      chapterIndex: z.number(),
      context: z.string().optional(),
    })).optional().describe('Notable quotes from the book'),
  }).describe('Semantic index data created by Claude'),
});

// PDF-specific schemas
export const ReadPdfPageSchema = z.object({
  bookId: z.string().describe('Book ID or title (partial match supported)'),
  pageNumber: z.number().min(1).describe('Page number (1-based)'),
  pageCount: z.number().min(1).max(10).optional().describe('Number of pages to read (max 10, default 1)'),
});

export const GetPdfTocSchema = z.object({
  bookId: z.string().describe('Book ID or title (partial match supported)'),
});

// ============================================================================
// Cache for extracted book content to avoid re-parsing
// ============================================================================

interface ExtractedBook {
  bookId: string;
  title: string;
  author: string;
  chapters: Array<{ index: number; title: string; content: string }>;
  extractedAt: number;
}

const bookCache = new Map<string, ExtractedBook>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Find a book by ID, title, or partial title match.
 * This makes the tools more user-friendly since Claude often uses titles instead of IDs.
 */
function findBook(bookIdOrTitle: string): { id: string; path: string; title: string; author: string } | null {
  const storage = getStorage();

  // First try exact ID match
  const byId = storage.getBook(bookIdOrTitle);
  if (byId) {
    return byId;
  }

  // Try to find by title (case-insensitive, partial match)
  const library = storage.getLibrary();
  const searchLower = bookIdOrTitle.toLowerCase().replace(/[_-]/g, ' ');

  // Exact title match first
  const exactMatch = library.books.find(
    (b) => b.title.toLowerCase() === searchLower
  );
  if (exactMatch) {
    return exactMatch;
  }

  // Partial title match (search term contained in title)
  const partialMatch = library.books.find(
    (b) => b.title.toLowerCase().includes(searchLower) ||
           searchLower.includes(b.title.toLowerCase().slice(0, 20))
  );
  if (partialMatch) {
    return partialMatch;
  }

  // Try matching words from the search term
  const searchWords = searchLower.split(/\s+/).filter(w => w.length > 2);
  const wordMatch = library.books.find((b) => {
    const titleLower = b.title.toLowerCase();
    return searchWords.every(word => titleLower.includes(word));
  });
  if (wordMatch) {
    return wordMatch;
  }

  return null;
}

async function getExtractedBook(bookIdOrTitle: string): Promise<ExtractedBook | null> {
  // Find the book first
  const book = findBook(bookIdOrTitle);
  if (!book) {
    return null;
  }

  const bookId = book.id;

  // Check cache
  const cached = bookCache.get(bookId);
  if (cached && Date.now() - cached.extractedAt < CACHE_TTL_MS) {
    return cached;
  }

  // Extract book content based on format
  let extracted;
  if (isPdf(book.path)) {
    extracted = await extractPdfText(book.path, bookId);
  } else {
    extracted = await extractBookText(book.path, bookId);
  }

  const result: ExtractedBook = {
    bookId: extracted.bookId,
    title: extracted.title,
    author: extracted.author,
    chapters: extracted.chapters,
    extractedAt: Date.now(),
  };

  // Cache it
  bookCache.set(bookId, result);
  return result;
}

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Get the table of contents for a book.
 * Returns chapter titles and indices so Claude can decide which to read.
 */
export async function getBookToc(args: z.infer<typeof GetBookTocSchema>) {
  const extracted = await getExtractedBook(args.bookId);

  if (!extracted) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Book not found with ID: ${args.bookId}. Use view_library to see available books.`,
        },
      ],
    };
  }

  // Check if we already have a semantic index
  const storage = getStorage();
  const existingIndex = storage.getSemanticIndex(args.bookId);

  const tocList = extracted.chapters.map((ch) => ({
    index: ch.index,
    title: ch.title,
    contentLength: ch.content.length,
  }));

  const tocText = tocList
    .map((ch) => `${ch.index}. ${ch.title} (${Math.round(ch.contentLength / 1000)}k chars)`)
    .join('\n');

  return {
    content: [
      {
        type: 'text' as const,
        text: `**${extracted.title}** by ${extracted.author}

**Table of Contents (${tocList.length} chapters):**
${tocText}

${existingIndex ? '✓ This book has a semantic index saved.' : '⚠ No semantic index yet. Consider reading key chapters and creating one.'}`,
      },
    ],
    structuredContent: {
      bookId: extracted.bookId,
      title: extracted.title,
      author: extracted.author,
      chapters: tocList,
      hasSemanticIndex: !!existingIndex,
    },
  };
}

/**
 * Read content from a specific chapter, with optional pagination.
 * Claude can use this to analyze the content and build a semantic index.
 * For large chapters, use offset/limit to read progressively.
 */
export async function readChapter(args: z.infer<typeof ReadChapterSchema>) {
  const extracted = await getExtractedBook(args.bookId);

  if (!extracted) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Book not found with ID: ${args.bookId}. Use view_library to see available books.`,
        },
      ],
    };
  }

  const chapter = extracted.chapters.find((ch) => ch.index === args.chapterIndex);

  if (!chapter) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Chapter ${args.chapterIndex} not found. Book has ${extracted.chapters.length} chapters (0-${extracted.chapters.length - 1}).`,
        },
      ],
    };
  }

  const totalLength = chapter.content.length;
  const offset = args.offset ?? 0;

  // For large chapters (>50k chars), default to chunked reading
  const defaultLimit = totalLength > 50000 ? 30000 : totalLength;
  const limit = args.limit ?? defaultLimit;

  // Extract the requested portion
  const contentSlice = chapter.content.slice(offset, offset + limit);
  const endOffset = offset + contentSlice.length;
  const hasMore = endOffset < totalLength;
  const remaining = totalLength - endOffset;

  // Build header with pagination info
  let header = `**${extracted.title}** - Chapter ${chapter.index}: ${chapter.title}`;
  if (offset > 0 || hasMore) {
    header += `\n📄 Reading chars ${offset + 1}-${endOffset} of ${totalLength}`;
    if (hasMore) {
      header += ` | ${Math.round(remaining / 1000)}k chars remaining`;
      header += `\n💡 To continue: read_chapter with offset=${endOffset}`;
    }
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: `${header}

---

${contentSlice}`,
      },
    ],
    structuredContent: {
      bookId: extracted.bookId,
      bookTitle: extracted.title,
      chapterIndex: chapter.index,
      chapterTitle: chapter.title,
      content: contentSlice,
      // Pagination info
      totalLength,
      offset,
      length: contentSlice.length,
      hasMore,
      remaining,
      nextOffset: hasMore ? endOffset : null,
    },
  };
}

/**
 * Get the saved semantic index for a book.
 * Returns null if no index has been created yet.
 */
export async function getBookIndex(args: z.infer<typeof GetBookIndexSchema>) {
  const storage = getStorage();
  const book = findBook(args.bookId);

  if (!book) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Book not found: "${args.bookId}". Use view_library to see available books.`,
        },
      ],
    };
  }

  const index = storage.getSemanticIndex(book.id);

  if (!index) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `No semantic index found for "${book.title}". Use get_book_toc and read_chapter to analyze the book, then save_book_index to create an index.`,
        },
      ],
      structuredContent: {
        bookId: book.id,
        bookTitle: book.title,
        hasIndex: false,
      },
    };
  }

  const indexData = JSON.parse(index.indexData);

  // Format index for display
  let displayText = `**Semantic Index for "${book.title}"**\n`;
  displayText += `Created: ${index.createdAt}\n`;
  displayText += `Updated: ${index.updatedAt}\n\n`;

  if (indexData.overallSummary) {
    displayText += `**Summary:**\n${indexData.overallSummary}\n\n`;
  }

  if (indexData.themes && indexData.themes.length > 0) {
    displayText += `**Themes:** ${indexData.themes.join(', ')}\n\n`;
  }

  if (indexData.keyTopics && indexData.keyTopics.length > 0) {
    displayText += `**Key Topics:**\n`;
    for (const topic of indexData.keyTopics) {
      displayText += `- ${topic.topic} (chapters: ${topic.chapters.join(', ')})\n`;
      if (topic.summary) {
        displayText += `  ${topic.summary}\n`;
      }
    }
    displayText += '\n';
  }

  if (indexData.chapterSummaries && indexData.chapterSummaries.length > 0) {
    displayText += `**Chapter Summaries:**\n`;
    for (const ch of indexData.chapterSummaries) {
      displayText += `${ch.chapterIndex}. ${ch.title}: ${ch.summary}\n`;
    }
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: displayText,
      },
    ],
    structuredContent: {
      bookId: book.id,
      bookTitle: book.title,
      hasIndex: true,
      index: indexData,
      createdAt: index.createdAt,
      updatedAt: index.updatedAt,
    },
  };
}

/**
 * Save a semantic index for a book.
 * Claude creates this after reading and analyzing the book content.
 */
export async function saveBookIndex(args: z.infer<typeof SaveBookIndexSchema>) {
  const storage = getStorage();
  const book = findBook(args.bookId);

  if (!book) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Book not found: "${args.bookId}". Use view_library to see available books.`,
        },
      ],
    };
  }

  // Save the index
  const indexJson = JSON.stringify(args.indexData);
  const saved = storage.saveSemanticIndex(book.id, indexJson);

  // Count what was saved
  const stats = {
    themes: args.indexData.themes?.length || 0,
    keyTopics: args.indexData.keyTopics?.length || 0,
    chapterSummaries: args.indexData.chapterSummaries?.length || 0,
    importantQuotes: args.indexData.importantQuotes?.length || 0,
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: `✓ Semantic index saved for "${book.title}"

Indexed:
- ${stats.themes} themes
- ${stats.keyTopics} key topics
- ${stats.chapterSummaries} chapter summaries
- ${stats.importantQuotes} important quotes

You can now use this index to answer questions about the book without re-reading chapters.`,
      },
    ],
    structuredContent: {
      success: true,
      bookId: book.id,
      bookTitle: book.title,
      indexId: saved.id,
      stats,
      updatedAt: saved.updatedAt,
    },
  };
}

// ============================================================================
// PDF-Specific Tool Implementations
// ============================================================================

/**
 * Read text content from specific PDF page(s).
 * This is the PDF equivalent of readChapter.
 */
export async function readPdfPage(args: z.infer<typeof ReadPdfPageSchema>) {
  const book = findBook(args.bookId);

  if (!book) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Book not found with ID: ${args.bookId}. Use view_library to see available books.`,
        },
      ],
    };
  }

  if (!isPdf(book.path)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `"${book.title}" is not a PDF. Use read_chapter for EPUB books.`,
        },
      ],
    };
  }

  try {
    const pageCount = args.pageCount || 1;
    const result = await extractPdfPagesText(book.path, book.id, args.pageNumber, pageCount);

    if (result.pages.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No content found on page ${args.pageNumber}. Book has ${result.totalPages} pages.`,
          },
        ],
      };
    }

    // Format the pages for display
    const pagesText = result.pages
      .map((p) => `--- Page ${p.pageNumber} ---\n\n${p.text}`)
      .join('\n\n');

    const pageRange = pageCount > 1
      ? `Pages ${args.pageNumber}-${args.pageNumber + result.pages.length - 1}`
      : `Page ${args.pageNumber}`;

    return {
      content: [
        {
          type: 'text' as const,
          text: `**${book.title}** - ${pageRange} of ${result.totalPages}

${pagesText}`,
        },
      ],
      structuredContent: {
        bookId: book.id,
        bookTitle: book.title,
        pages: result.pages,
        totalPages: result.totalPages,
        startPage: args.pageNumber,
        pagesReturned: result.pages.length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error reading PDF page: ${message}`,
        },
      ],
    };
  }
}

/**
 * Get the table of contents (outline/bookmarks) for a PDF.
 * Many PDFs don't have outlines, so this may return an empty list.
 */
export async function getPdfToc(args: z.infer<typeof GetPdfTocSchema>) {
  const book = findBook(args.bookId);

  if (!book) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Book not found with ID: ${args.bookId}. Use view_library to see available books.`,
        },
      ],
    };
  }

  if (!isPdf(book.path)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `"${book.title}" is not a PDF. Use get_book_toc for EPUB books.`,
        },
      ],
    };
  }

  try {
    const pdfInfo = await loadPdf(book.path, book.id);

    // Check if we already have a semantic index
    const storage = getStorage();
    const existingIndex = storage.getSemanticIndex(book.id);

    // Format the TOC
    let tocText = '';
    if (pdfInfo.toc.length > 0) {
      tocText = pdfInfo.toc
        .map((item) => {
          const indent = '  '.repeat(item.level);
          return `${indent}${item.title} (page ${item.pageNumber})`;
        })
        .join('\n');
    } else {
      tocText = '(No outline/bookmarks found in this PDF)';
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `**${pdfInfo.metadata.title}** by ${pdfInfo.metadata.author}

**Format:** PDF (${pdfInfo.metadata.pageCount} pages)

**Table of Contents:**
${tocText}

${existingIndex ? '✓ This book has a semantic index saved.' : '⚠ No semantic index yet. Consider reading key pages and creating one using save_book_index.'}

**Tip:** Use read_pdf_page with pageNumber to read specific pages.`,
        },
      ],
      structuredContent: {
        bookId: book.id,
        title: pdfInfo.metadata.title,
        author: pdfInfo.metadata.author,
        pageCount: pdfInfo.metadata.pageCount,
        toc: pdfInfo.toc,
        hasToc: pdfInfo.toc.length > 0,
        hasSemanticIndex: !!existingIndex,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error reading PDF: ${message}`,
        },
      ],
    };
  }
}
