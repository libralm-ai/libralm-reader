#!/usr/bin/env node
/**
 * CLI entry point for LibraLM Reader.
 *
 * Uses the bootstrap pattern to intercept console.warn BEFORE any module imports.
 * This is necessary because PDF.js outputs warnings during module initialization,
 * which breaks MCP's JSON-RPC communication over stdio.
 */

// CRITICAL: Intercept console.warn BEFORE any module imports
const originalWarn = console.warn;
console.warn = (...args) => {
  const firstArg = String(args[0] || '');
  if (
    firstArg.startsWith('Warning:') ||
    firstArg.includes('pdfjs') ||
    firstArg.includes('PDF') ||
    firstArg.includes('font')
  ) {
    return; // Suppress - breaks stdio JSON-RPC
  }
  originalWarn.apply(console, args);
};

// Also intercept console.log for any stray warnings
const originalLog = console.log;
console.log = (...args) => {
  const firstArg = String(args[0] || '');
  if (firstArg.startsWith('Warning:')) {
    return;
  }
  originalLog.apply(console, args);
};

// Dynamic import ensures interception is set up before PDF.js loads
import('../dist/main.js');
