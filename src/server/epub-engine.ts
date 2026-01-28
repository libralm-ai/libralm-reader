// epub2 uses named export
import { EPub } from 'epub2';
import * as fs from 'fs';
import * as path from 'path';
import { scanPdfFile, loadPdf, type PdfInfo, type PdfTocItem } from './pdf-engine.js';

// ============================================================================
// Types
// ============================================================================

export interface BookMetadata {
  id: string;
  title: string;
  author: string;
  format: 'epub' | 'pdf';
  coverUrl?: string;
  chapterCount: number;
}

export interface TocItem {
  title: string;
  index: number;
  level: number;
  href?: string;
}

export interface BookInfo {
  metadata: BookMetadata;
  toc: TocItem[];
}

// Internal page structure
interface PageInfo {
  title: string;
  flowId: string;
  href: string;
  anchor?: string; // For TOC-based navigation with anchors
}

// ============================================================================
// EPUB Cache
// ============================================================================

interface CachedEpub {
  epub: InstanceType<typeof EPub>;
  pages: PageInfo[];
  tocEntries: TocItem[];
  lastAccess: number;
}

const epubCache = new Map<string, CachedEpub>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function cleanCache(): void {
  const now = Date.now();
  for (const [key, value] of epubCache.entries()) {
    if (now - value.lastAccess > CACHE_TTL) {
      epubCache.delete(key);
    }
  }
}

setInterval(cleanCache, 5 * 60 * 1000);

// ============================================================================
// EPUB Engine
// ============================================================================

interface EpubTocItem {
  href?: string;
  title?: string;
  level?: number;
  order?: number;
}

interface EpubFlowItem {
  id: string;
  href: string;
}

interface EpubSpineItem {
  id: string;
  href: string;
  title?: string;
}

async function openEpub(filePath: string): Promise<CachedEpub> {
  const cached = epubCache.get(filePath);
  if (cached) {
    cached.lastAccess = Date.now();
    return cached;
  }

  const epub = await EPub.createAsync(filePath);

  const flow = (epub as unknown as { flow: EpubFlowItem[] }).flow || [];
  const toc = (epub as unknown as { toc: EpubTocItem[] }).toc || [];
  const spine = (epub as unknown as { spine: { contents: EpubSpineItem[] } }).spine;
  const spineContents = spine?.contents || [];

  // Build lookup maps
  const hrefToFlowId = new Map<string, string>();
  const hrefToFlowIndex = new Map<string, number>();
  for (let i = 0; i < flow.length; i++) {
    const item = flow[i];
    hrefToFlowId.set(item.href, item.id);
    hrefToFlowId.set(normalizeHref(item.href), item.id);
    hrefToFlowIndex.set(item.href, i);
    hrefToFlowIndex.set(normalizeHref(item.href), i);
  }

  // Build map of file href to TOC entries (for title lookup)
  const hrefToTocTitle = new Map<string, string>();
  for (const tocItem of toc) {
    if (tocItem.href && tocItem.title) {
      const fileHref = tocItem.href.split('#')[0];
      // Only set if not already set (first TOC entry wins)
      if (!hrefToTocTitle.has(fileHref)) {
        hrefToTocTitle.set(fileHref, tocItem.title);
      }
      if (!hrefToTocTitle.has(normalizeHref(fileHref))) {
        hrefToTocTitle.set(normalizeHref(fileHref), tocItem.title);
      }
    }
  }

  // Check if this book uses anchor-based TOC (like Life 3.0)
  // This is when TOC has more entries than flow items and uses anchors
  const tocHasAnchors = toc.some((t) => t.href?.includes('#'));
  const useAnchorBasedPages = toc.length > flow.length && tocHasAnchors;

  const pages: PageInfo[] = [];

  if (useAnchorBasedPages) {
    // TOC-based with anchors: each TOC entry is a page
    const sortedToc = [...toc].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    for (const tocItem of sortedToc) {
      if (!tocItem.href) continue;

      const [fileHref, anchor] = tocItem.href.split('#');
      const flowId = hrefToFlowId.get(fileHref) || hrefToFlowId.get(normalizeHref(fileHref));

      if (!flowId) continue;

      pages.push({
        title: tocItem.title || `Page ${pages.length + 1}`,
        flowId: flowId,
        href: fileHref,
        anchor: anchor,
      });
    }
  } else {
    // Flow-based: each HTML file in spine order is a page
    // Use spine contents for correct reading order with any embedded titles
    for (let i = 0; i < spineContents.length; i++) {
      const spineItem = spineContents[i];
      const flowId = spineItem.id;
      const href = spineItem.href;

      // Try to get title from: spine > TOC > fallback
      let title = spineItem.title;
      if (!title) {
        title = hrefToTocTitle.get(href) || hrefToTocTitle.get(normalizeHref(href));
      }
      if (!title) {
        title = `Page ${i + 1}`;
      }

      pages.push({
        title,
        flowId,
        href,
      });
    }
  }

  // Build TOC entries for sidebar navigation
  const tocEntries: TocItem[] = [];
  const sortedToc = [...toc].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  for (const tocItem of sortedToc) {
    if (!tocItem.href) continue;

    const fileHref = tocItem.href.split('#')[0];
    const anchor = tocItem.href.split('#')[1];

    // Find which page this TOC entry maps to
    let pageIndex: number;
    if (useAnchorBasedPages) {
      // For anchor-based books, match by full href
      pageIndex = pages.findIndex((p) => p.href === fileHref && p.anchor === anchor);
    } else {
      // For flow-based books, match by file href
      pageIndex = pages.findIndex(
        (p) => p.href === fileHref || normalizeHref(p.href) === normalizeHref(fileHref)
      );
    }

    if (pageIndex >= 0) {
      tocEntries.push({
        title: tocItem.title || `Section ${tocEntries.length + 1}`,
        index: pageIndex,
        level: tocItem.level || 0,
        href: tocItem.href,
      });
    }
  }

  const entry: CachedEpub = {
    epub,
    pages,
    tocEntries,
    lastAccess: Date.now(),
  };
  epubCache.set(filePath, entry);
  return entry;
}

