/**
 * JsonStore — minimal JSON file store (drop-in replacement for electron-store).
 *
 * Persists data to a JSON file on disk. No encryption (the proxy runs locally
 * so plain storage is fine). Has the same API surface that store.ts uses:
 *   new JsonStore({ name, cwd, defaults })
 *   store.get(key) / store.set(key, value) / store.store / store.clear()
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export interface JsonStoreOptions {
  name?: string
  cwd: string
  defaults?: Record<string, any>
  encryptionKey?: string | undefined // ignored (kept for API compat)
}

export class JsonStore {
  private filePath: string
  private data: Record<string, any>
  private defaults: Record<string, any>

  constructor(options: JsonStoreOptions) {
    const name = options.name || 'data'
    this.filePath = join(options.cwd, `${name}.json`)
    this.defaults = options.defaults || {}
    this.data = this.load()
  }

  private load(): Record<string, any> {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        // Merge with defaults (defaults only fill missing top-level keys)
        return { ...this.defaults, ...parsed }
      }
    } catch (err: any) {
      console.warn(`[JsonStore] failed to load ${this.filePath}: ${err.message} — using defaults`)
      // If the file is corrupted, back it up and start fresh
      if (existsSync(this.filePath)) {
        renameSync(this.filePath, `${this.filePath}.corrupted-${Date.now()}`)
      }
    }
    return { ...this.defaults }
  }

  private save(): void {
    try {
      const dir = join(this.filePath, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      // Atomic write: write to temp then rename
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      renameSync(tmp, this.filePath)
    } catch (err: any) {
      console.error(`[JsonStore] failed to save ${this.filePath}: ${err.message}`)
    }
  }

  get<T = any>(key: string): T {
    return this.data[key] as T
  }

  set(key: string, value: any): void {
    this.data[key] = value
    this.save()
  }

  delete(key: string): void {
    delete this.data[key]
    this.save()
  }

  clear(): void {
    this.data = { ...this.defaults }
    this.save()
  }

  get store(): Record<string, any> {
    return this.data
  }

  set store(value: Record<string, any>) {
    this.data = value
    this.save()
  }

  has(key: string): boolean {
    return key in this.data
  }
}

export default JsonStore
