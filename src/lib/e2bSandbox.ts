import path from 'node:path';
import { Sandbox } from '@e2b/code-interpreter';
import { validateMcpServer, type ValidationResult } from './mcpValidator.js';

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface SandboxBuildResult {
  sandboxId: string;
  projectDir: string;
  filesWritten: string[];
  commands: CommandResult[];
  validation?: ValidationResult;
}

export type SandboxProgressCallback = (event: {
  type: 'sandbox-command';
  command: string;
  status: 'start' | 'complete' | 'error';
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}) => void;

async function ensureDirectory(sandbox: Sandbox, dir: string) {
  const parts = dir.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try {
      await sandbox.files.makeDir(current);
    } catch (error: any) {
      if (!String(error?.message ?? error).includes('File exists')) {
        throw error;
      }
    }
  }
}

export async function runProjectInSandbox(options: {
  projectDir: string;
  files: GeneratedFile[];
  commands: string[];
  onProgress?: SandboxProgressCallback;
  validateServer?: boolean;
}): Promise<SandboxBuildResult> {
  const sandbox = await Sandbox.create();
  const sandboxId = sandbox.sandboxId;
  const filesWritten: string[] = [];

  try {
    options.onProgress?.({ type: 'sandbox-command', command: 'Writing files', status: 'start' });
    for (const file of options.files) {
      const relative = file.path.replace(/^\/+/, '');
      const fullPath = path.posix.join(options.projectDir, relative);
      await ensureDirectory(sandbox, path.posix.dirname(fullPath));
      await sandbox.files.write(fullPath, file.content);
      filesWritten.push(fullPath);
    }
    options.onProgress?.({ type: 'sandbox-command', command: 'Writing files', status: 'complete', exitCode: 0 });

    const results: CommandResult[] = [];
    for (const command of options.commands) {
      options.onProgress?.({ type: 'sandbox-command', command, status: 'start' });
      console.info('[AutoMCP][Sandbox] Running command:', command);
      const start = Date.now();
      const execution = await sandbox.commands.run(command, {
        cwd: options.projectDir,
        timeoutMs: 120_000,
      });
      const result: CommandResult = {
        command,
        stdout: execution.stdout,
        stderr: execution.stderr,
        exitCode: execution.exitCode,
        durationMs: Date.now() - start,
      };
      results.push(result);
      
      options.onProgress?.({
        type: 'sandbox-command',
        command,
        status: execution.exitCode === 0 ? 'complete' : 'error',
        stdout: execution.stdout,
        stderr: execution.stderr,
        exitCode: execution.exitCode,
      });
      
      console.info('[AutoMCP][Sandbox] Command finished:', {
        command,
        exitCode: execution.exitCode,
        durationMs: result.durationMs,
      });
      if (execution.stdout) {
        console.log('[AutoMCP][Sandbox][stdout]\n', execution.stdout);
      }
      if (execution.stderr) {
        console.error('[AutoMCP][Sandbox][stderr]\n', execution.stderr);
      }
      if (execution.exitCode !== 0) {
        console.error('[AutoMCP][Sandbox] Command failed, stopping further execution.');
        break;
      }
    }

    // Validate the MCP server if requested and build succeeded
    let validation: ValidationResult | undefined;
    if (options.validateServer) {
      const buildSucceeded = results.every(r => r.exitCode === 0);
      if (buildSucceeded) {
        const serverPath = path.posix.join(options.projectDir, 'dist', 'server.js');
        options.onProgress?.({ type: 'sandbox-command', command: 'Validating MCP server', status: 'start' });
        
        try {
          validation = await validateMcpServer(
            sandbox,
            serverPath,
            options.projectDir,
            (message) => {
              options.onProgress?.({
                type: 'sandbox-command',
                command: `Validation: ${message}`,
                status: 'start',
              });
            },
          );

          if (validation.success) {
            options.onProgress?.({
              type: 'sandbox-command',
              command: 'Validating MCP server',
              status: 'complete',
              exitCode: 0,
            });
          } else {
            options.onProgress?.({
              type: 'sandbox-command',
              command: 'Validating MCP server',
              status: 'error',
              exitCode: 1,
              stderr: validation.errors.join('\n'),
            });
          }
        } catch (error) {
          validation = {
            success: false,
            errors: [error instanceof Error ? error.message : String(error)],
            toolsFound: 0,
            toolsTested: 0,
            details: {
              initialized: false,
              toolsListed: false,
              toolTestResults: [],
            },
          };
          options.onProgress?.({
            type: 'sandbox-command',
            command: 'Validating MCP server',
            status: 'error',
            exitCode: 1,
            stderr: validation.errors.join('\n'),
          });
        }
      }
    }

    return {
      sandboxId,
      projectDir: options.projectDir,
      filesWritten,
      commands: results,
      validation,
    };
  } finally {
    await sandbox
      .kill()
      .catch((error: unknown) => {
        console.warn('[AutoMCP][Sandbox] Failed to terminate sandbox cleanly:', (error as Error).message);
      });
  }
}
