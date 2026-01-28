import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ============================================================================
// Types
// ============================================================================

export interface LibraryBook {
  id: string;
  path: string;
  title: string;
  author: string;
  format: 'epub' | 'pdf';
  coverUrl?: string;
  description?: string; // From EPUB metadata or semantic index
  chapterCount?: number;
  addedAt: string;
  lastRead?: string;
}

export interface Collection {
  id: string;
  name: string;
  bookIds: string[];
}

export interface LibraryData {
  version: number;
  bookPath: string;
  books: LibraryBook[];
  collections: Collection[];
}

export interface ReadingPosition {
  chapterIndex: number;
  scrollPosition: number;
  lastRead: string;
}

export interface SessionData {
  lastBook?: string;
  positions: Record<string, ReadingPosition>;
}

export interface Highlight {
  id: string;
  bookId: string;
  chapterIndex: number;
  text: string;
  color: string;
  cfiRange?: string; // EPUB CFI range for restoring highlight position
  pageNumber?: number; // PDF page number (1-based)
  createdAt: string;
}

export interface Note {
  id: string;
  bookId: string;
  chapterIndex: number;
  text: string;
  quote?: string;
  cfiRange?: string; // EPUB CFI range for navigating back to this location
  pageNumber?: number; // PDF page number (1-based)
  createdAt: string;
}

export interface Bookmark {
  id: string;
  bookId: string;
  chapterIndex: number;
  title?: string;
  cfiRange?: string; // EPUB CFI for exact position
  pageNumber?: number; // PDF page number (1-based)
  createdAt: string;
}

// ============================================================================
// Search Types
// ============================================================================

export interface BookContent {
  id: string;
  bookId: string;
  chapterIndex: number;
  chapterTitle: string;
  content: string;
  contentHash: string;
  indexedAt: string;
}

export interface SearchResult {
  bookId: string;
  bookTitle: string;
  author: string;
  chapterTitle: string;
  chapterIndex: number;
  content: string; // The matched passage
  score: number; // Relevance score 0-1
}

export interface BookStructure {
  id: string;
  bookId: string;
  treeJson: string; // PageIndex tree as JSON
  createdAt: string;
}

export interface SemanticIndex {
  id: string;
  bookId: string;
  indexData: string; // JSON containing semantic analysis (themes, summaries, key concepts)
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Storage Class
// ============================================================================

export class Storage {
  private dataPath: string;
  private db: Database.Database | null = null;

  constructor(dataPath?: string) {
    this.dataPath = dataPath || path.join(os.homedir(), '.libralm');
    this.initialize();
  }

