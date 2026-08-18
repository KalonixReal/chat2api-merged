/**
 * Auto-bootstrap helper - ensures deps are installed before the supervisor
 * tries to spawn daemons. Platform-aware (Windows + Unix).
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const PROJECT_ROOT = process.cwd()
const IS_WIN = process.platform === 'win32'

export function needsInstall(): boolean {
  const venvPython = IS_WIN ? '.venv/Scripts/python.exe' : '.venv/bin/python'
  const glmBin = IS_WIN ? 'zai-api.exe' : 'zai-api'
  const checks: Array<{ label: string; path: string }> = [
    { label: 'glm-free-api binary', path: `daemons/glm-free-api/${glmBin}` },
    { label: 'deepseek-api venv', path: `daemons/deepseek-api/${venvPython}` },
    { label: 'qwen-gate node_modules', path: 'daemons/qwen-gate/node_modules' },
    { label: 'kimi-free-api node_modules', path: 'daemons/kimi-free-api/node_modules' },
    { label: 'chat2api node_modules', path: 'node_modules' },
  ]
  for (const check of checks) {
    if (!existsSync(resolve(PROJECT_ROOT, check.path))) {
      console.log(`[AutoBootstrap] missing: ${check.label}`)
      return true
    }
  }
  return false
}

export async function ensureInstalled(): Promise<boolean> {
  if (!needsInstall()) return true
  console.log('[AutoBootstrap] first run - running bun run.ts install...')
  const result = spawnSync('bun', ['run.ts', 'install'], {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 10 * 60 * 1000,
    shell: IS_WIN,
  })
  if (result.error) {
    console.error('[AutoBootstrap] install failed:', result.error)
    return false
  }
  if (result.status !== 0) {
    console.error(`[AutoBootstrap] install exited with code ${result.status}`)
    return false
  }
  console.log('[AutoBootstrap] install completed')
  return true
}
