/**
 * scripts/patch-electron.js — overwrites node_modules/electron/index.js with
 * our shim so the proxy server can run headless (without Electron).
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
  if (fs.existsSync(targetPath)) {
    const current = fs.readFileSync(targetPath, 'utf-8')
    if (current.includes('Electron shim for headless server mode')) {
      console.log('[patch-electron] already patched, skipping')
      process.exit(0)
    }
  }
  const backupPath = targetPath + '.original'
  if (!fs.existsSync(backupPath) && fs.existsSync(targetPath)) {
    fs.copyFileSync(targetPath, backupPath)
  }
  fs.writeFileSync(targetPath, shimContent)
  console.log('[patch-electron] patched node_modules/electron/index.js with headless shim')
} catch (err) {
  console.error('[patch-electron] failed:', err.message)
  process.exit(0)
}
