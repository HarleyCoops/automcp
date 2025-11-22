#!/usr/bin/env node
import 'dotenv/config';
import process from 'node:process';
import { runAutoMcp } from './autoMcp.js';

function printUsage() {
  console.log(`Usage: pnpm start -- --apiName "Task API" --baseUrl https://api.example.com --docs https://api.example.com/docs`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith('--') || !value) {
      throw new Error('Arguments must be provided as --key value pairs');
    }
    result[key.slice(2)] = value;
  }
  return result;
}

async function main() {
  try {
    const { apiName, baseUrl, docs, maxIterations } = parseArgs();
    if (!apiName || !baseUrl || !docs) {
      printUsage();
      throw new Error('Missing required arguments: apiName, baseUrl, docs');
    }

    if (!process.env.E2B_API_KEY) {
      throw new Error('E2B_API_KEY is not set');
    }

    const provider = (process.env.LLM_PROVIDER ?? 'openai').toLowerCase();
    if (provider === 'groq') {
      if (!process.env.GROQ_API_KEY) {
        throw new Error('GROQ_API_KEY is not set');
      }
    } else {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not set');
      }
    }

    const parsedIterations =
      maxIterations !== undefined ? Math.max(1, Number.parseInt(maxIterations, 10)) : undefined;
    if (parsedIterations !== undefined && Number.isNaN(parsedIterations)) {
      throw new Error('maxIterations must be a positive integer');
    }

    const result = await runAutoMcp({ apiName, baseUrl, docsHint: docs, maxIterations: parsedIterations });
    console.log(JSON.stringify(result, null, 2));
    console.info('[AutoMCP] ✅ Completed successfully');
    process.exit(0);
  } catch (error) {
    if (error instanceof Error) {
      console.error('[AutoMCP] Failed:', error.message);
      if (error.stack) {
        console.error(error.stack);
      }
    } else {
      console.error('[AutoMCP] Failed with non-error value:', error);
    }
    process.exit(1);
  }
}

main();
