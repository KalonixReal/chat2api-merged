/**
 * BrowserLoginManager — Playwright-based login for ALL providers.
 *
 * Supports TWO login methods per provider:
 *   1. Browser login (Playwright opens a browser, user logs in, token captured automatically)
 *   2. Token/cookie paste (user pastes a token they obtained manually)
 *
 * For Qwen (China), also supports email/password login via qwengate API.
 *
 * After login, the token is saved to the account store with proper id/status
 * via AccountManager.create().
 */

import { chromium, type Browser, type Page } from 'playwright'
import { storeManager } from '../store/store'
import { AccountManager } from '../store/accounts'
import axios from 'axios'

interface ProviderLoginConfig {
  url: string
  label: string
  cookieNames: string[]
  localStorageKeys: string[]
  providerId: string
  accountName: string
  supportsEmailPassword: boolean
  emailPasswordUrl?: string
}

const PROVIDER_CONFIGS: Record<string, ProviderLoginConfig> = {
  qwen: {
    url: 'https://chat.qwen.ai/',
    label: 'Qwen (China)',
    cookieNames: ['tongyi_sso_ticket'],
    localStorageKeys: [],
    providerId: 'qwen',
    accountName: 'Qwen Browser Login',
    supportsEmailPassword: true,
    emailPasswordUrl: 'http://localhost:26405/api/accounts',
  },
  'qwen-ai': {
    url: 'https://chat.qwen.ai/',
    label: 'Qwen AI (International)',
    cookieNames: [],
    localStorageKeys: ['token'],
    providerId: 'qwen-ai',
    accountName: 'Qwen AI Browser Login',
    supportsEmailPassword: false,
  },
  deepseek: {
    url: 'https://chat.deepseek.com/sign_in',
    label: 'DeepSeek',
    cookieNames: [],
    localStorageKeys: ['userToken', 'token'],
    providerId: 'deepseek',
    accountName: 'DeepSeek Browser Login',
    supportsEmailPassword: false,
  },
  glm: {
    url: 'https://chat.z.ai/',
    label: 'Z.ai (GLM)',
    cookieNames: [],
    localStorageKeys: ['token'],
    providerId: 'glm',
    accountName: 'Z.ai Browser Login',
    supportsEmailPassword: false,
  },
  zai: {
    url: 'https://chat.z.ai/',
    label: 'Z.ai',
    cookieNames: [],
    localStorageKeys: ['token'],
    providerId: 'zai',
    accountName: 'Z.ai Browser Login',
    supportsEmailPassword: false,
  },
  kimi: {
    url: 'https://kimi.com/',
    label: 'Kimi',
    cookieNames: ['refresh_token'],
    localStorageKeys: ['token', 'refresh_token'],
    providerId: 'kimi',
    accountName: 'Kimi Browser Login',
    supportsEmailPassword: false,
  },
}

export class BrowserLoginManager {
  private browser: Browser | null = null

  /**
   * Open a browser window for the user to log in to a provider.
   * After login, captures the token and saves it to the account store.
   */
  async loginWithBrowser(providerId: string): Promise<{
    success: boolean
    token?: string
    message: string
  }> {
    const config = PROVIDER_CONFIGS[providerId]
    if (!config) {
      return { success: false, message: `Unknown provider: ${providerId}` }
    }

    try {
      if (!this.browser) {
        this.browser = await chromium.launch({
          headless: false,
          args: ['--disable-blink-features=AutomationControlled'],
        })
      }

      const context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      })
      const page = await context.newPage()

      console.log(`[BrowserLogin] Opening ${config.label} login page: ${config.url}`)
      await page.goto(config.url, { waitUntil: 'networkidle', timeout: 60000 })

      // Wait up to 5 minutes for the user to log in
      const maxWaitMs = 5 * 60 * 1000
      const pollIntervalMs = 2000
      const startTime = Date.now()
      let token: string | null = null

      while (Date.now() - startTime < maxWaitMs) {
        if (page.isClosed()) {
          return { success: false, message: 'Browser closed by user' }
        }

        // Try cookies
        if (config.cookieNames.length > 0) {
          const cookies = await context.cookies()
          for (const cookieName of config.cookieNames) {
            const cookie = cookies.find((c) => c.name === cookieName)
            if (cookie && cookie.value) {
              token = cookie.value
              break
            }
          }
        }

        // Try localStorage
        if (!token && config.localStorageKeys.length > 0) {
          for (const key of config.localStorageKeys) {
            try {
              const value = await page.evaluate((k) => localStorage.getItem(k), key)
              if (value && value.length > 10) {
                token = value
                break
              }
            } catch {}
          }
        }

        if (token) break
        await new Promise((r) => setTimeout(r, pollIntervalMs))
      }

