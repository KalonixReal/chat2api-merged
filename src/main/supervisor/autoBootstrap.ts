/**
 * Auto-bootstrap helper - ensures deps are installed before the supervisor
 * tries to spawn daemons. Windows-only.
 *
 * If any daemon's deps are missing, this runs `bun run.ts install` synchronously.
 * On first launch this takes ~2-3 minutes (installs + Playwright download).
 * On subsequent launches it's a no-op (deps already present).
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const PROJECT_ROOT = process.cwd()

/** Returns true if any daemon's install artifacts are missing. */
export function needsInstall(): boolean {
  const checks: Array<{ label: string; path: string }> = [
    { label: 'glm-free-api binary', path: 'vendor/glm-free-api/zai-api.exe' },
    { label: 'deepseek-api venv', path: 'vendor/deepseek-api/.venv/Scripts/python.exe' },
    { label: 'qwen-gate node_modules', path: 'vendor/qwen-gate/node_modules' },
    { label: 'kimi-free-api node_modules', path: 'vendor/kimi-free-api/node_modules' },
    { label: 'chat2api node_modules', path: 'node_modules' },
  ]
  for (const check of checks) {
    const full = resolve(PROJECT_ROOT, check.path)
    if (!existsSync(full)) {
      console.log(`[AutoBootstrap] missing: ${check.label} (${check.path})`)
      return true
    }
  }
  return false
}

/**
 * Run `bun run.ts install` if needed. Resolves true if install ran (or was
 * already done). Never throws - on failure, returns false and logs the error.
 */
export async function ensureInstalled(): Promise<boolean> {
  if (!needsInstall()) {
    return true
  }
  console.log('[AutoBootstrap] first run detected - running bun run.ts install...')
  const result = spawnSync('bun', ['run.ts', 'install'], {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 10 * 60 * 1000,
    shell: true,
  })
  if (result.error) {
    console.error('[AutoBootstrap] install failed to spawn:', result.error)
    return false
  }
  if (result.status !== 0) {
    console.error(`[AutoBootstrap] install exited with code ${result.status}`)
    console.error('[AutoBootstrap] stderr:', result.stderr?.slice(-2000))
    return false
  }
  console.log('[AutoBootstrap] install completed successfully')
  return true
}
