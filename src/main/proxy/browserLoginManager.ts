/**
 * BrowserLoginManager — Playwright-based login for ALL providers.
 *
 * Opens a real browser window to the provider's login page. The user logs in
 * manually (solving any CAPTCHAs). After login, Playwright captures the
 * session cookies/localStorage and saves the token to the account store.
 *
 * This replaces the old "paste your token" approach with a seamless
 * qwengate-style login experience.
 */

import { chromium, type Browser, type Page } from 'playwright'
import { storeManager } from '../store/store'
import { AccountManager } from '../store/accounts'

interface ProviderLoginConfig {
  url: string
  label: string
  // After login, we look for the token in these locations (in order)
  cookieNames?: string[]
  localStorageKeys?: string[]
  // The URL pattern that indicates login is complete (redirect after login)
  successUrlPattern?: string
  // How to save the captured token
  providerId: string
  accountName: string
}

const PROVIDER_CONFIGS: Record<string, ProviderLoginConfig> = {
  qwen: {
    url: 'https://chat.qwen.ai/',
    label: 'Qwen (China)',
    cookieNames: ['tongyi_sso_ticket'],
    localStorageKeys: [],
    successUrlPattern: 'chat.qwen.ai',
    providerId: 'qwen',
    accountName: 'Qwen Browser Login',
  },
  'qwen-ai': {
    url: 'https://chat.qwen.ai/',
    label: 'Qwen AI (International)',
    cookieNames: [],
    localStorageKeys: ['token'],
    successUrlPattern: 'chat.qwen.ai',
    providerId: 'qwen-ai',
    accountName: 'Qwen AI Browser Login',
  },
  deepseek: {
    url: 'https://chat.deepseek.com/sign_in',
    label: 'DeepSeek',
    cookieNames: [],
    localStorageKeys: ['userToken', 'token'],
    successUrlPattern: 'chat.deepseek.com',
    providerId: 'deepseek',
    accountName: 'DeepSeek Browser Login',
  },
  glm: {
    url: 'https://chat.z.ai/',
    label: 'Z.ai (GLM)',
    cookieNames: [],
    localStorageKeys: ['token'],
    successUrlPattern: 'chat.z.ai',
    providerId: 'glm',
    accountName: 'Z.ai Browser Login',
  },
  zai: {
    url: 'https://chat.z.ai/',
    label: 'Z.ai',
    cookieNames: [],
    localStorageKeys: ['token'],
    successUrlPattern: 'chat.z.ai',
    providerId: 'zai',
    accountName: 'Z.ai Browser Login',
  },
  kimi: {
    url: 'https://kimi.com/',
    label: 'Kimi',
    cookieNames: ['refresh_token'],
    localStorageKeys: ['token', 'refresh_token'],
    successUrlPattern: 'kimi.com',
    providerId: 'kimi',
    accountName: 'Kimi Browser Login',
  },
}

export class BrowserLoginManager {
  private browser: Browser | null = null

  /**
   * Open a browser window for the user to log in to a provider.
   * After login, captures the token and saves it to the account store.
   * Returns the captured token (or null if login failed/cancelled).
   */
  async loginWithProvider(providerId: string): Promise<{
    success: boolean
    token?: string
    message: string
  }> {
    const config = PROVIDER_CONFIGS[providerId]
    if (!config) {
      return { success: false, message: `Unknown provider: ${providerId}` }
    }

    try {
      // Launch browser (visible to the user)
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

      // Wait for the user to log in. We poll for the token to appear.
      // Give the user up to 5 minutes to solve CAPTCHAs + log in.
      const maxWaitMs = 5 * 60 * 1000
      const pollIntervalMs = 2000
      const startTime = Date.now()

      let token: string | null = null

      while (Date.now() - startTime < maxWaitMs) {
        // Check if the browser/page was closed by the user
        if (page.isClosed()) {
          return { success: false, message: 'Browser closed by user' }
        }

        // Try to capture token from cookies
        if (config.cookieNames && config.cookieNames.length > 0) {
          const cookies = await context.cookies()
          for (const cookieName of config.cookieNames) {
            const cookie = cookies.find((c) => c.name === cookieName)
            if (cookie && cookie.value) {
              token = cookie.value
              console.log(`[BrowserLogin] Found token in cookie: ${cookieName}`)
              break
            }
          }
        }

        // Try to capture token from localStorage
        if (!token && config.localStorageKeys && config.localStorageKeys.length > 0) {
          for (const key of config.localStorageKeys) {
            try {
              const value = await page.evaluate(
                (k) => localStorage.getItem(k),
                key,
              )
              if (value && value.length > 10) {
                token = value
                console.log(`[BrowserLogin] Found token in localStorage: ${key}`)
                break
              }
            } catch {
              // localStorage might not be accessible on some pages
            }
          }
        }

        if (token) {
          break
        }

        await new Promise((r) => setTimeout(r, pollIntervalMs))
      }

      // Clean up
      await context.close()

      if (!token) {
        return {
          success: false,
          message: 'Login timed out (5 minutes). Please try again.',
        }
      }

      // Save the token to the account store
      const existing = storeManager.getAccountsByProviderId(config.providerId)
      if (existing.length > 0) {
        // Update the first account
        storeManager.updateAccount(existing[0].id, {
          credentials: { ...existing[0].credentials, token },
        })
      } else {
        // Create a new account
        AccountManager.create({
          providerId: config.providerId,
          name: config.accountName,
          credentials: { token },
        })
      }

      console.log(`[BrowserLogin] Token saved for ${config.providerId}`)
      return {
        success: true,
        token,
        message: `${config.label} login successful! Token captured and saved.`,
      }
    } catch (err: any) {
      console.error(`[BrowserLogin] Error:`, err?.message)
      return {
        success: false,
        message: `Browser login failed: ${err?.message || 'unknown error'}`,
      }
    }
  }

  /** Close the browser if it's open. */
  async close(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close()
      } catch {}
      this.browser = null
    }
  }
}

export const browserLoginManager = new BrowserLoginManager()
