/**
 * Dashboard API routes — HTTP equivalents of the Electron IPC handlers.
 *
 * Exposes all the features the Electron renderer had, but via HTTP so a web
 * dashboard (served at /dashboard) can use them. This lets the app run as
 * a pure web server (no Electron) — just `bun run.ts daemons` + the proxy
 * server, then open http://localhost:8080/dashboard in any browser.
 *
 * Routes under /v0/management/dashboard/*:
 *   GET  /daemons              — daemon health status (qwen-gate, deepseek, glm, kimi)
 *   POST /daemons/:id/restart  — restart a daemon
 *   GET  /providers/status     — per-provider config status (qwen/deepseek/glm/kimi)
 *   POST /qwen/accounts        — add Qwen account (email+password → qwengate)
 *   GET  /qwen/accounts        — list Qwen accounts from qwengate
 *   DELETE /qwen/accounts/:email — remove Qwen account
 *   POST /deepseek/login       — spawn browser login for DeepSeek
 *   POST /glm/token            — set ZAI_TOKEN + restart GLM daemon
 *   POST /kimi/token           — save Kimi token
 *   POST /test-chat            — test chat through a provider
 *   GET  /notifications        — list recent notifications
 *   POST /notifications/dismiss — dismiss a notification
 *   POST /notifications/solve-captcha — open browser for CAPTCHA solving
 *   POST /notifications/recovery — trigger recovery sequence
 *   GET  /live-models/:providerId — fetch models from daemon's /v1/models
 *   GET  /live-models          — fetch models from all daemons
 *   GET  /smart-switcher/sessions — active session mappings
 *   GET  /smart-switcher/throttles — throttled accounts
 */

import Router from '@koa/router'
import { Context } from 'koa'
import axios from 'axios'
import { daemonSupervisor } from '../../../supervisor'
import { storeManager } from '../../../store/store'
import { notificationManager } from '../../../notifications/NotificationManager'
import { fetchLiveModels, fetchAllLiveModels } from '../../liveModelFetcher'

const router = new Router({ prefix: '/v0/management/dashboard' })

const QWENGATE_BASE = 'http://localhost:26405'
const DEEPSEEK_BASE = 'http://localhost:8000'
const GLM_BASE = 'http://localhost:3001'
const KIMI_BASE = 'http://localhost:5566'

// ─── Daemon status ──────────────────────────────────────────────────────────

router.get('/daemons', async (ctx: Context) => {
  try {
    const statuses = await daemonSupervisor.checkAll()
    ctx.body = { success: true, daemons: statuses }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message || 'Failed to check daemons' }
  }
})

router.post('/daemons/:id/restart', async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const ok = await daemonSupervisor.restartDaemon(id)
    ctx.body = { success: ok }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message || 'Failed to restart daemon' }
  }
})

router.post('/daemons/:id/start', async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const status = await daemonSupervisor.startOne(id)
    ctx.body = { success: !!status, status }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message || 'Failed to start daemon' }
  }
})

router.post('/daemons/:id/stop', async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const ok = await daemonSupervisor.stopOne(id)
    ctx.body = { success: ok }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message || 'Failed to stop daemon' }
  }
})

// ─── Provider status ────────────────────────────────────────────────────────

