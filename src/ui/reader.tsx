/**
 * LibraLM Reader - MCP App UI
 * Apple Books-inspired reading experience using MCP Apps SDK + React
 */
import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BookOpen, Library as LibraryIcon, FileText, Star, ChevronLeft,
  Menu, X, BookMarked, StickyNote, Search, Trash2, Highlighter, Heart,
  ChevronRight, ZoomIn, ZoomOut
} from 'lucide-react';
import { StrictMode, useCallback, useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactReader } from 'react-reader';
import type { Rendition } from 'epubjs';
import * as pdfjsLib from 'pdfjs-dist';
import { TextLayer, VerbosityLevel } from 'pdfjs-dist';
import type { PDFDocumentProxy, TextItem } from 'pdfjs-dist/types/src/display/api.js';
import './styles.css';
import { LIBRALM_LOGO } from './logo.js';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).href;

// ============================================================================
// Types
// ============================================================================

interface Book {
  id: string;
  title: string;
  author: string;
  format: 'epub' | 'pdf';
  coverUrl?: string;
  path?: string;
  lastRead?: string;
}

interface BookDetails extends Book {
  chapterCount: number;
}

interface Highlight {
  id: string;
  bookId: string;
  chapterIndex: number;
  text: string;
  color: string;
  cfiRange?: string; // EPUB CFI range for restoring highlight position
  pageNumber?: number; // PDF page number (1-based)
  createdAt: string;
}

interface Note {
  id: string;
  bookId: string;
  chapterIndex: number;
  text: string;
  quote?: string;
  cfiRange?: string; // EPUB CFI range for navigating back to this location
  pageNumber?: number; // PDF page number (1-based)
  createdAt: string;
}

interface Bookmark {
  id: string;
  bookId: string;
  chapterIndex: number;
  title?: string;
  cfiRange?: string; // EPUB CFI for exact position
  pageNumber?: number; // PDF page number (1-based)
  createdAt: string;
}

interface AppState {
  view: 'loading' | 'library' | 'reader';
  books: Book[];
  currentBook: BookDetails | null;
  highlights: Highlight[];
  notes: Note[];
  bookmarks: Bookmark[];
  filter: 'all' | 'epub' | 'pdf' | 'favorites';
  showNotes: boolean;
  notesTab: 'highlights' | 'notes' | 'bookmarks';
}

// ============================================================================
// Utility Functions
// ============================================================================

function generateCoverColor(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = title.charCodeAt(i) + ((hash << 5) - hash);
  }

  const colors = [
    'linear-gradient(135deg, #8b6914 0%, #a67c00 50%, #d4a84b 100%)',
    'linear-gradient(135deg, #5c4a34 0%, #7d6b52 50%, #9e8b70 100%)',
    'linear-gradient(135deg, #3d5a4c 0%, #4a7058 50%, #6b9178 100%)',
    'linear-gradient(135deg, #4a5568 0%, #5a6578 50%, #7a8598 100%)',
    'linear-gradient(135deg, #744a3a 0%, #8b5a4a 50%, #a87060 100%)',
    'linear-gradient(135deg, #5a4a6a 0%, #6b5a7a 50%, #8b7a9a 100%)',
    'linear-gradient(135deg, #3a5a6a 0%, #4a6a7a 50%, #6a8a9a 100%)',
    'linear-gradient(135deg, #6a4a3a 0%, #7a5a4a 50%, #9a7a6a 100%)',
  ];

  return colors[Math.abs(hash) % colors.length];
}

function extractStructuredContent<T>(result: CallToolResult): T | null {
  return (result as unknown as { structuredContent?: T }).structuredContent ?? null;
}

// ============================================================================
// Components
// ============================================================================

const BookCard: React.FC<{
  book: Book;
  coverUrl?: string;
  isFavorite: boolean;
  onClick: () => void;
  onToggleFavorite: (e: React.MouseEvent) => void;
}> = ({ book, coverUrl, isFavorite, onClick, onToggleFavorite }) => (
  <motion.div
    className="book-card"
    onClick={onClick}
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    whileHover={{ y: -4 }}
    transition={{ duration: 0.3 }}
  >
    <div className="book-cover">
      {coverUrl ? (
        <img src={coverUrl} alt={book.title} className="book-cover-image" />
      ) : (
        <div
          className="book-cover-generated"
          style={{ background: generateCoverColor(book.title) }}
        >
          <div className="book-cover-generated-title">{book.title}</div>
          <div className="book-cover-generated-author">{book.author}</div>
        </div>
      )}
      <span className="book-format-badge">{book.format}</span>
      <button
        className={`book-favorite-btn ${isFavorite ? 'is-favorite' : ''}`}
        onClick={onToggleFavorite}
        title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      >
        <Heart size={16} fill={isFavorite ? 'currentColor' : 'none'} />
      </button>
    </div>
    <div className="book-info">
      <div className="book-title">{book.title}</div>
      <div className="book-author">{book.author}</div>
    </div>
  </motion.div>
);

