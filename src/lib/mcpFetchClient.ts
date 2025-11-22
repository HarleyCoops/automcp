import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type TextContentBlock = { type: string; text?: string };

const FETCH_SERVER_COMMAND = 'docker';
const FETCH_SERVER_ARGS = ['run', '-i', '--rm', 'mcp/fetch'];

export async function fetchDocumentationWithMcp(url: string): Promise<string> {
  console.info('[AutoMCP][MCP] Starting fetch for URL:', url);
  const transport = new StdioClientTransport({
    command: FETCH_SERVER_COMMAND,
    args: FETCH_SERVER_ARGS,
  });

  const client = new Client({ name: 'auto-mcp-cli', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);

  try {
    console.info('[AutoMCP][MCP] Connected to fetch server, listing tools…');
    await client.listTools({});
    const result = await client.callTool(
      {
        name: 'fetch',
        arguments: { url },
      },
      undefined,
    );

    if (result.isError) {
      const message =
        result.structuredContent && typeof result.structuredContent === 'object'
          ? JSON.stringify(result.structuredContent)
          : ((result.content ?? []) as TextContentBlock[])
              .map(block => (block.type === 'text' ? block.text ?? '' : ''))
              .join('\n');
      throw new Error(`Fetch MCP tool reported error: ${message || 'unknown error'}`);
    }

    const textBlocks = (result.content ?? []) as TextContentBlock[];
    const textContent = textBlocks
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim();

    if (!textContent) {
      throw new Error('Fetch MCP tool returned empty content');
    }

    console.info('[AutoMCP][MCP] Successfully retrieved documentation via MCP.');
    return textContent;
  } finally {
    try {
      await client.close();
    } catch (error) {
      console.warn('[AutoMCP][MCP] Error closing client:', (error as Error).message);
    }
    try {
      await transport.close();
    } catch (error) {
      console.warn('[AutoMCP][MCP] Error closing transport:', (error as Error).message);
    }
    console.info('[AutoMCP][MCP] MCP connection closed.');
  }
}