  private initialize(): void {
    // Create directory structure
    fs.mkdirSync(this.dataPath, { recursive: true });

    // Initialize SQLite database
    const dbPath = path.join(this.dataPath, 'annotations.db');
    this.db = new Database(dbPath);

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS highlights (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        chapter_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        color TEXT DEFAULT 'yellow',
        cfi_range TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        chapter_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        quote TEXT,
        cfi_range TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bookmarks (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        chapter_index INTEGER NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id);
      CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book_id);
      CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON bookmarks(book_id);

      -- Search tables
      CREATE TABLE IF NOT EXISTS book_content (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        chapter_index INTEGER NOT NULL,
        chapter_title TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        book_title TEXT,
        author TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_book_content_book ON book_content(book_id);
      CREATE INDEX IF NOT EXISTS idx_book_content_hash ON book_content(content_hash);

      -- FTS5 virtual table for full-text search with BM25
      CREATE VIRTUAL TABLE IF NOT EXISTS book_content_fts USING fts5(
        content,
        chapter_title,
        content_id UNINDEXED,
        book_id UNINDEXED,
        tokenize='porter unicode61'
      );

      -- PageIndex tree structures cache
      CREATE TABLE IF NOT EXISTS book_structure (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL UNIQUE,
        tree_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_book_structure_book ON book_structure(book_id);

      -- Semantic index for Claude's analysis of books
      CREATE TABLE IF NOT EXISTS semantic_index (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL UNIQUE,
        index_data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_semantic_index_book ON semantic_index(book_id);
    `);

    // Migration: Add book_title and author columns if they don't exist
    try {
      this.db.exec(`ALTER TABLE book_content ADD COLUMN book_title TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE book_content ADD COLUMN author TEXT`);
    } catch {
      // Column already exists
    }

    // Migration: Add cfi_range column to bookmarks if it doesn't exist
    try {
      this.db.exec(`ALTER TABLE bookmarks ADD COLUMN cfi_range TEXT`);
    } catch {
      // Column already exists
    }

    // Migration: Add page_number column to highlights for PDF support
    try {
      this.db.exec(`ALTER TABLE highlights ADD COLUMN page_number INTEGER`);
    } catch {
      // Column already exists
    }

    // Migration: Add page_number column to notes for PDF support
    try {
      this.db.exec(`ALTER TABLE notes ADD COLUMN page_number INTEGER`);
    } catch {
      // Column already exists
    }

    // Migration: Add page_number column to bookmarks for PDF support
    try {
      this.db.exec(`ALTER TABLE bookmarks ADD COLUMN page_number INTEGER`);
    } catch {
      // Column already exists
    }

    // Initialize JSON files if they don't exist
    const libraryPath = path.join(this.dataPath, 'library.json');
    if (!fs.existsSync(libraryPath)) {
      this.saveLibrary({
        version: 1,
        bookPath: '',
        books: [],
        collections: [],
      });
    }

    const sessionPath = path.join(this.dataPath, 'session.json');
    if (!fs.existsSync(sessionPath)) {
      this.saveSession({
        positions: {},
      });
    }
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  generateId(): string {
    return crypto.randomUUID();
  }

  hashBook(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  // ==========================================================================
  // Library Methods (JSON)
  // ==========================================================================

  getLibrary(): LibraryData {
    const libraryPath = path.join(this.dataPath, 'library.json');
    try {
      const data = fs.readFileSync(libraryPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {
        version: 1,
        bookPath: '',
        books: [],
        collections: [],
      };
    }
  }

  saveLibrary(library: LibraryData): void {
    const libraryPath = path.join(this.dataPath, 'library.json');
    fs.writeFileSync(libraryPath, JSON.stringify(library, null, 2));
  }

  getBook(bookId: string): LibraryBook | undefined {
    const library = this.getLibrary();
    return library.books.find((b) => b.id === bookId);
  }

  getBookByPath(bookPath: string): LibraryBook | undefined {
    const library = this.getLibrary();
    return library.books.find((b) => b.path === bookPath);
  }

  addOrUpdateBook(book: LibraryBook): void {
    const library = this.getLibrary();
    const existingIndex = library.books.findIndex((b) => b.id === book.id);
    if (existingIndex >= 0) {
      library.books[existingIndex] = book;
    } else {
      library.books.push(book);
    }
    this.saveLibrary(library);
  }

  // ==========================================================================
  // Session Methods (JSON)
  // ==========================================================================

  getSession(): SessionData {
    const sessionPath = path.join(this.dataPath, 'session.json');
    try {
      const data = fs.readFileSync(sessionPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return { positions: {} };
    }
  }

  saveSession(session: SessionData): void {
    const sessionPath = path.join(this.dataPath, 'session.json');
    fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  }

  getPosition(bookId: string): ReadingPosition | undefined {
    const session = this.getSession();
    return session.positions[bookId];
  }

  savePosition(bookId: string, position: ReadingPosition): void {
    const session = this.getSession();
    session.positions[bookId] = position;
    session.lastBook = bookId;
    this.saveSession(session);
  }

  // ==========================================================================
  // Highlight Methods (SQLite)
  // ==========================================================================

  addHighlight(highlight: Omit<Highlight, 'id' | 'createdAt'>): Highlight {
    const id = this.generateId();
    const createdAt = new Date().toISOString();

    this.db!.prepare(`
      INSERT INTO highlights (id, book_id, chapter_index, text, color, cfi_range, page_number, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, highlight.bookId, highlight.chapterIndex, highlight.text, highlight.color || 'yellow', highlight.cfiRange || null, highlight.pageNumber || null, createdAt);

    return { ...highlight, id, createdAt, color: highlight.color || 'yellow' };
  }

  getHighlights(bookId: string): Highlight[] {
    const rows = this.db!.prepare(`
      SELECT id, book_id as bookId, chapter_index as chapterIndex, text, color, cfi_range as cfiRange, page_number as pageNumber, created_at as createdAt
      FROM highlights
      WHERE book_id = ?
      ORDER BY created_at DESC
    `).all(bookId) as Highlight[];

    return rows;
  }

  getHighlightsByChapter(bookId: string, chapterIndex: number): Highlight[] {
    const rows = this.db!.prepare(`
      SELECT id, book_id as bookId, chapter_index as chapterIndex, text, color, cfi_range as cfiRange, page_number as pageNumber, created_at as createdAt
      FROM highlights
      WHERE book_id = ? AND chapter_index = ?
      ORDER BY created_at DESC
    `).all(bookId, chapterIndex) as Highlight[];

    return rows;
  }

  deleteHighlight(id: string): void {
    this.db!.prepare('DELETE FROM highlights WHERE id = ?').run(id);
  }

  searchHighlights(params: {
    bookId?: string;
    searchText?: string;
    color?: string;
    limit?: number;
  }): Highlight[] {
    let sql = `
      SELECT id, book_id as bookId, chapter_index as chapterIndex, text, color, cfi_range as cfiRange, page_number as pageNumber, created_at as createdAt
      FROM highlights
      WHERE 1=1
    `;
    const sqlParams: (string | number)[] = [];

    if (params.bookId) {
      sql += ' AND book_id = ?';
      sqlParams.push(params.bookId);
    }

    if (params.searchText) {
      sql += ' AND text LIKE ?';
      sqlParams.push(`%${params.searchText}%`);
    }

    if (params.color) {
      sql += ' AND color = ?';
      sqlParams.push(params.color);
    }

    sql += ' ORDER BY created_at DESC';

    if (params.limit) {
      sql += ' LIMIT ?';
      sqlParams.push(params.limit);
    }

    return this.db!.prepare(sql).all(...sqlParams) as Highlight[];
  }

  // ==========================================================================
  // Note Methods (SQLite)
  // ==========================================================================

  addNote(note: Omit<Note, 'id' | 'createdAt'>): Note {
    const id = this.generateId();
    const createdAt = new Date().toISOString();

    this.db!.prepare(`
      INSERT INTO notes (id, book_id, chapter_index, text, quote, cfi_range, page_number, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, note.bookId, note.chapterIndex, note.text, note.quote || null, note.cfiRange || null, note.pageNumber || null, createdAt);

    return { ...note, id, createdAt };
  }

  getNotes(bookId: string): Note[] {
    const rows = this.db!.prepare(`
      SELECT id, book_id as bookId, chapter_index as chapterIndex, text, quote, cfi_range as cfiRange, page_number as pageNumber, created_at as createdAt
      FROM notes
      WHERE book_id = ?
      ORDER BY created_at DESC
    `).all(bookId) as Note[];

    return rows;
  }

  getNotesByChapter(bookId: string, chapterIndex: number): Note[] {
    const rows = this.db!.prepare(`
      SELECT id, book_id as bookId, chapter_index as chapterIndex, text, quote, cfi_range as cfiRange, page_number as pageNumber, created_at as createdAt
      FROM notes
      WHERE book_id = ? AND chapter_index = ?
      ORDER BY created_at DESC
    `).all(bookId, chapterIndex) as Note[];

    return rows;
  }

  deleteNote(id: string): void {
    this.db!.prepare('DELETE FROM notes WHERE id = ?').run(id);
  }

  searchNotes(params: {
    bookId?: string;
    searchText?: string;
    limit?: number;
  }): Note[] {
    let sql = `
      SELECT id, book_id as bookId, chapter_index as chapterIndex, text, quote, cfi_range as cfiRange, page_number as pageNumber, created_at as createdAt
      FROM notes
      WHERE 1=1
    `;
    const sqlParams: (string | number)[] = [];

    if (params.bookId) {
      sql += ' AND book_id = ?';
      sqlParams.push(params.bookId);
    }

    if (params.searchText) {
      sql += ' AND (text LIKE ? OR quote LIKE ?)';
      sqlParams.push(`%${params.searchText}%`);
      sqlParams.push(`%${params.searchText}%`);
    }

    sql += ' ORDER BY created_at DESC';

    if (params.limit) {
      sql += ' LIMIT ?';
      sqlParams.push(params.limit);
    }

    return this.db!.prepare(sql).all(...sqlParams) as Note[];
  }

  // ==========================================================================
  // Bookmark Methods (SQLite)
  // ==========================================================================

  addBookmark(bookmark: Omit<Bookmark, 'id' | 'createdAt'>): Bookmark {
    const id = this.generateId();
    const createdAt = new Date().toISOString();

    this.db!.prepare(`
      INSERT INTO bookmarks (id, book_id, chapter_index, title, cfi_range, page_number, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, bookmark.bookId, bookmark.chapterIndex, bookmark.title || null, bookmark.cfiRange || null, bookmark.pageNumber || null, createdAt);

    return { ...bookmark, id, createdAt };
  }

  getBookmarks(bookId: string): Bookmark[] {
    const rows = this.db!.prepare(`
      SELECT id, book_id as bookId, chapter_index as chapterIndex, title, cfi_range as cfiRange, page_number as pageNumber, created_at as createdAt
      FROM bookmarks
      WHERE book_id = ?
      ORDER BY chapter_index ASC
    `).all(bookId) as Bookmark[];

    return rows;
  }

  deleteBookmark(id: string): void {
    this.db!.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  }

  // ==========================================================================
  // Search Content Methods (SQLite + FTS5)
  // ==========================================================================

  /**
   * Check if a book is already indexed for search
   */
  isBookIndexed(bookId: string): boolean {
    const row = this.db!.prepare(`
      SELECT COUNT(*) as count FROM book_content WHERE book_id = ?
    `).get(bookId) as { count: number };
    return row.count > 0;
  }

  /**
   * Get the content hash for a book to detect changes
   */
  getBookContentHash(bookId: string): string | null {
    const row = this.db!.prepare(`
      SELECT content_hash FROM book_content WHERE book_id = ? LIMIT 1
    `).get(bookId) as { content_hash: string } | undefined;
    return row?.content_hash || null;
  }

  /**
   * Index book content for search. Replaces existing content if present.
   */
  indexBookContent(
    bookId: string,
    chapters: Array<{ index: number; title: string; content: string }>,
    contentHash: string,
    bookTitle?: string,
    author?: string
  ): void {
    const indexedAt = new Date().toISOString();

    // Use a transaction for atomicity
    const transaction = this.db!.transaction(() => {
      // Delete existing content for this book
      this.deleteBookContent(bookId);

      // Insert new content
      const insertContent = this.db!.prepare(`
        INSERT INTO book_content (id, book_id, chapter_index, chapter_title, content, content_hash, indexed_at, book_title, author)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertFts = this.db!.prepare(`
        INSERT INTO book_content_fts (content, chapter_title, content_id, book_id)
        VALUES (?, ?, ?, ?)
      `);

      for (const chapter of chapters) {
        const id = this.generateId();
        insertContent.run(
          id,
          bookId,
          chapter.index,
          chapter.title,
          chapter.content,
          contentHash,
          indexedAt,
          bookTitle || null,
          author || null
        );
        insertFts.run(chapter.content, chapter.title, id, bookId);
      }
    });

    transaction();
  }

  /**
   * Delete all indexed content for a book
   */
  deleteBookContent(bookId: string): void {
    // Get content IDs to delete from FTS
    const contentIds = this.db!.prepare(`
      SELECT id FROM book_content WHERE book_id = ?
    `).all(bookId) as Array<{ id: string }>;

    // Delete from FTS
    const deleteFts = this.db!.prepare(`
      DELETE FROM book_content_fts WHERE content_id = ?
    `);
    for (const { id } of contentIds) {
      deleteFts.run(id);
    }

    // Delete from main table
    this.db!.prepare(`DELETE FROM book_content WHERE book_id = ?`).run(bookId);
  }

  /**
   * Search book content using FTS5 BM25.
   * Returns passages ranked by relevance.
   */
  searchBookContent(params: {
    query: string;
    bookIds?: string[];
    limit?: number;
  }): Array<{
    bookId: string;
    bookTitle: string | null;
    author: string | null;
    chapterTitle: string;
    chapterIndex: number;
    content: string;
    score: number;
  }> {
    const limit = params.limit || 20;

    // Build FTS5 query - split on whitespace and join with AND
    const terms = params.query
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(' AND ');

    if (!terms) {
      return [];
    }

    let sql = `
      SELECT
        bc.book_id as bookId,
        bc.book_title as bookTitle,
        bc.author,
        bc.chapter_title as chapterTitle,
        bc.chapter_index as chapterIndex,
        bc.content,
        bm25(book_content_fts, 10.0, 1.0) as bm25_score
      FROM book_content_fts fts
      JOIN book_content bc ON fts.content_id = bc.id
      WHERE book_content_fts MATCH ?
    `;
    const sqlParams: (string | number)[] = [terms];

    // Filter by specific books if provided
    if (params.bookIds && params.bookIds.length > 0) {
      const placeholders = params.bookIds.map(() => '?').join(',');
      sql += ` AND bc.book_id IN (${placeholders})`;
      sqlParams.push(...params.bookIds);
    }

    sql += ` ORDER BY bm25_score LIMIT ?`;
    sqlParams.push(limit);

    const rows = this.db!.prepare(sql).all(...sqlParams) as Array<{
      bookId: string;
      bookTitle: string | null;
      author: string | null;
      chapterTitle: string;
      chapterIndex: number;
      content: string;
      bm25_score: number;
    }>;

    // Normalize BM25 scores to 0-1 range
    // BM25 in FTS5 returns negative scores where more negative = better match
    // Convert so higher score = better match (0-1 range)
    const absScores = rows.map((r) => Math.abs(r.bm25_score));
    const maxAbsScore = Math.max(...absScores, 1); // Avoid division by zero
    return rows.map((row) => ({
      bookId: row.bookId,
      bookTitle: row.bookTitle,
      author: row.author,
      chapterTitle: row.chapterTitle,
      chapterIndex: row.chapterIndex,
      content: row.content,
      score: Math.abs(row.bm25_score) / maxAbsScore,
    }));
  }

  /**
   * Get all indexed books
   */
  getIndexedBooks(): Array<{ bookId: string; chapterCount: number; indexedAt: string }> {
    return this.db!.prepare(`
      SELECT
        book_id as bookId,
        COUNT(*) as chapterCount,
        MAX(indexed_at) as indexedAt
      FROM book_content
      GROUP BY book_id
    `).all() as Array<{ bookId: string; chapterCount: number; indexedAt: string }>;
  }

  // ==========================================================================
  // PageIndex Structure Cache
  // ==========================================================================

  /**
   * Get cached PageIndex tree structure for a book
   */
  getBookStructure(bookId: string): string | null {
    const row = this.db!.prepare(`
      SELECT tree_json FROM book_structure WHERE book_id = ?
    `).get(bookId) as { tree_json: string } | undefined;
    return row?.tree_json || null;
  }

  /**
   * Save PageIndex tree structure for a book
   */
  saveBookStructure(bookId: string, treeJson: string): void {
    const id = this.generateId();
    const createdAt = new Date().toISOString();

    this.db!.prepare(`
      INSERT OR REPLACE INTO book_structure (id, book_id, tree_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(id, bookId, treeJson, createdAt);
  }

  /**
   * Delete cached structure for a book
   */
  deleteBookStructure(bookId: string): void {
    this.db!.prepare(`DELETE FROM book_structure WHERE book_id = ?`).run(bookId);
  }

  // ==========================================================================
  // Semantic Index Methods (Claude's book analysis)
  // ==========================================================================

  /**
   * Check if a book has a semantic index
   */
  hasSemanticIndex(bookId: string): boolean {
    const row = this.db!.prepare(`
      SELECT COUNT(*) as count FROM semantic_index WHERE book_id = ?
    `).get(bookId) as { count: number };
    return row.count > 0;
  }

  /**
   * Get semantic index for a book
   */
  getSemanticIndex(bookId: string): SemanticIndex | null {
    const row = this.db!.prepare(`
      SELECT id, book_id as bookId, index_data as indexData, created_at as createdAt, updated_at as updatedAt
      FROM semantic_index
      WHERE book_id = ?
    `).get(bookId) as SemanticIndex | undefined;
    return row || null;
  }

  /**
   * Save or update semantic index for a book
   */
  saveSemanticIndex(bookId: string, indexData: string): SemanticIndex {
    const now = new Date().toISOString();
    const existing = this.getSemanticIndex(bookId);

    if (existing) {
      this.db!.prepare(`
        UPDATE semantic_index SET index_data = ?, updated_at = ? WHERE book_id = ?
      `).run(indexData, now, bookId);
      return { ...existing, indexData, updatedAt: now };
    } else {
      const id = this.generateId();
      this.db!.prepare(`
        INSERT INTO semantic_index (id, book_id, index_data, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, bookId, indexData, now, now);
      return { id, bookId, indexData, createdAt: now, updatedAt: now };
    }
  }

  /**
   * Delete semantic index for a book
   */
  deleteSemanticIndex(bookId: string): void {
    this.db!.prepare(`DELETE FROM semantic_index WHERE book_id = ?`).run(bookId);
  }

  /**
   * Get all books with semantic indexes
   */
  getBooksWithSemanticIndex(): Array<{ bookId: string; createdAt: string; updatedAt: string }> {
    return this.db!.prepare(`
      SELECT book_id as bookId, created_at as createdAt, updated_at as updatedAt
      FROM semantic_index
      ORDER BY updated_at DESC
    `).all() as Array<{ bookId: string; createdAt: string; updatedAt: string }>;
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Singleton instance
let storageInstance: Storage | null = null;

export function getStorage(): Storage {
  if (!storageInstance) {
    storageInstance = new Storage(process.env.DATA_PATH);
  }
  return storageInstance;
}
