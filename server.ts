/**
 * server.ts — standalone proxy server entry point.
 *
 * Boots the Koa proxy server on :8080, auto-installs deps on first run,
 * and starts the daemon supervisor. The web dashboard is then available
 * at http://localhost:8080/dashboard
 *
 * Usage:
 *   bun server.ts
 *   bun run.ts server   (boots daemons + this server)
 */

import { ProxyServer } from './src/main/proxy/server'
import { daemonSupervisor, ensureInstalled } from './src/main/supervisor'
import { storeManager } from './src/main/store/store'
import { createWriteStream, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ─── Logging ────────────────────────────────────────────────────────────────
// Logs to BOTH stdout AND a file (logs/server.log) so the user can always
// find logs even if the terminal closes. Uses plain ASCII (no box-drawing
// chars) to avoid Windows cmd.exe encoding issues.
const LOG_DIR = join(process.cwd(), 'logs')
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = join(LOG_DIR, 'server.log')
const logStream = createWriteStream(LOG_FILE, { flags: 'a' })

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  gray: '\x1b[90m',
}

function ts(): string {
  return new Date().toISOString().slice(11, 19) // HH:MM:SS
}

function log(msg: string, color: string = C.reset): void {
  const line = `[${ts()}] ${msg}`
  console.log(`${C.gray}[${ts()}]${C.reset} ${color}${msg}${C.reset}`)
  logStream.write(line + '\n')
}
function logInfo(msg: string): void { log(msg, C.cyan) }
function logOk(msg: string): void { log(msg, C.green) }
function logWarn(msg: string): void { log(msg, C.yellow) }
function logErr(msg: string): void { log(msg, C.red) }

async function main() {
  console.log('\n=== chat2api-merged Web Dashboard Server v2.2.0 ===\n')
  logStream.write(`\n${'='.repeat(60)}\n[${new Date().toISOString()}] Server starting\n${'='.repeat(60)}\n`)

  // Auto-install deps on first run
  logInfo('Checking dependencies...')
  const installed = await ensureInstalled()
  if (!installed) {
    logWarn('Install completed with warnings -- continuing anyway')
  } else {
    logOk('Dependencies ready')
  }

  // Initialize the store
  logInfo('Initializing store...')
  try {
    await storeManager.initialize()
    const providers = storeManager.getProviders()
    const accounts = storeManager.getAccounts()
    logOk(`Store initialized: ${providers.length} providers, ${accounts.length} accounts`)
    providers.forEach(p => {
      const models = storeManager.getEffectiveModels(p.id)
      log(`  provider: ${p.id} (${models.length} models)`, C.dim)
    })
  } catch (err: any) {
    logErr(`Store initialization failed: ${err.message}`)
    logErr('Continuing with default config...')
  }

  // Start all daemons
  logInfo('Starting daemons...')
  await daemonSupervisor.startAll()
  const statuses = await daemonSupervisor.checkAll()
  statuses.forEach(s => {
    if (s.healthy) logOk(`  daemon: ${s.id} :${s.port} UP`)
    else logErr(`  daemon: ${s.id} :${s.port} DOWN ${s.detail || ''}`)
  })

  // Start the proxy server
  const port = parseInt(process.env.PROXY_PORT || '8080', 10)
  const host = process.env.PROXY_HOST || '127.0.0.1'
  logInfo(`Starting proxy server on ${host}:${port}...`)
  const proxy = new ProxyServer()
  const ok = await proxy.start(port, host)

  if (!ok) {
    logErr('Failed to start proxy server')
    process.exit(1)
  }

  console.log('')
  logOk('Server running!')
  console.log('')
  console.log(`  Dashboard:  http://${host}:${port}/dashboard`)
  console.log(`  OpenAI API: http://${host}:${port}/v1/chat/completions`)
  console.log(`  Health:     http://${host}:${port}/health`)
  console.log(`  Logs:       ${LOG_FILE}`)
  console.log('')
  logStream.write(`[${new Date().toISOString()}] Server ready on ${host}:${port}\n`)
  console.log('Press Ctrl+C to stop.\n')

  // Periodic status log (every 60s)
  setInterval(async () => {
    try {
      const statuses = await daemonSupervisor.checkAll()
      const up = statuses.filter(s => s.healthy).length
      const down = statuses.filter(s => !s.healthy).length
      log(`Status: ${up} daemons up, ${down} down`, C.dim)
    } catch {}
  }, 60_000)

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[${ts()}] ${signal} received -- shutting down...`)
    logInfo('Stopping daemons...')
    await daemonSupervisor.stopAll()
    logOk('All daemons stopped')
    logStream.write(`[${new Date().toISOString()}] Server stopped (${signal})\n`)
    logStream.end()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  logErr(`Fatal error: ${err.message}`)
  console.error(err.stack)
  logStream.write(`[${new Date().toISOString()}] FATAL: ${err.stack}\n`)
  logStream.end()
  process.exit(1)
})
