/**
 * PDF Engine for LibraLM Reader
 *
 * Server-side PDF parsing, caching, and text extraction using PDF.js.
 * Mirrors the patterns from epub-engine.ts for consistency.
 */
import * as fs from 'fs';
import * as path from 'path';

// CRITICAL: Intercept console.warn BEFORE importing pdfjs-dist to suppress its warnings
// PDF.js outputs warnings to stdout which breaks MCP's JSON-RPC communication
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  // Filter out PDF.js warnings (they start with "Warning: ")
  const firstArg = String(args[0] || '');
  if (firstArg.startsWith('Warning:') || firstArg.includes('pdfjs')) {
    return; // Suppress PDF.js warnings
  }
  originalWarn.apply(console, args);
};

// Use legacy build for Node.js compatibility (avoids "use legacy build" warning)
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/display/api.js';

// PDF.js options to suppress warnings and work properly in Node.js
// disableWorker runs PDF.js in the main thread - worker path resolution fails with npx
const PDF_OPTIONS = {
  useSystemFonts: true,
  verbosity: VerbosityLevel.ERRORS, // Only log errors, not warnings
  disableFontFace: true, // Avoid font-related warnings in Node.js
  isEvalSupported: false, // Disable eval for security and Node.js compatibility
  disableWorker: true, // Run in main thread - avoids worker path issues with npx
};

// ============================================================================
// Types
// ============================================================================

export interface PdfMetadata {
  id: string;
  title: string;
  author: string;
  format: 'pdf';
  pageCount: number;
  coverUrl?: string;
}

export interface PdfTocItem {
  title: string;
  pageNumber: number;
  level: number;
}

export interface PdfInfo {
  metadata: PdfMetadata;
  toc: PdfTocItem[];
}

// ============================================================================
// PDF Cache
// ============================================================================

interface CachedPdf {
  document: PDFDocumentProxy;
  metadata: PdfMetadata;
  toc: PdfTocItem[];
  lastAccess: number;
}

const pdfCache = new Map<string, CachedPdf>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function cleanCache(): void {
  const now = Date.now();
  for (const [key, value] of pdfCache.entries()) {
    if (now - value.lastAccess > CACHE_TTL) {
      value.document.destroy();
      pdfCache.delete(key);
    }
  }
}

setInterval(cleanCache, 5 * 60 * 1000);

// ============================================================================
// PDF Engine Core Functions
// ============================================================================

/**
 * Open and cache a PDF document.
 */
export async function openPdf(filePath: string, bookId: string): Promise<CachedPdf> {
  const cached = pdfCache.get(filePath);
  if (cached) {
    cached.lastAccess = Date.now();
    return cached;
  }

  // Read file and load PDF
  const data = new Uint8Array(fs.readFileSync(filePath));
  const document = await getDocument({ data, ...PDF_OPTIONS }).promise;

  // Extract metadata
  const pdfInfo = await document.getMetadata();
  const info = pdfInfo?.info as Record<string, string> | undefined;

  // Clean up title (some PDFs have filename or weird encoding)
  let title = info?.Title || '';
  if (!title || title === path.basename(filePath)) {
    title = path.basename(filePath, '.pdf');
  }
  // Clean up non-printable characters
  title = title.replace(/[\x00-\x1F\x7F]/g, '').trim();

  // Extract author
  let author = info?.Author || '';
  if (!author) {
    author = 'Unknown Author';
  }
  author = author.replace(/[\x00-\x1F\x7F]/g, '').trim();

  const metadata: PdfMetadata = {
    id: bookId,
    title: title || path.basename(filePath, '.pdf'),
    author,
    format: 'pdf',
    pageCount: document.numPages,
  };

  // Extract outline (TOC) if available
  const toc = await extractOutline(document);

  const entry: CachedPdf = {
    document,
    metadata,
    toc,
    lastAccess: Date.now(),
  };

  pdfCache.set(filePath, entry);
  return entry;
}

/**
 * Extract the PDF outline (bookmarks) as a table of contents.
 */
async function extractOutline(document: PDFDocumentProxy): Promise<PdfTocItem[]> {
  const toc: PdfTocItem[] = [];

  try {
    const outline = await document.getOutline();
    if (!outline || outline.length === 0) {
      return toc;
    }

    // Recursively process outline items
    async function processOutlineItems(
      items: Array<{ title: string; dest: string | unknown[] | null; items?: unknown[] }>,
      level: number
    ): Promise<void> {
      for (const item of items) {
        let pageNumber = 1;

        // Resolve destination to page number
        if (item.dest) {
          try {
            let dest: unknown[] | null = null;
            // If dest is a string, resolve it
            if (typeof item.dest === 'string') {
              dest = await document.getDestination(item.dest);
            } else if (Array.isArray(item.dest)) {
              dest = item.dest;
            }
            if (Array.isArray(dest) && dest[0]) {
              // dest[0] is typically a page reference
              const pageRef = dest[0] as { num: number; gen: number };
              const pageIndex = await document.getPageIndex(pageRef);
              pageNumber = pageIndex + 1; // Convert to 1-based
            }
          } catch {
            // Destination resolution failed, keep default page 1
          }
        }

        toc.push({
          title: item.title || `Section ${toc.length + 1}`,
          pageNumber,
          level,
        });

        // Process nested items
        if (item.items && Array.isArray(item.items) && item.items.length > 0) {
          await processOutlineItems(
            item.items as Array<{ title: string; dest: string | unknown[] | null; items?: unknown[] }>,
            level + 1
          );
        }
      }
    }

    await processOutlineItems(
      outline as Array<{ title: string; dest: string | unknown[] | null; items?: unknown[] }>,
      0
    );
  } catch (err) {
    console.error('Failed to extract PDF outline:', err);
  }

  return toc;
}

