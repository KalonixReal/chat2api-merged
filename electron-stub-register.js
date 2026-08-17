/**
 * electron-stub-register.js — Bun preload script that registers the electron
 * stub module before any other imports. This lets the proxy server run
 * headless without Electron.
 *
 * Usage: bun --preload ./electron-stub-register.js server.ts
 */

const Module = require('node:module')
const path = require('node:path')

const stubPath = path.resolve(__dirname, 'electron-stub.js')

// Override Module._resolveFilename so `require('electron')` returns our stub.
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'electron') {
    return stubPath
  }
  return originalResolve.call(this, request, parent, ...rest)
}

// Also intercept ESM-style imports via Bun's module registry
if (typeof globalThis.__createBinding === 'function') {
  // Bun-specific: not needed, Module._resolveFilename covers both CJS and ESM
}
