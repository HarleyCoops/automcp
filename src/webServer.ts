#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'url';
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
    return res.status(500).json({
      error: 'E2B_API_KEY is not set in environment variables',
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: 'OPENAI_API_KEY is not set in environment variables',
    });
  }

  // Set up Server-Sent Events
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  const sendEvent = (event: ProgressEvent | { type: 'result'; data: unknown } | { type: 'error'; error: string }) => {
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
      });
      res.end();
    }
  })();
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
  console.log(`📝 Make sure E2B_API_KEY and OPENAI_API_KEY are set in your .env file`);
});

