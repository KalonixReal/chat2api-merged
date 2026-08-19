/**
 * BrowserLoginManager — Playwright-based login for ALL providers.
 * Supports: Browser Login, Token Paste, Email+Password (ALL providers), Mass Import.
 */
import { chromium, type Browser } from 'playwright'
import { storeManager } from '../store/store'
import { AccountManager } from '../store/accounts'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

interface ProviderConfig {
  url: string; label: string; cookieNames: string[]; localStorageKeys: string[]
  providerId: string; accountName: string
  emailSelector?: string; passwordSelector?: string; submitSelector?: string
}

const CONFIGS: Record<string, ProviderConfig> = {
  qwen: { url: 'https://chat.qwen.ai/', label: 'Qwen', cookieNames: ['tongyi_sso_ticket'], localStorageKeys: [], providerId: 'qwen', accountName: 'Qwen Login', emailSelector: 'input[type="text"], input[type="email"], input[placeholder*="邮箱"], input[placeholder*="email"]', passwordSelector: 'input[type="password"]', submitSelector: 'button[type="submit"], button:has-text("登录"), button:has-text("Sign in")' },
  'qwen-ai': { url: 'https://chat.qwen.ai/', label: 'Qwen AI (International)', cookieNames: [], localStorageKeys: ['token'], providerId: 'qwen-ai', accountName: 'Qwen AI Login', emailSelector: 'input[type="text"], input[type="email"], input[placeholder*="email"]', passwordSelector: 'input[type="password"]', submitSelector: 'button[type="submit"], button:has-text("Sign in"), button:has-text("登录")' },
  deepseek: { url: 'https://chat.deepseek.com/sign_in', label: 'DeepSeek', cookieNames: [], localStorageKeys: ['userToken', 'token'], providerId: 'deepseek', accountName: 'DeepSeek Login', emailSelector: 'input[type="email"], input[placeholder*="email"], input[placeholder*="Email"]', passwordSelector: 'input[type="password"]', submitSelector: 'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")' },
  glm: { url: 'https://chat.z.ai/', label: 'Z.ai (GLM)', cookieNames: [], localStorageKeys: ['token'], providerId: 'glm', accountName: 'Z.ai Login', emailSelector: 'input[type="email"], input[type="text"], input[placeholder*="email"]', passwordSelector: 'input[type="password"]', submitSelector: 'button[type="submit"], button:has-text("Sign in"), button:has-text("登录")' },
  zai: { url: 'https://chat.z.ai/', label: 'Z.ai', cookieNames: [], localStorageKeys: ['token'], providerId: 'zai', accountName: 'Z.ai Login', emailSelector: 'input[type="email"], input[type="text"], input[placeholder*="email"]', passwordSelector: 'input[type="password"]', submitSelector: 'button[type="submit"], button:has-text("Sign in")' },
  kimi: { url: 'https://kimi.com/', label: 'Kimi', cookieNames: ['refresh_token'], localStorageKeys: ['token', 'refresh_token'], providerId: 'kimi', accountName: 'Kimi Login', emailSelector: 'input[type="text"], input[type="tel"], input[placeholder*="手机"], input[placeholder*="phone"], input[placeholder*="email"]', passwordSelector: 'input[type="password"]', submitSelector: 'button[type="submit"], button:has-text("登录"), button:has-text("Login")' },
}

export class BrowserLoginManager {
  private browser: Browser | null = null

