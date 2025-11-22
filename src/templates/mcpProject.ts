import { z } from 'zod';
import type { GeneratedFile } from '../lib/e2bSandbox.js';
import type { ProjectPlan } from '../lib/llm.js';
import { EndpointSchema } from '../lib/llm.js';

const DEFAULT_ENDPOINT = EndpointSchema.parse({
  name: 'root_request',
  description: 'Fetch the root of the API to verify connectivity.',
  method: 'GET',
  path: '/',
});

const DEFAULT_FIELD_VALUES: Record<string, string> = {
  id: '1',
  userId: '1',
  postId: '1',
  limit: '10',
  page: '1',
  per_page: '10',
};

const TOOL_TEMPLATE_HEADER = `import { z } from 'zod';\nimport { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nimport { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';\n\nconst server = new McpServer({ name: '__SERVER_NAME__', version: '0.1.0' });\nconst BASE_URL = '__BASE_URL__';\nconst DEFAULT_TIMEOUT_MS = 15000;\nconst DEFAULT_ARG_VALUES: Record<string, string> = {\n  id: '1',\n  userId: '1',\n  postId: '1',\n  limit: '10',\n  page: '1',\n  per_page: '10',\n};\n\nexport function registerTools() {`;

const TOOL_TEMPLATE_FOOTER = `}\n\nexport function createServer() {\n  registerTools();\n  return server;\n}\n\nasync function main() {\n  const instance = createServer();\n  const transport = new StdioServerTransport();\n  await instance.connect(transport);\n}\n\nmain().catch(error => {\n  console.error('[MCP Server] Fatal error:', error);\n  process.exit(1);\n});\n`;

function toIdentifier(value: string, fallback: string) {
  const cleaned = value
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((chunk, index) =>
      index === 0
        ? chunk.toLowerCase()
        : chunk.charAt(0).toUpperCase() + chunk.slice(1).toLowerCase(),
    )
    .join('');
  return cleaned || fallback;
}

function buildSchemaName(index: number) {
  return `tool${index + 1}ArgsSchema`;
}

function buildSchemaBlock(
  schemaName: string,
  queryFields: z.infer<typeof EndpointSchema>['queryParams'],
  bodyFields: z.infer<typeof EndpointSchema>['bodyFields'],
) {
  const allFields = [...(queryFields ?? []), ...(bodyFields ?? [])];
  if (allFields.length === 0) {
    return `const ${schemaName} = z.object({}).strict();`;
  }
  const entries = allFields
    .map(field => {
      const identifier = toIdentifier(field.name, 'param');
      const optional = field.required ? '' : '.optional()';
      const descriptionComment = field.description ? ` // ${field.description}` : '';
      return `  ${identifier}: z.string()${optional},${descriptionComment}`;
    })
    .join('\n');
  return `const ${schemaName} = z.object({\n${entries}\n}).strict();`;
}

function buildHealthTool() {
  return `  server.registerTool('health_check', {
    title: 'health_check',
    description: 'Call the API root to ensure the upstream service is reachable.',
    inputSchema: z.object({}).strict()
  }, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(BASE_URL, { method: 'GET', signal: controller.signal });
      const text = await response.text();
      return {
        content: [{ type: 'text', text: text || 'OK' }]
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: \`Health check failed: \${message}\` }]
      };
    } finally {
      clearTimeout(timeout);
    }
  });`;
}

function buildToolRegistration(endpoint: z.infer<typeof EndpointSchema>, index: number) {
  const argsSchemaName = buildSchemaName(index);
  const methodLiteral = JSON.stringify(endpoint.method);
  const description = JSON.stringify(endpoint.description);
  const title = JSON.stringify(endpoint.name);
  const pathLiteral = JSON.stringify(endpoint.path.startsWith('/') ? endpoint.path : `/${endpoint.path}`);

  const queryPrep = (endpoint.queryParams || [])
    .map(field => {
      const identifier = toIdentifier(field.name, 'param');
      const keyLiteral = JSON.stringify(field.name);
      const defaultValue =
        field.example ??
        DEFAULT_FIELD_VALUES[field.name.toLowerCase()] ??
        (field.required ? 'sample' : undefined);
      const defaultLine = defaultValue ? ` ?? ${JSON.stringify(defaultValue)}` : '';
      return `    const ${identifier}Value = args.${identifier}${defaultLine};
    if (${identifier}Value !== undefined) {
      url.searchParams.set(${keyLiteral}, String(${identifier}Value));
    }`;
    })
    .join('\n');

  const hasBody = Boolean(endpoint.bodyFields && endpoint.bodyFields.length);
  const bodyAssignments = (endpoint.bodyFields || [])
    .map(field => {
      const identifier = toIdentifier(field.name, 'field');
      const keyLiteral = JSON.stringify(field.name);
      const defaultValue =
        field.example ??
        DEFAULT_FIELD_VALUES[field.name.toLowerCase()] ??
        (field.required ? 'sample' : undefined);
      const defaultLine = defaultValue ? ` ?? ${JSON.stringify(defaultValue)}` : '';
      return `    const ${identifier}Value = args.${identifier}${defaultLine};
    if (${identifier}Value !== undefined) {
      bodyPayload[${keyLiteral}] = ${identifier}Value;
    }`;
    })
    .join('\n');
  const bodyBlock = hasBody
    ? `    const bodyPayload: Record<string, unknown> = {};
${bodyAssignments}
    if (Object.keys(bodyPayload).length > 0) {
      fetchOptions.body = JSON.stringify(bodyPayload);
      fetchOptions.headers = { 'Content-Type': 'application/json' };
    }`
    : '';

  return `  server.registerTool(${JSON.stringify(endpoint.name)}, {
    title: ${title},
    description: ${description},
    inputSchema: ${argsSchemaName}
  }, async (args) => {
    const url = new URL(BASE_URL + ${pathLiteral});
${queryPrep}
    const fetchOptions: { method: string; headers?: Record<string, string>; body?: string } = { method: ${methodLiteral} };
${bodyBlock}
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), { ...fetchOptions, signal: controller.signal });
      const text = await response.text();
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        // keep raw text if not JSON
      }
      const formatted = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      return {
        content: [
          {
            type: 'text',
            text: formatted || 'Request completed with empty response.'
          }
        ]
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: \`Request failed: \${message}\`
          }
        ]
      };
    } finally {
      clearTimeout(timeout);
    }
  });`;
}