      await context.close()

      if (!token) {
        return { success: false, message: 'Login timed out (5 minutes).' }
      }

      // Save token
      this.saveToken(config, token)
      return {
        success: true,
        token,
        message: `${config.label} login successful! Token captured and saved.`,
      }
    } catch (err: any) {
      return { success: false, message: `Browser login failed: ${err?.message}` }
    }
  }

  /**
   * Save a token/cookie directly (user pastes it manually).
   * Works for ALL providers.
   */
  saveTokenManually(providerId: string, token: string): {
    success: boolean
    message: string
  } {
    const config = PROVIDER_CONFIGS[providerId]
    if (!config) {
      return { success: false, message: `Unknown provider: ${providerId}` }
    }
    if (!token || token.length < 10) {
      return { success: false, message: 'Token is too short or empty' }
    }
    try {
      this.saveToken(config, token)
      return { success: true, message: `${config.label} token saved` }
    } catch (err: any) {
      return { success: false, message: err?.message || 'Failed to save token' }
    }
  }

  /**
   * Email/password login (Qwen only — uses qwengate API).
   */
  async loginWithEmailPassword(
    providerId: string,
    email: string,
    password: string,
  ): Promise<{ success: boolean; message: string }> {
    const config = PROVIDER_CONFIGS[providerId]
    if (!config || !config.supportsEmailPassword) {
      return { success: false, message: `Email/password login not supported for ${providerId}` }
    }
    try {
      const resp = await axios.post(
        config.emailPasswordUrl!,
        { email, password },
        { timeout: 60000, validateStatus: () => true },
      )
      if (resp.data?.loginSucceeded || resp.status < 400) {
        return { success: true, message: 'Login successful' }
      }
      return {
        success: false,
        message: resp.data?.loginError || 'Login failed',
      }
    } catch (err: any) {
      return { success: false, message: err?.message || 'Login failed' }
    }
  }

  /**
   * Mass import accounts from JSON.
   * Format: [{ providerId, token, email?, name? }, ...]
   */
  massImport(accounts: Array<{
    providerId: string
    token: string
    email?: string
    name?: string
  }>): { success: number; failed: number; errors: string[] } {
    let success = 0
    let failed = 0
    const errors: string[] = []

    for (const acct of accounts) {
      const config = PROVIDER_CONFIGS[acct.providerId]
      if (!config) {
        failed++
        errors.push(`Unknown provider: ${acct.providerId}`)
        continue
      }
      if (!acct.token || acct.token.length < 10) {
        failed++
        errors.push(`Invalid token for ${acct.providerId}`)
        continue
      }
      try {
        this.saveToken(config, acct.token, acct.name, acct.email)
        success++
      } catch (err: any) {
        failed++
        errors.push(`${acct.providerId}: ${err?.message || 'unknown error'}`)
      }
    }

    return { success, failed, errors }
  }

  /** Get all supported providers and their login methods. */
  getProviders(): Array<{
    id: string
    label: string
    url: string
    supportsBrowser: boolean
    supportsToken: boolean
    supportsEmailPassword: boolean
    tokenLocation: string
  }> {
    return Object.entries(PROVIDER_CONFIGS).map(([id, config]) => {
      const tokenLocation = config.cookieNames.length > 0
        ? 'Cookie: ' + config.cookieNames.join(', ')
        : 'localStorage: ' + config.localStorageKeys.join(', ')
      return {
        id,
        label: config.label,
        url: config.url,
        supportsBrowser: true,
        supportsToken: true,
        supportsEmailPassword: config.supportsEmailPassword,
        tokenLocation,
      }
    })
  }

  /** Internal: save a token to the account store. */
  private saveToken(
    config: ProviderLoginConfig,
    token: string,
    name?: string,
    email?: string,
  ): void {
    const existing = storeManager.getAccountsByProviderId(config.providerId)
    if (existing.length > 0) {
      storeManager.updateAccount(existing[0].id, {
        credentials: { ...existing[0].credentials, token },
      })
    } else {
      AccountManager.create({
        providerId: config.providerId,
        name: name || config.accountName,
        email,
        credentials: { token },
      })
    }
    console.log(`[BrowserLogin] Token saved for ${config.providerId}`)
  }

  async close(): Promise<void> {
    if (this.browser) {
      try { await this.browser.close() } catch {}
      this.browser = null
    }
  }
}

export const browserLoginManager = new BrowserLoginManager()
