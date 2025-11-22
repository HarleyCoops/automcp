import OpenAI from 'openai';
import Groq from 'groq-sdk';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import z from 'zod';

const FileSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const FieldSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  type: z.string().optional(),
  required: z.boolean().optional(),
  example: z.string().optional(),
});

export const EndpointSchema = z.object({
  name: z.string(),
  description: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  path: z.string(),
  queryParams: z.array(FieldSchema).optional(),
  bodyFields: z.array(FieldSchema).optional(),
});

export const ProjectPlanSchema = z.object({
  files: z.array(FileSchema).default([]),
  commands: z.array(z.string()).default([]),
  summary: z.string().optional(),
  endpoints: z.array(EndpointSchema).default([]),
});

export type EndpointSpec = z.infer<typeof EndpointSchema>;
export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;

type LlmProvider = 'openai' | 'groq';

const provider = (process.env.LLM_PROVIDER?.toLowerCase() as LlmProvider) ?? 'openai';
const MODEL =
  process.env.LLM_MODEL ??
  process.env.MODEL ??
  (provider === 'groq' ? 'llama-3.1-70b-instant' : 'gpt-4o-mini');

let openaiClient: OpenAI | null = null;
let groqClient: Groq | null = null;

function ensureLlmClient(): LlmProvider {
  if (provider === 'groq') {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY is not set');
    }
    if (!groqClient) {
      groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    }
    return 'groq';
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return 'openai';
}

async function runChatCompletion(params: {
  messages: ChatCompletionMessageParam[];
  temperature: number;
}): Promise<string> {
  const activeProvider = ensureLlmClient();

  if (activeProvider === 'groq') {
    const completion = await groqClient!.chat.completions.create({
      model: MODEL,
      temperature: params.temperature,
      // Groq SDK expects its own message type; cast for compatibility.
      messages: params.messages as any,
    });
    return completion.choices?.[0]?.message?.content ?? '';
  }

  const completion = await openaiClient!.chat.completions.create({
    model: MODEL,
    temperature: params.temperature,
    response_format: { type: 'json_object' },
    messages: params.messages,
  });
  return completion.choices?.[0]?.message?.content ?? '';
}

function buildPrompt(apiName: string, baseUrl: string, docsExcerpt: string) {
  return `You are AutoMCP, an AI engineer who generates Model Context Protocol (MCP) servers.
Given the API details below, respond with STRICT JSON describing:
- A list of 2-4 high-value REST endpoints
- Any supplemental files (besides the core template) you recommend
- Shell commands (must include npm install and npm run build)

Requirements:
- Endpoints should specify HTTP method, path, description, and optional query/body parameters.
- If parameters exist, describe each field (name, type, required flag, description).
- Do NOT generate server code; the local template will handle it. Just give metadata.
- Use ESM syntax when sharing sample snippets.
- Always include commands ["npm install", "npm run build"].

Return JSON in this shape:
{
  "summary": "One-paragraph overview",
  "endpoints": [
    {
      "name": "list_posts",
      "description": "List all posts",
      "method": "GET",
      "path": "/posts",
      "queryParams": [
        { "name": "userId", "description": "Filter by user ID", "type": "integer", "required": false }
      ]
    }
  ],
  "files": [
    { "path": "NOTES.md", "content": "Any extra docs you want to provide" }
  ],
  "commands": ["npm install", "npm run build"]
}

API Name: ${apiName}
Base URL: ${baseUrl}
Documentation:
"""
${docsExcerpt.slice(0, 8000)}
"""`;
}

function extractJsonBlock(output: string): string {
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('LLM response did not contain JSON payload');
  }
  return jsonMatch[0];
}

export async function generateProjectPlan(params: { apiName: string; baseUrl: string; docs: string }): Promise<ProjectPlan> {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'You create complete MCP server projects and ONLY return JSON.' },
    { role: 'user', content: buildPrompt(params.apiName, params.baseUrl, params.docs) },
  ];

  const content = await runChatCompletion({ messages, temperature: 0.1 });
  if (!content) {
    throw new Error('LLM response missing content');
  }

  const parsed = JSON.parse(extractJsonBlock(content));
  const plan = ProjectPlanSchema.parse({
    files: parsed.files ?? [],
    commands: parsed.commands ?? [],
    summary: parsed.summary,
    endpoints: parsed.endpoints ?? [],
  });

  const commands = Array.from(new Set([...(plan.commands ?? []), 'npm install', 'npm run build']));

  return { ...plan, commands };
}

export async function fixBuildErrors(params: {
  apiName: string;
  baseUrl: string;
  originalPlan: ProjectPlan;
  buildError: { command: string; stdout: string; stderr: string; exitCode: number };
  currentFiles: Array<{ path: string; content: string }>;
}): Promise<{ fixedFiles: Array<{ path: string; content: string }>; explanation: string }> {
  const errorContext = `
Build failed during: ${params.buildError.command}
Exit code: ${params.buildError.exitCode}
Stdout:
${params.buildError.stdout.slice(0, 2000)}

Stderr:
${params.buildError.stderr.slice(0, 2000)}
`;

  const prompt = `You are AutoMCP, an AI engineer fixing a broken MCP server build.

The build failed with the error above. Analyze the error and fix the code.

Current files:
${params.currentFiles.map(f => `\n=== ${f.path} ===\n${f.content.slice(0, 1000)}`).join('\n')}

Original plan endpoints:
${JSON.stringify(params.originalPlan.endpoints, null, 2)}

Return JSON with:
{
  "explanation": "Brief explanation of what was wrong and how you fixed it",
  "fixedFiles": [
    { "path": "src/server.ts", "content": "fixed code..." }
  ]
}

Only include files that need changes. The template will regenerate unchanged files.`;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'You fix broken code and ONLY return JSON.' },
    { role: 'user', content: errorContext + '\n\n' + prompt },
  ];

  const content = await runChatCompletion({ messages, temperature: 0.2 });
  if (!content) {
    throw new Error('LLM response missing content');
  }

  const parsed = JSON.parse(extractJsonBlock(content));
  const FixedFilesSchema = z.object({
    explanation: z.string(),
    fixedFiles: z.array(FileSchema),
  });

  const result = FixedFilesSchema.parse(parsed);
  return result;
}
