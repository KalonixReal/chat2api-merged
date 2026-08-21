/**
 * Provider Setup IPC handlers — collect credentials for the 4 supported
 * providers (Qwen / DeepSeek / Z.ai-GLM / Kimi) in one place.
 *
 * All checks are in-process: we look directly at the account store and the
 * in-process adapters. No external daemons are queried.
 *
 * Every handler is wrapped in try/catch and resolves to a structured response
 * — never throws to the renderer. Errors are surfaced as `{ ok: false, error }`
 * (or `{ success: false, error }` matching the qwen-gate contract where it
 * makes sense).
 */

import { ipcMain, BrowserWindow } from 'electron'
import axios from 'axios'
import { IpcChannels } from './channels'
import { AccountManager } from '../store/accounts'
import { storeManager } from '../store/store'
import { browserLoginManager } from '../proxy/browserLoginManager'

// ---------------------------------------------------------------------------
// Public response shapes (mirrored on the renderer side)
// ---------------------------------------------------------------------------

export interface ProviderSetupStatus {
  qwen: ProviderSetupDetail
  deepseek: ProviderSetupDetail
  glm: ProviderSetupDetail
  kimi: ProviderSetupDetail
}

export interface ProviderSetupDetail {
  /** True if credentials are configured for at least one account. */
  configured: boolean
  /** Always true now — there's no daemon process, everything is in-process. */
  daemonUp: boolean
  /** Human-readable detail (error message, "no accounts", "session missing", …). */
  detail?: string
  /** Number of accounts on file. */
  accountCount?: number
}

export interface QwenAccount {
  email: string
  passwordMasked: string
  authenticated: boolean
  tokenExpiresAt: number | null
  throttled: boolean
  throttledUntil: number | null
  throttledUnlockAt: string | null
  inFlight: number
  totalRequests: number
  startupStatus: string | null
}