router.get('/providers/status', async (ctx: Context) => {
  try {
    const [qwenAccounts, dsHealth, glmModels, kimiModels] = await Promise.allSettled([
      axios.get(`${QWENGATE_BASE}/api/accounts`, { timeout: 5000, validateStatus: () => true }),
      axios.get(`${DEEPSEEK_BASE}/healthz`, { timeout: 5000, validateStatus: () => true }),
      axios.get(`${GLM_BASE}/v1/models`, { timeout: 5000, headers: { Authorization: 'Bearer Waguri' }, validateStatus: () => true }),
      axios.get(`${KIMI_BASE}/v1/models`, { timeout: 5000, validateStatus: () => true }),
    ])

    const qwenOk = qwenAccounts.status === 'fulfilled' && qwenAccounts.value.status < 500
    const dsOk = dsHealth.status === 'fulfilled' && dsHealth.value.status < 500
    const glmOk = glmModels.status === 'fulfilled' && glmModels.value.status < 500
    const kimiOk = kimiModels.status === 'fulfilled' && kimiModels.value.status < 500

    const qwenList = qwenOk && qwenAccounts.value.data?.accounts ? qwenAccounts.value.data.accounts : []

    ctx.body = {
      success: true,
      providers: {
        qwen: {
          configured: qwenList.length > 0,
          daemonUp: qwenOk,
          accountCount: qwenList.length,
          accounts: qwenList,
        },
        deepseek: {
          configured: dsOk,
          daemonUp: dsOk,
          detail: dsOk ? 'Session ready' : 'No session — click Login',
        },
        glm: {
          configured: !!daemonSupervisor.getDaemonEnv('glm-free-api')?.ZAI_TOKEN,
          daemonUp: glmOk,
          models: glmOk ? (glmModels.value.data?.data?.map((m: any) => m.id) || []) : [],
        },
        kimi: {
          configured: storeManager.getAccountsByProviderId('kimi').length > 0,
          daemonUp: kimiOk,
          models: kimiOk ? (kimiModels.value.data?.data?.map((m: any) => m.id) || []) : [],
        },
      },
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message || 'Failed to get provider status' }
  }
})

// ─── Qwen accounts (proxy to qwengate) ───────────────────────────────────────

router.post('/qwen/accounts', async (ctx: Context) => {
  try {
    const { email, password } = ctx.request.body as { email: string; password: string }
    if (!email || !password) {
      ctx.status = 400
      ctx.body = { success: false, error: 'email and password are required' }
      return
    }
    const resp = await axios.post(
      `${QWENGATE_BASE}/api/accounts`,
      { email, password },
      { timeout: 30000, validateStatus: () => true },
    )
    ctx.body = resp.data
    ctx.status = resp.status
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message || 'Failed to add Qwen account' }
  }
})

router.get('/qwen/accounts', async (ctx: Context) => {
  try {
    const resp = await axios.get(`${QWENGATE_BASE}/api/accounts`, { timeout: 5000, validateStatus: () => true })
    ctx.body = resp.data
    ctx.status = resp.status
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to list Qwen accounts' }
  }
})

router.delete('/qwen/accounts/:email', async (ctx: Context) => {
  try {
    const email = decodeURIComponent(ctx.params.email)
    const resp = await axios.delete(`${QWENGATE_BASE}/api/accounts/${encodeURIComponent(email)}`, { timeout: 5000, validateStatus: () => true })
    ctx.body = resp.data
    ctx.status = resp.status
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to remove Qwen account' }
  }
})

// ─── DeepSeek login ────────────────────────────────────────────────────────

router.post('/deepseek/login', async (ctx: Context) => {
  try {
    // Spawn the auth script in the deepseek-api venv
    const ok = await daemonSupervisor.spawnAuthWindow('deepseek-api', [
      '.venv/Scripts/python.exe', '-m', 'deepseek.auth',
    ])
    ctx.body = { success: ok, message: ok ? 'Browser login window opened' : 'Failed to spawn login' }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message || 'Failed to start DeepSeek login' }
  }
})

// ─── Z.ai/GLM token ────────────────────────────────────────────────────────

router.post('/glm/token', async (ctx: Context) => {
  try {
    const { token } = ctx.request.body as { token: string }
    if (!token) {
      ctx.status = 400
      ctx.body = { success: false, error: 'token is required' }
      return
    }
    daemonSupervisor.setDaemonEnv('glm-free-api', { ZAI_TOKEN: token })
    const restarted = await daemonSupervisor.restartDaemon('glm-free-api')
    ctx.body = { success: restarted, message: restarted ? 'GLM daemon restarted with new token' : 'Failed to restart' }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message || 'Failed to set GLM token' }
  }
})

