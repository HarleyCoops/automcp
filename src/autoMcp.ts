import crypto from 'node:crypto';
import { fetchDocumentationWithMcp } from './lib/mcpFetchClient.js';
import { generateProjectPlan, ProjectPlan, fixBuildErrors } from './lib/llm.js';
import { runProjectInSandbox } from './lib/e2bSandbox.js';
import { readPlanFromCache, writePlanToCache } from './lib/cache.js';
import { buildTemplateFiles } from './templates/mcpProject.js';
import { saveProjectLocally } from './lib/localSaver.js';
import type { GeneratedFile } from './lib/e2bSandbox.js';

export interface AutoMcpInput {
  apiName: string;
  baseUrl: string;
  docsHint: string;
  maxIterations?: number;
}

export type ProgressEvent = 
  | { type: 'step'; message: string; data?: unknown }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'sandbox-command'; command: string; status: 'start' | 'complete' | 'error'; stdout?: string; stderr?: string; exitCode?: number }
  | { type: 'build-iteration'; iteration: number; maxIterations: number; status: 'start' | 'retry' | 'success' | 'failed' };

export type ProgressCallback = (event: ProgressEvent) => void;

export interface AutoMcpResult {
  sandboxId: string;
  projectDir: string;
  filesWritten: string[];
  commands: { command: string; exitCode: number; stdout: string; stderr: string; durationMs: number }[];
  summary?: string;
  documentationSource: 'mcp-fetch' | 'http-fetch';
  localPath: string;
  validation?: {
    success: boolean;
    errors: string[];
    toolsFound: number;
    toolsTested: number;
    details: {
      initialized: boolean;
      toolsListed: boolean;
      toolTestResults: Array<{ name: string; success: boolean; error?: string }>;
    };
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'api';
}

async function downloadDocs(url: string, onProgress?: ProgressCallback): Promise<{ content: string; source: AutoMcpResult['documentationSource'] }> {
  try {
    onProgress?.({ type: 'step', message: 'Fetching documentation via MCP…' });
    onProgress?.({ type: 'log', level: 'info', message: `Fetching from: ${url}` });
    const content = await fetchDocumentationWithMcp(url);
    onProgress?.({ type: 'step', message: 'Documentation retrieved via MCP' });
    return { content, source: 'mcp-fetch' };
  } catch (error) {
    onProgress?.({ type: 'log', level: 'warn', message: `MCP fetch failed: ${error instanceof Error ? error.message : String(error)}` });
    onProgress?.({ type: 'step', message: 'Falling back to direct HTTP fetch…' });
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Fallback HTTP fetch failed with status ${response.status}`);
    }
    const content = await response.text();
    onProgress?.({ type: 'step', message: 'Documentation retrieved via HTTP' });
    return { content, source: 'http-fetch' };
  }
}

export async function runAutoMcp(input: AutoMcpInput, onProgress?: ProgressCallback): Promise<AutoMcpResult> {
  onProgress?.({ type: 'step', message: `Starting run for API "${input.apiName}"` });
  onProgress?.({ type: 'log', level: 'info', message: `Base URL: ${input.baseUrl}` });
  const { content: docs, source } = await downloadDocs(input.docsHint, onProgress);
  onProgress?.({ type: 'log', level: 'info', message: `Documentation source: ${source}` });

  const cacheKey = crypto
    .createHash('sha256')
    .update(input.apiName)
    .update('|')
    .update(input.baseUrl)
    .update('|')
    .update(docs);
  const planKey = cacheKey.digest('hex');

  let plan: ProjectPlan | null = await readPlanFromCache(planKey);
  if (plan) {
    onProgress?.({ type: 'step', message: 'Loaded project plan from cache' });
    onProgress?.({ type: 'log', level: 'info', message: `Cache key: ${planKey}` });
  } else {
    onProgress?.({ type: 'step', message: 'Generating project plan with LLM…' });
    plan = await generateProjectPlan({ apiName: input.apiName, baseUrl: input.baseUrl, docs });
    onProgress?.({ type: 'log', level: 'info', message: `LLM produced ${plan.files.length} files and ${plan.commands.length} commands` });
    await writePlanToCache(planKey, plan);
    onProgress?.({ type: 'step', message: 'Project plan cached' });
  }
  if (!plan) {
    throw new Error('Failed to obtain project plan.');
  }

  const slug = slugify(input.apiName);
  const projectDir = `/home/user/generated/${slug}-mcp`;
  
  // Agentic loop: try building, fix errors, retry
  const MAX_ITERATIONS = Math.max(1, Math.min(input.maxIterations ?? 3, 10));
  let files: GeneratedFile[] = [];
  let build: Awaited<ReturnType<typeof runProjectInSandbox>> | null = null;
  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    onProgress?.({ type: 'build-iteration', iteration, maxIterations: MAX_ITERATIONS, status: iteration === 1 ? 'start' : 'retry' });
    onProgress?.({ type: 'log', level: 'info', message: `Build attempt ${iteration}/${MAX_ITERATIONS}` });
    
    if (iteration === 1) {
      // First attempt: use the original plan
      onProgress?.({ type: 'step', message: 'Launching E2B sandbox…' });
      onProgress?.({ type: 'log', level: 'info', message: `Project directory: ${projectDir}` });
      const templateFiles = buildTemplateFiles({ apiName: input.apiName, baseUrl: input.baseUrl, plan });
      const templatePaths = new Set(templateFiles.map(file => file.path.replace(/^\.?\//, '')));
      const additionalFiles = plan.files.filter(file => !templatePaths.has(file.path.replace(/^\.?\//, '')));
      files = [...templateFiles, ...additionalFiles];
      onProgress?.({ type: 'log', level: 'info', message: `Generated ${files.length} files` });
    } else {
      // Subsequent attempts: apply fixes from LLM
      const failedCommand = build!.commands.at(-1)!;
      onProgress?.({ type: 'step', message: 'Analyzing build failure and generating fixes…' });
      const fixes = await fixBuildErrors({
        apiName: input.apiName,
        baseUrl: input.baseUrl,
        originalPlan: plan,
        buildError: {
          command: failedCommand.command,
          stdout: failedCommand.stdout,
          stderr: failedCommand.stderr,
          exitCode: failedCommand.exitCode,
        },
        currentFiles: files,
      });
      
      onProgress?.({ type: 'log', level: 'info', message: `Fix explanation: ${fixes.explanation}` });
      onProgress?.({ type: 'step', message: `Applying fixes to ${fixes.fixedFiles.length} file(s)…` });
      
      // Update files with fixes
      const fixedPaths = new Set(fixes.fixedFiles.map(f => f.path.replace(/^\.?\//, '')));
      files = files.map(file => {
        const normalizedPath = file.path.replace(/^\.?\//, '');
        const fixed = fixes.fixedFiles.find(f => f.path.replace(/^\.?\//, '') === normalizedPath);
        return fixed ? { ...file, content: fixed.content } : file;
      });
      
      // Add any new files from fixes
      for (const fixedFile of fixes.fixedFiles) {
        const normalizedPath = fixedFile.path.replace(/^\.?\//, '');
        if (!files.some(f => f.path.replace(/^\.?\//, '') === normalizedPath)) {
          files.push(fixedFile);
        }
      }
    }

    build = await runProjectInSandbox({
      projectDir,
      files,
      commands: plan.commands,
      onProgress,
      validateServer: true, // Enable server validation
    });
    
    const finalExit = build.commands.at(-1)?.exitCode ?? 0;
    const validationPassed = build.validation?.success ?? false;
    
    onProgress?.({ type: 'log', level: finalExit === 0 ? 'info' : 'error', message: `Build attempt ${iteration} complete. Exit code: ${finalExit}` });
    
    if (finalExit === 0) {
      if (build.validation && !validationPassed) {
        const validationMessage = build.validation.errors.join('; ') || 'Unknown validation error';
        onProgress?.({ type: 'log', level: 'error', message: `❌ Server validation failed: ${validationMessage}` });

        if (iteration < MAX_ITERATIONS) {
          onProgress?.({ type: 'log', level: 'warn', message: 'Validation failed, attempting another build iteration…' });
          continue;
        }

        throw new Error(`Server validation failed after ${MAX_ITERATIONS} attempts: ${validationMessage}`);
      }

      if (build.validation && validationPassed) {
        onProgress?.({ type: 'log', level: 'info', message: `✅ Server validation passed: ${build.validation.toolsFound} tools found, ${build.validation.toolsTested} tested` });
      }
      
      onProgress?.({ type: 'build-iteration', iteration, maxIterations: MAX_ITERATIONS, status: 'success' });
      onProgress?.({ type: 'step', message: '✅ Build and validation succeeded!' });
      break;
    }
    
    if (iteration < MAX_ITERATIONS) {
      onProgress?.({ type: 'log', level: 'warn', message: 'Build failed, will retry with fixes…' });
    } else {
      onProgress?.({ type: 'build-iteration', iteration, maxIterations: MAX_ITERATIONS, status: 'failed' });
      throw new Error(
        `Sandbox command failed after ${MAX_ITERATIONS} attempts: ${build.commands.at(-1)?.command} (exit ${finalExit}). Check logs above for details.`,
      );
    }
  }

  if (!build) {
    throw new Error('Build never completed');
  }

  onProgress?.({ type: 'step', message: 'Saving generated project locally…' });
  const localPath = await saveProjectLocally(slug, files);
  onProgress?.({ type: 'log', level: 'info', message: `Project files saved to ${localPath}` });
  onProgress?.({ type: 'step', message: '✅ Generation completed successfully!' });

  return {
    sandboxId: build.sandboxId,
    projectDir: build.projectDir,
    filesWritten: build.filesWritten,
    commands: build.commands,
    summary: plan.summary,
    documentationSource: source,
    localPath,
    validation: build.validation,
  };
}
