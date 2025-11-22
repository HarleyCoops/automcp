#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'node:fs';
import archiver from 'archiver';
import { runAutoMcp, type AutoMcpInput, type ProgressEvent } from './autoMcp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Generate MCP server endpoint with SSE progress streaming
app.post('/api/generate', async (req, res) => {
  const { apiName, baseUrl, docs, maxIterations } = req.body;

  if (!apiName || !baseUrl || !docs) {
    return res.status(400).json({
      error: 'Missing required fields: apiName, baseUrl, docs',
    });
  }

  if (!process.env.E2B_API_KEY) {
    console.error('[WebServer] Missing E2B_API_KEY');
    return res.status(500).json({
      error: 'E2B_API_KEY is not set in environment variables',
    });
  }

  const provider = (process.env.LLM_PROVIDER ?? 'openai').toLowerCase();
  if (provider === 'groq') {
    if (!process.env.GROQ_API_KEY) {
      console.error('[WebServer] Missing GROQ_API_KEY while LLM_PROVIDER=groq');
      return res.status(500).json({
        error: 'GROQ_API_KEY is not set in environment variables',
      });
    }
  } else {
    if (!process.env.OPENAI_API_KEY) {
      console.error('[WebServer] Missing OPENAI_API_KEY while LLM_PROVIDER=openai');
      return res.status(500).json({
        error: 'OPENAI_API_KEY is not set in environment variables',
      });
    }
  }

  // Set up Server-Sent Events
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  const sendEvent = (
    event:
      | ProgressEvent
      | { type: 'result'; data: unknown }
      | { type: 'error'; error: string; downloadId?: string; localPath?: string }
  ) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      console.error('[WebServer] Error writing SSE event:', err);
    }
  };

  // Run generation asynchronously
  (async () => {
    try {
      const input: AutoMcpInput = {
        apiName: String(apiName),
        baseUrl: String(baseUrl),
        docsHint: String(docs),
        maxIterations:
          maxIterations !== undefined ? Math.max(1, Number.parseInt(String(maxIterations), 10)) : undefined,
      };

      const result = await runAutoMcp(input, (event) => {
        sendEvent(event);
      });

      sendEvent({ type: 'result', data: result });
      res.end();
    } catch (error) {
      console.error('[WebServer] Generation failed:', error);
      sendEvent({
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        downloadId: (error as any)?.downloadId,
        localPath: (error as any)?.localPath,
      });
      res.end();
    }
  })();
});

app.get('/download/:id', async (req, res) => {
  const downloadId = req.params.id;
  const folderPath = path.join(process.cwd(), 'output', downloadId);
  try {
    await fs.access(folderPath);
  } catch {
    return res.status(404).json({ error: 'Download not found' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadId}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err: Error) => {
    console.error('[WebServer] Archive error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create archive' });
    } else {
      res.end();
    }
  });

  archive.pipe(res);
  archive.directory(folderPath, false);
  archive.finalize();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Serve the frontend for all non-API routes (SPA fallback)
app.use((req, res) => {
  // Only serve index.html for non-API routes
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 AutoMCP Web UI running at http://localhost:${PORT}`);
  const provider = (process.env.LLM_PROVIDER ?? 'openai').toLowerCase();
  if (provider === 'groq') {
    console.log(`📝 Make sure E2B_API_KEY and GROQ_API_KEY are set in your environment`);
  } else {
    console.log(`📝 Make sure E2B_API_KEY and OPENAI_API_KEY are set in your environment`);
  }
});