function buildServerSource(apiName: string, baseUrl: string, endpoints: z.infer<typeof EndpointSchema>[]) {
  const serverName = `${toIdentifier(apiName, 'api')}-mcp`;
  const endpointList = endpoints.length ? endpoints : [DEFAULT_ENDPOINT];

  const schemaBlocks: string[] = [];
  endpointList.forEach((endpoint, index) => {
    schemaBlocks.push(buildSchemaBlock(buildSchemaName(index), endpoint.queryParams, endpoint.bodyFields));
  });

  const registrations = [buildHealthTool(), ...endpointList.map((endpoint, index) => buildToolRegistration(endpoint, index))].join('\n\n');

  const header = TOOL_TEMPLATE_HEADER
    .replace('__SERVER_NAME__', serverName)
    .replace('__BASE_URL__', baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl);

  return [header, ...schemaBlocks, registrations, TOOL_TEMPLATE_FOOTER]
    .filter(Boolean)
    .join('\n\n');
}

function buildPackageJson(apiName: string): string {
  return JSON.stringify(
    {
      name: `${toIdentifier(apiName, 'api')}-mcp-server`,
      version: '0.1.0',
      type: 'module',
      scripts: {
        build: 'tsc',
        start: 'node dist/server.js',
      },
      dependencies: {
        '@modelcontextprotocol/sdk': '^1.22.0',
        zod: '^3.25.0',
      },
      devDependencies: {
        typescript: '^5.9.0',
        '@types/node': '^20.0.0',
      },
    },
    null,
    2,
  );
}

function buildTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'node',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: 'dist',
        rootDir: 'src',
      },
      include: ['src/**/*'],
    },
    null,
    2,
  );
}

function buildReadme(apiName: string, baseUrl: string, endpoints: z.infer<typeof EndpointSchema>[], summary?: string) {
  const rows = (endpoints.length ? endpoints : [DEFAULT_ENDPOINT])
    .map(endpoint => `| ${endpoint.name} | ${endpoint.method} | ${endpoint.path} | ${endpoint.description} |`)
    .join('\n');

  return `# ${apiName} MCP Server\n\n${summary ?? 'This MCP server exposes convenient tools for the target REST API.'}\n\n## Endpoints\n\n| Name | Method | Path | Description |\n| ---- | ------ | ---- | ----------- |\n${rows}\n\nBase URL: ${baseUrl}\n\n## Development\n\n\`\`\`bash\nnpm install\nnpm run build\nnpm start\n\`\`\`\n`;
}

function buildDockerfile() {
  return `# syntax=docker/dockerfile:1

FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/server.js"]
`;
}

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function sanitizeEndpoint(endpoint: ProjectPlan['endpoints'][number]) {
  const parsed = EndpointSchema.parse(endpoint);
  const method = VALID_METHODS.has(parsed.method) ? parsed.method : 'GET';
  let path = parsed.path?.trim() || '/';
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  const name =
    parsed.name?.trim() ||
    `${method.toLowerCase()}${path.replace(/[^a-z0-9]+/gi, '_')}`.replace(/_{2,}/g, '_');
  const description = parsed.description?.trim() || `Call ${method} ${path}`;
  return { ...parsed, method, path, name, description };
}

export function buildTemplateFiles(params: {
  apiName: string;
  baseUrl: string;
  plan: ProjectPlan;
}): GeneratedFile[] {
  const endpoints = params.plan.endpoints.length
    ? params.plan.endpoints.map(endpoint => sanitizeEndpoint(endpoint))
    : [];
  const packageJson = buildPackageJson(params.apiName);
  const tsconfig = buildTsconfig();
  const serverSource = buildServerSource(params.apiName, params.baseUrl, endpoints);
  const readme = buildReadme(params.apiName, params.baseUrl, endpoints, params.plan.summary);
  const dockerfile = buildDockerfile();

  return [
    { path: 'package.json', content: packageJson },
    { path: 'tsconfig.json', content: tsconfig },
    { path: 'src/server.ts', content: serverSource },
    { path: 'README.md', content: readme },
    { path: 'Dockerfile', content: dockerfile },
  ];
}
