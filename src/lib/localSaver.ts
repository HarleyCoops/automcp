import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GeneratedFile } from './e2bSandbox.js';

export async function saveProjectLocally(slug: string, files: GeneratedFile[]): Promise<string> {
  const outputDir = path.resolve(process.cwd(), 'output', slug);
  await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);

  for (const file of files) {
    const relative = file.path.replace(/^\/+/, '');
    const fullPath = path.join(outputDir, relative);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content, 'utf-8');
  }

  return outputDir;
}
