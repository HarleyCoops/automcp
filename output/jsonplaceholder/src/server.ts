import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'jsonplaceholder-mcp', version: '0.1.0' });
const BASE_URL = 'https://jsonplaceholder.typicode.com';

function registerTools() {

const tool1ArgsSchema = z.object({}).strict();

  server.registerTool("root_request", {
    title: "root_request",
    description: "Fetch the root of the API to verify connectivity.",
    inputSchema: tool1ArgsSchema
  }, async (args) => {
    const url = new URL(BASE_URL + "/");

    const fetchOptions: { method: string; headers?: Record<string, string>; body?: string } = { method: "GET" };

    const response = await fetch(url.toString(), fetchOptions);
    const text = await response.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // non-json response, keep raw text
    }
    return {
      content: [
        {
          type: 'text',
          text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
        }
      ]
    };
  });

}

async function main() {
  registerTools();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error('[MCP Server] Fatal error:', error);
  process.exit(1);
});
