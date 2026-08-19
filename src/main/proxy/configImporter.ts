/**
 * ConfigImporter — reads an `accounts.json` file from the project root and
 * mass-imports the entries into the account store via the BrowserLoginManager.
 *
 * File format:
 *   [
 *     { "providerId": "qwen", "email": "user1@example.com", "password": "secret" },
 *     { "providerId": "kimi", "token": "eyJhbGc..." },
 *     { "providerId": "deepseek", "token": "abc...", "name": "work acct" }
 *   ]
 *
 * Behavior:
 *   - On app startup, `autoImportAccounts()` is called by handlers.ts. If
 *     the file doesn't exist, it's a no-op.
 *   - The IPC handler `config:importAccounts` re-runs the import on demand
 *     (e.g. when the user clicks "Re-import accounts" in the UI).
 *   - Idempotent: accounts with the same providerId + email (or providerId +
 *     token) are skipped.
 */

import { ipcMain } from 'electron'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IpcChannels } from '../ipc/channels'
import { browserLoginManager } from './browserLoginManager'
import { storeManager } from '../store/store'

interface ImportEntry {
  providerId: string
  token?: string
  email?: string
  password?: string
  name?: string
}

interface ImportResult {
  ok: boolean
  imported: number
  failed: number
  skipped: number
  errors: string[]
  missingFields: string[]
}

/**
 * Resolve the path to `accounts.json` in the project root.
 *
 * Walks up from this file's location (compiled or source) looking for a
 * directory containing `package.json`. Falls back to `process.cwd()` if the
 * walk fails.
 */
function resolveAccountsJsonPath(): string {
  // Try a few candidate locations — in development the file sits next to
  // package.json at the project root; in a packaged build it may be in the
  // resources directory.
  const candidates: string[] = []

  // 1) Try process.cwd() — works for `bun start` and `electron .`
  candidates.push(join(process.cwd(), 'accounts.json'))

  // 2) Try walking up from this file's location (works in compiled output
  //    where __dirname is somewhere under out/main/proxy/).
  try {
    let here: string
    try {
      // __dirname is available in CJS
      here = resolvePath(__dirname)
    } catch {
      // ESM fallback
      here = dirname(fileURLToPath(import.meta.url))
    }
    let dir = here
    for (let i = 0; i < 10; i++) {
      candidates.push(join(dir, 'accounts.json'))
      if (existsSync(join(dir, 'package.json'))) {
        candidates.push(join(dir, 'accounts.json'))
        break
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* ignore */
  }

  // Return the first candidate that exists; if none exist, return the
  // process.cwd() candidate (callers check existence before reading).
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

/**
 * Read accounts.json from the project root and mass-import its entries
 * into the account store via BrowserLoginManager. Idempotent — existing
 * accounts (matched by providerId + email or providerId + token) are skipped.
 */
export async function autoImportAccounts(): Promise<ImportResult> {
  const path = resolveAccountsJsonPath()
  if (!existsSync(path)) {
    return {
      ok: true,
      imported: 0,
      failed: 0,
      skipped: 0,
      errors: [],
      missingFields: [`accounts.json not found at ${path}`],
    }
  }

  let entries: ImportEntry[] = []
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        imported: 0,
        failed: 0,
        skipped: 0,
        errors: ['accounts.json must be a JSON array'],
        missingFields: [],
      }
    }
    entries = parsed
  } catch (err: any) {
    return {
      ok: false,
      imported: 0,
      failed: 0,
      skipped: 0,
      errors: [`failed to parse accounts.json: ${err?.message || err}`],
      missingFields: [],
    }
  }

  // Filter out entries that already exist (matched by providerId + email or
  // providerId + token).
  const toImport: ImportEntry[] = []
  let skipped = 0
  const missingFields: string[] = []
  for (const entry of entries) {
    if (!entry.providerId) {
      missingFields.push('entry missing providerId')
      continue
    }
    if (!entry.token && !entry.email) {
      missingFields.push(`${entry.providerId}: entry missing token or email`)
      continue
    }
    if (entry.token && accountExistsByToken(entry.providerId, entry.token)) {
      skipped++
      continue
    }
    if (entry.email && accountExistsByEmail(entry.providerId, entry.email)) {
      skipped++
      continue
    }
    toImport.push(entry)
  }

  if (toImport.length === 0) {
    return {
      ok: true,
      imported: 0,
      failed: 0,
      skipped,
      errors: [],
      missingFields,
    }
  }

  // Delegate to BrowserLoginManager.massImport which handles the per-entry
  // save + kicks off background email/password logins.
  try {
    const result = await browserLoginManager.massImport(toImport)
    return {
      ok: result.failed === 0,
      imported: result.success,
      failed: result.failed,
      skipped,
      errors: result.errors,
      missingFields,
    }
  } catch (err: any) {
    return {
      ok: false,
      imported: 0,
      failed: toImport.length,
      skipped,
      errors: [err?.message || 'massImport threw'],
      missingFields,
    }
  }
}

function accountExistsByToken(providerId: string, token: string): boolean {
  try {
    const accounts = storeManager.getAccountsByProviderId(providerId, true)
    return accounts.some((a) => {
      const c = (a.credentials || {}) as Record<string, any>
      return c.token === token
    })
  } catch {
    return false
  }
}

function accountExistsByEmail(providerId: string, email: string): boolean {
  try {
    const accounts = storeManager.getAccountsByProviderId(providerId, true)
    return accounts.some((a) => a.email === email)
  } catch {
    return false
  }
}

/**
 * Register the `config:importAccounts` IPC handler. Safe to call multiple
 * times — ipcMain.handle dedupes by channel name.
 */
export function registerConfigImporterHandlers(): void {
  ipcMain.handle(IpcChannels.CONFIG_IMPORT_ACCOUNTS, async (): Promise<ImportResult> => {
    try {
      return await autoImportAccounts()
    } catch (err: any) {
      return {
        ok: false,
        imported: 0,
        failed: 0,
        skipped: 0,
        errors: [err?.message || 'config:importAccounts threw'],
        missingFields: [],
      }
    }
  })
}
