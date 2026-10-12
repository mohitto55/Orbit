import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { createProject, type Ctx } from '../src/core/workspace'

export async function tempDir(prefix = 'girsktop-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function newProject(): Promise<Ctx> {
  return createProject(await tempDir(), 'test-project')
}