function normalizeHref(href: string): string {
  return href
    .replace(/^OEBPS\//, '')
    .replace(/^EPUB\//, '')
    .replace(/^OPS\//, '')
    .replace(/^xhtml\//, '')
    .replace(/^text\//, '');
}

export async function loadBook(filePath: string, bookId: string): Promise<BookInfo> {
  const { epub, pages, tocEntries } = await openEpub(filePath);

  let coverUrl: string | undefined;
  try {
    coverUrl = await extractCover(epub);
  } catch {
    // No cover available
  }

  const metadata = (epub as unknown as { metadata: { title?: string; creator?: string } }).metadata || {};

  const bookMetadata: BookMetadata = {
    id: bookId,
    title: metadata.title || path.basename(filePath, '.epub'),
    author: metadata.creator || 'Unknown Author',
    format: 'epub',
    coverUrl,
    chapterCount: pages.length,
  };

  return { metadata: bookMetadata, toc: tocEntries };
}

async function extractCover(epub: InstanceType<typeof EPub>): Promise<string | undefined> {
  const manifest = (
    epub as unknown as { manifest: Record<string, { 'media-type'?: string; href?: string }> }
  ).manifest;
  if (!manifest) return undefined;

  let coverId: string | undefined;

  const epubMetadata = (epub as unknown as { metadata?: { cover?: string } }).metadata;
  if (epubMetadata?.cover) {
    coverId = epubMetadata.cover;
  }

  if (!coverId) {
    const coverPatterns = ['cover', 'cover-image', 'coverimage', 'Cover'];
    for (const pattern of coverPatterns) {
      if (manifest[pattern]) {
        coverId = pattern;
        break;
      }
    }
  }

  if (!coverId) {
    for (const [id, item] of Object.entries(manifest)) {
      if (
        item['media-type']?.startsWith('image/') &&
        (id.toLowerCase().includes('cover') || (item.href && item.href.toLowerCase().includes('cover')))
      ) {
        coverId = id;
        break;
      }
    }
  }

  if (!coverId) return undefined;

  try {
    const result = await epub.getImageAsync(coverId);
    if (result && result[0]) {
      const [data, mimeType] = result;
      const base64 = data.toString('base64');
      return `data:${mimeType};base64,${base64}`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

// ============================================================================
// PDF Support
// ============================================================================

export function isPdf(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.pdf');
}

export function isEpub(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.epub');
}

export async function getPdfMetadata(filePath: string, bookId: string): Promise<BookMetadata> {
  try {
    const pdfInfo = await loadPdf(filePath, bookId);
    return {
      id: bookId,
      title: pdfInfo.metadata.title,
      author: pdfInfo.metadata.author,
      format: 'pdf',
      chapterCount: pdfInfo.metadata.pageCount,
    };
  } catch (err) {
    // Fallback to basic metadata if PDF parsing fails
    console.error(`Failed to load PDF metadata for ${filePath}:`, err);
    return {
      id: bookId,
      title: path.basename(filePath, '.pdf'),
      author: 'Unknown Author',
      format: 'pdf',
      chapterCount: 1,
    };
  }
}

/**
 * Load a PDF and return full BookInfo with TOC.
 * This mirrors loadBook() for EPUBs.
 */
export async function loadPdfBook(filePath: string, bookId: string): Promise<BookInfo> {
  const pdfInfo = await loadPdf(filePath, bookId);

  // Convert PdfTocItem[] to TocItem[] format
  const toc: TocItem[] = pdfInfo.toc.length > 0
    ? pdfInfo.toc.map((item: PdfTocItem, index: number) => ({
        title: item.title,
        index: item.pageNumber - 1, // Convert to 0-based index
        level: item.level,
      }))
    : [{ title: 'Document', index: 0, level: 0 }]; // Fallback if no TOC

  const metadata: BookMetadata = {
    id: bookId,
    title: pdfInfo.metadata.title,
    author: pdfInfo.metadata.author,
    format: 'pdf',
    chapterCount: pdfInfo.metadata.pageCount,
  };

  return { metadata, toc };
}

// ============================================================================
// Book Scanning
// ============================================================================

export interface ScannedBook {
  path: string;
  format: 'epub' | 'pdf';
  title: string;
  author: string;
  coverUrl?: string;
  description?: string; // From EPUB metadata <dc:description>
  pageCount?: number; // PDF page count
}

// ============================================================================
// Content Extraction for Search
// ============================================================================

export interface ExtractedChapter {
  index: number;
  title: string;
  content: string; // Plain text, HTML stripped
}

export interface ExtractedBookContent {
  bookId: string;
  title: string;
  author: string;
  chapters: ExtractedChapter[];
}

/**
 * Extract plain text content from all chapters of an EPUB for search indexing.
 * Strips HTML tags, normalizes whitespace, and removes repeated frontmatter.
 */
export async function extractBookText(filePath: string, bookId: string): Promise<ExtractedBookContent> {
  const { epub, pages } = await openEpub(filePath);
  const metadata = (epub as unknown as { metadata: { title?: string; creator?: string } }).metadata || {};

  const rawChapters: ExtractedChapter[] = [];

  // Extract text from each page/chapter
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    try {
      // Get the raw HTML content for this chapter
      const html = await new Promise<string>((resolve, reject) => {
        epub.getChapter(page.flowId, (err: Error | null, text?: string) => {
          if (err) reject(err);
          else resolve(text || '');
        });
      });

      // Strip HTML and normalize text
      const plainText = stripHtml(html);

      if (plainText.trim()) {
        rawChapters.push({
          index: i,
          title: page.title,
          content: plainText,
        });
      }
    } catch (err) {
      console.error(`Failed to extract chapter ${i} from ${filePath}:`, err);
      // Continue with other chapters
    }
  }

  // Remove repeated frontmatter/TOC text that appears across multiple chapters
  const chapters = deduplicateChapterContent(rawChapters);

  return {
    bookId,
    title: metadata.title || path.basename(filePath, '.epub'),
    author: metadata.creator || 'Unknown Author',
    chapters,
  };
}

/**
 * Detect and remove text blocks that appear in multiple chapters.
 * Some EPUBs have TOC/copyright text embedded in every chapter file.
 */
function deduplicateChapterContent(chapters: ExtractedChapter[]): ExtractedChapter[] {
  if (chapters.length < 3) return chapters;

  // Find common text blocks at the start of chapters
  // Take first 2000 chars of each chapter to compare
  const prefixes = chapters.map((ch) => ch.content.slice(0, 2000));

  // Find longest common prefix across most chapters
  const commonPrefix = findCommonPrefix(prefixes, Math.ceil(chapters.length * 0.5));

  // Find common suffixes (text at end of chapters)
  const suffixes = chapters.map((ch) => ch.content.slice(-1500));
  const commonSuffix = findCommonSuffix(suffixes, Math.ceil(chapters.length * 0.5));

  // Strip common prefix/suffix from all chapters
  return chapters.map((ch) => {
    let content = ch.content;

    // Remove common prefix if found and substantial (> 200 chars)
    if (commonPrefix.length > 200) {
      const prefixIndex = content.indexOf(commonPrefix);
      if (prefixIndex !== -1 && prefixIndex < 500) {
        content = content.slice(prefixIndex + commonPrefix.length);
      }
    }

    // Remove common suffix if found and substantial
    if (commonSuffix.length > 200) {
      const suffixIndex = content.lastIndexOf(commonSuffix);
      if (suffixIndex !== -1 && suffixIndex > content.length - 2000) {
        content = content.slice(0, suffixIndex);
      }
    }

    return {
      ...ch,
      content: content.trim(),
    };
  });
}

/**
 * Find the longest common prefix that appears in at least minCount strings.
 */
function findCommonPrefix(strings: string[], minCount: number): string {
  if (strings.length === 0) return '';

  // Start with first string and progressively find common prefix
  let prefix = strings[0];

  for (let len = Math.min(prefix.length, 2000); len >= 100; len -= 50) {
    const testPrefix = prefix.slice(0, len);
    const matchCount = strings.filter((s) => s.startsWith(testPrefix)).length;

    if (matchCount >= minCount) {
      return testPrefix;
    }
  }

  return '';
}

/**
 * Find the longest common suffix that appears in at least minCount strings.
 */
function findCommonSuffix(strings: string[], minCount: number): string {
  if (strings.length === 0) return '';

  // Start with first string and find common suffix
  let suffix = strings[0];

  for (let len = Math.min(suffix.length, 1500); len >= 100; len -= 50) {
    const testSuffix = suffix.slice(-len);
    const matchCount = strings.filter((s) => s.endsWith(testSuffix)).length;

    if (matchCount >= minCount) {
      return testSuffix;
    }
  }

  return '';
}

/**
 * Strip HTML tags and normalize whitespace for plain text.
 */
function stripHtml(html: string): string {
  // Remove script and style elements entirely
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Replace block-level elements with newlines
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr)[^>]*>/gi, '\n');

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/&mdash;/gi, '—');
  text = text.replace(/&ndash;/gi, '–');
  text = text.replace(/&rsquo;/gi, "'");
  text = text.replace(/&lsquo;/gi, "'");
  text = text.replace(/&rdquo;/gi, '"');
  text = text.replace(/&ldquo;/gi, '"');
  text = text.replace(/&#\d+;/gi, ''); // Remove numeric entities

  // Normalize whitespace
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/\n\s+/g, '\n');
  text = text.replace(/\n+/g, '\n');

  return text.trim();
}

// ============================================================================
// Book Scanning
// ============================================================================

export async function scanDirectory(dirPath: string): Promise<ScannedBook[]> {
  const books: ScannedBook[] = [];

  if (!fs.existsSync(dirPath)) {
    return books;
  }

  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      const subBooks = await scanDirectory(filePath);
      books.push(...subBooks);
    } else if (isEpub(file)) {
      try {
        const { epub } = await openEpub(filePath);
        const coverUrl = await extractCover(epub);
        const metadata = (epub as unknown as { metadata: { title?: string; creator?: string; description?: string } }).metadata || {};

        // Clean and truncate description if present
        let description = metadata.description;
        if (description) {
          // Strip HTML tags from description
          description = description.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          // Truncate if very long (some EPUBs have full synopses)
          if (description.length > 300) {
            description = description.slice(0, 297) + '...';
          }
        }

        books.push({
          path: filePath,
          format: 'epub',
          title: metadata.title || path.basename(file, '.epub'),
          author: metadata.creator || 'Unknown Author',
          coverUrl,
          description,
        });
      } catch (err) {
        console.error(`Failed to scan EPUB ${filePath}:`, err);
        books.push({
          path: filePath,
          format: 'epub',
          title: path.basename(file, '.epub'),
          author: 'Unknown Author',
        });
      }
    } else if (isPdf(file)) {
      try {
        const pdfInfo = await scanPdfFile(filePath);
        books.push({
          path: pdfInfo.path,
          format: 'pdf',
          title: pdfInfo.title,
          author: pdfInfo.author,
          pageCount: pdfInfo.pageCount,
        });
      } catch (err) {
        console.error(`Failed to scan PDF ${filePath}:`, err);
        books.push({
          path: filePath,
          format: 'pdf',
          title: path.basename(file, '.pdf'),
          author: 'Unknown Author',
        });
      }
    }
  }

  return books;
}
