#!/usr/bin/env node
/**
 * Test script for locally testing an MCP server
 * 
 * Usage:
 *   node test-mcp-server.mjs <path-to-server-dist>
 * 
 * Example:
 *   node test-mcp-server.mjs output/jsonplaceholder/dist/server.js
 */

import { spawn } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serverPath = process.argv[2];

if (!serverPath) {
  console.error('Usage: node test-mcp-server.mjs <path-to-server-dist>');
  console.error('Example: node test-mcp-server.mjs output/jsonplaceholder/dist/server.js');
  process.exit(1);
}

const fullServerPath = resolve(process.cwd(), serverPath);

console.log(`[Test] Starting MCP server: ${fullServerPath}`);
console.log('[Test] Connecting to server...\n');

const serverProcess = spawn('node', [fullServerPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: dirname(fullServerPath),
});

serverProcess.stderr.on('data', (data) => {
  console.error('[Server stderr]', data.toString());
});

serverProcess.on('exit', (code) => {
  if (code !== null && code !== 0) {
    console.error(`[Test] Server exited with code ${code}`);
  }
});

const transport = new StdioClientTransport({
  command: 'node',
  args: [fullServerPath],
  env: process.env,
});

const client = new Client(
  { name: 'mcp-test-client', version: '1.0.0' },
  { capabilities: {} }
);

async function testServer() {
  try {
    await client.connect(transport);
    console.log('✅ Connected to MCP server\n');

    // List available tools
    console.log('[Test] Listing available tools...');
    const toolsResponse = await client.listTools({});
    const tools = toolsResponse.tools || [];
    
    if (tools.length === 0) {
      console.log('⚠️  No tools found on server');
      return;
    }

    console.log(`\n📋 Found ${tools.length} tool(s):\n`);
    tools.forEach((tool, index) => {
      console.log(`${index + 1}. ${tool.name}`);
      console.log(`   Description: ${tool.description || 'N/A'}`);
      if (tool.inputSchema) {
        console.log(`   Input schema: ${JSON.stringify(tool.inputSchema, null, 2)}`);
      }
      console.log('');
    });

    // Test each tool
    for (const tool of tools) {
      console.log(`[Test] Testing tool: ${tool.name}`);
      console.log('─'.repeat(50));
      
      try {
        // Call tool with empty args (or tool-specific args if needed)
        const result = await client.callTool(
          {
            name: tool.name,
            arguments: {},
          },
          undefined
        );

        if (result.isError) {
          console.error(`❌ Tool ${tool.name} returned error:`, result.content);
        } else {
          console.log(`✅ Tool ${tool.name} succeeded`);
          if (result.content && result.content.length > 0) {
            const textContent = result.content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n');
            
            // Try to parse as JSON for pretty printing
            try {
              const json = JSON.parse(textContent);
              console.log('Response:', JSON.stringify(json, null, 2));
            } catch {
              console.log('Response:', textContent.slice(0, 500));
            }
          }
        }
      } catch (error) {
        console.error(`❌ Error calling tool ${tool.name}:`, error instanceof Error ? error.message : error);
      }
      
      console.log('');
    }

    console.log('✅ All tests completed');
  } catch (error) {
    console.error('❌ Test failed:', error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    try {
      await client.close();
      await transport.close();
    } catch (error) {
      // Ignore cleanup errors
    }
    serverProcess.kill();
  }
}

testServer().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

