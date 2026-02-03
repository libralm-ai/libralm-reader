/**
 * Entry point for running the LibraLM Reader MCP server.
 * Run with: npm run serve
 * Or: node dist/main.js [--stdio]
 *
 * NOTE: When running via stdio (Claude Desktop), use bootstrap.ts instead.
 * Bootstrap sets up console.warn interception before module imports to
 * suppress PDF.js warnings that would break JSON-RPC communication.
 */

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import express from 'express';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createServer } from './index.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '3001', 10);

/**
 * Starts an MCP server with Streamable HTTP transport in stateless mode.
 */
async function startStreamableHTTPServer(): Promise<void> {
  const app = createMcpExpressApp({ host: '0.0.0.0' });
  app.use(cors());

  // Handle all MCP requests - create new server instance per request (stateless)
  app.all('/mcp', async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', name: 'libralm-reader', version: '2.0.0' });
  });

  // Get the book path
  const bookPath = process.env.BOOK_PATH || path.join(os.homedir(), 'Books');

  // Proxy external images to bypass CSP restrictions
  // Images are fetched server-side and returned as base64 data URLs
  app.get('/proxy-image', async (req: Request, res: Response) => {
    const imageUrl = req.query.url as string;

    if (!imageUrl) {
      res.status(400).json({ error: 'Missing url parameter' });
      return;
    }

    try {
      // Decode the URL
      const decodedUrl = decodeURIComponent(imageUrl);

      // Validate it's a proper URL
      const parsedUrl = new URL(decodedUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        res.status(400).json({ error: 'Invalid URL protocol' });
        return;
      }

      // Fetch the image
      const response = await fetch(decodedUrl, {
        headers: {
          'User-Agent': 'LibraLM-Reader/2.0 (RSS Image Proxy)',
          'Accept': 'image/*',
        },
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (!response.ok) {
        res.status(response.status).json({ error: `Failed to fetch image: ${response.statusText}` });
        return;
      }

      const contentType = response.headers.get('content-type') || 'image/png';

      // Check if it's actually an image
      if (!contentType.startsWith('image/')) {
        res.status(400).json({ error: 'URL does not point to an image' });
        return;
      }

      // Get the image data and forward it
      const buffer = await response.arrayBuffer();

      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
      res.send(Buffer.from(buffer));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Image proxy error:', message);
      res.status(500).json({ error: `Failed to proxy image: ${message}` });
    }
  });

  // Serve EPUB files by absolute path (URL-encoded)
  app.get('/epub', (req: Request, res: Response) => {
    const filePath = req.query.path as string;

    if (!filePath) {
      res.status(400).json({ error: 'Missing path parameter' });
      return;
    }

    // Decode the path
    const decodedPath = decodeURIComponent(filePath);

    // Security: ensure the file is within the books directory
    const normalizedPath = path.normalize(decodedPath);
    if (!normalizedPath.startsWith(path.normalize(bookPath))) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Check if file exists
    if (!fs.existsSync(normalizedPath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Set appropriate headers for EPUB files
    res.setHeader('Content-Type', 'application/epub+zip');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Stream the file
    res.sendFile(normalizedPath);
  });

  const httpServer = app.listen(PORT, () => {
    console.log(`LibraLM Reader v2.0.0`);
    console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`\nBook path: ${process.env.BOOK_PATH || '~/Books'}`);
    console.log(`Data path: ${process.env.DATA_PATH || '~/.libralm'}`);
  });

  let isShuttingDown = false;
  const shutdown = () => {
    if (isShuttingDown) {
      console.log('Force exit...');
      process.exit(1);
    }
    isShuttingDown = true;
    console.log('\nShutting down...');
    httpServer.close(() => process.exit(0));
    // Force exit after 3 seconds if server doesn't close
    setTimeout(() => process.exit(0), 3000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Starts an MCP server with stdio transport.
 */
async function startStdioServer(): Promise<void> {
  console.error('Starting LibraLM Reader in stdio mode...');
  await createServer().connect(new StdioServerTransport());
}

async function main() {
  if (process.argv.includes('--stdio')) {
    await startStdioServer();
  } else {
    await startStreamableHTTPServer();
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
