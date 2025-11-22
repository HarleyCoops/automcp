import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProjectPlan, ProjectPlanSchema } from './llm.js';

const CACHE_DIR = path.resolve(process.cwd(), '.automcp-cache');

function cachePath(key: string) {
  return path.join(CACHE_DIR, `${key}.json`);
}

export async function readPlanFromCache(key: string): Promise<ProjectPlan | null> {
  try {
    const data = await fs.readFile(cachePath(key), 'utf-8');
    const parsed = JSON.parse(data);
    return ProjectPlanSchema.parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    console.warn('[AutoMCP][Cache] Failed to read cache entry:', (error as Error).message);
    return null;
  }
}

export async function writePlanToCache(key: string, plan: ProjectPlan): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(cachePath(key), JSON.stringify(plan, null, 2), 'utf-8');
  } catch (error) {
    console.warn('[AutoMCP][Cache] Failed to write cache entry:', (error as Error).message);
  }
}