// ─── Kimi token ────────────────────────────────────────────────────────────

router.post('/kimi/token', async (ctx: Context) => {
  try {
    const { token } = ctx.request.body as { token: string }
    if (!token) {
      ctx.status = 400
      ctx.body = { success: false, error: 'token is required' }
      return
    }
    // Store as an account in the store so the adapter can use it
    const existing = storeManager.getAccountsByProviderId('kimi')
    if (existing.length > 0) {
      // Update the first one
      storeManager.updateAccount(existing[0].id, {
        credentials: { ...existing[0].credentials, token },
      })
    } else {
      storeManager.addAccount({
        providerId: 'kimi',
        name: 'Kimi Web',
        credentials: { token },
      })
    }
    ctx.body = { success: true, message: 'Kimi token saved' }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message || 'Failed to save Kimi token' }
  }
})

// ─── Test chat ──────────────────────────────────────────────────────────────

router.post('/test-chat', async (ctx: Context) => {
  try {
    const { provider, model, message } = ctx.request.body as {
      provider: string
      model?: string
      message?: string
    }
    const ports: Record<string, { port: number; auth?: string; defaultModel: string }> = {
      qwen: { port: 26405, defaultModel: 'qwen3-max' },
      deepseek: { port: 8000, defaultModel: 'deepseek-chat' },
      glm: { port: 3001, auth: 'Waguri', defaultModel: 'glm-4.7' },
      kimi: { port: 5566, defaultModel: 'kimi-k2.6' },
    }
    const cfg = ports[provider]
    if (!cfg) {
      ctx.status = 400
      ctx.body = { success: false, error: `Unknown provider: ${provider}` }
      return
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.auth) headers['Authorization'] = `Bearer ${cfg.auth}`
    const resp = await axios.post(
      `http://localhost:${cfg.port}/v1/chat/completions`,
      {
        model: model || cfg.defaultModel,
        messages: [{ role: 'user', content: message || 'Say hello in one word.' }],
        stream: false,
      },
      { headers, timeout: 30000, validateStatus: () => true },
    )
    ctx.body = {
      success: resp.status < 400,
      status: resp.status,
      data: resp.data,
    }
    ctx.status = 200
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message || 'Test chat failed' }
  }
})

// ─── Notifications ─────────────────────────────────────────────────────────

router.get('/notifications', async (ctx: Context) => {
  try {
    ctx.body = { success: true, notifications: notificationManager.list() }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message }
  }
})

router.post('/notifications/dismiss', async (ctx: Context) => {
  try {
    const { id } = ctx.request.body as { id: string }
    notificationManager.dismiss(id)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message }
  }
})

router.post('/notifications/dismiss-all', async (ctx: Context) => {
  try {
    notificationManager.dismissAll()
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message }
  }
})

router.post('/notifications/solve-captcha', async (ctx: Context) => {
  try {
    const { providerId } = ctx.request.body as { providerId?: string }
    // Open the appropriate login page in the user's browser
    const urls: Record<string, string> = {
      qwen: 'https://chat.qwen.ai/',
      'qwen-ai': 'https://chat.qwen.ai/',
      deepseek: 'https://chat.deepseek.com/sign_in',
      glm: 'https://chat.z.ai/',
      zai: 'https://chat.z.ai/',
      kimi: 'https://kimi.com/',
    }
    const url = providerId ? urls[providerId] : undefined
    if (url) {
      // Can't open browser from server, but we return the URL for the client to open
      ctx.body = { success: true, url, message: 'Open this URL in your browser to solve the CAPTCHA' }
    } else {
      ctx.body = { success: false, error: 'Unknown provider for CAPTCHA solving' }
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message }
  }
})

router.post('/notifications/recovery', async (ctx: Context) => {
  try {
    const { providerId, accountId } = ctx.request.body as { providerId: string; accountId?: string }
    // Dynamically import smartSwitcher (it may not be initialized yet)
    const { smartSwitcher } = await import('../../smartSwitcher')
    const result = await smartSwitcher.recoverySequence(providerId, accountId)
    ctx.body = { success: result.recovered, result }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message }
  }
})

