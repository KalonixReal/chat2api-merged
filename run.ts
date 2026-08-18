/**
 * run.ts - Windows single entry point.
 *
 * One command: bun run.ts (or double-click start.bat).
 * Auto-installs deps on first run, boots daemons, starts the proxy server.
 *
 * Usage:
 *   bun run.ts              # install (if needed) + boot server + dashboard
 *   bun run.ts daemons       # boot daemons only (no proxy)
 *   bun run.ts check        # check daemon health
 *   bun run.ts install      # run install only
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
const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', gray: '\x1b[90m',
}
function c(color: keyof typeof C, msg: string): string {
  return `${C[color]}${msg}${C.reset}`
}
function log(msg: string, color: keyof typeof C = 'reset'): void {
  console.log(`${c('gray', `[${ts()}]`)} ${c(color, msg)}`)
}
function ts(): string {
  return new Date().toISOString().slice(11, 19)
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
  log('Installing (Windows)...', 'blue')

  // Check runtimes
  if (!commandExists('bun')) {
    log('ERROR: bun not found. Install: https://bun.sh', 'red')
    process.exit(1)
  }
  log('  bun OK', 'green')
  if (!checkPython()) {
    log('ERROR: Python 3.9+ not found. Install from https://python.org', 'red')
    process.exit(1)
  }
  log('  python OK', 'green')

  // 1. GLM-Free-API: copy pre-built Windows binary
  log('1/4 GLM-Free-API (Z.ai) - pre-built binary', 'blue')
  const glmDir = join(ROOT, 'vendor', 'glm-free-api')
  const glmBin = join(glmDir, 'zai-api.exe')
  const platformBin = join(glmDir, 'zai-api-windows-amd64.exe')
  if (existsSync(glmBin)) {
    log('  already copied', 'green')
  } else if (existsSync(platformBin)) {
    copyFileSync(platformBin, glmBin)
    log('  copied zai-api.exe', 'green')
  } else {
    log('  ERROR: no pre-built binary found', 'red')
  }
  const captchaBin = join(glmDir, 'captcha-collector.exe')
  const captchaPlatform = join(glmDir, 'captcha-collector-windows-amd64.exe')
  if (!existsSync(captchaBin) && existsSync(captchaPlatform)) {
    copyFileSync(captchaPlatform, captchaBin)
    log('  copied captcha-collector.exe', 'green')
  }
  const tokensDb = join(glmDir, 'tokens.sqlite')
  if (!existsSync(tokensDb)) {
    writeFileSync(tokensDb, '')
    log('  created empty tokens.sqlite', 'yellow')
  }

  // 2. DeepSeek-API: Python venv + deps
  log('2/4 DeepSeek-API - Python venv', 'blue')
  const dsDir = join(ROOT, 'vendor', 'deepseek-api')
  const venvPython = join(dsDir, '.venv', 'Scripts', 'python.exe')
  const venvPip = join(dsDir, '.venv', 'Scripts', 'pip.exe')
  if (!existsSync(venvPython)) {
    log('  creating venv...', 'yellow')
    const pythonCmd = commandExists('python') ? 'python' : 'python3'
    const venvResult = spawnSync(pythonCmd, ['-m', 'venv', join(dsDir, '.venv')], { stdio: 'pipe', shell: true, encoding: 'utf-8' })
    if (venvResult.status !== 0) {
      log('  venv creation failed: ' + (venvResult.stderr || '').slice(0, 300), 'red')
      process.exit(1)
    }
    log('  venv created', 'green')
  } else {
    log('  venv already exists', 'green')
  }
  const depCheck = spawnSync(venvPip, ['show', 'fastapi'], { stdio: 'pipe', encoding: 'utf-8', shell: true })
  if (depCheck.status !== 0 || !depCheck.stdout?.includes('Name: fastapi')) {
    log('  installing python deps...', 'yellow')
    spawnSync(venvPip, ['install', '-q', '--upgrade', 'pip'], { stdio: 'pipe', shell: true })
    const pipInstall = spawnSync(venvPip, ['install', '-q', '-r', join(dsDir, 'requirements.txt')], { stdio: 'pipe', shell: true, encoding: 'utf-8' })
    if (pipInstall.status !== 0) {
      log('  pip install failed: ' + (pipInstall.stderr || '').slice(0, 300), 'red')
      process.exit(1)
    }
    log('  deps installed', 'green')
  } else {
    log('  deps already installed', 'green')
  }
  // Playwright for Python venv
  const playwrightCheck = spawnSync(venvPip, ['show', 'playwright'], { stdio: 'pipe', encoding: 'utf-8', shell: true })
  if (playwrightCheck.status !== 0 || !playwrightCheck.stdout?.includes('Name: playwright')) {
    log('  installing playwright for python...', 'yellow')
    spawnSync(venvPip, ['install', '-q', 'playwright'], { stdio: 'pipe', shell: true })
    log('  playwright installed', 'green')
  } else {
    log('  playwright already installed', 'green')
  }
  // Chromium browser for Python Playwright
  const pwBrowserPath = join(process.env.USERPROFILE || '', 'AppData', 'Local', 'ms-playwright')
  let pyHasChromium = false
  try {
    if (existsSync(pwBrowserPath)) {
      pyHasChromium = readdirSync(pwBrowserPath).some((e) => e.startsWith('chromium'))
    }
  } catch {}
  if (!pyHasChromium) {
    log('  installing playwright chromium...', 'yellow')
    const pwExe = join(dsDir, '.venv', 'Scripts', 'playwright.exe')
    spawnSync(pwExe, ['install', 'chromium'], { stdio: 'pipe', shell: true })
    log('  chromium installed', 'green')
  } else {
    log('  chromium already present', 'green')
  }

  // 3. TS daemons: bun install
  log('3/4 TypeScript daemons - bun install', 'blue')
  for (const dir of ['vendor/qwen-gate', 'vendor/kimi-free-api', '.']) {
    const name = dir === '.' ? 'chat2api' : basename(dir)
    const fullPath = join(ROOT, dir)
    if (existsSync(join(fullPath, 'node_modules'))) {
      log(`  ${name} deps already installed`, 'green')
    } else {
      log(`  installing ${name} deps...`, 'yellow')
      spawnSync('bun', ['install', '--silent'], { cwd: fullPath, stdio: 'pipe', shell: true })
      log(`  ${name} deps installed`, 'green')
    }
  }
  // Patch kimi port 8000 -> 5566
  const kimiCfg = join(ROOT, 'vendor', 'kimi-free-api', 'configs', 'dev', 'service.yml')
  if (existsSync(kimiCfg)) {
    const content = readFileSync(kimiCfg, 'utf-8')
    if (content.includes('port: 8000')) {
      writeFileSync(kimiCfg, content.replace(/^port: 8000$/m, 'port: 5566'))
      log('  kimi-free-api port set to 5566', 'green')
    }
  }

  // 4. Playwright Chromium (Node)
  log('4/4 Playwright Chromium (Node)', 'blue')
  const pwCache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.USERPROFILE || '', 'AppData', 'Local', 'ms-playwright')
  let hasChromium = false
  try {
    if (existsSync(pwCache)) {
      hasChromium = readdirSync(pwCache).some((e) => e.startsWith('chromium'))
    }
  } catch {}
  if (hasChromium) {
    log('  chromium already downloaded', 'green')
  } else {
    log('  downloading chromium...', 'yellow')
    spawnSync('bun', ['x', 'playwright', 'install', 'chromium'], { cwd: join(ROOT, 'vendor', 'qwen-gate'), stdio: 'pipe', shell: true })
    log('  chromium downloaded', 'green')
  }

  log('INSTALL COMPLETE', 'blue')
}

// ============================================================================
// Daemon management (Windows)
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
    command: ['.venv\\Scripts\\python.exe', 'app_windows.py'],
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
    command: ['bun', 'dist/index.js'],
  },
]

const runningChildren: Map<string, ChildProcess> = new Map()

async function startDaemon(cfg: DaemonConfig): Promise<boolean> {
  if (await healthCheck(cfg.port, cfg.healthPath, cfg.auth)) {
    log(`${cfg.id} already running on :${cfg.port}`, 'green')
    return true
  }
  log(`starting ${cfg.id} on :${cfg.port}...`, 'yellow')
  const cwd = resolve(ROOT, cfg.cwd)
  const logPath = join(LOG_DIR, `${cfg.id}.log`)
  const logFd = openSync(logPath, 'a')
  const childEnv = { ...process.env, ...cfg.env } as NodeJS.ProcessEnv
  // shell:true on Windows so bun.exe / python.exe / zai-api.exe resolve via PATHEXT
  const child = spawn(cfg.command[0], cfg.command.slice(1), {
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
    log(`${cfg.id} up on :${cfg.port}`, 'green')
    return true
  }
  log(`${cfg.id} failed - see ${logPath}`, 'red')
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
    log(`${id}: stopped`, 'green')
  }
  runningChildren.clear()
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  const mode = process.argv[2] || 'all'

  if (mode === 'check') {
    log('Daemon health:', 'blue')
    for (const cfg of DAEMONS) {
      const ok = await healthCheck(cfg.port, cfg.healthPath, cfg.auth)
      log(`  ${ok ? 'OK' : 'XX'} ${cfg.id.padEnd(16)} :${cfg.port}  ${ok ? 'UP' : 'DOWN'}`, ok ? 'green' : 'red')
    }
    return
  }

  if (needsInstall() || mode === 'install') {
    await runInstall()
    if (mode === 'install') return
  }

  if (mode === 'daemons') {
    log('Starting daemons...', 'blue')
    for (const cfg of DAEMONS) { await startDaemon(cfg) }
    log('Daemon status:', 'blue')
    for (const cfg of DAEMONS) {
      const ok = await healthCheck(cfg.port, cfg.healthPath, cfg.auth)
      log(`  ${ok ? 'OK' : 'XX'} ${cfg.id.padEnd(16)} :${cfg.port}  ${ok ? 'UP' : 'DOWN'}`, ok ? 'green' : 'red')
    }
    log('Daemons-only mode. Press Ctrl+C to stop.', 'green')
    process.on('SIGINT', async () => { await stopAllDaemons(); process.exit(0) })
    process.on('SIGTERM', async () => { await stopAllDaemons(); process.exit(0) })
    setInterval(() => {}, 1000)
    return
  }

  // Default: start the proxy server (server.ts owns the daemons)
  log('Starting proxy server...', 'blue')
  log(`  Dashboard:  http://localhost:8080/dashboard`, 'blue')
  log(`  OpenAI API: http://localhost:8080/v1/chat/completions`, 'blue')
  log(`  Logs:       ${LOG_DIR}`, 'blue')
  const server = spawn('bun', ['server.ts'], { cwd: ROOT, stdio: 'inherit', shell: true })
  server.on('exit', (code) => { process.exit(code ?? 0) })
  process.on('SIGINT', () => { process.exit(0) })
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
  const result = spawnSync('where', [cmd], { stdio: 'pipe', shell: true })
  return result.status === 0
}

function checkPython(): boolean {
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const result = spawnSync(cmd, ['--version'], { stdio: 'pipe', encoding: 'utf-8', shell: true, timeout: 5000 })
      if (result.status === 0) {
        const output = (result.stdout || '') + (result.stderr || '')
        if (/Python 3\.\d+/.test(output) && output.trim()) return true
      }
    } catch {}
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('FATAL ERROR:', err)
  process.exit(1)
})
