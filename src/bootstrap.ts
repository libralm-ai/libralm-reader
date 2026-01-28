/**
 * Bootstrap file for LibraLM Reader.
 *
 * This file MUST run before any other imports to intercept console.warn.
 * PDF.js outputs warnings to stdout during module loading which breaks
 * MCP's JSON-RPC communication over stdio.
 *
 * This is the actual entry point - it sets up the warning suppression,
 * then dynamically imports main.ts.
 */

// CRITICAL: Intercept console.warn BEFORE any module imports
// This must happen before pdfjs-dist is loaded anywhere in the module tree
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const firstArg = String(args[0] || '');
  // Filter out PDF.js warnings (they start with "Warning: ")
  if (
    firstArg.startsWith('Warning:') ||
    firstArg.includes('pdfjs') ||
    firstArg.includes('PDF') ||
    firstArg.includes('font')
  ) {
    return; // Suppress - these break stdio JSON-RPC
  }
  originalWarn.apply(console, args);
};

// Also intercept console.log to catch any other PDF.js output
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  const firstArg = String(args[0] || '');
  if (firstArg.startsWith('Warning:')) {
    return; // Suppress PDF.js warnings that go to console.log
  }
  originalLog.apply(console, args);
};

// Now dynamically import main - this ensures all warning interception
// is set up before pdfjs-dist loads
import('./main.js');
