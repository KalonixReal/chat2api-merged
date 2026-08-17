/**
 * Provider Setup IPC handlers — collect credentials for the 4 vendored
 * standalone daemons (Qwen / DeepSeek / Z.ai-GLM / Kimi) in one place.
 *
 * The handlers proxy to:
 *   - qwen-gate REST API     (http://localhost:26405/api/accounts)
 *   - deepseek-api healthz   (http://localhost:8000/healthz)
 *   - DaemonSupervisor       (env mutation + restart + spawnAuthWindow)
 *   - Chat2API Account store (providerId='kimi')
 *
 * Every handler is wrapped in try/catch and resolves to a structured response
 * — never throws to the renderer. Errors are surfaced as `{ ok: false, error }`
 * (or `{ success: false, error }` matching the qwen-gate contract where it
 * makes sense).
 */

import { ipcMain, BrowserWindow } from 'electron'
import axios from 'axios'
import { IpcChannels } from './channels'
import { daemonSupervisor } from '../supervisor'
import { AccountManager } from '../store/accounts'

// ---------------------------------------------------------------------------
// Daemon endpoint constants
// ---------------------------------------------------------------------------

const QWENGATE_BASE = 'http://localhost:26405'
const DEEPSEEK_BASE = 'http://localhost:8000'
const GLM_BASE = 'http://localhost:3001'
const KIMI_BASE = 'http://localhost:5566'

const QWENGATE_DAEMON_ID = 'qwen-gate'
const DEEPSEEK_DAEMON_ID = 'deepseek-api'
const GLM_DAEMON_ID = 'glm-free-api'
const KIMI_DAEMON_ID = 'kimi-free-api'

const IS_WIN = process.platform === 'win32'
// `.venv/bin/python` on Unix, `.venv/Scripts/python.exe` on Windows —
// matches the path chosen by DaemonSupervisor.DEFAULT_DAEMON_SPECS.
const DEEPSEEK_VENV_PYTHON = IS_WIN
  ? '.venv/Scripts/python.exe'
  : '.venv/bin/python'

// Timeout for HTTP calls to the daemons from the IPC handler. The daemons
// themselves handle upstream slowness; we just want to know if they're up.
const DAEMON_HTTP_TIMEOUT = 5_000

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
  /** True if credentials are configured and the daemon appears reachable. */
  configured: boolean
  /** True if the daemon process is alive (best-effort — used for UI badges). */
  daemonUp: boolean
  /** Human-readable detail (error message, "no accounts", "session missing", …). */
  detail?: string
  /** Number of accounts on file (Qwen + Kimi only). */
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

/** Quick TCP/HTTP liveness check — used by getStatus for each daemon. */
async function isDaemonAlive(baseUrl: string, healthPath: string): Promise<boolean> {
  try {
    const resp = await axios.get(`${baseUrl}${healthPath}`, {
      timeout: DAEMON_HTTP_TIMEOUT,
      validateStatus: () => true,
    })
    return resp.status < 500
  } catch {
    return false
  }
}

/**
 * Send a one-shot non-streaming chat completion to a daemon's OpenAI
 * endpoint. Used by providerSetup:testChat to verify the credentials work
 * end-to-end (through the daemon → upstream provider).
 *
 * We bypass Chat2API's own proxy layer on purpose: the proxy may not be
 * running, may require an API key, and would add a layer that complicates
 * error attribution. Hitting the daemon directly is the truest "does my
 * credential work" check.
 */
