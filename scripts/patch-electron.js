/**
 * scripts/patch-electron.js — overwrites node_modules/electron/index.js with
 * our shim so the proxy server can run headless (without Electron).
 *
 * This runs automatically as a postinstall step after `bun install` / `npm install`,
 * so the shim survives dependency reinstalls.
 *
 * In Electron mode (electron-vite), the build bundles from source and ignores
 * node_modules/electron — so this shim doesn't affect the Electron app.
 */

const fs = require('node:fs')
const path = require('node:path')

const shimPath = path.resolve(__dirname, '..', 'electron-shim', 'index.js')
const targetPath = path.resolve(__dirname, '..', 'node_modules', 'electron', 'index.js')

try {
  if (!fs.existsSync(shimPath)) {
    console.log('[patch-electron] shim source not found, skipping')
    process.exit(0)
  }

  const shimContent = fs.readFileSync(shimPath, 'utf-8')

  // Check if already patched (avoid redundant writes)
  if (fs.existsSync(targetPath)) {
    const current = fs.readFileSync(targetPath, 'utf-8')
    if (current.includes('Electron shim for headless server mode')) {
      console.log('[patch-electron] already patched, skipping')
      process.exit(0)
    }
  }

  // Backup the original (only if no backup exists)
  const backupPath = targetPath + '.original'
  if (!fs.existsSync(backupPath) && fs.existsSync(targetPath)) {
    fs.copyFileSync(targetPath, backupPath)
  }

  // Overwrite with the shim
  fs.writeFileSync(targetPath, shimContent)
  console.log('[patch-electron] patched node_modules/electron/index.js with headless shim')
} catch (err) {
  console.error('[patch-electron] failed:', err.message)
  // Don't fail the install if patching fails
  process.exit(0)
}
