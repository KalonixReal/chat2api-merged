// Electron shim for headless server mode
// Stubs all APIs the codebase uses so the proxy server + dashboard can run
// without a display server.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const DATA_DIR = path.join(process.cwd(), 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

module.exports = {
  app: {
    isReady: () => true,
    getPath: (name) => name === 'userData' ? DATA_DIR : DATA_DIR,
    on: () => {}, once: () => {}, quit: () => process.exit(0),
    relaunch: () => {}, getVersion: () => '1.1.0',
    isQuitting: false,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (str) => Buffer.from(str, 'utf-8'),
    decryptString: (buf) => buf.toString('utf-8'),
  },
  BrowserWindow: class {
    constructor() {}
    loadURL() {} loadFile() {} on() {} once() {}
    webContents = { send: () => {}, on: () => {} }
    show() {} hide() {} close() {} destroy() {}
    isFocused() { return false } isDestroyed() { return true }
    static getAllWindows() { return [] }
    static fromWebContents() { return null }
  },
  ipcMain: { handle: () => {}, on: () => {}, off: () => {}, removeAllListeners: () => {} },
  ipcRenderer: { send: () => {}, on: () => {}, invoke: () => Promise.resolve() },
  shell: { openExternal: (url) => console.log('[shell.openExternal] ' + url), openPath: () => {}, showItemInFolder: () => {} },
  session: { defaultSession: { cookies: { get: () => Promise.resolve([]), set: () => Promise.resolve() }, clearStorageData: () => Promise.resolve() } },
  net: { request: () => ({ on: () => {}, end: () => {}, write: () => {} }) },
  Notification: class { constructor() {} show() {} close() {} },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} },
  nativeImage: { createFromPath: () => ({}) },
  globalShortcut: { register: () => {}, unregister: () => {} },
}