async function sendTestChat(
  baseUrl: string,
  model: string,
  message: string,
  bearer: string
): Promise<TestChatResult> {
  try {
    const resp = await axios.post(
      `${baseUrl}/v1/chat/completions`,
      {
        model,
        messages: [{ role: 'user', content: message }],
        stream: false,
        max_tokens: 32,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${bearer}`,
        },
        timeout: 60_000,
        validateStatus: () => true,
      }
    )

    if (resp.status >= 400) {
      const raw = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)
      return {
        ok: false,
        status: resp.status,
        raw,
        error: `daemon returned HTTP ${resp.status}`,
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
  // mainWindow is referenced for parity with other register*Handlers fns —
  // we don't currently need it but future push notifications (e.g. "ZAI_TOKEN
  // applied, daemon restarted") would go through it.
  void mainWindow

  // 1. getStatus — aggregate credentials state across all 4 providers
  ipcMain.handle(
    IpcChannels.PROVIDER_SETUP_GET_STATUS,
    async (): Promise<ProviderSetupStatus> => {
      // Qwen — accounts exist on the qwen-gate daemon?
      let qwen: ProviderSetupDetail = { configured: false, daemonUp: false }
      try {
        const qwenUp = await isDaemonAlive(QWENGATE_BASE, '/health')
        let qwenAccounts = 0
        let qwenDetail = 'daemon unreachable'
        if (qwenUp) {
          try {
            const resp = await axios.get(`${QWENGATE_BASE}/api/accounts`, {
              timeout: DAEMON_HTTP_TIMEOUT,
              validateStatus: () => true,
            })
            if (resp.status < 400 && resp.data?.accounts) {
              qwenAccounts = resp.data.accounts.length
              qwenDetail =
                qwenAccounts > 0
                  ? `${qwenAccounts} account(s) configured`
                  : 'no accounts added yet'
            } else {
              qwenDetail = `qwen-gate returned HTTP ${resp.status}`
            }
          } catch (err) {
            qwenDetail = err instanceof Error ? err.message : 'qwen-gate request failed'
          }
        }
        qwen = {
          configured: qwenAccounts > 0,
          daemonUp: qwenUp,
          accountCount: qwenAccounts,
          detail: qwenDetail,
        }
      } catch (err) {
        qwen = {
          configured: false,
          daemonUp: false,
          detail: err instanceof Error ? err.message : 'qwen status failed',
        }
      }

      // DeepSeek — healthz reachable = session loaded
      let deepseek: ProviderSetupDetail = { configured: false, daemonUp: false }
      try {
        const resp = await axios.get(`${DEEPSEEK_BASE}/healthz`, {
          timeout: DAEMON_HTTP_TIMEOUT,
          validateStatus: () => true,
        })
        const up = resp.status >= 200 && resp.status < 400
        deepseek = {
          configured: up,
          daemonUp: up,
          detail: up ? 'session ready' : `healthz HTTP ${resp.status}`,
        }
      } catch (err) {
        deepseek = {
          configured: false,
          daemonUp: false,
          detail:
            err && typeof err === 'object' && 'code' in err
              ? String((err as { code: unknown }).code)
              : err instanceof Error
                ? err.message
                : 'deepseek unreachable',
        }
      }

      // GLM — ZAI_TOKEN env set on the daemon?
      let glm: ProviderSetupDetail = { configured: false, daemonUp: false }
      try {
        const glmEnv = daemonSupervisor.getDaemonEnv(GLM_DAEMON_ID)
        const hasToken = !!glmEnv.ZAI_TOKEN
        let glmUp = false
        try {
          glmUp = await isDaemonAlive(GLM_BASE, '/v1/models')
        } catch {
          glmUp = false
        }
        glm = {
          configured: hasToken,
          daemonUp: glmUp,
          detail: hasToken
            ? 'ZAI_TOKEN set'
            : 'guest mode only (glm-4.7) — set ZAI_TOKEN for full access',
        }
      } catch (err) {
        glm = {
          configured: false,
          daemonUp: false,
          detail: err instanceof Error ? err.message : 'glm status failed',
        }
      }

      // Kimi — any Account in the store with providerId='kimi'?
      let kimi: ProviderSetupDetail = { configured: false, daemonUp: false }
      try {
        const accounts = AccountManager.getByProviderId('kimi', true)
        let kimiUp = false
        try {
          kimiUp = await isDaemonAlive(KIMI_BASE, '/v1/models')
        } catch {
          kimiUp = false
        }
        kimi = {
          configured: accounts.length > 0,
          daemonUp: kimiUp,
          accountCount: accounts.length,
          detail:
            accounts.length > 0
              ? `${accounts.length} account(s) configured`
              : 'no Kimi account saved yet',
        }
      } catch (err) {
        kimi = {
          configured: false,
          daemonUp: false,
          detail: err instanceof Error ? err.message : 'kimi status failed',
        }
      }

      return { qwen, deepseek, glm, kimi }
    }
  )

  // 2. addQwenAccount — POST email+password to qwen-gate
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
        const resp = await axios.post(
          `${QWENGATE_BASE}/api/accounts`,
          { email: args.email, password: args.password },
          {
            timeout: 60_000,
            validateStatus: () => true,
            headers: { 'Content-Type': 'application/json' },
          }
        )
        if (resp.status >= 400) {
          const msg =
            resp.data?.error?.message ||
            (typeof resp.data === 'string' ? resp.data : `HTTP ${resp.status}`)
          return { success: false, error: msg }
        }
        return {
          success: !!resp.data?.success,
          loginSucceeded: resp.data?.loginSucceeded,
          loginError: resp.data?.loginError,
        }
      } catch (err) {
        const msg =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code: unknown }).code)
            : err instanceof Error
              ? err.message
              : 'qwen-gate unreachable'
        return { success: false, error: msg }
      }
    }
  )

  // 3. removeQwenAccount — DELETE email from qwen-gate
  ipcMain.handle(
    IpcChannels.PROVIDER_SETUP_REMOVE_QWEN_ACCOUNT,
    async (_, args: { email: string }): Promise<{ success: boolean; error?: string }> => {
      try {
        if (!args?.email) {
          return { success: false, error: 'email is required' }
        }
        const resp = await axios.delete(
          `${QWENGATE_BASE}/api/accounts/${encodeURIComponent(args.email)}`,
          { timeout: 15_000, validateStatus: () => true }
        )
        if (resp.status >= 400) {
          const msg =
            resp.data?.error?.message ||
            (typeof resp.data === 'string' ? resp.data : `HTTP ${resp.status}`)
          return { success: false, error: msg }
        }
        return { success: !!resp.data?.success }
      } catch (err) {
        const msg =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code: unknown }).code)
            : err instanceof Error
              ? err.message
              : 'qwen-gate unreachable'
        return { success: false, error: msg }
      }
    }
  )

  // 4. listQwenAccounts — GET /api/accounts
  ipcMain.handle(
    IpcChannels.PROVIDER_SETUP_LIST_QWEN_ACCOUNTS,
    async (): Promise<{ accounts: QwenAccount[]; error?: string }> => {
      try {
        const resp = await axios.get(`${QWENGATE_BASE}/api/accounts`, {
          timeout: DAEMON_HTTP_TIMEOUT,
          validateStatus: () => true,
        })
        if (resp.status >= 400) {
          return {
            accounts: [],
            error:
              resp.data?.error?.message ||
              (typeof resp.data === 'string' ? resp.data : `HTTP ${resp.status}`),
          }
        }
        const accounts: QwenAccount[] = Array.isArray(resp.data?.accounts)
          ? resp.data.accounts
          : []
        return { accounts }
      } catch (err) {
        const msg =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code: unknown }).code)
            : err instanceof Error
              ? err.message
              : 'qwen-gate unreachable'
        return { accounts: [], error: msg }
      }
    }
  )

  // 5. loginDeepSeek — spawn `python -m deepseek.auth` in the venv, detached
  ipcMain.handle(
    IpcChannels.PROVIDER_SETUP_LOGIN_DEEPSEEK,
    async (): Promise<{ spawned: boolean; error?: string }> => {
      try {
        const ok = await daemonSupervisor.spawnAuthWindow(DEEPSEEK_DAEMON_ID, [
          DEEPSEEK_VENV_PYTHON,
          '-m',
          'deepseek.auth',
        ])
        return { spawned: ok, error: ok ? undefined : 'spawn failed — see main log' }
      } catch (err) {
        return {
          spawned: false,
          error: err instanceof Error ? err.message : 'spawn threw',
        }
      }
    }
  )

  // 6. setZaiToken — merge ZAI_TOKEN into glm-free-api env, then restart
  ipcMain.handle(
    IpcChannels.PROVIDER_SETUP_SET_ZAI_TOKEN,
    async (_, args: { token: string }): Promise<{ success: boolean; error?: string }> => {
      try {
        if (!args?.token) {
          return { success: false, error: 'token is required' }
        }
        daemonSupervisor.setDaemonEnv(GLM_DAEMON_ID, { ZAI_TOKEN: args.token })
        const restarted = await daemonSupervisor.restartDaemon(GLM_DAEMON_ID)
        return {
          success: restarted,
          error: restarted ? undefined : 'failed to restart glm-free-api',
        }
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

        const existing = AccountManager.getByProviderId('kimi', true)
        const credentials = { token: args.token }

        if (existing.length > 0) {
          // Update the first kimi account we find — the KimiAdapter forwards
          // requests to the daemon with this token as the Bearer header.
          const acct = existing[0]
          AccountManager.update(acct.id, {
            credentials,
            status: 'active',
            errorMessage: undefined,
            updatedAt: Date.now(),
          })
          return { success: true, accountId: acct.id }
        }

        const created = AccountManager.create({
          providerId: 'kimi',
          name: args.name || 'Kimi (Provider Setup)',
          credentials,
        })
        return { success: true, accountId: created.id }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'setKimiToken threw',
        }
      }
    }
  )

  // 8. testChat — verify a provider's credentials by hitting its daemon
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
          kimi: 'kimi-k2.6',
        }
        const model = args?.model || defaultModels[provider]

        if (provider === 'qwen') {
          // qwen-gate ignores the Bearer token (it manages its own accounts).
          return await sendTestChat(QWENGATE_BASE, model, message, 'chat2api-test')
        }
        if (provider === 'deepseek') {
          // deepseek-api manages its own session — any bearer works.
          return await sendTestChat(DEEPSEEK_BASE, model, message, 'chat2api-test')
        }
        if (provider === 'glm') {
          // glm-free-api enforces AUTH_TOKEN=Waguri (set in spec.env).
          const env = daemonSupervisor.getDaemonEnv(GLM_DAEMON_ID)
          const bearer = env.AUTH_TOKEN || 'Waguri'
          // If user has set a ZAI_TOKEN, prefer a model that needs it.
          const glmModel = env.ZAI_TOKEN
            ? args?.model || 'glm-4.6'
            : args?.model || 'glm-4.7'
          return await sendTestChat(GLM_BASE, glmModel, message, bearer)
        }
        if (provider === 'kimi') {
          // Kimi-Free-API uses the user-supplied Bearer token per-request.
          const accounts = AccountManager.getByProviderId('kimi', true)
          if (accounts.length === 0) {
            return { ok: false, error: 'no Kimi token saved — set one first' }
          }
          const acct = accounts[0]
          const bearer =
            acct.credentials?.jwtToken ||
            acct.credentials?.token ||
            acct.credentials?.refreshToken ||
            ''
          if (!bearer) {
            return { ok: false, error: 'Kimi account has no token credential' }
          }
          return await sendTestChat(KIMI_BASE, model, message, bearer)
        }

        return { ok: false, error: `unknown provider: ${String(provider)}` }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'testChat threw',
        }
      }
    }
  )
}
