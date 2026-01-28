import { z } from 'zod';
import * as path from 'path';
import * as os from 'os';
import { getStorage, type LibraryBook } from '../../storage/index.js';
import { scanDirectory, loadBook, isEpub, loadPdfBook } from '../epub-engine.js';

// ============================================================================
// Schemas
// ============================================================================

export const ViewLibrarySchema = z.object({});

export const LoadBookSchema = z.object({
  path: z.string().describe('Path to the book file'),
});

export const SavePositionSchema = z.object({
  bookId: z.string().describe('Book ID'),
  chapterIndex: z.number().describe('Current chapter index'),
  scrollPosition: z.number().min(0).max(1).describe('Scroll position (0-1)'),
});

export const SyncReadingContextSchema = z.object({
  bookId: z.string().describe('Book ID'),
  title: z.string().describe('Book title'),
  author: z.string().describe('Book author'),
  position: z.string().describe('Position info (e.g., "Page 5 of 20, 25%")'),
  visibleText: z.string().describe('Currently visible text on the page'),
});

// ============================================================================
// Current Reading Context (synced from UI)
// ============================================================================

interface ReadingContext {
  bookId: string;
  title: string;
  author: string;
  position: string;
  visibleText: string;
  lastUpdated: string;
}

let currentReadingContext: ReadingContext | null = null;

// ============================================================================
// Tool Implementations
// ============================================================================

export async function viewLibrary() {
  const storage = getStorage();
  const bookPath = process.env.BOOK_PATH || path.join(os.homedir(), 'Books');

  // Scan directory for books
  const scannedBooks = await scanDirectory(bookPath);

  // Update library with scanned books
  const library = storage.getLibrary();
  library.bookPath = bookPath;

  // Add/update books
  for (const scanned of scannedBooks) {
    const bookId = storage.hashBook(scanned.path);
    const existingBook = library.books.find((b) => b.id === bookId);

    if (existingBook) {
      // Update existing book
      existingBook.title = scanned.title;
      existingBook.author = scanned.author;
      existingBook.coverUrl = scanned.coverUrl;
      existingBook.description = scanned.description;
    } else {
      // Add new book
      library.books.push({
        id: bookId,
        path: scanned.path,
        title: scanned.title,
        author: scanned.author,
        format: scanned.format,
        coverUrl: scanned.coverUrl,
        description: scanned.description,
        addedAt: new Date().toISOString(),
      });
    }
  }

  // Remove books that no longer exist
  library.books = library.books.filter((book) =>
    scannedBooks.some((s) => s.path === book.path)
  );

  storage.saveLibrary(library);

  // Prepare response - exclude coverUrl to save tokens (UI fetches separately)
  const bookSummaries = library.books.map((book) => ({
    id: book.id,
    path: book.path,
    title: book.title,
    author: book.author,
    format: book.format,
    description: book.description,
    lastRead: book.lastRead,
  }));

  // Format book list for text response so Claude can see titles and descriptions
  const bookList = library.books
    .map((book) => {
      // Include format so Claude knows which tools to use (EPUB vs PDF)
      const formatLabel = book.format === 'pdf' ? '[PDF]' : '[EPUB]';
      let entry = `- ${formatLabel} "${book.title}" by ${book.author}`;

      // Try to get description: EPUB metadata first, then semantic index summary
      let description = book.description;
      if (!description) {
        const index = storage.getSemanticIndex(book.id);
        if (index) {
          try {
            const indexData = JSON.parse(index.indexData);
            if (indexData.overallSummary) {
              description = indexData.overallSummary.slice(0, 200);
              if (indexData.overallSummary.length > 200) description += '...';
            }
          } catch {
            // Ignore JSON parse errors
          }
        }
      }

      if (description) {
        entry += `\n  ${description}`;
      }
      return entry;
    })
    .join('\n');

  return {
    content: [
      {
        type: 'text' as const,
        text: `Found ${library.books.length} books in your library at ${bookPath}:\n\n${bookList}`,
      },
    ],
    structuredContent: {
      books: bookSummaries,
      collections: library.collections,
      bookPath,
    },
  };
}

