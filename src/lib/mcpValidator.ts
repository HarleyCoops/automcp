import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Sandbox } from '@e2b/code-interpreter';

export interface ValidationResult {
  success: boolean;
  errors: string[];
  toolsFound: number;
  toolsTested: number;
  details: {
    initialized: boolean;
    toolsListed: boolean;
    toolTestResults: Array<{ name: string; success: boolean; error?: string }>;
  };
}

export type ValidationProgressCallback = (message: string) => void;

/**
 * Validates that an MCP server works correctly by:
 * 1. Starting the server process
 * 2. Connecting via MCP protocol
 * 3. Listing available tools
 * 4. Testing at least one tool call
 */
export async function validateMcpServer(
  sandbox: Sandbox,
  serverPath: string,
  projectDir: string,
  onProgress?: ValidationProgressCallback,
): Promise<ValidationResult> {
  const errors: string[] = [];
  const toolTestResults: Array<{ name: string; success: boolean; error?: string }> = [];

  onProgress?.('Starting MCP server validation...');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: {},
  });

  const client = new Client({ name: 'auto-mcp-validator', version: '1.0.0' }, { capabilities: {} });

  try {
    // Step 1: Connect and initialize
    onProgress?.('Connecting to MCP server...');
    await client.connect(transport);
    onProgress?.('✅ Connected to MCP server');

    // Step 2: List tools
    onProgress?.('Listing available tools...');
    const toolsResponse = await client.listTools({});
    const tools = toolsResponse.tools || [];

    if (tools.length === 0) {
      errors.push('No tools found on the MCP server');
      return {
        success: false,
        errors,
        toolsFound: 0,
        toolsTested: 0,
        details: {
          initialized: true,
          toolsListed: true,
          toolTestResults: [],
        },
      };
    }

    onProgress?.(`✅ Found ${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}`);

    // Step 3: Test the first tool (or up to 2 tools)
    const toolsToTest = tools.slice(0, Math.min(2, tools.length));
    onProgress?.(`Testing ${toolsToTest.length} tool(s)...`);

    for (const tool of toolsToTest) {
      try {
        onProgress?.(`Testing tool: ${tool.name}...`);
        const result = await client.callTool(
          {
            name: tool.name,
            arguments: {},
          },
          undefined,
        );

        if (result.isError) {
          let errorMsg = 'Unknown error';
          if (result.content && Array.isArray(result.content)) {
            errorMsg = result.content
              .map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
              .join(' ');
          } else if (result.content) {
            errorMsg = String(result.content);
          }
          errors.push(`Tool ${tool.name} returned error: ${errorMsg}`);
          toolTestResults.push({ name: tool.name, success: false, error: errorMsg });
        } else {
          onProgress?.(`✅ Tool ${tool.name} executed successfully`);
          toolTestResults.push({ name: tool.name, success: true });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`Tool ${tool.name} failed: ${errorMsg}`);
        toolTestResults.push({ name: tool.name, success: false, error: errorMsg });
        onProgress?.(`❌ Tool ${tool.name} failed: ${errorMsg}`);
      }
    }

    const success = errors.length === 0 && toolTestResults.some(r => r.success);

    return {
      success,
      errors,
      toolsFound: tools.length,
      toolsTested: toolsToTest.length,
      details: {
        initialized: true,
        toolsListed: true,
        toolTestResults,
      },
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    errors.push(`Validation failed: ${errorMsg}`);
    onProgress?.(`❌ Validation failed: ${errorMsg}`);

    return {
      success: false,
      errors,
      toolsFound: 0,
      toolsTested: 0,
      details: {
        initialized: false,
        toolsListed: false,
        toolTestResults: [],
      },
    };
  } finally {
    try {
      await client.close();
    } catch (error) {
      // Ignore cleanup errors
    }
    try {
      await transport.close();
    } catch (error) {
      // Ignore cleanup errors
    }
  }
}