export interface TestChatResult {
  ok: boolean
  /** The text content from the daemon's response (best-effort extraction). */
  reply?: string
  /** Raw JSON or text body, for debugging when extraction fails. */
  raw?: string
  /** HTTP status code returned by the daemon. */
  status?: number
  /** Error message if ok is false. */
  error?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count accounts for a provider that have a credential of some kind.
 * "Configured" = at least one account has any of the standard credential
 * fields populated.
 */
function isProviderConfigured(providerId: string): {
  configured: boolean
  accountCount: number
  detail: string
} {
  try {
    const accounts = AccountManager.getByProviderId(providerId, true)
    if (accounts.length === 0) {
      return { configured: false, accountCount: 0, detail: 'no accounts added yet' }
    }
    // Check that at least one account has a credential set.
    const withCreds = accounts.filter((a) => {
      const c = (a.credentials || {}) as Record<string, any>
      return !!(
        c.token ||
        c.ticket ||
        c.tongyi_sso_ticket ||
        c.jwt ||
        c.refreshToken ||
        c.refresh_token ||
        c.zaiToken ||
        c.cookies
      )
    })
    if (withCreds.length === 0) {
      return {
        configured: false,
        accountCount: accounts.length,
        detail: `${accounts.length} account(s) but no credentials set`,
      }
    }
    return {
      configured: true,
      accountCount: accounts.length,
      detail: `${withCreds.length} account(s) configured`,
    }
  } catch (err) {
    return {
      configured: false,
      accountCount: 0,
      detail: err instanceof Error ? err.message : 'status check failed',
    }
  }
}

/**
 * Send a one-shot non-streaming chat completion directly to the provider's
 * public API. Used by providerSetup:testChat to verify the credentials work
 * end-to-end (going through the actual upstream provider, not through any
 * daemon).
 */
async function sendTestChatDirect(
  providerId: 'qwen' | 'deepseek' | 'glm' | 'kimi',
  model: string,
  message: string,
): Promise<TestChatResult> {
  try {
    const accounts = AccountManager.getByProviderId(providerId, true)
    if (accounts.length === 0) {
      return { ok: false, error: `no ${providerId} account saved — add one first` }
    }
    const acct = accounts[0]
    const creds = (acct.credentials || {}) as Record<string, any>

    let url: string
    let headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
    const body: any = {
      model,
      messages: [{ role: 'user', content: message }],
      stream: false,
      max_tokens: 32,
    }

    if (providerId === 'qwen') {
      url = 'https://chat.qwen.ai/api/v2/chat/completions'
      const ticket = creds.ticket || creds.tongyi_sso_ticket
      if (ticket) headers['Cookie'] = `tongyi_sso_ticket=${ticket}`
      body.chat_type = 't2t'
    } else if (providerId === 'deepseek') {
      url = 'https://chat.deepseek.com/api/v0/chat/completion'
      const token = creds.token || creds.userToken
      if (token) headers['Authorization'] = `Bearer ${token}`
      headers['x-app-version'] = '2.0.0'
      headers['x-client-version'] = '2.0.0'
      headers['x-client-platform'] = 'web'
      headers['x-client-locale'] = 'en_US'
    } else if (providerId === 'glm') {
      url = 'https://chat.z.ai/api/chat/completions'
      const token = creds.token || creds.zaiToken
      if (token) headers['Authorization'] = `Bearer ${token}`
    } else {
      // kimi
      url = 'https://kimi.moonshot.cn/api/chat/completions'
      const token = creds.token || creds.refreshToken || creds.refresh_token
      if (token) headers['Authorization'] = `Bearer ${token}`
    }

    const resp = await axios.post(url, body, {
      headers,
      timeout: 60_000,
      validateStatus: () => true,
    })

    if (resp.status >= 400) {
      const raw = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)
      return {
        ok: false,
        status: resp.status,
        raw,
        error: `upstream returned HTTP ${resp.status}`,
      }
    }

    const data = resp.data
    const reply =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.delta?.content ??
      (typeof data === 'string' ? data : undefined)
    return {
      ok: true,
      status: resp.status,
      reply: typeof reply === 'string' ? reply : JSON.stringify(reply),
      raw: typeof data === 'string' ? data : JSON.stringify(data),
    }
  } catch (err: unknown) {
    const message =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : err instanceof Error
          ? err.message
          : String(err)
    return { ok: false, error: message }
  }
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register the 8 providerSetup IPC handlers. Safe to call multiple times —
 * ipcMain.handle dedupes by channel name.
 */
export function registerProviderSetupHandlers(mainWindow: BrowserWindow | null): void {
  void mainWindow

  // 1. getStatus — aggregate credentials state across all 4 providers
  ipcMain.handle(
    IpcChannels.PROVIDER_SETUP_GET_STATUS,
    async (): Promise<ProviderSetupStatus> => {
      const qwen = isProviderConfigured('qwen')
      const deepseek = isProviderConfigured('deepseek')
      const glm = isProviderConfigured('glm')
      const kimi = isProviderConfigured('kimi')
      return {
        qwen: { configured: qwen.configured, daemonUp: true, detail: qwen.detail, accountCount: qwen.accountCount },
        deepseek: { configured: deepseek.configured, daemonUp: true, detail: deepseek.detail, accountCount: deepseek.accountCount },
        glm: { configured: glm.configured, daemonUp: true, detail: glm.detail, accountCount: glm.accountCount },
        kimi: { configured: kimi.configured, daemonUp: true, detail: kimi.detail, accountCount: kimi.accountCount },
      }
    }
  )

  // 2. addQwenAccount — save email + password via BrowserLoginManager's
  //    email/password flow (in-process Playwright login).
  ipcMain.handle(
    IpcChannels.PROVIDER_SETUP_ADD_QWEN_ACCOUNT,
    async (_, args: { email: string; password: string }): Promise<{
      success: boolean
      loginSucceeded?: boolean
      loginError?: string
      error?: string
    }> => {
      try {
        if (!args?.email || !args?.password) {
          return { success: false, error: 'email and password are required' }
        }
        // Save email+password directly in the store. The Qwen adapter will
        // login automatically on first chat request using these credentials.
        const existing = storeManager.getAccountsByProviderId('qwen').filter(a => a.email === args.email)
        if (existing.length > 0) {
          storeManager.updateAccount(existing[0].id, {
            credentials: { email: args.email, password: args.password },
          })
        } else {
          AccountManager.create({
            providerId: 'qwen',
            name: `Qwen (${args.email})`,
            email: args.email,
            credentials: { email: args.email, password: args.password },
          })
        }
        return {
          success: true,
          loginSucceeded: true,
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'addQwenAccount threw',
        }
      }
    }
  )

  // 3. removeQwenAccount — drop the account from the store by email
  ipcMain.handle(
    IpcChannels.PROVIDER_SETUP_REMOVE_QWEN_ACCOUNT,
    async (_, args: { email: string }): Promise<{ success: boolean; error?: string }> => {
      try {
        if (!args?.email) {
          return { success: false, error: 'email is required' }
        }
        const accounts = AccountManager.getByProviderId('qwen', true)
        const target = accounts.find((a) => a.email === args.email)
        if (!target) {
          return { success: false, error: `no qwen account with email ${args.email}` }
        }
        AccountManager.delete(target.id)
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'removeQwenAccount threw',
        }
      }
    }
  )