export async function getBookCover(args: { bookId: string }) {
  const storage = getStorage();
  const book = storage.getBook(args.bookId);

  if (!book) {
    return {
      content: [{ type: 'text' as const, text: 'Book not found.' }],
      structuredContent: { coverUrl: null },
    };
  }

  return {
    content: [{ type: 'text' as const, text: 'Cover loaded.' }],
    structuredContent: { coverUrl: book.coverUrl || null },
  };
}

export async function loadBookTool(args: z.infer<typeof LoadBookSchema>) {
  const storage = getStorage();
  const bookPath = args.path;

  // Get or create book ID
  const bookId = storage.hashBook(bookPath);

  // Load book metadata
  let bookInfo;
  if (isEpub(bookPath)) {
    bookInfo = await loadBook(bookPath, bookId);
  } else {
    // PDF - use loadPdfBook to get real metadata and TOC
    bookInfo = await loadPdfBook(bookPath, bookId);
  }

  // Get last reading position and validate it
  let lastPosition = storage.getPosition(bookId);

  // Ensure the saved position is within valid chapter range
  if (lastPosition && lastPosition.chapterIndex >= bookInfo.metadata.chapterCount) {
    // Reset to first chapter if saved position is out of bounds
    lastPosition = {
      chapterIndex: 0,
      scrollPosition: 0,
      lastRead: lastPosition.lastRead,
    };
    // Save the corrected position
    storage.savePosition(bookId, lastPosition);
  }

  // Update library with last read time
  const library = storage.getLibrary();
  const bookEntry = library.books.find((b) => b.id === bookId);
  if (bookEntry) {
    bookEntry.lastRead = new Date().toISOString();
    bookEntry.chapterCount = bookInfo.metadata.chapterCount;
    storage.saveLibrary(library);
  }

  // Update session
  const session = storage.getSession();
  session.lastBook = bookId;
  storage.saveSession(session);

  return {
    content: [
      {
        type: 'text' as const,
        text: `Loaded "${bookInfo.metadata.title}" by ${bookInfo.metadata.author}`,
      },
    ],
    structuredContent: {
      book: {
        id: bookInfo.metadata.id,
        title: bookInfo.metadata.title,
        author: bookInfo.metadata.author,
        format: bookInfo.metadata.format,
        coverUrl: bookInfo.metadata.coverUrl,
        toc: bookInfo.toc,
        chapterCount: bookInfo.metadata.chapterCount,
      },
      lastPosition: lastPosition
        ? {
            chapterIndex: lastPosition.chapterIndex,
            scrollPosition: lastPosition.scrollPosition,
          }
        : undefined,
    },
  };
}

export async function savePosition(args: z.infer<typeof SavePositionSchema>) {
  const storage = getStorage();

  storage.savePosition(args.bookId, {
    chapterIndex: args.chapterIndex,
    scrollPosition: args.scrollPosition,
    lastRead: new Date().toISOString(),
  });

  // Also update the book's lastRead in library
  const library = storage.getLibrary();
  const book = library.books.find((b) => b.id === args.bookId);
  if (book) {
    book.lastRead = new Date().toISOString();
    storage.saveLibrary(library);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: 'Position saved.',
      },
    ],
    structuredContent: {
      success: true,
    },
  };
}

export async function syncReadingContext(args: z.infer<typeof SyncReadingContextSchema>) {
  currentReadingContext = {
    bookId: args.bookId,
    title: args.title,
    author: args.author,
    position: args.position,
    visibleText: args.visibleText,
    lastUpdated: new Date().toISOString(),
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: 'Reading context synced.',
      },
    ],
    structuredContent: {
      success: true,
    },
  };
}

export async function getCurrentContext() {
  if (!currentReadingContext) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'No book is currently being read. The user needs to open a book in LibraLM Reader first.',
        },
      ],
    };
  }

  const ctx = currentReadingContext;

  return {
    content: [
      {
        type: 'text' as const,
        text: `**Currently Reading:** "${ctx.title}" by ${ctx.author}
**${ctx.position}**

**Visible content on current page:**
${ctx.visibleText}`,
      },
    ],
  };
}