  async loginWithBrowser(providerId: string): Promise<{ success: boolean; token?: string; message: string }> {
    const cfg = CONFIGS[providerId]
    if (!cfg) return { success: false, message: `Unknown provider: ${providerId}` }
    try {
      if (!this.browser) this.browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] })
      const ctx = await this.browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
      const page = await ctx.newPage()
      await page.goto(cfg.url, { waitUntil: 'networkidle', timeout: 60000 })
      const token = await this.captureToken(ctx, page, cfg, 300000)
      await ctx.close()
      if (!token) return { success: false, message: 'Login timed out (5 min).' }
      this.saveToken(cfg, token)
      return { success: true, token, message: `${cfg.label} login successful!` }
    } catch (err: any) { return { success: false, message: `Browser login failed: ${err?.message}` } }
  }

  async loginWithEmailPassword(providerId: string, email: string, password: string): Promise<{ success: boolean; message: string }> {
    const cfg = CONFIGS[providerId]
    if (!cfg) return { success: false, message: `Unknown provider: ${providerId}` }
    if (!cfg.emailSelector || !cfg.passwordSelector || !cfg.submitSelector) return { success: false, message: `Email/password not supported for ${providerId}` }
    try {
      if (!this.browser) this.browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] })
      const ctx = await this.browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
      const page = await ctx.newPage()
      await page.goto(cfg.url, { waitUntil: 'networkidle', timeout: 60000 })
      // Fill email
      const emailEl = await page.locator(cfg.emailSelector).first()
      await emailEl.waitFor({ timeout: 10000 })
      await emailEl.fill(email)
      // Fill password
      await page.locator(cfg.passwordSelector).first().fill(password)
      // Click submit
      await page.locator(cfg.submitSelector).first().click()
      // Wait for token to appear
      const token = await this.captureToken(ctx, page, cfg, 120000)
      await ctx.close()
      if (!token) return { success: false, message: 'Login failed - token not captured. Check credentials or solve CAPTCHA manually.' }
      this.saveToken(cfg, token)
      return { success: true, message: `${cfg.label} login successful! Token captured.` }
    } catch (err: any) { return { success: false, message: `Email/password login failed: ${err?.message}` } }
  }

  saveTokenManually(providerId: string, token: string): { success: boolean; message: string } {
    const cfg = CONFIGS[providerId]
    if (!cfg) return { success: false, message: `Unknown provider: ${providerId}` }
    if (!token || token.length < 10) return { success: false, message: 'Token too short' }
    try { this.saveToken(cfg, token); return { success: true, message: `${cfg.label} token saved` } }
    catch (err: any) { return { success: false, message: err?.message } }
  }

  massImport(accounts: Array<{ providerId: string; token: string; email?: string; name?: string }>): { success: number; failed: number; errors: string[] } {
    let success = 0, failed = 0; const errors: string[] = []
    for (const acct of accounts) {
      const cfg = CONFIGS[acct.providerId]
      if (!cfg) { failed++; errors.push(`Unknown provider: ${acct.providerId}`); continue }
      if (!acct.token || acct.token.length < 10) { failed++; errors.push(`Invalid token for ${acct.providerId}`); continue }
      try { this.saveToken(cfg, acct.token, acct.name, acct.email); success++ }
      catch (err: any) { failed++; errors.push(`${acct.providerId}: ${err?.message}`) }
    }
    return { success, failed, errors }
  }

  importFromConfigFile(filePath?: string): { success: number; failed: number; errors: string[]; message: string } {
    const path = filePath || join(process.cwd(), 'accounts.json')
    if (!existsSync(path)) return { success: 0, failed: 0, errors: ['File not found'], message: `Config file not found: ${path}` }
    try {
      const raw = readFileSync(path, 'utf-8')
      const accounts = JSON.parse(raw)
      if (!Array.isArray(accounts)) return { success: 0, failed: 0, errors: ['Not an array'], message: 'Config file must contain a JSON array' }
      const result = this.massImport(accounts)
      return { ...result, message: `Imported ${result.success} accounts, ${result.failed} failed` }
    } catch (err: any) { return { success: 0, failed: 0, errors: [err.message], message: `Failed to read config: ${err.message}` } }
  }

  getProviders() {
    return Object.entries(CONFIGS).map(([id, cfg]) => ({
      id, label: cfg.label, url: cfg.url,
      supportsBrowser: true, supportsToken: true, supportsEmailPassword: !!cfg.emailSelector,
      tokenLocation: cfg.cookieNames.length > 0 ? 'Cookie: ' + cfg.cookieNames.join(', ') : 'localStorage: ' + cfg.localStorageKeys.join(', '),
    }))
  }

  private async captureToken(ctx: any, page: any, cfg: ProviderConfig, maxWaitMs: number): Promise<string | null> {
    const start = Date.now()
    while (Date.now() - start < maxWaitMs) {
      if (page.isClosed()) return null
      // Check cookies
      if (cfg.cookieNames.length > 0) {
        const cookies = await ctx.cookies()
        for (const name of cfg.cookieNames) {
          const c = cookies.find((x: any) => x.name === name)
          if (c?.value) return c.value
        }
      }
      // Check localStorage
      if (cfg.localStorageKeys.length > 0) {
        for (const key of cfg.localStorageKeys) {
          try {
            const val = await page.evaluate((k: string) => localStorage.getItem(k), key)
            if (val && val.length > 10) return val
          } catch {}
        }
      }
      await new Promise(r => setTimeout(r, 2000))
    }
    return null
  }

  private saveToken(cfg: ProviderConfig, token: string, name?: string, email?: string): void {
    const existing = storeManager.getAccountsByProviderId(cfg.providerId)
    if (existing.length > 0) {
      storeManager.updateAccount(existing[0].id, { credentials: { ...existing[0].credentials, token } })
    } else {
      AccountManager.create({ providerId: cfg.providerId, name: name || cfg.accountName, email, credentials: { token } })
    }
  }

  async close(): Promise<void> { if (this.browser) { try { await this.browser.close() } catch {} ; this.browser = null } }
}

export const browserLoginManager = new BrowserLoginManager()