/**
 * Load a PDF and return its info.
 */
export async function loadPdf(filePath: string, bookId: string): Promise<PdfInfo> {
  const cached = await openPdf(filePath, bookId);
  return {
    metadata: cached.metadata,
    toc: cached.toc,
  };
}

// ============================================================================
// Text Extraction
// ============================================================================

/**
 * Extract text content from a specific PDF page.
 */
export async function extractPdfPageText(filePath: string, bookId: string, pageNumber: number): Promise<string> {
  const cached = await openPdf(filePath, bookId);
  const { document } = cached;

  if (pageNumber < 1 || pageNumber > document.numPages) {
    throw new Error(`Page ${pageNumber} out of range (1-${document.numPages})`);
  }

  const page = await document.getPage(pageNumber);
  return await getPageText(page);
}

/**
 * Extract text from a PDF page proxy.
 */
async function getPageText(page: PDFPageProxy): Promise<string> {
  const textContent = await page.getTextContent();

  // Build text from items, preserving some structure
  const lines: string[] = [];
  let currentLine = '';
  let lastY: number | null = null;

  for (const item of textContent.items) {
    if (!('str' in item)) continue;
    const textItem = item as TextItem;

    // Check if this is a new line (significant Y change)
    const y = textItem.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > 5) {
      if (currentLine.trim()) {
        lines.push(currentLine.trim());
      }
      currentLine = '';
    }
    lastY = y;

    currentLine += textItem.str;
  }

  if (currentLine.trim()) {
    lines.push(currentLine.trim());
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Extract text from a range of pages.
 */
export async function extractPdfPagesText(
  filePath: string,
  bookId: string,
  startPage: number,
  pageCount: number = 1
): Promise<{ pages: Array<{ pageNumber: number; text: string }>; totalPages: number }> {
  const cached = await openPdf(filePath, bookId);
  const { document } = cached;

  const endPage = Math.min(startPage + pageCount - 1, document.numPages);
  const pages: Array<{ pageNumber: number; text: string }> = [];

  for (let i = startPage; i <= endPage; i++) {
    const page = await document.getPage(i);
    const text = await getPageText(page);
    pages.push({ pageNumber: i, text });
  }

  return { pages, totalPages: document.numPages };
}

// ============================================================================
// Content Extraction for Search/Indexing
// ============================================================================

export interface ExtractedPdfContent {
  bookId: string;
  title: string;
  author: string;
  chapters: Array<{
    index: number;
    title: string;
    content: string;
  }>;
}

/**
 * Extract all text from a PDF for search indexing.
 * Each page is treated as a "chapter" for consistency with EPUB structure.
 */
export async function extractPdfText(filePath: string, bookId: string): Promise<ExtractedPdfContent> {
  const cached = await openPdf(filePath, bookId);
  const { document, metadata, toc } = cached;

  const chapters: Array<{ index: number; title: string; content: string }> = [];

  // Build a map of page numbers to TOC titles
  const pageToTitle = new Map<number, string>();
  for (const item of toc) {
    if (!pageToTitle.has(item.pageNumber)) {
      pageToTitle.set(item.pageNumber, item.title);
    }
  }

  // Extract text from each page
  for (let pageNum = 1; pageNum <= document.numPages; pageNum++) {
    try {
      const page = await document.getPage(pageNum);
      const text = await getPageText(page);

      if (text.trim()) {
        // Use TOC title if available, otherwise "Page N"
        const title = pageToTitle.get(pageNum) || `Page ${pageNum}`;

        chapters.push({
          index: pageNum - 1, // 0-based index
          title,
          content: text,
        });
      }
    } catch (err) {
      console.error(`Failed to extract page ${pageNum} from ${filePath}:`, err);
    }
  }

  return {
    bookId,
    title: metadata.title,
    author: metadata.author,
    chapters,
  };
}

// ============================================================================
// Scanning Support
// ============================================================================

export interface ScannedPdf {
  path: string;
  format: 'pdf';
  title: string;
  author: string;
  pageCount: number;
  coverUrl?: string;
}

/**
 * Scan a PDF file and extract its metadata for the library.
 */
export async function scanPdfFile(filePath: string): Promise<ScannedPdf> {
  try {
    // Read just enough to get metadata without full caching
    const data = new Uint8Array(fs.readFileSync(filePath));
    const document = await getDocument({ data, ...PDF_OPTIONS }).promise;

    const pdfInfo = await document.getMetadata();
    const info = pdfInfo?.info as Record<string, string> | undefined;

    let title = info?.Title || '';
    if (!title) {
      title = path.basename(filePath, '.pdf');
    }
    title = title.replace(/[\x00-\x1F\x7F]/g, '').trim();

    let author = info?.Author || '';
    if (!author) {
      author = 'Unknown Author';
    }
    author = author.replace(/[\x00-\x1F\x7F]/g, '').trim();

    const pageCount = document.numPages;

    // Clean up document (not caching during scan)
    document.destroy();

    return {
      path: filePath,
      format: 'pdf',
      title: title || path.basename(filePath, '.pdf'),
      author,
      pageCount,
    };
  } catch (err) {
    console.error(`Failed to scan PDF ${filePath}:`, err);
    return {
      path: filePath,
      format: 'pdf',
      title: path.basename(filePath, '.pdf'),
      author: 'Unknown Author',
      pageCount: 0,
    };
  }
}

/**
 * Get the page count for a PDF without full parsing.
 */
export async function getPdfPageCount(filePath: string): Promise<number> {
  try {
    const data = new Uint8Array(fs.readFileSync(filePath));
    const document = await getDocument({ data, ...PDF_OPTIONS }).promise;
    const count = document.numPages;
    document.destroy();
    return count;
  } catch {
    return 0;
  }
}
