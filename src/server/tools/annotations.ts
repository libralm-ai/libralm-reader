import { z } from 'zod';
import { getStorage } from '../../storage/index.js';

// ============================================================================
// Schemas
// ============================================================================

export const AddHighlightSchema = z.object({
  bookId: z.string().optional().describe('Book ID (uses current book if not provided)'),
  chapterIndex: z.number().optional().describe('Chapter index (uses current chapter if not provided)'),
  text: z.string().describe('The highlighted text'),
  color: z.enum(['yellow', 'green', 'blue', 'pink']).optional().describe('Highlight color'),
  cfiRange: z.string().optional().describe('EPUB CFI range for restoring highlight position'),
});

export const AddNoteSchema = z.object({
  bookId: z.string().optional().describe('Book ID (uses current book if not provided)'),
  chapterIndex: z.number().optional().describe('Chapter index (uses current chapter if not provided)'),
  text: z.string().describe('The note content'),
  quote: z.string().optional().describe('Optional quote the note is attached to'),
  cfiRange: z.string().optional().describe('EPUB CFI range for navigating back to this location'),
});

export const SearchHighlightsSchema = z.object({
  bookId: z.string().optional().describe('Filter by book ID. If not provided, searches all books.'),
  searchText: z.string().optional().describe('Search within highlighted text (case-insensitive substring match)'),
  color: z.enum(['yellow', 'green', 'blue', 'pink']).optional().describe('Filter by highlight color'),
  limit: z.number().optional().default(50).describe('Maximum number of results to return (default 50)'),
});

export const SearchNotesSchema = z.object({
  bookId: z.string().optional().describe('Filter by book ID. If not provided, searches all books.'),
  searchText: z.string().optional().describe('Search within note text or quote (case-insensitive substring match)'),
  limit: z.number().optional().default(50).describe('Maximum number of results to return (default 50)'),
});

export const DeleteAnnotationSchema = z.object({
  id: z.string().describe('Annotation ID'),
  type: z.enum(['highlight', 'note', 'bookmark']).describe('Type of annotation'),
});

// ============================================================================
// Bookmark Schemas
// ============================================================================

export const AddBookmarkSchema = z.object({
  bookId: z.string().describe('Book ID'),
  chapterIndex: z.number().describe('Chapter index to bookmark'),
  title: z.string().optional().describe('Optional title for the bookmark'),
  cfiRange: z.string().optional().describe('EPUB CFI for exact position'),
});

export const ListBookmarksSchema = z.object({
  bookId: z.string().describe('Book ID'),
});

export const DeleteBookmarkSchema = z.object({
  id: z.string().describe('Bookmark ID'),
});

// ============================================================================
// Export Schema
// ============================================================================

export const ExportAnnotationsSchema = z.object({
  bookId: z.string().describe('Book ID'),
  format: z.enum(['markdown', 'json']).optional().default('markdown').describe('Export format'),
});

// ============================================================================
// Tool Implementations
// ============================================================================

export async function addHighlight(args: z.infer<typeof AddHighlightSchema>) {
  const storage = getStorage();

  const bookId = args.bookId;
  const chapterIndex = args.chapterIndex;

  if (!bookId) {
    throw new Error('No book specified');
  }

  if (chapterIndex === undefined) {
    throw new Error('No chapter specified');
  }

  const highlight = storage.addHighlight({
    bookId,
    chapterIndex,
    text: args.text,
    color: args.color || 'yellow',
    cfiRange: args.cfiRange,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: `Highlight added: "${args.text.slice(0, 50)}${args.text.length > 50 ? '...' : ''}"`,
      },
    ],
    _meta: {
      highlightAdded: highlight,
    },
  };
}

export async function addNote(args: z.infer<typeof AddNoteSchema>) {
  const storage = getStorage();

  const bookId = args.bookId;
  const chapterIndex = args.chapterIndex;

  if (!bookId) {
    throw new Error('No book specified');
  }

  if (chapterIndex === undefined) {
    throw new Error('No chapter specified');
  }

  const note = storage.addNote({
    bookId,
    chapterIndex,
    text: args.text,
    quote: args.quote,
    cfiRange: args.cfiRange,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: `Note saved${args.quote ? ` on "${args.quote.slice(0, 30)}..."` : ''}: "${args.text.slice(0, 50)}${args.text.length > 50 ? '...' : ''}"`,
      },
    ],
    _meta: {
      noteAdded: note,
    },
  };
}

export async function searchHighlights(args: z.infer<typeof SearchHighlightsSchema>) {
  const storage = getStorage();

  const highlights = storage.searchHighlights({
    bookId: args.bookId,
    searchText: args.searchText,
    color: args.color,
    limit: args.limit || 50,
  });

  // Format for model consumption
  let text = '';

  if (highlights.length > 0) {
    text += `**Found ${highlights.length} highlight${highlights.length === 1 ? '' : 's'}:**\n\n`;
    for (const h of highlights) {
      text += `- [${h.color}] "${h.text}"\n`;
      text += `  Created: ${new Date(h.createdAt).toLocaleDateString()}\n\n`;
    }
  } else {
    text = 'No highlights found matching your criteria.';
  }

  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
    structuredContent: {
      highlights,
      count: highlights.length,
    },
  };
}