const Sidebar: React.FC<{
  filter: AppState['filter'];
  books: Book[];
  favorites: Set<string>;
  onFilterChange: (filter: AppState['filter']) => void;
  isCollapsed: boolean;
  onToggle: () => void;
}> = ({ filter, books, favorites, onFilterChange, isCollapsed, onToggle }) => {
  const epubCount = books.filter(b => b.format === 'epub').length;
  const pdfCount = books.filter(b => b.format === 'pdf').length;
  const favoritesCount = favorites.size;

  return (
    <aside className={`sidebar ${isCollapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <img src={LIBRALM_LOGO} alt="LibraLM" className="sidebar-logo-image" />
          {!isCollapsed && <span className="sidebar-logo-text">LibraLM</span>}
        </div>
        {!isCollapsed && (
          <button className="sidebar-toggle" onClick={onToggle} title="Collapse sidebar">
            <ChevronLeft size={18} />
          </button>
        )}
      </div>

      <div className="sidebar-section">
        {!isCollapsed && <div className="sidebar-section-title">Library</div>}
        <nav className="sidebar-nav">
          <div
            className={`sidebar-nav-item ${filter === 'all' ? 'active' : ''}`}
            onClick={() => onFilterChange('all')}
            title="All Books"
          >
            <LibraryIcon size={18} />
            {!isCollapsed && (
              <>
                <span>All Books</span>
                <span className="sidebar-nav-count">{books.length}</span>
              </>
            )}
          </div>
          <div
            className={`sidebar-nav-item ${filter === 'epub' ? 'active' : ''}`}
            onClick={() => onFilterChange('epub')}
            title="EPUBs"
          >
            <BookOpen size={18} />
            {!isCollapsed && (
              <>
                <span>EPUBs</span>
                <span className="sidebar-nav-count">{epubCount}</span>
              </>
            )}
          </div>
          <div
            className={`sidebar-nav-item ${filter === 'pdf' ? 'active' : ''}`}
            onClick={() => onFilterChange('pdf')}
            title="PDFs"
          >
            <FileText size={18} />
            {!isCollapsed && (
              <>
                <span>PDFs</span>
                <span className="sidebar-nav-count">{pdfCount}</span>
              </>
            )}
          </div>
        </nav>
      </div>

      <div className="sidebar-section">
        {!isCollapsed && <div className="sidebar-section-title">Collections</div>}
        <nav className="sidebar-nav">
          <div
            className={`sidebar-nav-item ${filter === 'favorites' ? 'active' : ''}`}
            onClick={() => onFilterChange('favorites')}
            title="Favorites"
          >
            <Star size={18} />
            {!isCollapsed && (
              <>
                <span>Favorites</span>
                <span className="sidebar-nav-count">{favoritesCount}</span>
              </>
            )}
          </div>
        </nav>
      </div>
    </aside>
  );
};

const LibraryView: React.FC<{
  state: AppState;
  app: App | null;
  favorites: Set<string>;
  onFilterChange: (filter: AppState['filter']) => void;
  onOpenBook: (book: Book) => void;
  onToggleFavorite: (bookId: string) => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}> = ({ state, app, favorites, onFilterChange, onOpenBook, onToggleFavorite, sidebarCollapsed, onToggleSidebar }) => {
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Fetch covers lazily when books change
  useEffect(() => {
    if (!app || state.books.length === 0) return;

    const fetchCovers = async () => {
      for (const book of state.books) {
        // Skip if we already have this cover
        if (covers[book.id]) continue;

        try {
          const result = await app.callServerTool({
            name: 'get_book_cover',
            arguments: { bookId: book.id },
          });
          const data = extractStructuredContent<{ coverUrl: string | null }>(result);
          if (data?.coverUrl) {
            setCovers(prev => ({ ...prev, [book.id]: data.coverUrl! }));
          }
        } catch (err) {
          // Silently ignore cover fetch errors
        }
      }
    };

    fetchCovers();
  }, [app, state.books]);

  // Focus search input when opened
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  const filteredBooks = state.books.filter(book => {
    // First apply format/favorites filter
    let passesFilter = true;
    if (state.filter === 'epub') passesFilter = book.format === 'epub';
    else if (state.filter === 'pdf') passesFilter = book.format === 'pdf';
    else if (state.filter === 'favorites') passesFilter = favorites.has(book.id);

    // Then apply search filter
    if (passesFilter && searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      passesFilter = book.title.toLowerCase().includes(query) ||
                     book.author.toLowerCase().includes(query);
    }

    return passesFilter;
  });

  return (
    <div className="library">
      <Sidebar
        filter={state.filter}
        books={state.books}
        favorites={favorites}
        onFilterChange={onFilterChange}
        isCollapsed={sidebarCollapsed}
        onToggle={onToggleSidebar}
      />
      <main className="library-main">
        <header className="library-header">
          {sidebarCollapsed && (
            <button className="btn btn-ghost sidebar-expand-btn" onClick={onToggleSidebar} title="Expand sidebar">
              <Menu size={18} />
            </button>
          )}
          <h1 className="library-title">
            {state.filter === 'all' && 'All Books'}
            {state.filter === 'epub' && 'EPUBs'}
            {state.filter === 'pdf' && 'PDFs'}
            {state.filter === 'favorites' && 'Favorites'}
          </h1>
          <div className="library-actions">
            {showSearch ? (
              <div className="search-container">
                <input
                  ref={searchInputRef}
                  type="text"
                  className="search-input"
                  placeholder="Search books..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setShowSearch(false);
                      setSearchQuery('');
                    }
                  }}
                />
                <button
                  className="btn btn-ghost search-close"
                  onClick={() => { setShowSearch(false); setSearchQuery(''); }}
                  title="Close search"
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <button className="btn btn-ghost" onClick={() => setShowSearch(true)} title="Search books">
                <Search size={18} />
              </button>
            )}
          </div>
        </header>
        <div className="book-grid">
          {filteredBooks.length > 0 ? (
            <div className="book-grid-inner">
              {filteredBooks.map((book) => (
                <BookCard
                  key={book.id}
                  book={book}
                  coverUrl={covers[book.id]}
                  isFavorite={favorites.has(book.id)}
                  onClick={() => onOpenBook(book)}
                  onToggleFavorite={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(book.id);
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <LibraryIcon className="empty-state-icon" />
              <h2 className="empty-state-title">No books found</h2>
              <p className="empty-state-text">
                Add EPUB or PDF files to your book directory to see them here.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

const NotesPanel: React.FC<{
  highlights: Highlight[];
  notes: Note[];
  bookmarks: Bookmark[];
  activeTab: 'highlights' | 'notes' | 'bookmarks';
  onTabChange: (tab: 'highlights' | 'notes' | 'bookmarks') => void;
  onClose: () => void;
  onDeleteHighlight: (id: string) => void;
  onDeleteNote: (id: string) => void;
  onDeleteBookmark: (id: string) => void;
  onAddNote: (text: string, quote?: string, locationOrCfiRange?: string, pageNumber?: number) => void;
  onAddHighlight: (color: 'yellow' | 'green' | 'blue' | 'pink') => void;
  selectedText: string;
  selectedCfiRange: string;
  selectedPageNumber?: number;
  onClearSelection: () => void;
  onNavigateToHighlight: (location: string) => void;
  onNavigateToNote: (location: string) => void;
  onNavigateToBookmark: (location: string) => void;
  onNavigateToPage?: (pageNumber: number) => void;
  onExport: (format: 'markdown' | 'json') => void;
  format?: 'epub' | 'pdf';
}> = ({ highlights, notes, bookmarks, activeTab, onTabChange, onClose, onDeleteHighlight, onDeleteNote, onDeleteBookmark, onAddNote, onAddHighlight, selectedText, selectedCfiRange, selectedPageNumber, onClearSelection, onNavigateToHighlight, onNavigateToNote, onNavigateToBookmark, onNavigateToPage, onExport, format = 'epub' }) => {
  const [noteText, setNoteText] = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);
  const isPdf = format === 'pdf';

  const handleSubmitNote = () => {
    if (noteText.trim()) {
      // Pass location info so we can navigate back
      onAddNote(noteText.trim(), selectedText || undefined, selectedCfiRange || undefined, selectedPageNumber);
      setNoteText('');
      setShowNoteInput(false);
      onClearSelection();
    }
  };

  const handleHighlight = (color: 'yellow' | 'green' | 'blue' | 'pink') => {
    onAddHighlight(color);
    onClearSelection();
  };

  return (
    <motion.aside
      className="notes-panel"
      initial={{ x: 320, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 320, opacity: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      <div className="notes-panel-header">
        <h2 className="notes-panel-title">Annotations</h2>
        <button className="notes-panel-close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      {/* Selection Actions - Show when text is selected */}
      {selectedText && (
        <div className="selection-section">
          <div className="selection-header">
            <Highlighter size={16} />
            <span>Selected Text</span>
            <button className="selection-clear" onClick={onClearSelection} title="Clear selection">
              <X size={14} />
            </button>
          </div>
          <div className="selection-text">"{selectedText.length > 150 ? selectedText.slice(0, 150) + '...' : selectedText}"</div>

          {!showNoteInput ? (
            <div className="selection-actions">
              <div className="selection-colors">
                <span className="selection-label">Highlight:</span>
                <button
                  className="highlight-color-btn yellow"
                  onClick={() => handleHighlight('yellow')}
                  title="Yellow"
                />
                <button
                  className="highlight-color-btn green"
                  onClick={() => handleHighlight('green')}
                  title="Green"
                />
                <button
                  className="highlight-color-btn blue"
                  onClick={() => handleHighlight('blue')}
                  title="Blue"
                />
                <button
                  className="highlight-color-btn pink"
                  onClick={() => handleHighlight('pink')}
                  title="Pink"
                />
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowNoteInput(true)}>
                <StickyNote size={14} />
                Add Note
              </button>
            </div>
          ) : (
            <div className="selection-note-form">
              <textarea
                className="note-form-input"
                placeholder="Write your note about this text..."
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                rows={3}
                autoFocus
              />
              <div className="note-form-buttons">
                <button className="btn btn-ghost btn-sm" onClick={() => { setShowNoteInput(false); setNoteText(''); }}>
                  Cancel
                </button>
                <button className="btn btn-primary btn-sm" onClick={handleSubmitNote} disabled={!noteText.trim()}>
                  Save Note
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="notes-panel-tabs">
        <button
          className={`notes-panel-tab ${activeTab === 'highlights' ? 'active' : ''}`}
          onClick={() => onTabChange('highlights')}
        >
          Highlights ({highlights.length})
        </button>
        <button
          className={`notes-panel-tab ${activeTab === 'notes' ? 'active' : ''}`}
          onClick={() => onTabChange('notes')}
        >
          Notes ({notes.length})
        </button>
        <button
          className={`notes-panel-tab ${activeTab === 'bookmarks' ? 'active' : ''}`}
          onClick={() => onTabChange('bookmarks')}
        >
          Bookmarks ({bookmarks.length})
        </button>
      </div>

      <div className="notes-panel-content">
        {activeTab === 'highlights' ? (
          highlights.length > 0 ? (
            highlights.map((h) => {
              const canNavigate = isPdf ? !!h.pageNumber : !!h.cfiRange;
              const handleClick = () => {
                if (isPdf && h.pageNumber && onNavigateToPage) {
                  onNavigateToPage(h.pageNumber);
                } else if (h.cfiRange) {
                  onNavigateToHighlight(h.cfiRange);
                }
              };
              return (
                <div
                  key={h.id}
                  className={`annotation-item highlight-${h.color} ${canNavigate ? 'clickable' : ''}`}
                  onClick={handleClick}
                  title={canNavigate ? 'Click to go to this highlight' : undefined}
                >
                  <div className="annotation-text">"{h.text}"</div>
                  <div className="annotation-footer">
                    <div className="annotation-meta">
                      <span>{new Date(h.createdAt).toLocaleDateString()}</span>
                      {isPdf && h.pageNumber && <span className="annotation-page">Page {h.pageNumber}</span>}
                      {canNavigate && <span className="annotation-goto">Go to →</span>}
                    </div>
                    <button
                      className="annotation-delete"
                      onClick={(e) => { e.stopPropagation(); onDeleteHighlight(h.id); }}
                      title="Delete highlight"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="empty-state" style={{ padding: '2rem 1rem' }}>
              <Highlighter size={40} style={{ opacity: 0.3, marginBottom: '1rem' }} />
              <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>
                No highlights yet. Select text in the reader, then use the sidebar to highlight.
              </p>
            </div>
          )
        ) : activeTab === 'notes' ? (
          notes.length > 0 ? (
            notes.map((n) => {
              const canNavigate = isPdf ? !!n.pageNumber : !!n.cfiRange;
              const handleClick = () => {
                if (isPdf && n.pageNumber && onNavigateToPage) {
                  onNavigateToPage(n.pageNumber);
                } else if (n.cfiRange) {
                  onNavigateToNote(n.cfiRange);
                }
              };
              return (
                <div
                  key={n.id}
                  className={`annotation-item ${canNavigate ? 'clickable' : ''}`}
                  onClick={handleClick}
                  title={canNavigate ? 'Click to go to this note' : undefined}
                >
                  {n.quote && <div className="annotation-quote">"{n.quote}"</div>}
                  <div className="annotation-note">{n.text}</div>
                  <div className="annotation-footer">
                    <div className="annotation-meta">
                      <span>{new Date(n.createdAt).toLocaleDateString()}</span>
                      {isPdf && n.pageNumber && <span className="annotation-page">Page {n.pageNumber}</span>}
                      {canNavigate && <span className="annotation-goto">Go to →</span>}
                    </div>
                    <button
                      className="annotation-delete"
                      onClick={(e) => { e.stopPropagation(); onDeleteNote(n.id); }}
                      title="Delete note"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="empty-state" style={{ padding: '2rem 1rem' }}>
              <StickyNote size={40} style={{ opacity: 0.3, marginBottom: '1rem' }} />
              <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>
                No notes yet. Select text and add a note from the sidebar.
              </p>
            </div>
          )
        ) : (
          // Bookmarks tab
          bookmarks.length > 0 ? (
            bookmarks.map((b) => {
              const canNavigate = isPdf ? !!b.pageNumber : !!b.cfiRange;
              const handleClick = () => {
                if (isPdf && b.pageNumber && onNavigateToPage) {
                  onNavigateToPage(b.pageNumber);
                } else if (b.cfiRange) {
                  onNavigateToBookmark(b.cfiRange);
                }
              };
              const displayTitle = isPdf
                ? (b.title || `Page ${b.pageNumber}`)
                : (b.title || `Chapter ${b.chapterIndex + 1}`);
              return (
                <div
                  key={b.id}
                  className={`annotation-item ${canNavigate ? 'clickable' : ''}`}
                  onClick={handleClick}
                  title={canNavigate ? 'Click to go to this bookmark' : undefined}
                >
                  <div className="annotation-note">
                    <Star size={14} fill="currentColor" style={{ marginRight: '0.5rem', color: 'var(--accent-gold)' }} />
                    {displayTitle}
                  </div>
                  <div className="annotation-footer">
                    <div className="annotation-meta">
                      <span>{new Date(b.createdAt).toLocaleDateString()}</span>
                      {canNavigate && <span className="annotation-goto">Go to →</span>}
                    </div>
                    <button
                      className="annotation-delete"
                      onClick={(e) => { e.stopPropagation(); onDeleteBookmark(b.id); }}
                      title="Delete bookmark"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="empty-state" style={{ padding: '2rem 1rem' }}>
              <Star size={40} style={{ opacity: 0.3, marginBottom: '1rem' }} />
              <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>
                No bookmarks yet. Click the star icon in the header to bookmark this page.
              </p>
            </div>
          )
        )}
      </div>

      {/* Export Section - Copies to clipboard (downloads blocked in MCP App iframe) */}
      <div className="notes-panel-export">
        <div className="export-label">Export via Claude</div>
        <div className="export-buttons">
          <button className="btn btn-secondary btn-sm" onClick={() => onExport('markdown')}>
            <FileText size={14} />
            Markdown
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => onExport('json')}>
            <FileText size={14} />
            JSON
          </button>
        </div>
      </div>
    </motion.aside>
  );
};

// Helper to convert base64 to ArrayBuffer
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// Highlight color mapping for epub.js
const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: 'rgba(255, 220, 100, 0.4)',
  green: 'rgba(130, 200, 130, 0.35)',
  blue: 'rgba(130, 180, 220, 0.35)',
  pink: 'rgba(220, 150, 180, 0.35)',
};

// ============================================================================
// PDF Reader View Component
// ============================================================================

const PDFReaderView: React.FC<{
  state: AppState;
  app: App | null;
  onToggleNotes: () => void;
  onSetNotesTab: (tab: 'highlights' | 'notes' | 'bookmarks') => void;
  onBack: () => void;
  onAddHighlight: (text: string, color: 'yellow' | 'green' | 'blue' | 'pink', pageNumber?: number) => void;
  onAddNote: (text: string, quote?: string, pageNumber?: number) => void;
  onDeleteHighlight: (id: string) => void;
  onDeleteNote: (id: string) => void;
  onToggleBookmark: (pageNumber: number) => void;
  onDeleteBookmark: (id: string) => void;
  onExport: (format: 'markdown' | 'json') => void;
  onOpenNotes: () => void;
}> = ({
  state,
  app,
  onToggleNotes,
  onSetNotesTab,
  onBack,
  onAddHighlight,
  onAddNote,
  onDeleteHighlight,
  onDeleteNote,
  onToggleBookmark,
  onDeleteBookmark,
  onExport,
  onOpenNotes,
}) => {
  const { currentBook, highlights, notes, bookmarks, showNotes, notesTab } = state;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState('');
  const [selectedPageNumber, setSelectedPageNumber] = useState(1);

  // Load saved reading position when book changes
  useEffect(() => {
    if (!currentBook?.id) return;

    try {
      const savedPositions = localStorage.getItem('libralm-reading-positions');
      if (savedPositions) {
        const positions = JSON.parse(savedPositions);
        const savedPage = positions[currentBook.id];
        if (savedPage && typeof savedPage === 'number') {
          console.log('[LibraLM-PDF] Restoring page position for', currentBook.id, ':', savedPage);
          setCurrentPage(savedPage);
          return;
        }
      }
    } catch {
      // Ignore storage errors
    }
    setCurrentPage(1);
  }, [currentBook?.id]);

  // Load PDF data when book changes
  useEffect(() => {
    if (!currentBook?.path || !app) return;

    const loadPdfData = async () => {
      setLoading(true);
      setError(null);

      try {
        const pdfResult = await app.callServerTool({
          name: 'get_pdf_data',
          arguments: { path: currentBook.path },
        });
        const result = extractStructuredContent<{ base64: string; mimeType: string; size: number }>(pdfResult);
        if (!result?.base64) {
          throw new Error('Failed to get PDF data');
        }

        const arrayBuffer = base64ToArrayBuffer(result.base64);
        const data = new Uint8Array(arrayBuffer);
        const pdf = await pdfjsLib.getDocument({
          data,
          verbosity: VerbosityLevel.ERRORS, // Suppress warnings that interfere with MCP JSON
        }).promise;
        setPdfDoc(pdf);
        setTotalPages(pdf.numPages);
        setLoading(false);

        console.log('[LibraLM-PDF] PDF loaded, pages:', pdf.numPages);

        app.updateModelContext({
          content: [{
            type: 'text',
            text: `LibraLM Reader | "${currentBook.title}" by ${currentBook.author}\n\nPDF opened (${pdf.numPages} pages).`,
          }],
        });
      } catch (err) {
        console.error('[LibraLM-PDF] Failed to load PDF:', err);
        setError(err instanceof Error ? err.message : 'Failed to load PDF');
        setLoading(false);
      }
    };

    loadPdfData();
  }, [app, currentBook?.path, currentBook?.title, currentBook?.author]);

  // Render current page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || !textLayerRef.current) return;

    const renderPage = async () => {
      try {
        const page = await pdfDoc.getPage(currentPage);
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current!;
        const ctx = canvas.getContext('2d')!;
        const textLayerEl = textLayerRef.current!;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = viewport.width * dpr;
        canvas.height = viewport.height * dpr;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        ctx.scale(dpr, dpr);

        textLayerEl.innerHTML = '';
        textLayerEl.style.width = `${viewport.width}px`;
        textLayerEl.style.height = `${viewport.height}px`;

        await page.render({ canvasContext: ctx, viewport }).promise;

        const textContent = await page.getTextContent();
        const textLayer = new TextLayer({
          textContentSource: textContent,
          container: textLayerEl,
          viewport,
        });
        await textLayer.render();

        // Apply visual highlights to the text layer
        const pageHighlights = highlights.filter(h => h.pageNumber === currentPage);
        if (pageHighlights.length > 0) {
          const spans = textLayerEl.querySelectorAll('span');

          const colorMap: Record<string, string> = {
            yellow: 'rgba(255, 220, 100, 0.5)',
            green: 'rgba(130, 200, 130, 0.5)',
            blue: 'rgba(130, 180, 220, 0.5)',
            pink: 'rgba(220, 150, 180, 0.5)',
          };

          // Helper to normalize text for matching (collapse whitespace, lowercase)
          const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

          // Build normalized full text and track span boundaries
          const spanData: { span: Element; start: number; end: number }[] = [];
          let normPosition = 0;

          spans.forEach((span) => {
            const rawText = span.textContent || '';
            const normText = normalize(rawText);
            if (normText.length > 0) {
              spanData.push({
                span,
                start: normPosition,
                end: normPosition + normText.length,
              });
              normPosition += normText.length + 1; // +1 for space separator
            }
          });

          // Build full normalized text (spaces between spans)
          const fullNormText = Array.from(spans)
            .map(s => normalize(s.textContent || ''))
            .filter(t => t.length > 0)
            .join(' ');

          pageHighlights.forEach(highlight => {
            const highlightNorm = normalize(highlight.text);
            if (!highlightNorm || highlightNorm.length < 3) return;

            // Find where the highlight text appears in the full normalized text
            const matchPos = fullNormText.indexOf(highlightNorm);
            if (matchPos === -1) return;

            const matchEnd = matchPos + highlightNorm.length;

            // Find spans that overlap with this match range
            spanData.forEach(({ span, start, end }) => {
              // Check if this span overlaps with the match range
              if (start < matchEnd && end > matchPos) {
                (span as HTMLElement).style.backgroundColor = colorMap[highlight.color] || colorMap.yellow;
                (span as HTMLElement).style.borderRadius = '2px';
              }
            });
          });
        }

        const pageText = (textContent.items as TextItem[])
          .map((item) => item.str || '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        // Save position
        if (currentBook?.id) {
          try {
            const savedPositions = localStorage.getItem('libralm-reading-positions');
            const positions = savedPositions ? JSON.parse(savedPositions) : {};
            positions[currentBook.id] = currentPage;
            localStorage.setItem('libralm-reading-positions', JSON.stringify(positions));
          } catch { /* ignore */ }
        }

        // Sync reading context
        if (app && currentBook) {
          app.callServerTool({
            name: 'sync_reading_context',
            arguments: {
              bookId: currentBook.id,
              title: currentBook.title,
              author: currentBook.author,
              position: `Page ${currentPage} of ${totalPages}`,
              visibleText: pageText.slice(0, 5000),
            },
          }).catch(console.warn);

          app.updateModelContext({
            content: [{
              type: 'text',
              text: `LibraLM Reader | "${currentBook.title}" by ${currentBook.author}\nPage ${currentPage} of ${totalPages}\n\n[Use get_current_context tool to see the visible page content]`,
            }],
          });
        }
      } catch (err) {
        console.error('[LibraLM-PDF] Failed to render page:', err);
      }
    };

    renderPage();
  }, [pdfDoc, currentPage, scale, app, currentBook, totalPages, highlights]);

  // Handle text selection - open notes panel when text is selected
  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim();
      if (text && text.length > 2) {
        setSelectedText(text);
        setSelectedPageNumber(currentPage);
        // Auto-open notes panel when text is selected
        onOpenNotes();
      }
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, [currentPage, onOpenNotes]);

  const handleClearSelection = useCallback(() => {
    setSelectedText('');
    window.getSelection()?.removeAllRanges();
  }, []);

  const goToPage = useCallback((page: number) => {
    const targetPage = Math.max(1, Math.min(page, totalPages));
    if (targetPage !== currentPage) setCurrentPage(targetPage);
  }, [currentPage, totalPages]);

  const prevPage = useCallback(() => goToPage(currentPage - 1), [currentPage, goToPage]);
  const nextPage = useCallback(() => goToPage(currentPage + 1), [currentPage, goToPage]);
  const zoomIn = useCallback(() => setScale((s) => Math.min(s + 0.25, 3.0)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(s - 0.25, 0.5)), []);

  const handleHighlightFromSelection = useCallback((color: 'yellow' | 'green' | 'blue' | 'pink') => {
    if (!selectedText) return;
    onAddHighlight(selectedText, color, selectedPageNumber);
    handleClearSelection();
  }, [selectedText, selectedPageNumber, onAddHighlight, handleClearSelection]);

  const handleAddNoteFromSelection = useCallback((noteText: string) => {
    onAddNote(noteText, selectedText || undefined, selectedPageNumber);
    handleClearSelection();
  }, [selectedText, selectedPageNumber, onAddNote, handleClearSelection]);

  const handleNavigateToPage = useCallback((pageNumber: number) => {
    if (pageNumber >= 1 && pageNumber <= totalPages) setCurrentPage(pageNumber);
  }, [totalPages]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case 'ArrowLeft':
        case 'PageUp':
          prevPage();
          e.preventDefault();
          break;
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          nextPage();
          e.preventDefault();
          break;
        case '+':
        case '=':
          zoomIn();
          e.preventDefault();
          break;
        case '-':
          zoomOut();
          e.preventDefault();
          break;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [prevPage, nextPage, zoomIn, zoomOut]);

  if (!currentBook) return null;

  return (
    <div className="reader">
      <header className="reader-header">
        <div className="reader-header-left">
          <button className="reader-back-btn" onClick={onBack}>
            <ChevronLeft />
            <span>Library</span>
          </button>
          <span className="reader-book-title">{currentBook.title}</span>
        </div>
        <div className="reader-header-right">
          {(() => {
            const isBookmarked = bookmarks.some(b => b.pageNumber === currentPage);
            return (
              <button
                className={`reader-header-btn ${isBookmarked ? 'is-bookmarked' : ''}`}
                onClick={() => onToggleBookmark(currentPage)}
                title={isBookmarked ? 'Remove bookmark' : 'Bookmark this page'}
              >
                <Star fill={isBookmarked ? 'currentColor' : 'none'} />
              </button>
            );
          })()}
          <button className="reader-header-btn" onClick={onToggleNotes} title="Notes & Highlights">
            <BookMarked />
          </button>
        </div>
      </header>

      <div className="reader-content reader-content-pdf">
        <div className="pdf-viewer-container">
          {loading && (
            <div className="pdf-loading">
              <div className="pdf-loading-spinner" />
              <p>Loading PDF...</p>
            </div>
          )}
          {error && <div className="pdf-error"><p>Error: {error}</p></div>}
          {!loading && !error && (
            <>
              <div className="pdf-controls">
                <button onClick={prevPage} disabled={currentPage <= 1} className="pdf-nav-btn">
                  <ChevronLeft size={20} />
                </button>
                <div className="pdf-page-info">
                  <input
                    type="number"
                    value={currentPage}
                    onChange={(e) => goToPage(parseInt(e.target.value, 10) || 1)}
                    min={1}
                    max={totalPages}
                    className="pdf-page-input"
                  />
                  <span>of {totalPages}</span>
                </div>
                <button onClick={nextPage} disabled={currentPage >= totalPages} className="pdf-nav-btn">
                  <ChevronRight size={20} />
                </button>
                <div className="pdf-zoom-controls">
                  <button onClick={zoomOut} disabled={scale <= 0.5} className="pdf-zoom-btn">
                    <ZoomOut size={18} />
                  </button>
                  <span className="pdf-zoom-level">{Math.round(scale * 100)}%</span>
                  <button onClick={zoomIn} disabled={scale >= 3.0} className="pdf-zoom-btn">
                    <ZoomIn size={18} />
                  </button>
                </div>
              </div>

              <div className="pdf-canvas-wrapper">
                <div className="pdf-page-container" style={{ position: 'relative' }}>
                  <canvas ref={canvasRef} className="pdf-canvas" />
                  <div ref={textLayerRef} className="pdf-text-layer" />
                </div>
              </div>
            </>
          )}
        </div>

        <AnimatePresence>
          {showNotes && (
            <NotesPanel
              highlights={highlights}
              notes={notes}
              bookmarks={bookmarks}
              activeTab={notesTab}
              onTabChange={onSetNotesTab}
              onClose={onToggleNotes}
              onDeleteHighlight={onDeleteHighlight}
              onDeleteNote={onDeleteNote}
              onDeleteBookmark={onDeleteBookmark}
              onAddNote={handleAddNoteFromSelection}
              onAddHighlight={handleHighlightFromSelection}
              selectedText={selectedText}
              selectedCfiRange=""
              selectedPageNumber={selectedPageNumber}
              onClearSelection={handleClearSelection}
              onNavigateToHighlight={() => {}}
              onNavigateToNote={() => {}}
              onNavigateToBookmark={() => {}}
              onNavigateToPage={handleNavigateToPage}
              onExport={onExport}
              format="pdf"
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

// ============================================================================
// EPUB Reader View Component
// ============================================================================

const ReaderView: React.FC<{
  state: AppState;
  app: App | null;
  onToggleNotes: () => void;
  onSetNotesTab: (tab: 'highlights' | 'notes' | 'bookmarks') => void;
  onBack: () => void;
  onAddHighlight: (text: string, color: 'yellow' | 'green' | 'blue' | 'pink', cfiRange?: string) => void;
  onAddNote: (text: string, quote?: string) => void;
  onDeleteHighlight: (id: string) => void;
  onDeleteNote: (id: string) => void;
  onToggleBookmark: (cfiRange: string) => void;
  onDeleteBookmark: (id: string) => void;
  onExport: (format: 'markdown' | 'json') => void;
  onOpenNotes: () => void;
  selectedText: string;
  selectedCfiRange: string;
  onSetSelection: (text: string, cfiRange: string) => void;
  onClearSelection: () => void;
}> = ({ state, app, onToggleNotes, onSetNotesTab, onBack, onAddHighlight, onAddNote, onDeleteHighlight, onDeleteNote, onToggleBookmark, onDeleteBookmark, onExport, onOpenNotes, selectedText, selectedCfiRange, onSetSelection, onClearSelection }) => {
  const { currentBook, highlights, notes, showNotes, notesTab } = state;
  const [epubData, setEpubData] = useState<ArrayBuffer | null>(null);
  const [location, setLocation] = useState<string | number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renditionReady, setRenditionReady] = useState(false);

  // Store rendition reference
  const renditionRef = useRef<Rendition | null>(null);

  // Load saved reading position when book changes
  useEffect(() => {
    if (!currentBook?.id) return;

    try {
      const savedPositions = localStorage.getItem('libralm-reading-positions');
      if (savedPositions) {
        const positions = JSON.parse(savedPositions);
        const savedLocation = positions[currentBook.id];
        if (savedLocation) {
          console.log('[LibraLM] Restoring reading position for', currentBook.id);
          setLocation(savedLocation);
          return;
        }
      }
    } catch {
      // Ignore storage errors
    }
    // No saved position, start at beginning
    setLocation(0);
  }, [currentBook?.id]);

  // Load EPUB data when book changes
  useEffect(() => {
    if (!currentBook?.path || !app) return;

    const loadEpubData = async () => {
      setLoading(true);
      setError(null);
      setRenditionReady(false); // Reset when loading new book

      try {
        // Get the EPUB data as base64 via MCP tool (CSP-safe)
        const epubResult = await app.callServerTool({
          name: 'get_epub_data',
          arguments: { path: currentBook.path },
        });
        const result = extractStructuredContent<{ base64: string; mimeType: string; size: number }>(epubResult);
        if (!result?.base64) {
          throw new Error('Failed to get EPUB data');
        }

        // Convert base64 to ArrayBuffer (like pdf-server does)
        const arrayBuffer = base64ToArrayBuffer(result.base64);
        setEpubData(arrayBuffer);
        setLoading(false);

        // Send initial context to model
        app.updateModelContext({
          content: [{
            type: 'text',
            text: `LibraLM Reader | "${currentBook.title}" by ${currentBook.author}\n\nBook opened. User is now reading this book.`,
          }],
        });
      } catch (err) {
        console.error('[LibraLM] Failed to load EPUB:', err);
        setError(err instanceof Error ? err.message : 'Failed to load book');
        setLoading(false);
      }
    };

    loadEpubData();
  }, [app, currentBook?.path]);

  // Apply saved highlights when rendition is ready and highlights are loaded
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition || !renditionReady || highlights.length === 0) return;

    console.log('[LibraLM] Applying', highlights.length, 'highlights to rendition');

    // Add highlights to rendition
    highlights.forEach((h) => {
      if (h.cfiRange) {
        try {
          rendition.annotations.highlight(
            h.cfiRange,
            {},
            undefined,
            'hl',
            { fill: HIGHLIGHT_COLORS[h.color] || HIGHLIGHT_COLORS.yellow }
          );
        } catch (err) {
          console.warn('[LibraLM] Failed to apply highlight:', h.id, err);
        }
      }
    });
  }, [highlights, renditionReady]);

  // Listen for page relocations to update model context on every page turn
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition || !renditionReady || !app || !currentBook) return;

    const handleRelocated = (location: { start: { percentage?: number; displayed?: { page: number; total: number }; cfi?: string }; end?: { cfi?: string } }) => {
      let locationInfo = '';
      let visibleText = '';

      if (location && location.start) {
        const start = location.start;
        const displayedPage = start.displayed?.page || 1;
        const totalPages = start.displayed?.total || 1;

        locationInfo = `Page ${displayedPage} of ${totalPages} in current section`;

        // Get visible text using CFI range from epub.js
        try {
          const contents = rendition.getContents() as unknown as Array<{ document: Document; window: Window }>;
          if (contents && Array.isArray(contents) && contents.length > 0) {
            const content = contents[0];
            const doc = content.document;
            const win = content.window;

            if (doc && win) {
              const body = doc.body;
              const fullText = body?.innerText?.trim() || body?.textContent?.trim() || '';

              // Primary method: Use CFI range to get exact visible content
              // CFI is viewport-independent, unlike page numbers
              if (location.start.cfi && location.end?.cfi) {
                try {
                  const startRange = rendition.getRange(location.start.cfi);
                  const endRange = rendition.getRange(location.end.cfi);

                  if (startRange && endRange) {
                    const visibleRange = doc.createRange();
                    visibleRange.setStart(startRange.startContainer, startRange.startOffset);
                    visibleRange.setEnd(endRange.endContainer, endRange.endOffset);
                    const cfiText = visibleRange.toString().trim();

                    // CFI extraction worked - use it if it's reasonable size
                    if (cfiText.length > 0 && cfiText.length <= 10000) {
                      visibleText = cfiText;
                      console.log('[LibraLM] CFI range extracted', visibleText.length, 'chars');
                    } else if (cfiText.length > 10000) {
                      // CFI returned too much - extract center portion around estimated position
                      console.log('[LibraLM] CFI returned', cfiText.length, 'chars (too long), using center extraction');
                      const center = Math.floor(cfiText.length / 2);
                      const windowSize = 2500; // Get ~5000 chars total
                      visibleText = cfiText.slice(Math.max(0, center - windowSize), center + windowSize).trim();
                    }
                  }
                } catch (rangeErr) {
                  console.log('[LibraLM] CFI range failed:', rangeErr);
                }
              }

              // Fallback: Extract text around the percentage position in the section
              // This is viewport-independent since we use overall percentage, not page numbers
              if (!visibleText && fullText) {
                // Use the percentage within the section to find our position
                // We estimate that 1 "page" of content is roughly fullText.length / totalPages chars
                // But since totalPages is viewport-dependent, we use a fixed window instead

                // Estimate position: page X of Y means we're at X/Y through the section
                const sectionProgress = totalPages > 0 ? displayedPage / totalPages : 0;

                // Extract a window around this position
                const windowSize = 2500; // ~5000 chars total
                const centerChar = Math.floor(sectionProgress * fullText.length);
                const startChar = Math.max(0, centerChar - windowSize);
                const endChar = Math.min(fullText.length, centerChar + windowSize);

                visibleText = fullText.slice(startChar, endChar).trim();
                console.log('[LibraLM] Percentage-based extraction: progress', (sectionProgress * 100).toFixed(1) + '%',
                  '- center char', centerChar, 'of', fullText.length,
                  '- extracted', visibleText.length, 'chars');
              }

              // Last resort: Just get the start of the section
              if (!visibleText && fullText) {
                visibleText = fullText.slice(0, 3000);
                console.log('[LibraLM] Last resort: first 3000 chars');
              }
            }
          }
        } catch (e) {
          console.error('[LibraLM] Text extraction failed:', e);
          visibleText = '[Error extracting visible text]';
        }

        // Safety limit: A single page should never exceed ~5000 chars
        // If we got more, something went wrong with extraction
        if (visibleText.length > 5000) {
          console.warn('[LibraLM] Text too long, truncating from', visibleText.length, 'to 5000 chars');
          visibleText = visibleText.slice(0, 5000) + '\n\n[Content truncated - showing first 5000 characters of current page]';
        }
      }

      console.log('[LibraLM] Page relocated, syncing reading context, text length:', visibleText.length);
      // Sync reading context to server (no token limit unlike updateModelContext)
      app.callServerTool({
        name: 'sync_reading_context',
        arguments: {
          bookId: currentBook.id,
          title: currentBook.title,
          author: currentBook.author,
          position: locationInfo,
          visibleText: visibleText,
        },
      }).catch((err) => {
        console.warn('[LibraLM] Failed to sync reading context:', err);
      });

      // Also update model context with lightweight metadata (no text, stays under token limit)
      // This gives Claude instant visibility into what the user is reading
      app.updateModelContext({
        content: [{
          type: 'text',
          text: `LibraLM Reader | "${currentBook.title}" by ${currentBook.author}
${locationInfo}

[Use get_current_context tool to see the visible page content]`,
        }],
      });
    };

    // Add the relocated listener - will fire when EPUB navigates to a page
    rendition.on('relocated', handleRelocated);

    return () => {
      rendition.off('relocated', handleRelocated);
    };
  }, [renditionReady, app, currentBook]);

  const handleLocationChange = useCallback((epubcfi: string) => {
    // Update location state - the 'relocated' event handles context syncing
    setLocation(epubcfi);

    // Save reading position to localStorage
    if (currentBook?.id && epubcfi) {
      try {
        const savedPositions = localStorage.getItem('libralm-reading-positions');
        const positions = savedPositions ? JSON.parse(savedPositions) : {};
        positions[currentBook.id] = epubcfi;
        localStorage.setItem('libralm-reading-positions', JSON.stringify(positions));
      } catch {
        // Ignore storage errors
      }
    }
  }, [currentBook?.id]);

  // Handle adding a highlight from sidebar
  const handleHighlightFromSidebar = useCallback((color: 'yellow' | 'green' | 'blue' | 'pink') => {
    if (!selectedText || !selectedCfiRange || !renditionRef.current) return;

    // Add visual highlight to rendition
    try {
      renditionRef.current.annotations.highlight(
        selectedCfiRange,
        {},
        undefined,
        'hl',
        { fill: HIGHLIGHT_COLORS[color] }
      );
    } catch (err) {
      console.warn('[LibraLM] Failed to add highlight to rendition:', err);
    }

    // Save to server (pass cfiRange along with text)
    onAddHighlight(selectedText, color, selectedCfiRange);
  }, [selectedText, selectedCfiRange, onAddHighlight]);

  // Navigate to a highlight location
  const handleNavigateToHighlight = useCallback((cfiRange: string) => {
    if (!renditionRef.current) return;
    try {
      renditionRef.current.display(cfiRange);
    } catch (err) {
      console.warn('[LibraLM] Failed to navigate to highlight:', err);
    }
  }, []);

  // Navigate to a note location
  const handleNavigateToNote = useCallback((cfiRange: string) => {
    if (!renditionRef.current) return;
    try {
      renditionRef.current.display(cfiRange);
    } catch (err) {
      console.warn('[LibraLM] Failed to navigate to note:', err);
    }
  }, []);

  // Navigate to a bookmark location
  const handleNavigateToBookmark = useCallback((cfiRange: string) => {
    if (!renditionRef.current) return;
    try {
      renditionRef.current.display(cfiRange);
    } catch (err) {
      console.warn('[LibraLM] Failed to navigate to bookmark:', err);
    }
  }, []);

  // Setup rendition with selection handling
  const handleRendition = useCallback((rendition: Rendition) => {
    renditionRef.current = rendition;

    // Apply theme
    rendition.themes.default({
      body: {
        background: '#faf8f5',
        color: '#2c2416',
        'font-family': 'Georgia, serif',
      },
      '::selection': {
        background: 'rgba(139, 105, 20, 0.3)',
      },
    });

    // Handle text selection - open sidebar with selection
    rendition.on('selected', (cfiRange: string, contents: { window: Window }) => {
      const selection = contents.window.getSelection();
      const text = selection?.toString().trim();

      if (text && text.length > 0) {
        // Set selection in parent state and open notes panel
        onSetSelection(text, cfiRange);
        onOpenNotes();
      }
    });

    // Mark rendition as ready to trigger highlight application
    setRenditionReady(true);
    console.log('[LibraLM] Rendition ready with selection handling');
  }, [onSetSelection, onOpenNotes]);

  if (!currentBook) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
        <div className="loading-text">Loading book...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="reader">
        <header className="reader-header">
          <div className="reader-header-left">
            <button className="reader-back-btn" onClick={onBack}>
              <ChevronLeft />
              <span>Library</span>
            </button>
          </div>
        </header>
        <div className="reader-error">
          <div className="reader-error-icon">
            <X size={48} />
          </div>
          <h2>Failed to Load Book</h2>
          <p>{error}</p>
          <button className="btn btn-primary" onClick={onBack}>
            Return to Library
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="reader">
      <header className="reader-header">
        <div className="reader-header-left">
          <button className="reader-back-btn" onClick={onBack}>
            <ChevronLeft />
            <span>Library</span>
          </button>
          <span className="reader-book-title">{currentBook.title}</span>
        </div>
        <div className="reader-header-right">
          {(() => {
            // Check if current location is bookmarked
            const currentCfi = location?.toString();
            const isBookmarked = currentCfi && state.bookmarks.some(b => b.cfiRange === currentCfi);
            return (
              <button
                className={`reader-header-btn ${isBookmarked ? 'is-bookmarked' : ''}`}
                onClick={() => currentCfi && onToggleBookmark(currentCfi)}
                title={isBookmarked ? 'Remove bookmark' : 'Bookmark this page'}
              >
                <Star fill={isBookmarked ? 'currentColor' : 'none'} />
              </button>
            );
          })()}
          <button className="reader-header-btn" onClick={onToggleNotes} title="Notes & Highlights">
            <BookMarked />
          </button>
        </div>
      </header>

      <div className="reader-content reader-content-epub">
        {loading || location === null ? (
          <div className="loading">
            <div className="loading-spinner" />
            <div className="loading-text">Loading book...</div>
          </div>
        ) : epubData ? (
          <ReactReader
            url={epubData}
            location={location}
            locationChanged={handleLocationChange}
            title={currentBook.title}
            showToc={true}
            getRendition={handleRendition}
          />
        ) : null}

        <AnimatePresence>
          {showNotes && (
            <NotesPanel
              highlights={highlights}
              notes={notes}
              bookmarks={state.bookmarks}
              activeTab={notesTab}
              onTabChange={onSetNotesTab}
              onClose={onToggleNotes}
              onDeleteHighlight={onDeleteHighlight}
              onDeleteNote={onDeleteNote}
              onDeleteBookmark={onDeleteBookmark}
              onAddNote={onAddNote}
              onAddHighlight={handleHighlightFromSidebar}
              selectedText={selectedText}
              selectedCfiRange={selectedCfiRange}
              onClearSelection={onClearSelection}
              onNavigateToHighlight={handleNavigateToHighlight}
              onNavigateToNote={handleNavigateToNote}
              onNavigateToBookmark={handleNavigateToBookmark}
              onExport={onExport}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

// ============================================================================
// Main App with MCP App SDK
// ============================================================================

function LibraLMReaderApp() {
  const [state, setState] = useState<AppState>({
    view: 'loading',
    books: [],
    currentBook: null,
    highlights: [],
    notes: [],
    bookmarks: [],
    filter: 'all',
    showNotes: false,
    notesTab: 'highlights',
  });

  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();

  // Selection state - managed at app level so sidebar can access it
  const [selectedText, setSelectedText] = useState<string>('');
  const [selectedCfiRange, setSelectedCfiRange] = useState<string>('');

  // Sidebar collapsed state - start collapsed for better MCP App display
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  // Favorites state - persisted to localStorage
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('libralm-favorites');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => !prev);
  }, []);

  const handleToggleFavorite = useCallback((bookId: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(bookId)) {
        next.delete(bookId);
      } else {
        next.add(bookId);
      }
      // Persist to localStorage
      try {
        localStorage.setItem('libralm-favorites', JSON.stringify([...next]));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  const handleSetSelection = useCallback((text: string, cfiRange: string) => {
    setSelectedText(text);
    setSelectedCfiRange(cfiRange);
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedText('');
    setSelectedCfiRange('');
  }, []);

  const handleOpenNotes = useCallback(() => {
    setState(prev => ({ ...prev, showNotes: true }));
  }, []);

  // Initialize MCP App with useApp hook
  const { app, error } = useApp({
    appInfo: { name: 'LibraLM Reader', version: '2.0.0' },
    capabilities: {},
    onAppCreated: (app) => {
      // Handle teardown
      app.onteardown = async () => {
        console.info('LibraLM Reader is being torn down');
        return {};
      };

      // Handle tool input (when tool is called)
      app.ontoolinput = async (input) => {
        console.info('Received tool input:', input);
      };

      // Handle tool result (when tool returns data)
      app.ontoolresult = async (result) => {
        console.info('Received tool result');

        // Extract books from view_library result
        const data = extractStructuredContent<{ books: Book[] }>(result);
        if (data?.books) {
          setState(prev => ({
            ...prev,
            view: 'library',
            books: data.books,
          }));
        }
      };

      app.ontoolcancelled = (params) => {
        console.info('Tool cancelled:', params.reason);
      };

      app.onerror = console.error;

      app.onhostcontextchanged = (params) => {
        setHostContext(prev => ({ ...prev, ...params }));
      };
    },
  });

  // Apply host styles
  useHostStyles(app);

  // Get initial host context
  useEffect(() => {
    if (app) {
      setHostContext(app.getHostContext());
    }
  }, [app]);

  // Handle opening a book
  const handleOpenBook = useCallback(async (book: Book) => {
    if (!app) return;

    setState(prev => ({ ...prev, view: 'loading' }));

    try {
      // Load book details
      const loadResult = await app.callServerTool({
        name: 'load_book',
        arguments: { path: book.path },
      });

      const bookData = extractStructuredContent<{
        book: BookDetails;
        lastPosition?: { chapterIndex: number };
      }>(loadResult);

      if (bookData?.book) {
        // Switch to reader view - react-reader will handle the rest
        setState(prev => ({
          ...prev,
          view: 'reader',
          currentBook: { ...bookData.book, path: book.path },
          highlights: [],
          notes: [],
          bookmarks: [],
        }));

        // Load saved annotations and bookmarks from server
        try {
          const [annotationsResult, bookmarksResult] = await Promise.all([
            app.callServerTool({
              name: 'list_annotations',
              arguments: { bookId: bookData.book.id },
            }),
            app.callServerTool({
              name: 'list_bookmarks',
              arguments: { bookId: bookData.book.id },
            }),
          ]);

          const annotations = extractStructuredContent<{
            highlights: Highlight[];
            notes: Note[];
          }>(annotationsResult);

          const bookmarksData = extractStructuredContent<{
            bookmarks: Bookmark[];
          }>(bookmarksResult);

          setState(prev => ({
            ...prev,
            highlights: annotations?.highlights || [],
            notes: annotations?.notes || [],
            bookmarks: bookmarksData?.bookmarks || [],
          }));
        } catch (err) {
          console.error('[LibraLM] Failed to load annotations:', err);
        }
      }
    } catch (err) {
      console.error('Failed to open book:', err);
      setState(prev => ({ ...prev, view: 'library' }));
    }
  }, [app]);

  // Handle back to library
  const handleBack = useCallback(() => {
    setState(prev => ({
      ...prev,
      view: 'library',
      currentBook: null,
    }));
  }, []);

  // Handle add highlight - update local state immediately, persist to server in background
  const handleAddHighlight = useCallback(async (text: string, color: 'yellow' | 'green' | 'blue' | 'pink', cfiRange?: string) => {
    if (!app || !state.currentBook) return;

    // Optimistic local ID (will be replaced by server ID)
    const tempId = `temp-${Date.now()}`;
    const newHighlight: Highlight = {
      id: tempId,
      bookId: state.currentBook.id,
      chapterIndex: 0,
      text,
      color,
      cfiRange,
      createdAt: new Date().toISOString(),
    };

    // Update local state immediately for instant UI
    setState(prev => ({
      ...prev,
      highlights: [newHighlight, ...prev.highlights],
    }));

    // Persist to server in background
    try {
      const result = await app.callServerTool({
        name: 'add_highlight',
        arguments: {
          bookId: state.currentBook.id,
          chapterIndex: 0,
          text,
          color,
          cfiRange,
        },
      });

      // Update with real ID from server
      const meta = (result as unknown as { _meta?: { highlightAdded?: Highlight } })._meta;
      if (meta?.highlightAdded) {
        setState(prev => ({
          ...prev,
          highlights: prev.highlights.map(h =>
            h.id === tempId ? { ...h, id: meta.highlightAdded!.id } : h
          ),
        }));
      }
      console.log('[LibraLM] Highlight persisted to server');
    } catch (err) {
      console.error('[LibraLM] Failed to persist highlight:', err);
    }
  }, [app, state.currentBook]);

  // Handle add note - update local state immediately, persist to server in background
  const handleAddNote = useCallback(async (text: string, quote?: string, cfiRange?: string) => {
    if (!app || !state.currentBook) return;

    const tempId = `temp-${Date.now()}`;
    const newNote: Note = {
      id: tempId,
      bookId: state.currentBook.id,
      chapterIndex: 0,
      text,
      quote,
      cfiRange,
      createdAt: new Date().toISOString(),
    };

    // Update local state immediately
    setState(prev => ({
      ...prev,
      notes: [newNote, ...prev.notes],
    }));

    // Persist to server in background
    try {
      const result = await app.callServerTool({
        name: 'add_note',
        arguments: {
          bookId: state.currentBook.id,
          chapterIndex: 0,
          text,
          quote,
          cfiRange,
        },
      });

      // Update with real ID from server
      const meta = (result as unknown as { _meta?: { noteAdded?: Note } })._meta;
      if (meta?.noteAdded) {
        setState(prev => ({
          ...prev,
          notes: prev.notes.map(n =>
            n.id === tempId ? { ...n, id: meta.noteAdded!.id } : n
          ),
        }));
      }
      console.log('[LibraLM] Note persisted to server');
    } catch (err) {
      console.error('[LibraLM] Failed to persist note:', err);
    }
  }, [app, state.currentBook]);

  // Handle delete highlight - update local state immediately, persist to server
  const handleDeleteHighlight = useCallback(async (id: string) => {
    // Update local state immediately
    setState(prev => ({
      ...prev,
      highlights: prev.highlights.filter(h => h.id !== id),
    }));

    // Persist to server (skip if it was a temp ID that never got saved)
    if (!id.startsWith('temp-') && app) {
      try {
        await app.callServerTool({
          name: 'delete_annotation',
          arguments: { id, type: 'highlight' },
        });
        console.log('[LibraLM] Highlight deleted from server');
      } catch (err) {
        console.error('[LibraLM] Failed to delete highlight from server:', err);
      }
    }
  }, [app]);

  // Handle delete note - update local state immediately, persist to server
  const handleDeleteNote = useCallback(async (id: string) => {
    // Update local state immediately
    setState(prev => ({
      ...prev,
      notes: prev.notes.filter(n => n.id !== id),
    }));

    // Persist to server
    if (!id.startsWith('temp-') && app) {
      try {
        await app.callServerTool({
          name: 'delete_annotation',
          arguments: { id, type: 'note' },
        });
        console.log('[LibraLM] Note deleted from server');
      } catch (err) {
        console.error('[LibraLM] Failed to delete note from server:', err);
      }
    }
  }, [app]);

  // Handle toggle bookmark - add if not exists, remove if exists
  const handleToggleBookmark = useCallback(async (cfiRange: string) => {
    if (!app || !state.currentBook) return;

    // Check if bookmark already exists at this location
    const existingBookmark = state.bookmarks.find(b => b.cfiRange === cfiRange);

    if (existingBookmark) {
      // Remove existing bookmark
      setState(prev => ({
        ...prev,
        bookmarks: prev.bookmarks.filter(b => b.id !== existingBookmark.id),
      }));

      // Persist deletion to server
      if (!existingBookmark.id.startsWith('temp-')) {
        try {
          await app.callServerTool({
            name: 'delete_annotation',
            arguments: { id: existingBookmark.id, type: 'bookmark' },
          });
          console.log('[LibraLM] Bookmark removed from server');
        } catch (err) {
          console.error('[LibraLM] Failed to delete bookmark from server:', err);
        }
      }
    } else {
      // Add new bookmark
      const tempId = `temp-${Date.now()}`;
      const newBookmark: Bookmark = {
        id: tempId,
        bookId: state.currentBook.id,
        chapterIndex: 0,
        title: `Bookmark at ${new Date().toLocaleTimeString()}`,
        cfiRange,
        createdAt: new Date().toISOString(),
      };

      // Update local state immediately
      setState(prev => ({
        ...prev,
        bookmarks: [newBookmark, ...prev.bookmarks],
      }));

      // Persist to server
      try {
        const result = await app.callServerTool({
          name: 'add_bookmark',
          arguments: {
            bookId: state.currentBook.id,
            chapterIndex: 0,
            title: newBookmark.title,
            cfiRange,
          },
        });

        // Update with real ID from server
        const data = extractStructuredContent<{ bookmark: Bookmark }>(result);
        if (data?.bookmark) {
          setState(prev => ({
            ...prev,
            bookmarks: prev.bookmarks.map(b =>
              b.id === tempId ? { ...b, id: data.bookmark!.id } : b
            ),
          }));
        }
        console.log('[LibraLM] Bookmark persisted to server');
      } catch (err) {
        console.error('[LibraLM] Failed to persist bookmark:', err);
      }
    }
  }, [app, state.currentBook, state.bookmarks]);

  // Handle delete bookmark - update local state immediately, persist to server
  const handleDeleteBookmark = useCallback(async (id: string) => {
    // Update local state immediately
    setState(prev => ({
      ...prev,
      bookmarks: prev.bookmarks.filter(b => b.id !== id),
    }));

    // Persist to server
    if (!id.startsWith('temp-') && app) {
      try {
        await app.callServerTool({
          name: 'delete_annotation',
          arguments: { id, type: 'bookmark' },
        });
        console.log('[LibraLM] Bookmark deleted from server');
      } catch (err) {
        console.error('[LibraLM] Failed to delete bookmark from server:', err);
      }
    }
  }, [app]);

  // ========================================================================
  // PDF-specific handlers (use pageNumber instead of cfiRange)
  // ========================================================================

  // Handle add highlight for PDF - uses pageNumber instead of cfiRange
  const handleAddHighlightPdf = useCallback(async (text: string, color: 'yellow' | 'green' | 'blue' | 'pink', pageNumber?: number) => {
    if (!app || !state.currentBook) return;

    const tempId = `temp-${Date.now()}`;
    const newHighlight: Highlight = {
      id: tempId,
      bookId: state.currentBook.id,
      chapterIndex: pageNumber ? pageNumber - 1 : 0,
      text,
      color,
      pageNumber,
      createdAt: new Date().toISOString(),
    };

    setState(prev => ({
      ...prev,
      highlights: [newHighlight, ...prev.highlights],
    }));

    try {
      const result = await app.callServerTool({
        name: 'add_highlight',
        arguments: {
          bookId: state.currentBook.id,
          chapterIndex: pageNumber ? pageNumber - 1 : 0,
          text,
          color,
          pageNumber,
        },
      });

      const meta = (result as unknown as { _meta?: { highlightAdded?: Highlight } })._meta;
      if (meta?.highlightAdded) {
        setState(prev => ({
          ...prev,
          highlights: prev.highlights.map(h =>
            h.id === tempId ? { ...h, id: meta.highlightAdded!.id } : h
          ),
        }));
      }
      console.log('[LibraLM-PDF] Highlight persisted to server');
    } catch (err) {
      console.error('[LibraLM-PDF] Failed to persist highlight:', err);
    }
  }, [app, state.currentBook]);

  // Handle add note for PDF - uses pageNumber instead of cfiRange
  const handleAddNotePdf = useCallback(async (text: string, quote?: string, pageNumber?: number) => {
    if (!app || !state.currentBook) return;

    const tempId = `temp-${Date.now()}`;
    const newNote: Note = {
      id: tempId,
      bookId: state.currentBook.id,
      chapterIndex: pageNumber ? pageNumber - 1 : 0,
      text,
      quote,
      pageNumber,
      createdAt: new Date().toISOString(),
    };

    setState(prev => ({
      ...prev,
      notes: [newNote, ...prev.notes],
    }));

    try {
      const result = await app.callServerTool({
        name: 'add_note',
        arguments: {
          bookId: state.currentBook.id,
          chapterIndex: pageNumber ? pageNumber - 1 : 0,
          text,
          quote,
          pageNumber,
        },
      });

      const meta = (result as unknown as { _meta?: { noteAdded?: Note } })._meta;
      if (meta?.noteAdded) {
        setState(prev => ({
          ...prev,
          notes: prev.notes.map(n =>
            n.id === tempId ? { ...n, id: meta.noteAdded!.id } : n
          ),
        }));
      }
      console.log('[LibraLM-PDF] Note persisted to server');
    } catch (err) {
      console.error('[LibraLM-PDF] Failed to persist note:', err);
    }
  }, [app, state.currentBook]);

  // Handle toggle bookmark for PDF - uses pageNumber instead of cfiRange
  const handleToggleBookmarkPdf = useCallback(async (pageNumber: number) => {
    if (!app || !state.currentBook) return;

    const existingBookmark = state.bookmarks.find(b => b.pageNumber === pageNumber);

    if (existingBookmark) {
      setState(prev => ({
        ...prev,
        bookmarks: prev.bookmarks.filter(b => b.id !== existingBookmark.id),
      }));

      if (!existingBookmark.id.startsWith('temp-')) {
        try {
          await app.callServerTool({
            name: 'delete_annotation',
            arguments: { id: existingBookmark.id, type: 'bookmark' },
          });
          console.log('[LibraLM-PDF] Bookmark removed from server');
        } catch (err) {
          console.error('[LibraLM-PDF] Failed to delete bookmark from server:', err);
        }
      }
    } else {
      const tempId = `temp-${Date.now()}`;
      const newBookmark: Bookmark = {
        id: tempId,
        bookId: state.currentBook.id,
        chapterIndex: pageNumber - 1,
        title: `Page ${pageNumber}`,
        pageNumber,
        createdAt: new Date().toISOString(),
      };

      setState(prev => ({
        ...prev,
        bookmarks: [newBookmark, ...prev.bookmarks],
      }));

      try {
        const result = await app.callServerTool({
          name: 'add_bookmark',
          arguments: {
            bookId: state.currentBook.id,
            chapterIndex: pageNumber - 1,
            title: newBookmark.title,
            pageNumber,
          },
        });

        const data = extractStructuredContent<{ bookmark: Bookmark }>(result);
        if (data?.bookmark) {
          setState(prev => ({
            ...prev,
            bookmarks: prev.bookmarks.map(b =>
              b.id === tempId ? { ...b, id: data.bookmark!.id } : b
            ),
          }));
        }
        console.log('[LibraLM-PDF] Bookmark persisted to server');
      } catch (err) {
        console.error('[LibraLM-PDF] Failed to persist bookmark:', err);
      }
    }
  }, [app, state.currentBook, state.bookmarks]);

  // Toast notification state
  const [toast, setToast] = useState<string | null>(null);

  // Handle export annotations - send to Claude via sendMessage (downloads/clipboard blocked in MCP App iframe)
  const handleExport = useCallback(async (format: 'markdown' | 'json') => {
    if (!app || !state.currentBook) return;

    try {
      setToast('Exporting annotations...');

      const result = await app.callServerTool({
        name: 'export_annotations',
        arguments: {
          bookId: state.currentBook.id,
          format,
        },
      });

      // Get the exported content
      const content = result.content?.[0];
      if (content && content.type === 'text') {
        // Send to Claude via sendMessage - Claude can help user save the file
        const bookTitle = state.currentBook.title || 'Book';
        const filename = `${bookTitle.replace(/[^a-zA-Z0-9]/g, '_')}_annotations.${format === 'markdown' ? 'md' : 'json'}`;

        await app.sendMessage({
          role: 'user',
          content: [{
            type: 'text',
            text: `Please save the following ${format === 'markdown' ? 'Markdown' : 'JSON'} annotations export for "${bookTitle}" to a file named "${filename}":\n\n\`\`\`${format === 'markdown' ? 'markdown' : 'json'}\n${content.text}\n\`\`\``,
          }],
        });

        setToast(`Sent ${format.toUpperCase()} export to Claude!`);
        setTimeout(() => setToast(null), 3000);
        console.log('[LibraLM] Annotations sent to Claude as', format);
      }
    } catch (err) {
      console.error('[LibraLM] Failed to export annotations:', err);
      setToast('Export failed');
      setTimeout(() => setToast(null), 3000);
    }
  }, [app, state.currentBook]);

  // Error state
  if (error) {
    return (
      <div className="app">
        <div className="loading">
          <div className="loading-text">Error: {error.message}</div>
        </div>
      </div>
    );
  }

  // Connecting state
  if (!app) {
    return (
      <div className="app">
        <div className="loading">
          <div className="loading-spinner" />
          <div className="loading-text">Connecting...</div>
        </div>
      </div>
    );
  }

  // Apply safe area insets
  const safeAreaStyle = hostContext?.safeAreaInsets ? {
    paddingTop: hostContext.safeAreaInsets.top,
    paddingRight: hostContext.safeAreaInsets.right,
    paddingBottom: hostContext.safeAreaInsets.bottom,
    paddingLeft: hostContext.safeAreaInsets.left,
  } : {};

  return (
    <div className="app" style={safeAreaStyle}>
      <AnimatePresence mode="wait">
        {state.view === 'loading' && (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="loading"
          >
            <div className="loading-spinner" />
            <div className="loading-text">Loading LibraLM...</div>
          </motion.div>
        )}

        {state.view === 'library' && (
          <motion.div
            key="library"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            style={{ height: '100%', width: '100%' }}
          >
            <LibraryView
              state={state}
              app={app}
              favorites={favorites}
              onFilterChange={(filter) => setState(prev => ({ ...prev, filter }))}
              onOpenBook={handleOpenBook}
              onToggleFavorite={handleToggleFavorite}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={handleToggleSidebar}
            />
          </motion.div>
        )}

        {state.view === 'reader' && state.currentBook?.format === 'epub' && (
          <motion.div
            key="reader-epub"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            style={{ height: '100%', width: '100%' }}
          >
            <ReaderView
              state={state}
              app={app}
              onToggleNotes={() => setState(prev => ({ ...prev, showNotes: !prev.showNotes }))}
              onSetNotesTab={(tab) => setState(prev => ({ ...prev, notesTab: tab }))}
              onBack={handleBack}
              onAddHighlight={handleAddHighlight}
              onAddNote={handleAddNote}
              onDeleteHighlight={handleDeleteHighlight}
              onDeleteNote={handleDeleteNote}
              onToggleBookmark={handleToggleBookmark}
              onDeleteBookmark={handleDeleteBookmark}
              onExport={handleExport}
              onOpenNotes={handleOpenNotes}
              selectedText={selectedText}
              selectedCfiRange={selectedCfiRange}
              onSetSelection={handleSetSelection}
              onClearSelection={handleClearSelection}
            />
          </motion.div>
        )}

        {state.view === 'reader' && state.currentBook?.format === 'pdf' && (
          <motion.div
            key="reader-pdf"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            style={{ height: '100%', width: '100%' }}
          >
            <PDFReaderView
              state={state}
              app={app}
              onToggleNotes={() => setState(prev => ({ ...prev, showNotes: !prev.showNotes }))}
              onSetNotesTab={(tab) => setState(prev => ({ ...prev, notesTab: tab }))}
              onBack={handleBack}
              onAddHighlight={handleAddHighlightPdf}
              onAddNote={handleAddNotePdf}
              onDeleteHighlight={handleDeleteHighlight}
              onDeleteNote={handleDeleteNote}
              onToggleBookmark={handleToggleBookmarkPdf}
              onDeleteBookmark={handleDeleteBookmark}
              onExport={handleExport}
              onOpenNotes={handleOpenNotes}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            className="toast"
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            transition={{ duration: 0.2 }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ============================================================================
// Mount
// ============================================================================

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LibraLMReaderApp />
  </StrictMode>
);
