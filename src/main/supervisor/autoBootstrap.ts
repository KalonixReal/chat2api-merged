/**
 * Auto-bootstrap helper — ensures deps are installed before the supervisor
 * tries to spawn daemons. Cross-platform (Windows + Unix).
 *
 * If any daemon's deps are missing (no venv, no node_modules, no pre-built
 * binary), this runs `bun run.ts install` synchronously and waits for it to
 * finish. The install is silent (output goes to logs/install.log) so the
 * Electron boot isn't cluttered — but errors are surfaced.
 *
 * On first launch this takes ~2-3 minutes (installs + Playwright download).
 * On subsequent launches it's a no-op (deps already present).
 */

import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const PROJECT_ROOT = process.cwd()
const IS_WIN = process.platform === 'win32'

/** Returns true if any daemon's install artifacts are missing. */
export function needsInstall(): boolean {
  const venvPython = IS_WIN ? '.venv/Scripts/python.exe' : '.venv/bin/python'
  const glmBin = IS_WIN ? 'zai-api.exe' : 'zai-api'
  const checks: Array<{ label: string; path: string }> = [
    { label: 'glm-free-api binary', path: `vendor/glm-free-api/${glmBin}` },
    { label: 'deepseek-api venv', path: `vendor/deepseek-api/${venvPython}` },
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
 * already done). Never throws — on failure, returns false and logs the error.
 */
export async function ensureInstalled(): Promise<boolean> {
  if (!needsInstall()) {
    return true
  }
  console.log('[AutoBootstrap] first run detected — running bun run.ts install...')
  const result = spawnSync('bun', ['run.ts', 'install'], {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 10 * 60 * 1000, // 10 min max — Playwright download can be slow
    shell: IS_WIN, // Windows needs shell:true so bun.exe resolves via PATHEXT
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
