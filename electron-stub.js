/**
 * electron-stub.js — minimal stub for the 'electron' module so the proxy
 * server can run headless (without Electron installed/running).
 *
 * Only stubs the APIs the store module actually uses:
 *   - app.getPath(), app.isReady, app.on, app.quit
 *   - safeStorage.isEncryptionAvailable(), encryptString(), decryptString()
 *   - BrowserWindow (stub — not used in headless mode)
 *   - ipcMain (stub — no IPC in headless mode)
 *   - shell.openExternal (stub — logs instead)
 *
 * This lets the full proxy server + dashboard run with `bun server.ts`
 * without needing a display server.
 */

const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

// App data dir — use a local folder so we don't pollute the user's home
const APP_DATA_DIR = path.join(process.cwd(), 'data')
if (!fs.existsSync(APP_DATA_DIR)) fs.mkdirSync(APP_DATA_DIR, { recursive: true })

const app = {
  isReady: () => true,
  getPath: (name) => {
    if (name === 'userData') return APP_DATA_DIR
    if (name === 'logs') return path.join(APP_DATA_DIR, 'logs')
    if (name === 'temp') return os.tmpdir()
    return APP_DATA_DIR
  },
  on: () => {},
  once: () => {},
  quit: () => process.exit(0),
  relaunch: () => {},
  getVersion: () => '1.1.0',
}

const safeStorage = {
  isEncryptionAvailable: () => false, // forces plain storage fallback in store.ts
  encryptString: (str) => Buffer.from(str, 'utf-8'),
  decryptString: (buf) => buf.toString('utf-8'),
}

class BrowserWindow {
  constructor() {}
  loadURL() {}
  loadFile() {}
  on() {}
  once() {}
  webContents = { send: () => {} }
  show() {}
  hide() {}
  close() {}
  destroy() {}
  isFocused() { return false }
  isDestroyed() { return false }
  static getAllWindows() { return [] }
  static fromWebContents() { return null }
}

const ipcMain = {
  handle: () => {},
  on: () => {},
  off: () => {},
  removeAllListeners: () => {},
}

const shell = {
  openExternal: (url) => console.log(`[shell.openExternal stub] ${url}`),
  openPath: () => {},
  showItemInFolder: () => {},
}

const session = {
  defaultSession: {
    cookies: { get: () => Promise.resolve([]), set: () => Promise.resolve() },
    clearStorageData: () => Promise.resolve(),
  },
}

const net = {
  request: () => ({ on: () => {}, end: () => {}, write: () => {} }),
}

module.exports = { app, safeStorage, BrowserWindow, ipcMain, shell, session, net }
