/**
 * DeepSeekPow — TypeScript port of deepseek-api/deepseek/pow.py
 * Solves DeepSeek's proof-of-work challenge using the same WASM module
 * the browser runs. Uses WebAssembly API instead of Python wasmtime.
 *
 * The WASM file (`sha3_wasm_bg.7b9ca65ddd.wasm`) is shipped at the project
 * root. We resolve its path robustly:
 *   1. Try walking up from `import.meta.url` / `__dirname` (works in compiled
 *      output where this file is under `out/main/proxy/providers/deepseek/`).
 *   2. Try `process.cwd()/sha3_wasm_bg.7b9ca65ddd.wasm` (works for `bun start`,
 *      `electron .`, and most dev workflows).
 *   3. As a last resort, try `process.cwd()` itself.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const WASM_FILENAME = 'sha3_wasm_bg.7b9ca65ddd.wasm'

/**
 * Build a list of candidate paths where the WASM file might live, in order
 * of preference. The first one that exists is used.
 */
function resolveWasmPath(): string {
  const candidates: string[] = []

  // 1) import.meta.url — works in ESM. Walk up to find WASM at project root.
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    candidates.push(join(here, WASM_FILENAME))
    let dir = here
    for (let i = 0; i < 10; i++) {
      candidates.push(join(dir, WASM_FILENAME))
      if (existsSync(join(dir, 'package.json'))) break
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* ignore ESM resolution failure */
  }

  // 2) __dirname — works in CJS (vite compiled output). Walk up.
  try {
    // @ts-ignore — __dirname is a CJS global, may not exist in ESM.
    if (typeof __dirname !== 'undefined') {
      const here = resolvePath(__dirname)
      candidates.push(join(here, WASM_FILENAME))
      let dir = here
      for (let i = 0; i < 10; i++) {
        candidates.push(join(dir, WASM_FILENAME))
        if (existsSync(join(dir, 'package.json'))) break
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
  } catch {
    /* ignore CJS resolution failure */
  }

  // 3) process.cwd() — works for `bun start`, `electron .`, most dev workflows.
  candidates.push(join(process.cwd(), WASM_FILENAME))

  // 4) As a last resort, the current working directory itself.
  candidates.push(WASM_FILENAME)

  // Pick the first candidate that exists.
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  // If none exist, return the process.cwd() candidate so the read attempt
  // produces a useful ENOENT error message.
  return join(process.cwd(), WASM_FILENAME)
}

export class DeepSeekPow {
  private memory!: WebAssembly.Memory
  private solve!: (retptr: number, cPtr: number, cLen: number, pPtr: number, pLen: number, difficulty: number) => void
  private malloc!: (size: number, align: number) => number
  private addToStack!: (delta: number) => number
  private initialized = false
  private wasmPath: string | null = null

  async init(): Promise<void> {
    if (this.initialized) return
    const wasmPath = resolveWasmPath()
    const wasmBuffer = readFileSync(wasmPath)
    this.wasmPath = wasmPath
    const module = await WebAssembly.compile(wasmBuffer)
    const instance = await WebAssembly.instantiate(module, {
      wbg: {
        __wbindgen_throw: (ptr: number, len: number) => {
          const mem = new Uint8Array(this.memory.buffer)
          throw new Error(new TextDecoder().decode(mem.slice(ptr, ptr + len)))
        },
        __wbindgen_string_new: (ptr: number, len: number) => {
          const mem = new Uint8Array(this.memory.buffer)
          return new TextDecoder().decode(mem.slice(ptr, ptr + len))
        },
      },
    })
    const exports = instance.exports as any
    this.memory = exports.memory
    this.solve = exports.wasm_solve
    this.malloc = exports.__wbindgen_export_0
    this.addToStack = exports.__wbindgen_add_to_stack_pointer
    this.initialized = true
  }

  private writeStr(text: string): [number, number] {
    const data = new TextEncoder().encode(text)
    const ptr = this.malloc(data.length, 1)
    new Uint8Array(this.memory.buffer).set(data, ptr)
    return [ptr, data.length]
  }

  solveChallenge(challenge: string, prefix: string, difficulty: number): number | null {
    const retptr = this.addToStack(-16)
    try {
      const [cPtr, cLen] = this.writeStr(challenge)
      const [pPtr, pLen] = this.writeStr(prefix)
      this.solve(retptr, cPtr, cLen, pPtr, pLen, difficulty)
      const view = new DataView(this.memory.buffer)
      const status = view.getInt32(retptr, true)
      const value = view.getFloat64(retptr + 8, true)
      return status === 0 ? null : Math.floor(value)
    } finally {
      this.addToStack(16)
    }
  }

  makeHeader(challenge: any): string {
    const prefix = `${challenge.salt}_${challenge.expire_at}_`
    const answer = this.solveChallenge(challenge.challenge, prefix, challenge.difficulty)
    if (answer === null) throw new Error('PoW solver returned no answer')
    return Buffer.from(JSON.stringify({
      algorithm: challenge.algorithm, challenge: challenge.challenge,
      salt: challenge.salt, answer, signature: challenge.signature, target_path: challenge.target_path,
    })).toString('base64')
  }
}