// ─── Live models ────────────────────────────────────────────────────────────

router.get('/live-models/:providerId', async (ctx: Context) => {
  try {
    const result = await fetchLiveModels(ctx.params.providerId)
    ctx.body = result
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message }
  }
})

router.get('/live-models', async (ctx: Context) => {
  try {
    const results = await fetchAllLiveModels()
    ctx.body = { success: true, results }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message }
  }
})

// ─── Smart switcher status ─────────────────────────────────────────────────

router.get('/smart-switcher/sessions', async (ctx: Context) => {
  try {
    const { smartSwitcher } = await import('../../smartSwitcher')
    ctx.body = { success: true, sessions: smartSwitcher.snapshotSessions() }
  } catch (err: any) {
    ctx.body = { success: true, sessions: [], error: err?.message }
  }
})

router.get('/smart-switcher/throttles', async (ctx: Context) => {
  try {
    const { smartSwitcher } = await import('../../smartSwitcher')
    ctx.body = { success: true, throttles: smartSwitcher.getAllThrottles() }
  } catch (err: any) {
    ctx.body = { success: true, throttles: [] }
  }
})

// ─── Model management (CRUD) ────────────────────────────────────────────────
// These let the dashboard add/remove/customize models per provider. The proxy's
// /v1/models endpoint returns these effective models, so any model added here
// immediately appears to Qwen Code / curl / any OpenAI client.

router.get('/models/:providerId', async (ctx: Context) => {
  try {
    const providerId = ctx.params.providerId
    const models = storeManager.getEffectiveModels(providerId)
    ctx.body = { success: true, models }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message }
  }
})

router.post('/models/:providerId/add', async (ctx: Context) => {
  try {
    const providerId = ctx.params.providerId
    const { displayName, actualModelId } = ctx.request.body as {
      displayName: string
      actualModelId: string
    }
    if (!displayName || !actualModelId) {
      ctx.status = 400
      ctx.body = { success: false, error: 'displayName and actualModelId are required' }
      return
    }
    const models = storeManager.addCustomModel(providerId, { displayName, actualModelId })
    ctx.body = { success: true, models, message: `Added model "${displayName}" → "${actualModelId}"` }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message }
  }
})

router.post('/models/:providerId/remove', async (ctx: Context) => {
  try {
    const providerId = ctx.params.providerId
    const { modelName } = ctx.request.body as { modelName: string }
    if (!modelName) {
      ctx.status = 400
      ctx.body = { success: false, error: 'modelName is required' }
      return
    }
    const models = storeManager.removeModel(providerId, modelName)
    ctx.body = { success: true, models, message: `Removed model "${modelName}"` }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message }
  }
})

router.post('/models/:providerId/reset', async (ctx: Context) => {
  try {
    const providerId = ctx.params.providerId
    const models = storeManager.resetModels(providerId)
    ctx.body = { success: true, models, message: 'Models reset to defaults' }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message }
  }
})

// ─── Config (proxy settings) ────────────────────────────────────────────────

router.get('/config', async (ctx: Context) => {
  try {
    const config = storeManager.getConfig()
    ctx.body = {
      success: true,
      config: {
        proxyPort: config.proxyPort,
        proxyHost: config.proxyHost,
        proxyEnabled: config.proxyEnabled,
      },
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message }
  }
})

router.put('/config', async (ctx: Context) => {
  try {
    const { proxyPort, proxyHost } = ctx.request.body as {
      proxyPort?: number
      proxyHost?: string
    }
    const config = storeManager.getConfig()
    if (proxyPort !== undefined) config.proxyPort = proxyPort
    if (proxyHost !== undefined) config.proxyHost = proxyHost
    storeManager.updateConfig(config)
    ctx.body = { success: true, message: 'Settings saved. Restart the proxy to apply.' }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err?.message }
  }
})

export default router
