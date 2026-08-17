/**
 * server.ts — standalone proxy server entry point (no Electron required).
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

// ─── Verbose logger ─────────────────────────────────────────────────────────
// Wraps console.log with timestamps + color codes so the terminal shows
// exactly what's happening at all times.
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  gray: '\x1b[90m',
}
function ts(): string {
  return new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
}
function log(msg: string, color: string = C.reset): void {
  console.log(`${C.gray}[${ts()}]${C.reset} ${color}${msg}${C.reset}`)
}
function logInfo(msg: string): void { log(msg, C.cyan) }
function logOk(msg: string): void { log(msg, C.green) }
function logWarn(msg: string): void { log(msg, C.yellow) }
function logErr(msg: string): void { log(msg, C.red) }

async function main() {
  console.log(`\n${C.magenta}╔══════════════════════════════════════════════════════╗${C.reset}`)
  console.log(`${C.magenta}║   chat2api-merged — Web Dashboard Server v2.1.0     ║${C.reset}`)
  console.log(`${C.magenta}╚══════════════════════════════════════════════════════╝${C.reset}\n`)

  // Auto-install deps on first run
  logInfo('Checking dependencies...')
  const installed = await ensureInstalled()
  if (!installed) {
    logWarn('Install completed with warnings — continuing anyway')
  } else {
    logOk('Dependencies ready')
  }

  // Initialize the store (loads config, accounts, providers from disk)
  logInfo('Initializing store...')
  try {
    await storeManager.initialize()
    const providers = storeManager.getProviders()
    const accounts = storeManager.getAccounts()
    logOk(`Store initialized: ${providers.length} providers, ${accounts.length} accounts`)
  } catch (err: any) {
    logErr(`Store initialization failed: ${err.message}`)
    logErr('Continuing with default config...')
  }

  // Start all daemons in the background
  logInfo('Starting daemons...')
  await daemonSupervisor.startAll()

  // Start the proxy server (serves the dashboard + OpenAI API)
  const port = parseInt(process.env.PROXY_PORT || '8080', 10)
  const host = process.env.PROXY_HOST || '127.0.0.1'
  const proxy = new ProxyServer()
  const ok = await proxy.start(port, host)

  if (!ok) {
    logErr('Failed to start proxy server')
    process.exit(1)
  }

  console.log(`\n${C.green}╔══════════════════════════════════════════════════════╗${C.reset}`)
  console.log(`${C.green}║  ✓ Server running                                    ║${C.reset}`)
  console.log(`${C.green}╠══════════════════════════════════════════════════════╣${C.reset}`)
  console.log(`${C.green}║  Dashboard:  http://${host}:${port}/dashboard${' '.repeat(Math.max(0, 28 - host.length - String(port).length - 21))}║${C.reset}`)
  console.log(`${C.green}║  OpenAI API: http://${host}:${port}/v1/chat/completions${' '.repeat(Math.max(0, 28 - host.length - String(port).length - 34))}║${C.reset}`)
  console.log(`${C.green}║  Health:     http://${host}:${port}/health${' '.repeat(Math.max(0, 28 - host.length - String(port).length - 19))}║${C.reset}`)
  console.log(`${C.green}╚══════════════════════════════════════════════════════╝${C.reset}`)
  console.log(`\n${C.gray}Press Ctrl+C to stop.${C.reset}\n`)

  // Periodic status log (every 60s)
  setInterval(async () => {
    const statuses = await daemonSupervisor.checkAll()
    const up = statuses.filter(s => s.healthy).length
    const down = statuses.filter(s => !s.healthy).length
    log(`Status: ${up} up, ${down} down`, C.dim)
  }, 60_000)

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${C.yellow}[${ts()}] ${signal} received — shutting down...${C.reset}`)
    logInfo('Stopping daemons...')
    await daemonSupervisor.stopAll()
    logOk('All daemons stopped')
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  logErr(`Fatal error: ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