export async function searchNotes(args: z.infer<typeof SearchNotesSchema>) {
  const storage = getStorage();

  const notes = storage.searchNotes({
    bookId: args.bookId,
    searchText: args.searchText,
    limit: args.limit || 50,
  });

  // Format for model consumption
  let text = '';

  if (notes.length > 0) {
    text += `**Found ${notes.length} note${notes.length === 1 ? '' : 's'}:**\n\n`;
    for (const n of notes) {
      if (n.quote) {
        text += `- On "${n.quote}":\n`;
        text += `  "${n.text}"\n`;
      } else {
        text += `- "${n.text}"\n`;
      }
      text += `  Created: ${new Date(n.createdAt).toLocaleDateString()}\n\n`;
    }
  } else {
    text = 'No notes found matching your criteria.';
  }

  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
    structuredContent: {
      notes,
      count: notes.length,
    },
  };
}

// Keep for UI to load annotations on book open
export async function listAnnotations(args: { bookId?: string }) {
  const storage = getStorage();

  const bookId = args.bookId;

  if (!bookId) {
    throw new Error('No book specified');
  }

  const highlights = storage.getHighlights(bookId);
  const notes = storage.getNotes(bookId);

  return {
    content: [
      {
        type: 'text' as const,
        text: `Loaded ${highlights.length} highlights and ${notes.length} notes.`,
      },
    ],
    structuredContent: {
      highlights,
      notes,
    },
  };
}

export async function deleteAnnotation(args: z.infer<typeof DeleteAnnotationSchema>) {
  const storage = getStorage();

  if (args.type === 'highlight') {
    storage.deleteHighlight(args.id);
  } else if (args.type === 'note') {
    storage.deleteNote(args.id);
  } else if (args.type === 'bookmark') {
    storage.deleteBookmark(args.id);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: `${args.type.charAt(0).toUpperCase() + args.type.slice(1)} deleted.`,
      },
    ],
    _meta: {
      annotationDeleted: { id: args.id, type: args.type },
    },
  };
}

// ============================================================================
// Bookmark Implementations
// ============================================================================

export async function addBookmark(args: z.infer<typeof AddBookmarkSchema>) {
  const storage = getStorage();

  const bookmark = storage.addBookmark({
    bookId: args.bookId,
    chapterIndex: args.chapterIndex,
    title: args.title,
    cfiRange: args.cfiRange,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: `Bookmark added${args.title ? `: "${args.title}"` : ` at chapter ${args.chapterIndex}`}`,
      },
    ],
    structuredContent: {
      bookmark,
    },
  };
}

export async function listBookmarks(args: z.infer<typeof ListBookmarksSchema>) {
  const storage = getStorage();

  const bookmarks = storage.getBookmarks(args.bookId);

  return {
    content: [
      {
        type: 'text' as const,
        text: `Found ${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'}.`,
      },
    ],
    structuredContent: {
      bookmarks,
    },
  };
}

export async function deleteBookmark(args: z.infer<typeof DeleteBookmarkSchema>) {
  const storage = getStorage();
  storage.deleteBookmark(args.id);

  return {
    content: [
      {
        type: 'text' as const,
        text: 'Bookmark deleted.',
      },
    ],
  };
}

// ============================================================================
// Export Implementation
// ============================================================================

export async function exportAnnotations(args: z.infer<typeof ExportAnnotationsSchema>) {
  const storage = getStorage();

  const book = storage.getBook(args.bookId);
  const highlights = storage.getHighlights(args.bookId);
  const notes = storage.getNotes(args.bookId);
  const bookmarks = storage.getBookmarks(args.bookId);

  const bookTitle = book?.title || 'Unknown Book';
  const bookAuthor = book?.author || 'Unknown Author';

  if (args.format === 'json') {
    const exportData = {
      book: { id: args.bookId, title: bookTitle, author: bookAuthor },
      exportedAt: new Date().toISOString(),
      highlights,
      notes,
      bookmarks,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(exportData, null, 2),
        },
      ],
      structuredContent: {
        format: 'json',
        data: exportData,
      },
    };
  }

  // Markdown format
  let markdown = `# ${bookTitle}\n`;
  markdown += `**Author:** ${bookAuthor}\n`;
  markdown += `**Exported:** ${new Date().toLocaleDateString()}\n\n`;

  if (highlights.length > 0) {
    markdown += `## Highlights (${highlights.length})\n\n`;
    for (const h of highlights) {
      markdown += `> ${h.text}\n`;
      markdown += `> — *Chapter ${h.chapterIndex + 1}, ${h.color} highlight*\n\n`;
    }
  }

  if (notes.length > 0) {
    markdown += `## Notes (${notes.length})\n\n`;
    for (const n of notes) {
      if (n.quote) {
        markdown += `> ${n.quote}\n\n`;
        markdown += `**Note:** ${n.text}\n`;
      } else {
        markdown += `**Note:** ${n.text}\n`;
      }
      markdown += `*Chapter ${n.chapterIndex + 1}*\n\n`;
    }
  }

  if (bookmarks.length > 0) {
    markdown += `## Bookmarks (${bookmarks.length})\n\n`;
    for (const b of bookmarks) {
      markdown += `- ${b.title || `Chapter ${b.chapterIndex + 1}`}\n`;
    }
    markdown += '\n';
  }

  if (highlights.length === 0 && notes.length === 0 && bookmarks.length === 0) {
    markdown += '*No annotations found for this book.*\n';
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: markdown,
      },
    ],
    structuredContent: {
      format: 'markdown',
      markdown,
      counts: {
        highlights: highlights.length,
        notes: notes.length,
        bookmarks: bookmarks.length,
      },
    },
  };
}
