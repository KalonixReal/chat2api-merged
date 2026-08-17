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

async function main() {
  console.log('=== chat2api-merged server (headless mode) ===\n')

  // Auto-install deps on first run
  await ensureInstalled()

  // Initialize the store (loads config, accounts, providers from disk)
  await storeManager.initialize()

  // Start all daemons in the background
  console.log('Starting daemons...')
  await daemonSupervisor.startAll()

  // Start the proxy server (serves the dashboard + OpenAI API)
  const port = parseInt(process.env.PROXY_PORT || '8080', 10)
  const host = process.env.PROXY_HOST || '127.0.0.1'
  const proxy = new ProxyServer()
  const ok = await proxy.start(port, host)

  if (!ok) {
    console.error('Failed to start proxy server')
    process.exit(1)
  }

  console.log(`\n✓ Proxy server running on http://${host}:${port}`)
  console.log(`✓ Dashboard: http://${host}:${port}/dashboard`)
  console.log(`✓ OpenAI API: http://${host}:${port}/v1/chat/completions`)
  console.log('\nPress Ctrl+C to stop.\n')

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...')
    await daemonSupervisor.stopAll()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
