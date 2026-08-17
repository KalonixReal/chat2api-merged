/**
 * run.ts — Windows single entry point.
 *
 * One command. `bun run.ts` (or double-click start.bat).
 * Auto-installs deps on first run, boots 4 daemons, launches the Electron app.
 *
 * Usage:
 *   bun run.ts              # install (if needed) + boot daemons + start Electron
 *   bun run.ts daemons       # headless: boot daemons only
 *   bun run.ts check        # check daemon health
 *   bun run.ts install      # run install only, don't boot
 */

import { existsSync, mkdirSync, copyFileSync, writeFileSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = __dirname

const LOG_DIR = join(ROOT, 'logs')
const PID_DIR = join(ROOT, '.run')
mkdirSync(LOG_DIR, { recursive: true })
mkdirSync(PID_DIR, { recursive: true })

// ============================================================================
// Logging
// ============================================================================
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
}
function c(color: keyof typeof colors, msg: string): string {
  return `${colors[color]}${msg}${colors.reset}`
}
function log(msg: string): void {
  console.log(msg)
}

// ============================================================================
// Health check
// ============================================================================
async function healthCheck(port: number, path: string, auth?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = {}
    if (auth) headers['Authorization'] = `Bearer ${auth}`
    const url = `http://localhost:${port}${path}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const resp = await fetch(url, { headers, signal: controller.signal })
    clearTimeout(timeout)
    return resp.ok || resp.status < 500
  } catch {
    return false
  }
}

// ============================================================================
// Install logic (Windows)
// ============================================================================
async function runInstall(): Promise<void> {
  log(c('blue', '\n=== Installing (Windows) ===\n'))

  // Check runtimes
  if (!commandExists('bun')) {
    log(c('red', 'ERROR: bun not found. Install: https://bun.sh'))
    process.exit(1)
  }
  log(c('green', `  ✓ bun ${Bun.version}`))
  if (!commandExists('python') && !commandExists('python3')) {
    log(c('red', 'ERROR: python not found (needed for DeepSeek daemon)'))
    process.exit(1)
  }
  log(c('green', '  ✓ python'))

  // 1. GLM-Free-API: copy pre-built Windows binary
  log(c('blue', '\n=== 1/4 GLM-Free-API (Z.ai) — pre-built binary ==='))
  const glmDir = join(ROOT, 'vendor', 'glm-free-api')
  const glmBin = join(glmDir, 'zai-api.exe')
  const platformBin = join(glmDir, 'zai-api-windows-amd64.exe')
  if (existsSync(glmBin)) {
    log(c('green', '  ✓ already copied'))
  } else if (existsSync(platformBin)) {
    copyFileSync(platformBin, glmBin)
    log(c('green', '  ✓ copied zai-api.exe'))
  } else {
    log(c('red', '  ✗ no pre-built binary found'))
  }
  // Captcha collector
  const captchaBin = join(glmDir, 'captcha-collector.exe')
  const captchaPlatform = join(glmDir, 'captcha-collector-windows-amd64.exe')
  if (!existsSync(captchaBin) && existsSync(captchaPlatform)) {
    copyFileSync(captchaPlatform, captchaBin)
    log(c('green', '  ✓ copied captcha-collector.exe'))
  }
  // Empty tokens.sqlite so GLM boots in guest mode
  const tokensDb = join(glmDir, 'tokens.sqlite')
  if (!existsSync(tokensDb)) {
    writeFileSync(tokensDb, '')
    log(c('yellow', '  ⚠ created empty tokens.sqlite'))
  }

  // 2. DeepSeek-API: Python venv + deps
  log(c('blue', '\n=== 2/4 DeepSeek-API — Python venv ==='))
  const dsDir = join(ROOT, 'vendor', 'deepseek-api')
  const venvPython = join(dsDir, '.venv', 'Scripts', 'python.exe')
  const venvPip = join(dsDir, '.venv', 'Scripts', 'pip.exe')
  if (!existsSync(venvPython)) {
    log(c('yellow', '  → creating venv...'))
    const pythonCmd = commandExists('python') ? 'python' : 'python3'
    spawnSync(pythonCmd, ['-m', 'venv', join(dsDir, '.venv')], { stdio: 'pipe' })
    log(c('green', '  ✓ venv created'))
  } else {
    log(c('green', '  ✓ venv already exists'))
  }
  const depCheck = spawnSync(venvPip, ['show', 'fastapi'], { stdio: 'pipe', encoding: 'utf-8' })
  if (depCheck.status !== 0 || !depCheck.stdout?.includes('Name: fastapi')) {
    log(c('yellow', '  → installing python deps (~30s)...'))
    spawnSync(venvPip, ['install', '-q', '--upgrade', 'pip'], { stdio: 'pipe' })
    spawnSync(venvPip, ['install', '-q', '-r', join(dsDir, 'requirements.txt')], { stdio: 'pipe' })
    log(c('green', '  ✓ deps installed'))
  } else {
    log(c('green', '  ✓ deps already installed'))
  }
  // Always verify Playwright is installed in the Python venv (deepseek-api
  // imports playwright at module load — if missing, the daemon crashes on boot).
  // Idempotent: if already installed, this is a fast no-op.
  const playwrightCheck = spawnSync(venvPip, ['show', 'playwright'], { stdio: 'pipe', encoding: 'utf-8' })
  if (playwrightCheck.status !== 0 || !playwrightCheck.stdout?.includes('Name: playwright')) {
    log(c('yellow', '  → installing playwright for python venv...'))
    spawnSync(venvPip, ['install', '-q', 'playwright'], { stdio: 'pipe' })
    log(c('green', '  ✓ playwright installed'))
  } else {
    log(c('green', '  ✓ playwright already installed'))
  }
  // Verify Playwright Chromium browser is installed for the Python venv
  // (separate from Node's Playwright — they don't share browser binaries).
  const pwBrowserPath = join(process.env.USERPROFILE || '', 'AppData', 'Local', 'ms-playwright')
  let pyHasChromium = false
  try {
    if (existsSync(pwBrowserPath)) {
      const entries = readdirSync(pwBrowserPath)
      pyHasChromium = entries.some((e) => e.startsWith('chromium'))
    }
  } catch {}
  if (!pyHasChromium) {
    log(c('yellow', '  → installing playwright chromium for python...'))
    const pwExe = join(dsDir, '.venv', 'Scripts', 'playwright.exe')
    spawnSync(pwExe, ['install', 'chromium'], { stdio: 'pipe', shell: true })
    log(c('green', '  ✓ playwright chromium installed'))
  } else {
    log(c('green', '  ✓ playwright chromium already present'))
  }

  // 3. TS daemons: bun install
  log(c('blue', '\n=== 3/4 TypeScript daemons — bun install ==='))
  for (const dir of ['vendor/qwen-gate', 'vendor/kimi-free-api', '.']) {
    const name = dir === '.' ? 'chat2api' : basename(dir)
    const fullPath = join(ROOT, dir)
    if (existsSync(join(fullPath, 'node_modules'))) {
      log(c('green', `  ✓ ${name} deps already installed`))
    } else {
      log(c('yellow', `  → installing ${name} deps...`))
      spawnSync('bun', ['install', '--silent'], { cwd: fullPath, stdio: 'pipe' })
      log(c('green', `  ✓ ${name} deps installed`))
    }
  }
  // Patch kimi port 8000 → 5566
  const kimiCfg = join(ROOT, 'vendor', 'kimi-free-api', 'configs', 'dev', 'service.yml')
  if (existsSync(kimiCfg)) {
    const content = readFileSync(kimiCfg, 'utf-8')
    if (content.includes('port: 8000')) {
      writeFileSync(kimiCfg, content.replace(/^port: 8000$/m, 'port: 5566'))
      log(c('green', '  ✓ kimi-free-api port set to 5566'))
    }
  }

  // 4. Playwright Chromium
  log(c('blue', '\n=== 4/4 Playwright Chromium ==='))
  const pwCache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.USERPROFILE || '', '.cache', 'ms-playwright')
  let hasChromium = false
  try {
    if (existsSync(pwCache)) {
      const entries = readdirSync(pwCache)
      hasChromium = entries.some((e) => e.startsWith('chromium'))
    }
  } catch {}
  if (hasChromium) {
    log(c('green', '  ✓ chromium already downloaded'))
  } else {
    log(c('yellow', '  → downloading chromium (~150MB)...'))
    spawnSync('bun', ['x', 'playwright', 'install', 'chromium'], {
      cwd: join(ROOT, 'vendor', 'qwen-gate'),
      stdio: 'pipe',
      shell: true,
    })
    log(c('green', '  ✓ chromium downloaded'))
  }

  log(c('blue', '\n=== INSTALL COMPLETE ===\n'))
}

// ============================================================================
// Daemon management
// ============================================================================
interface DaemonConfig {
  id: string
  port: number
  healthPath: string
  auth?: string
  cwd: string
  env: Record<string, string>
  command: string[]
}

const DAEMONS: DaemonConfig[] = [
  {
    id: 'qwen-gate',
    port: 26405,
    healthPath: '/health',
    cwd: 'vendor/qwen-gate',
    env: { PORT: '26405' },
    command: ['bun', 'src/index.tsx'],
  },
  {
    id: 'deepseek-api',
    port: 8000,
    healthPath: '/v1/models',
    cwd: 'vendor/deepseek-api',
    env: { PORT: '8000', HOST: '127.0.0.1' },
    // app_windows.py imports the FastAPI app object directly (avoids uvicorn
    // string-import resolution which fails on Windows).
    command: ['.venv/Scripts/python.exe', 'app_windows.py'],
  },
  {
    id: 'glm-free-api',
    port: 3001,
    healthPath: '/v1/models',
    auth: 'Waguri',
    cwd: 'vendor/glm-free-api',
    env: { PORT: '3001', AUTH_TOKEN: 'Waguri' },
    command: ['zai-api.exe'],
  },
  {
    id: 'kimi-free-api',
    port: 5566,
    healthPath: '/v1/models',
    cwd: 'vendor/kimi-free-api',
    env: {},
    // Use 'start' (node dist/index.js) instead of 'dev' (tsup --watch).
    // The dist/ folder is committed so no build needed, and 'dev' mode is
    // slow on Windows due to tsup watch + esbuild service overhead.
    command: ['bun', 'run', 'start'],
  },
]

const runningChildren: Map<string, ChildProcess> = new Map()

async function startDaemon(cfg: DaemonConfig): Promise<boolean> {
  if (await healthCheck(cfg.port, cfg.healthPath, cfg.auth)) {
    log(c('green', `  ✓ ${cfg.id} already running on :${cfg.port}`))
    return true
  }
  log(c('yellow', `  → starting ${cfg.id} on :${cfg.port}...`))
  const cwd = resolve(ROOT, cfg.cwd)
  const logPath = join(LOG_DIR, `${cfg.id}.log`)
  const logFd = openSync(logPath, 'a')
  const childEnv = { ...process.env, ...cfg.env } as NodeJS.ProcessEnv
  // On Windows, normalize paths to backslashes so cmd.exe (shell:true) resolves
  // relative paths like .venv\Scripts\python.exe correctly.
  const isWin = process.platform === 'win32'
  const cmd0 = isWin ? cfg.command[0].replace(/\//g, '\\') : cfg.command[0]
  const cmdRest = isWin
    ? cfg.command.slice(1).map((a) => a.replace(/\//g, '\\'))
    : cfg.command.slice(1)
  const child = spawn(cmd0, cmdRest, {
    cwd,
    env: childEnv,
    stdio: ['ignore', logFd, logFd],
    detached: false,
    windowsHide: true,
    shell: true,
  })
  runningChildren.set(cfg.id, child)
  writeFileSync(join(PID_DIR, `${cfg.id}.pid`), String(child.pid))

  for (let i = 0; i < 20; i++) {
    if (await healthCheck(cfg.port, cfg.healthPath, cfg.auth)) break
    await sleep(1000)
  }
  if (await healthCheck(cfg.port, cfg.healthPath, cfg.auth)) {
    log(c('green', `  ✓ ${cfg.id} up on :${cfg.port} (PID ${child.pid})`))
    return true
  }
  log(c('red', `  ✗ ${cfg.id} failed — see ${logPath}`))
  return false
}

async function stopAllDaemons(): Promise<void> {
  for (const [id, child] of runningChildren) {
    try {
      if (!child.killed) {
        child.kill('SIGTERM')
        await sleep(500)
        if (!child.killed) child.kill('SIGKILL')
      }
    } catch {}
    log(c('green', `  ${id}: stopped`))
  }
  runningChildren.clear()
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  const mode = process.argv[2] || 'all'

  if (mode === 'check') {
    log(c('blue', '=== Daemon health ==='))
    for (const cfg of DAEMONS) {
      const ok = await healthCheck(cfg.port, cfg.healthPath, cfg.auth)
      log(`  ${ok ? c('green', 'V') : c('red', 'X')} ${cfg.id.padEnd(16)} :${cfg.port}  ${ok ? 'UP' : 'DOWN'}`)
    }
    return
  }

  if (needsInstall() || mode === 'install') {
    await runInstall()
    if (mode === 'install') return
  }

  if (mode === 'daemons' || mode === 'all') {
    log(c('blue', '\n=== Starting daemons ==='))
    for (const cfg of DAEMONS) {
      await startDaemon(cfg)
    }
    log(c('blue', '\n=== Daemon status ==='))
    for (const cfg of DAEMONS) {
      const ok = await healthCheck(cfg.port, cfg.healthPath, cfg.auth)
      log(`  ${ok ? c('green', 'V') : c('red', 'X')} ${cfg.id.padEnd(16)} :${cfg.port}  ${ok ? 'UP' : 'DOWN'}`)
    }
  }

  if (mode === 'daemons') {
    log(c('green', '\nDaemons-only mode. Press Ctrl+C to stop.'))
    process.on('SIGINT', async () => { await stopAllDaemons(); process.exit(0) })
    process.on('SIGTERM', async () => { await stopAllDaemons(); process.exit(0) })
    setInterval(() => {}, 1000)
    return
  }

  if (mode === 'all') {
    log(c('blue', '\n=== Starting Chat2API Electron app ==='))
    log(`  Dashboard: http://localhost:8080`)
    log(`  Logs:      ${LOG_DIR}`)
    const electron = spawn('bun', ['start'], { cwd: ROOT, stdio: 'inherit', shell: true })
    electron.on('exit', async (code) => {
      await stopAllDaemons()
      process.exit(code ?? 0)
    })
    process.on('SIGINT', async () => { await stopAllDaemons(); process.exit(0) })
  }
}

// ============================================================================
// Helpers
// ============================================================================
function needsInstall(): boolean {
  const checks = [
    join(ROOT, 'vendor/glm-free-api/zai-api.exe'),
    join(ROOT, 'vendor/deepseek-api/.venv/Scripts/python.exe'),
    join(ROOT, 'vendor/qwen-gate/node_modules'),
    join(ROOT, 'vendor/kimi-free-api/node_modules'),
    join(ROOT, 'node_modules'),
  ]
  return checks.some((p) => !existsSync(p))
}

function commandExists(cmd: string): boolean {
  const result = spawnSync('where', [cmd], { stdio: 'pipe' })
  return result.status === 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error(c('red', '\n=== FATAL ERROR ==='))
  console.error(err)
  process.exit(1)
})