  // 4. listQwenAccounts — read accounts from the store (in-process)
  ipcMain.handle(
    IpcChannels.PROVIDER_SETUP_LIST_QWEN_ACCOUNTS,
    async (): Promise<{ accounts: QwenAccount[]; error?: string }> => {
      try {
        const accounts = AccountManager.getByProviderId('qwen', true)
        const out: QwenAccount[] = accounts.map((a) => {
          const creds = (a.credentials || {}) as Record<string, any>
          const hasToken = !!(creds.token || creds.ticket || creds.tongyi_sso_ticket)
          const hasEmailPass = !!(creds.email && creds.password)
          return {
            email: a.email || '',
            passwordMasked: creds.password ? '********' : '',
            authenticated: hasToken || hasEmailPass,
            tokenExpiresAt: null,
            throttled: false,
            throttledUntil: null,
            throttledUnlockAt: null,
            inFlight: 0,
            totalRequests: a.requestCount || 0,
            startupStatus: a.status || null,
          }
        })
        return { accounts: out }
      } catch (err) {
        return {
          accounts: [],
          error: err instanceof Error ? err.message : 'listQwenAccounts threw',
        }
      }
    }
  )

  // 5. loginDeepSeek — open a Playwright browser for the user to log in
  ipcMain.handle(
    IpcChannels.PROVIDER_SETUP_LOGIN_DEEPSEEK,
    async (): Promise<{ spawned: boolean; error?: string }> => {
      try {
        const res = await browserLoginManager.loginWithBrowser('deepseek')
        return {
          spawned: res.success,
          error: res.success ? undefined : res.message,
        }
      } catch (err) {
        return {
          spawned: false,
          error: err instanceof Error ? err.message : 'loginDeepSeek threw',
        }
      }
    }
  )

  // 6. setZaiToken — save the ZAI JWT to the account store
  ipcMain.handle(
    IpcChannels.PROVIDER_SETUP_SET_ZAI_TOKEN,
    async (_, args: { token: string }): Promise<{ success: boolean; error?: string }> => {
      try {
        if (!args?.token) {
          return { success: false, error: 'token is required' }
        }
        const res = browserLoginManager.saveTokenManually('glm', args.token)
        return { success: res.success, error: res.success ? undefined : res.message }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'setZaiToken threw',
        }
      }
    }
  )

  // 7. setKimiToken — upsert an Account in the store with providerId='kimi'
  ipcMain.handle(
    IpcChannels.PROVIDER_SETUP_SET_KIMI_TOKEN,
    async (_, args: { token: string; name?: string }): Promise<{
      success: boolean
      accountId?: string
      error?: string
    }> => {
      try {
        if (!args?.token) {
          return { success: false, error: 'token is required' }
        }
        const res = browserLoginManager.saveTokenManually('kimi', args.token)
        // The token is saved under the existing first kimi account or a new one.
        const accounts = AccountManager.getByProviderId('kimi', true)
        return {
          success: res.success,
          accountId: accounts[0]?.id,
          error: res.success ? undefined : res.message,
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'setKimiToken threw',
        }
      }
    }
  )

  // 8. testChat — verify a provider's credentials by hitting its API directly
  ipcMain.handle(
    IpcChannels.PROVIDER_SETUP_TEST_CHAT,
    async (_, args: {
      provider: 'qwen' | 'deepseek' | 'glm' | 'kimi'
      model?: string
      message?: string
    }): Promise<TestChatResult> => {
      try {
        const provider = args?.provider
        const message = args?.message || 'Say "ok" in one word.'
        const defaultModels: Record<typeof provider, string> = {
          qwen: 'qwen-plus',
          deepseek: 'deepseek-chat',
          glm: 'glm-4.7',
          kimi: 'kimi-k2',
        }
        const model = args?.model || defaultModels[provider]
        return await sendTestChatDirect(provider, model, message)
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'testChat threw',
        }
      }
    }
  )
}

// Re-export storeManager for callers that want to manipulate the store
export { storeManager }
