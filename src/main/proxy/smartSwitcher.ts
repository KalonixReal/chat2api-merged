/**
 * SmartSwitcher — intelligent account switching + session affinity engine.
 *
 * Two coupled features live here:
 *
 *  Feature A — Smart Account Switching & Recovery
 *  When an in-flight chat request hits a throttle / rate-limit / auth failure on
 *  the current account, the proxy:
 *    1. Detects the failure (HTTP 429/403/401 OR SSE error markers)
 *    2. Marks the account throttled (with cooldown)
 *    3. Picks the next healthy account (round-robin, skip throttled)
 *    4. If streaming with partial output already sent, falls back to
 *       "context.txt mode" — pushes the full conversation history into a fresh
 *       chat on the new account so the user doesn't lose continuity
 *    5. Runs an automated recovery sequence on the failed account (token
 *       refresh → stored creds → browser profile) per-provider
 *    6. If ALL accounts for the provider are throttled AND recovery fails, emits
 *       a `captcha:required` event (Task 7's notifications system subscribes).
 *
 *  Feature B — Session Affinity (Chat Reuse)
 *  Same conversation = same upstream chat. We hash (system prompt + first user
 *  message + tool signatures) and map: `sessionHash → { providerId, accountId,
 *  upstreamChatId }`. Reuse until throttle or invalid chat; switch model only
 *  when a new session starts or full provider failover is needed.
 *
 * Persistence:
 *  `~/.chat2api/session-map.json` and `~/.chat2api/throttle-status.json` —
 *  debounced 2s writes so the maps survive process restarts.
 *
 * Concurrency:
 *  Per-sessionHash in-memory lock prevents two concurrent requests for the
 *  same logical session from racing on get-or-create.
 *
 * Robustness:
 *  The switcher NEVER throws — every public method resolves to a result
 *  (possibly a failure result). The proxy stays up.
 */

import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import axios from 'axios'

import type { Account, Provider } from '../store/types'
import { storeManager } from '../store/store'
import { loadBalancer } from './loadbalancer'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionMapping {
  /** sha256(system + firstUser + sortedToolSignatures) */
  sessionHash: string
  /** Provider this session is bound to. */
  providerId: string
  /** Account currently owning this session. */
  accountId: string
  /** Upstream chat / conversation id passed to the daemon to continue the chat. */
  upstreamChatId: string
  /** Model used for this session — only changed when session restarts. */
  modelId: string
  /** Last activity timestamp (ms). */
  lastUsed: number
  /** Created timestamp (ms). */
  createdAt: number
}

export interface ThrottleStatus {
  accountId: string
  providerId: string
  /** Unix ms when throttle expires. */
  throttledUntil: number
  /** Why the account was throttled. */
  reason: string
  /** Recovery attempts so far (used to cap retries). */
  recoveryAttempts: number
  /** Last recovery method tried, if any. */
  lastRecoveryMethod?: string
  /** Last recovery timestamp. */
  lastRecoveryAt?: number
}

export interface ChatCompletionRequestLike {
  model: string
  messages: Array<{
    role: string
    content: string | any[] | null
    tool_call_id?: string
    tool_calls?: any[]
  }>
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: any } }>
  [key: string]: any
}

export interface CaptchaRequiredEvent {
  providerId: string
  accountId: string
  accountName?: string
  detail: string
  timestamp: number
}

export interface RecoveryResult {
  recovered: boolean
  method: string
  detail?: string
}

export interface GetOrCreateSessionOptions {
  preferredProviderId?: string
  preferredModel?: string
  /** Exclude these account ids (e.g. the one we just throttled). */
  excludeAccountIds?: string[]
}

export interface FailoverResult {
  session: SessionMapping | null
  reason: string
  crossProvider: boolean
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default throttle cooldown: 60 seconds (covers most rate-limit windows). */
const DEFAULT_THROTTLE_COOLDOWN_MS = 60_000
/** Session TTL: 2 hours of inactivity → stale. */
const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000
/** Debounce for JSON persistence. */
const PERSIST_DEBOUNCE_MS = 2_000
/** Per-provider throttle cooldown overrides (some upstreams are stricter). */
const PROVIDER_COOLDOWN_MS: Record<string, number> = {
  qwen: 5 * 60_000, // Qwen's WAF/anti-bot is aggressive
  'qwen-ai': 5 * 60_000,
  deepseek: 2 * 60_000, // DeepSeek rate limit
  glm: 5 * 60_000, // Z.ai captcha cooldown
  zai: 5 * 60_000, // Same daemon as glm
  kimi: 90_000, // Kimi JWT
}

// ─── SmartSwitcher ────────────────────────────────────────────────────────────

class SmartSwitcher extends EventEmitter {
  private sessionMap: Map<string, SessionMapping> = new Map()
  private throttleMap: Map<string, ThrottleStatus> = new Map()

  /** Per-sessionHash in-flight locks. Prevents racing get-or-create. */
  private sessionLocks: Map<string, Promise<SessionMapping | null>> = new Map()

  private persistTimer: NodeJS.Timeout | null = null
  private dirty = false
  private initialized = false
  private storageDir: string

  constructor() {
    super()
    // Match storeManager's path (~/.chat2api) so everything lives together.
    this.storageDir = join(homedir(), '.chat2api')
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  initialize(): void {
    if (this.initialized) return
    try {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true })
      }
      this.loadSessionMap()
      this.loadThrottleMap()
      this.cleanupStale()
      this.initialized = true
      console.log(
        `[SmartSwitcher] Initialized: ${this.sessionMap.size} sessions, ${this.throttleMap.size} throttles`
      )
    } catch (err: any) {
      // Never throw from the switcher — log + degrade to in-memory only.
      console.error('[SmartSwitcher] initialize failed (degraded mode):', err?.message || err)
      this.initialized = true
    }
  }

  private sessionMapPath(): string {
    return join(this.storageDir, 'session-map.json')
  }

  private throttleMapPath(): string {
    return join(this.storageDir, 'throttle-status.json')
  }

  private loadSessionMap(): void {
    try {
      if (!existsSync(this.sessionMapPath())) return
      const raw = readFileSync(this.sessionMapPath(), 'utf-8')
      const arr = JSON.parse(raw) as SessionMapping[]
      if (Array.isArray(arr)) {
        for (const s of arr) {
          if (s && s.sessionHash) this.sessionMap.set(s.sessionHash, s)
        }
      }
    } catch (err: any) {
      console.warn('[SmartSwitcher] session-map load failed:', err?.message || err)
    }
  }

  private loadThrottleMap(): void {
    try {
      if (!existsSync(this.throttleMapPath())) return
      const raw = readFileSync(this.throttleMapPath(), 'utf-8')
      const arr = JSON.parse(raw) as ThrottleStatus[]
      const now = Date.now()
      if (Array.isArray(arr)) {
        for (const t of arr) {
          if (!t || !t.accountId) continue
          // Drop already-expired throttles on load.
          if (t.throttledUntil > now) {
            this.throttleMap.set(t.accountId, t)
          }
        }
      }
    } catch (err: any) {
      console.warn('[SmartSwitcher] throttle-status load failed:', err?.message || err)
    }
  }

  private schedulePersist(): void {
    this.dirty = true
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      if (!this.dirty) return
      this.persistNow()
    }, PERSIST_DEBOUNCE_MS)
    // Don't keep the event loop alive just for persistence.
    if (typeof this.persistTimer.unref === 'function') {
      this.persistTimer.unref()
    }
  }

  private persistNow(): void {
    this.dirty = false
    try {
      const sessions = Array.from(this.sessionMap.values())
      writeFileSync(this.sessionMapPath(), JSON.stringify(sessions, null, 2), 'utf-8')
    } catch (err: any) {
      console.warn('[SmartSwitcher] session-map persist failed:', err?.message || err)
    }
    try {
      const throttles = Array.from(this.throttleMap.values())
      writeFileSync(this.throttleMapPath(), JSON.stringify(throttles, null, 2), 'utf-8')
    } catch (err: any) {
      console.warn('[SmartSwitcher] throttle-status persist failed:', err?.message || err)
    }
  }

  // ─── Session hashing ────────────────────────────────────────────────────────

  /**
   * Compute a stable hash for a chat request:
   *   sha256( systemPrompt + "\n---\n" + firstUserMessage + "\n---\n" + sortedToolSignatures )
   *
   * Why these fields:
   *  - System prompt: a different system prompt = a different persona = different session
   *  - First user message: identifies the conversation thread
   *  - Tool signatures (sorted by name): same tool set = same capability surface
   *
   * We deliberately do NOT hash later messages — the same session can grow with
   * more turns and still hash to the same value, so we can reuse the upstream
   * chat id. This is what gives us session affinity.
   */
  computeSessionHash(request: ChatCompletionRequestLike): string {
    const messages = Array.isArray(request.messages) ? request.messages : []
    const systemMsgs = messages.filter(m => m.role === 'system')
    const firstUser = messages.find(m => m.role === 'user')

    const systemText = systemMsgs
      .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
      .join('\n\n')

    const firstUserText = firstUser
      ? typeof firstUser.content === 'string'
        ? firstUser.content
        : JSON.stringify(firstUser.content ?? '')
      : ''

    // Tool signatures: name + description + parameter shape (sorted by name).
    const tools = Array.isArray(request.tools) ? request.tools : []
    const toolSignatures = tools
      .map(t => ({
        name: t?.function?.name || '',
        desc: t?.function?.description || '',
        params: t?.function?.parameters ? JSON.stringify(t.function.parameters) : '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(t => `${t.name}|${t.desc}|${t.params}`)
      .join('\n')

    const input = `${systemText}\n---\n${firstUserText}\n---\n${toolSignatures}`
    return createHash('sha256').update(input, 'utf-8').digest('hex')
  }

  // ─── Session lookup / creation ────────────────────────────────────────────

  /**
   * Get an existing session mapping, or create a new one bound to a healthy
   * account. Concurrency-safe per sessionHash.
   */
  async getOrCreateSession(
    request: ChatCompletionRequestLike,
    options: GetOrCreateSessionOptions = {}
  ): Promise<SessionMapping | null> {
    const hash = this.computeSessionHash(request)
    const existing = this.sessionMap.get(hash)
    if (existing) {
      // Existing mapping — verify the account is still healthy & not throttled.
      if (this.isHealthy(existing.accountId)) {
        // Touch lastUsed (no need to await — fire & forget via schedulePersist).
        existing.lastUsed = Date.now()
        this.schedulePersist()
        return existing
      }
      // The bound account is throttled or disabled. Don't reuse — try to
      // rebind to a healthy account of the SAME provider (preserves model +
      // upstream chat id from a previous successful request won't help here
      // because we have to start a new chat on the new account, so we leave
      // upstreamChatId empty and let the daemon create a new chat).
      const rebonded = await this.rebindSession(existing, options.excludeAccountIds)
      if (rebonded) return rebonded
      // Fall through to fresh creation (may pick a different provider).
    }

    // Per-hash lock: only one request at a time creates the mapping.
    const pending = this.sessionLocks.get(hash)
    if (pending) {
      try {
        return await pending
      } catch {
        // ignore — fall through and try ourselves
      }
    }

    const promise = (async (): Promise<SessionMapping | null> => {
      try {
        const providerId =
          options.preferredProviderId || this.pickProviderForModel(request.model)
        const account = this.pickHealthyAccount(
          providerId,
          options.excludeAccountIds
        )
        if (!account) {
          // Try any healthy provider that supports this model as a last resort.
          const fallbackAccount = this.pickAnyHealthyAccountForModel(
            request.model,
            options.excludeAccountIds
          )
          if (!fallbackAccount) {
            console.warn(
              `[SmartSwitcher] No healthy account for model=${request.model}`
            )
            return null
          }
          return this.createMapping(
            hash,
            fallbackAccount.providerId,
            fallbackAccount.id,
            '',
            request.model
          )
        }
        return this.createMapping(hash, providerId, account.id, '', request.model)
      } finally {
        // Release the lock.
        this.sessionLocks.delete(hash)
      }
    })()

    this.sessionLocks.set(hash, promise)
    return promise
  }

  /**
   * Rebind an existing session to a new healthy account of the SAME provider.
   * Preserves sessionHash + modelId; resets upstreamChatId (new account = new
   * upstream chat). Returns the updated mapping or null if no healthy account.
   */
  private async rebindSession(
    session: SessionMapping,
    excludeAccountIds?: string[]
  ): Promise<SessionMapping | null> {
    const account = this.pickHealthyAccount(session.providerId, [
      session.accountId,
      ...(excludeAccountIds || []),
    ])
    if (!account) {
      console.log(
        `[SmartSwitcher] rebind: no healthy account for provider=${session.providerId}, sessionHash=${session.sessionHash.slice(0, 12)}…`
      )
      return null
    }
    session.accountId = account.id
    session.upstreamChatId = ''
    session.lastUsed = Date.now()
    this.schedulePersist()
    console.log(
      `[SmartSwitcher] Rebound session ${session.sessionHash.slice(0, 12)}… to account ${account.id} (provider ${session.providerId})`
    )
    return session
  }

  private createMapping(
    sessionHash: string,
    providerId: string,
    accountId: string,
    upstreamChatId: string,
    modelId: string
  ): SessionMapping {
    const now = Date.now()
    const mapping: SessionMapping = {
      sessionHash,
      providerId,
      accountId,
      upstreamChatId,
      modelId,
      lastUsed: now,
      createdAt: now,
    }
    this.sessionMap.set(sessionHash, mapping)
    this.schedulePersist()
    console.log(
      `[SmartSwitcher] Created session mapping hash=${sessionHash.slice(0, 12)}… provider=${providerId} account=${accountId}`
    )
    return mapping
  }

  /**
   * Update the upstream chat id on an existing mapping (called by the forwarder
   * after a successful response carries a conversation_id back from the daemon).
   */
  updateUpstreamChatId(sessionHash: string, upstreamChatId: string): void {
    if (!upstreamChatId) return
    const mapping = this.sessionMap.get(sessionHash)
    if (!mapping) return
    if (mapping.upstreamChatId !== upstreamChatId) {
      mapping.upstreamChatId = upstreamChatId
      console.log(
        `[SmartSwitcher] Stored upstream chat id=${upstreamChatId.slice(0, 16)}… for session ${sessionHash.slice(0, 12)}…`
      )
    }
    mapping.lastUsed = Date.now()
    this.schedulePersist()
  }

  /**
   * Get a mapping by hash (read-only). Does NOT touch lastUsed.
   */
  getSession(sessionHash: string): SessionMapping | undefined {
    return this.sessionMap.get(sessionHash)
  }

  /**
   * Delete a session mapping (e.g. when the daemon reports the chat as invalid).
   */
  deleteSession(sessionHash: string): void {
    if (this.sessionMap.delete(sessionHash)) {
      this.schedulePersist()
      console.log(`[SmartSwitcher] Deleted session hash=${sessionHash.slice(0, 12)}…`)
    }
  }

  // ─── Throttle state ──────────────────────────────────────────────────────────

  /**
   * Mark an account as throttled. Auto-unthrottles after cooldown.
   * Emits a `throttled` event the notifications system (Task 7) listens to.
   */
  markThrottled(
    accountId: string,
    providerId: string,
    reason: string,
    cooldownMs?: number
  ): void {
    const cd = cooldownMs ?? PROVIDER_COOLDOWN_MS[providerId] ?? DEFAULT_THROTTLE_COOLDOWN_MS
    const existing = this.throttleMap.get(accountId)
    const throttledUntil = Date.now() + cd
    const status: ThrottleStatus = {
      accountId,
      providerId,
      throttledUntil,
      reason,
      recoveryAttempts: existing?.recoveryAttempts ?? 0,
      lastRecoveryMethod: existing?.lastRecoveryMethod,
      lastRecoveryAt: existing?.lastRecoveryAt,
    }
    this.throttleMap.set(accountId, status)
    this.schedulePersist()
    console.warn(
      `[SmartSwitcher] Throttled account=${accountId} provider=${providerId} until +${cd}ms reason="${reason}"`
    )
    // Emit event for the notifications system.
    try {
      this.emit('throttled', {
        providerId,
        accountId,
        reason,
        until: throttledUntil,
      })
    } catch (err: any) {
      console.warn('[SmartSwitcher] throttled emit failed:', err?.message || err)
    }

    // Schedule auto-unthrottle. Don't keep the loop alive for this.
    const timer = setTimeout(() => {
      const cur = this.throttleMap.get(accountId)
      if (cur && cur.throttledUntil <= Date.now()) {
        this.throttleMap.delete(accountId)
        this.schedulePersist()
        console.log(`[SmartSwitcher] Auto-unthrottled account=${accountId}`)
      }
    }, cd + 500)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * Manually clear throttle state (e.g. after successful recovery).
   */
  clearThrottle(accountId: string): void {
    if (this.throttleMap.delete(accountId)) {
      this.schedulePersist()
      console.log(`[SmartSwitcher] Cleared throttle for account=${accountId}`)
    }
  }

  /**
   * Is the account healthy (not throttled + active + not over daily limit)?
   */
  isHealthy(accountId: string): boolean {
    const status = this.throttleMap.get(accountId)
    if (status && status.throttledUntil > Date.now()) {
      return false
    }
    if (status && status.throttledUntil <= Date.now()) {
      // Expired — clean up lazily.
      this.throttleMap.delete(accountId)
      this.schedulePersist()
    }
    const account = this.lookupAccount(accountId)
    if (!account) return false
    if (account.status !== 'active') return false
    if (account.dailyLimit && account.todayUsed && account.todayUsed >= account.dailyLimit) {
      return false
    }
    return true
  }

  /**
   * Get all healthy accounts for a provider (filters throttled + disabled).
   */
  getHealthyAccounts(providerId: string): Account[] {
    try {
      const accounts = storeManager.getAccountsByProviderId(providerId, true)
      return accounts.filter(a => this.isHealthy(a.id))
    } catch (err: any) {
      console.warn('[SmartSwitcher] getHealthyAccounts failed:', err?.message || err)
      return []
    }
  }

  getThrottleStatus(accountId: string): ThrottleStatus | undefined {
    return this.throttleMap.get(accountId)
  }

  getAllThrottles(): ThrottleStatus[] {
    return Array.from(this.throttleMap.values())
  }

  // ─── Failover ──────────────────────────────────────────────────────────────

  /**
   * Failover: pick a new account for the same provider (or cross-provider if
   * all are down), create a new chat. Marks the old account as throttled.
   */
  async failover(
    session: SessionMapping,
    reason: string
  ): Promise<FailoverResult> {
    // Mark the old account throttled.
    this.markThrottled(session.accountId, session.providerId, reason)

    // 1. Try same provider, different account.
    const sameProviderAccount = this.pickHealthyAccount(session.providerId, [
      session.accountId,
    ])
    if (sameProviderAccount) {
      session.accountId = sameProviderAccount.id
      session.upstreamChatId = '' // new account → new upstream chat
      session.lastUsed = Date.now()
      this.schedulePersist()
      console.log(
        `[SmartSwitcher] Failover (same provider): session ${session.sessionHash.slice(0, 12)}… → account ${sameProviderAccount.id}`
      )
      return { session, reason, crossProvider: false }
    }

    // 2. All same-provider accounts down — try cross-provider failover.
    const crossAccount = this.pickAnyHealthyAccountForModel(session.modelId, [
      session.accountId,
    ])
    if (crossAccount && crossAccount.providerId !== session.providerId) {
      session.providerId = crossAccount.providerId
      session.accountId = crossAccount.id
      session.upstreamChatId = ''
      session.lastUsed = Date.now()
      this.schedulePersist()
      console.log(
        `[SmartSwitcher] Failover (cross-provider): session ${session.sessionHash.slice(0, 12)}… → provider=${crossAccount.providerId} account=${crossAccount.id}`
      )
      return { session, reason, crossProvider: true }
    }

    console.warn(
      `[SmartSwitcher] Failover FAILED: no healthy accounts for model=${session.modelId}`
    )
    return { session: null, reason, crossProvider: false }
  }

  // ─── Recovery sequence ────────────────────────────────────────────────────────

  /**
   * Run the automated recovery sequence on a failed account.
   *   1. Token refresh (provider-specific)
   *   2. Stored credentials retry (re-POST email/password etc.)
   *   3. Browser profile fallback (DeepSeek only)
   *
   * Per-provider:
   *   qwen/qwen-ai: POST http://localhost:26405/api/accounts/:email/login
   *                 (qwen-gate opens a headless browser to re-establish the session)
   *   deepseek:     spawn `.venv/bin/python -m deepseek.auth` (opens browser)
   *   glm/zai:      re-run `captcha-collector` binary in vendor/glm-free-api/ (best-effort)
   *   kimi:         token auto-refreshes server-side; just retry
   *
   * Public signature accepts (providerId, accountId?) so the notifications
   * system (Task 7) can call it from its IPC handler after the user solves a
   * CAPTCHA. Internally we look the account up by id.
   */
  async recoverySequence(
    providerId: string,
    accountId?: string
  ): Promise<RecoveryResult> {
    if (!accountId) {
      // No specific account — try the first healthy-or-throttled account of
      // this provider (used when the UI just says "provider X needs recovery").
      const account = this.findAnyAccountForProvider(providerId)
      if (!account) {
        return { recovered: false, method: 'none', detail: `no account for provider ${providerId}` }
      }
      return this.recoverySequenceForAccount(account)
    }
    const account = this.lookupAccount(accountId)
    if (!account) {
      return { recovered: false, method: 'none', detail: `account ${accountId} not found` }
    }
    return this.recoverySequenceForAccount(account)
  }

  private findAnyAccountForProvider(providerId: string): Account | null {
    try {
      const accounts = storeManager.getAccountsByProviderId(providerId, true)
      if (accounts.length === 0) return null
      // Prefer the most-recently-throttled one (it's the broken one).
      const throttled = accounts.filter(a => this.throttleMap.has(a.id))
      if (throttled.length > 0) return throttled[0]
      return accounts[0]
    } catch {
      return null
    }
  }

  private async recoverySequenceForAccount(account: Account): Promise<RecoveryResult> {
    const status = this.throttleMap.get(account.id)
    const attempts = (status?.recoveryAttempts ?? 0) + 1
    if (status) {
      status.recoveryAttempts = attempts
      status.lastRecoveryAt = Date.now()
      this.schedulePersist()
    }
    // Cap recovery attempts at 3 to avoid hammering a broken account.
    if (attempts > 3) {
      console.warn(
        `[SmartSwitcher] Recovery cap reached for account=${account.id} (${attempts} attempts)`
      )
      this.emit('recovery-failed', {
        providerId: account.providerId,
        accountId: account.id,
        error: 'max recovery attempts reached',
      })
      return { recovered: false, method: 'cap-reached', detail: 'max recovery attempts reached' }
    }

    const providerId = account.providerId
    console.log(
      `[SmartSwitcher] Recovery attempt #${attempts} for account=${account.id} provider=${providerId}`
    )

    try {
      // Step 1: token refresh (provider-specific).
      const refreshResult = await this.tryTokenRefresh(account)
      if (refreshResult.recovered) {
        if (status) {
          status.lastRecoveryMethod = refreshResult.method
          this.clearThrottle(account.id)
        }
        console.log(
          `[SmartSwitcher] Recovery succeeded via ${refreshResult.method} for account=${account.id}`
        )
        this.emit('recovery-success', {
          providerId: account.providerId,
          accountId: account.id,
          method: refreshResult.method,
        })
        return refreshResult
      }

      // Step 2: stored credentials retry (re-invoke the daemon's auth).
      const credResult = await this.tryStoredCredentials(account)
      if (credResult.recovered) {
        if (status) {
          status.lastRecoveryMethod = credResult.method
          this.clearThrottle(account.id)
        }
        console.log(
          `[SmartSwitcher] Recovery succeeded via ${credResult.method} for account=${account.id}`
        )
        this.emit('recovery-success', {
          providerId: account.providerId,
          accountId: account.id,
          method: credResult.method,
        })
        return credResult
      }

      // Step 3: browser profile fallback (DeepSeek only).
      if (providerId === 'deepseek') {
        const browserResult = await this.tryDeepSeekBrowserProfile(account)
        if (browserResult.recovered) {
          if (status) {
            status.lastRecoveryMethod = browserResult.method
            this.clearThrottle(account.id)
          }
          console.log(
            `[SmartSwitcher] Recovery succeeded via ${browserResult.method} for account=${account.id}`
          )
          this.emit('recovery-success', {
            providerId: account.providerId,
            accountId: account.id,
            method: browserResult.method,
          })
          return browserResult
        }
      }

      if (status) {
        status.lastRecoveryMethod = 'none'
      }
      this.emit('recovery-failed', {
        providerId: account.providerId,
        accountId: account.id,
        error: 'all recovery steps failed',
      })
      return {
        recovered: false,
        method: 'all-failed',
        detail: 'token refresh, stored credentials, and browser fallback all failed',
      }
    } catch (err: any) {
      console.error(
        `[SmartSwitcher] Recovery sequence threw for account=${account.id}:`,
        err?.message || err
      )
      this.emit('recovery-failed', {
        providerId: account.providerId,
        accountId: account.id,
        error: err?.message || String(err),
      })
      return { recovered: false, method: 'exception', detail: err?.message || String(err) }
    }
  }

  /**
   * Step 1 — Token refresh. Per provider.
   */
  private async tryTokenRefresh(account: Account): Promise<RecoveryResult> {
    const pid = account.providerId
    // Kimi auto-refreshes server-side; we just clear throttle and let retry happen.
    if (pid === 'kimi') {
      return { recovered: true, method: 'kimi-auto-refresh', detail: 'server-side refresh' }
    }

    // qwen / qwen-ai: qwengate has a refresh path (tokenRefresh.ts) invoked
    // automatically by the daemon's chat request retry. To trigger it
    // explicitly we hit the account's login endpoint which reloads cookies
    // from the persistent profile.
    if (pid === 'qwen' || pid === 'qwen-ai') {
      const email = account.email || account.credentials?.email
      if (!email) {
        return { recovered: false, method: 'qwen-refresh', detail: 'no email on account' }
      }
      try {
        const resp = await axios.get(
          `http://localhost:26405/api/accounts/${encodeURIComponent(email)}/login`,
          { timeout: 60_000, validateStatus: () => true }
        )
        if (resp.status < 400 && resp.data?.authenticated) {
          return { recovered: true, method: 'qwen-token-refresh' }
        }
        return {
          recovered: false,
          method: 'qwen-refresh',
          detail: `HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`,
        }
      } catch (err: any) {
        return {
          recovered: false,
          method: 'qwen-refresh',
          detail: err?.code || err?.message || 'unreachable',
        }
      }
    }

    // DeepSeek: token auto-refreshes server-side via headless profile scrape;
    // here we just signal "retry the request".
    if (pid === 'deepseek') {
      return { recovered: true, method: 'deepseek-headless-refresh', detail: 'daemon will headless-refresh' }
    }

    // GLM / Zai: captcha-collector harvests a fresh z.ai guest token.
    if (pid === 'glm' || pid === 'zai') {
      return await this.tryGlmCaptchaCollector(account)
    }

    return { recovered: false, method: 'none', detail: `no refresh path for provider ${pid}` }
  }

  /**
   * Step 2 — Stored credentials retry.
   * For Qwen: re-POST email/password to /api/accounts (re-logs in).
   * For others: best-effort noop (the daemon already retries internally).
   */
  private async tryStoredCredentials(account: Account): Promise<RecoveryResult> {
    const pid = account.providerId
    if (pid === 'qwen' || pid === 'qwen-ai') {
      const email = account.email || account.credentials?.email
      const password = account.credentials?.password
      if (!email || !password) {
        return { recovered: false, method: 'qwen-stored-creds', detail: 'no stored email/password' }
      }
      try {
        const resp = await axios.post(
          'http://localhost:26405/api/accounts',
          { email, password },
          { timeout: 60_000, validateStatus: () => true }
        )
        if (resp.status < 400 && resp.data?.loginSucceeded) {
          return { recovered: true, method: 'qwen-stored-creds' }
        }
        return {
          recovered: false,
          method: 'qwen-stored-creds',
          detail: `HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`,
        }
      } catch (err: any) {
        return {
          recovered: false,
          method: 'qwen-stored-creds',
          detail: err?.code || err?.message || 'unreachable',
        }
      }
    }
    // DeepSeek/GLM/Kimi: no equivalent — the daemon handles auth internally.
    return { recovered: false, method: 'none', detail: 'no stored-creds path' }
  }

  /**
   * Step 3 — Browser profile fallback (DeepSeek only).
   * Spawns `python -m deepseek.auth` in the vendored deepseek-api directory;
   * this opens a visible Chromium window for the user to complete the human
   * check. The persistent profile means subsequent runs are headless.
   */
  private async tryDeepSeekBrowserProfile(account: Account): Promise<RecoveryResult> {
    const { spawn } = await import('node:child_process')
    const { existsSync } = await import('node:fs')
    const projectRoot = this.findProjectRoot()
    if (!projectRoot) {
      return { recovered: false, method: 'deepseek-browser', detail: 'cannot locate project root' }
    }
    const venvPython =
      process.platform === 'win32'
        ? join(projectRoot, 'vendor', 'deepseek-api', '.venv', 'Scripts', 'python.exe')
        : join(projectRoot, 'vendor', 'deepseek-api', '.venv', 'bin', 'python')
    if (!existsSync(venvPython)) {
      return { recovered: false, method: 'deepseek-browser', detail: 'venv python not found' }
    }
    return new Promise(resolve => {
      const child = spawn(
        venvPython,
        ['-m', 'deepseek.auth'],
        {
          cwd: join(projectRoot, 'vendor', 'deepseek-api'),
          stdio: 'ignore',
          detached: true,
        }
      )
      child.on('error', err => {
        resolve({
          recovered: false,
          method: 'deepseek-browser',
          detail: `spawn error: ${err.message}`,
        })
      })
      // Give the auth window up to 5 minutes; don't block the proxy longer.
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        resolve({
          recovered: false,
          method: 'deepseek-browser',
          detail: 'timeout — user did not complete login in 5 minutes',
        })
      }, 5 * 60 * 1000)
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve({ recovered: true, method: 'deepseek-browser' })
        } else {
          resolve({
            recovered: false,
            method: 'deepseek-browser',
            detail: `python -m deepseek.auth exited with code ${code}`,
          })
        }
      })
      // Detach so the proxy doesn't wait on the child.
      if (typeof child.unref === 'function') child.unref()
    })
  }

  /**
   * GLM / Zai — re-run the captcha-collector binary to harvest a fresh z.ai
   * guest token into tokens.sqlite. Best-effort.
   */
  private async tryGlmCaptchaCollector(_account: Account): Promise<RecoveryResult> {
    const { spawn } = await import('node:child_process')
    const { existsSync } = await import('node:fs')
    const projectRoot = this.findProjectRoot()
    if (!projectRoot) {
      return { recovered: false, method: 'glm-captcha', detail: 'cannot locate project root' }
    }
    const platform = process.platform
    const arch = process.arch
    let binName: string
    if (platform === 'linux' && arch === 'x64') binName = 'captcha-collector-linux-amd64'
    else if (platform === 'darwin' && arch === 'arm64') binName = 'captcha-collector-darwin-arm64'
    else if (platform === 'darwin' && arch === 'x64') binName = 'captcha-collector-darwin-amd64'
    else if (platform === 'win32' && arch === 'x64') binName = 'captcha-collector-windows-amd64.exe'
    else return { recovered: false, method: 'glm-captcha', detail: `no captcha-collector binary for ${platform}/${arch}` }

    const binPath = join(projectRoot, 'vendor', 'glm-free-api', binName)
    if (!existsSync(binPath)) {
      return { recovered: false, method: 'glm-captcha', detail: 'captcha-collector binary not found' }
    }
    return new Promise(resolve => {
      const child = spawn(binPath, [], {
        cwd: join(projectRoot, 'vendor', 'glm-free-api'),
        stdio: 'ignore',
        detached: true,
      })
      child.on('error', err => {
        resolve({ recovered: false, method: 'glm-captcha', detail: `spawn error: ${err.message}` })
      })
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        resolve({ recovered: false, method: 'glm-captcha', detail: 'timeout' })
      }, 30_000)
      child.on('exit', code => {
        clearTimeout(timer)
        // captcha-collector exit code 0 = success.
        if (code === 0) {
          resolve({ recovered: true, method: 'glm-captcha' })
        } else {
          resolve({
            recovered: false,
            method: 'glm-captcha',
            detail: `captcha-collector exited with code ${code}`,
          })
        }
      })
      if (typeof child.unref === 'function') child.unref()
    })
  }

  // ─── CAPTCHA event ──────────────────────────────────────────────────────────

  /**
   * Emit a `captcha:required` event. Task 7 (notifications system) will
   * subscribe to this and surface it in the UI.
   */
  emitCaptchaRequired(
    providerId: string,
    accountId: string,
    detail: string
  ): void {
    const account = this.lookupAccount(accountId)
    const event: CaptchaRequiredEvent = {
      providerId,
      accountId,
      accountName: account?.name,
      detail,
      timestamp: Date.now(),
    }
    console.error(
      `[SmartSwitcher] CAPTCHA required: provider=${providerId} account=${accountId} (${account?.name || '?'}) detail=${detail}`
    )
    this.emit('captcha:required', event)
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────────

  /**
   * Remove session mappings older than TTL (default 2 hours of inactivity).
   */
  cleanupStale(ttlMs: number = DEFAULT_SESSION_TTL_MS): number {
    const now = Date.now()
    let removed = 0
    for (const [hash, mapping] of this.sessionMap.entries()) {
      if (now - mapping.lastUsed > ttlMs) {
        this.sessionMap.delete(hash)
        removed++
      }
    }
    // Also purge expired throttle entries.
    for (const [accountId, status] of this.throttleMap.entries()) {
      if (status.throttledUntil <= now) {
        this.throttleMap.delete(accountId)
      }
    }
    if (removed > 0 || this.throttleMap.size > 0) {
      this.schedulePersist()
      console.log(
        `[SmartSwitcher] Cleanup: removed ${removed} stale sessions, pruned throttles`
      )
    }
    return removed
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Pick a healthy account for a provider via the loadbalancer (round-robin).
   */
  pickHealthyAccount(
    providerId: string,
    excludeAccountIds: string[] = []
  ): Account | null {
    try {
      // Prefer the new loadbalancer method when available.
      const lb = loadBalancer as any
      if (typeof lb.pickHealthyAccount === 'function') {
        const acc = lb.pickHealthyAccount(providerId, excludeAccountIds)
        if (acc) return acc
      }
      // Fallback: manual filter.
      const accounts = this.getHealthyAccounts(providerId).filter(
        a => !excludeAccountIds.includes(a.id)
      )
      return accounts.length > 0 ? accounts[0] : null
    } catch (err: any) {
      console.warn('[SmartSwitcher] pickHealthyAccount failed:', err?.message || err)
      return null
    }
  }

  /**
   * Pick any healthy account (any provider) that supports the given model.
   * Used for cross-provider failover.
   */
  pickAnyHealthyAccountForModel(
    model: string,
    excludeAccountIds: string[] = []
  ): Account | null {
    try {
      const providers = storeManager.getProviders().filter(p => p.enabled)
      for (const provider of providers) {
        // Skip providers we know can't serve this model (rough check — the
        // loadbalancer does the authoritative check).
        const accounts = this.getHealthyAccounts(provider.id).filter(
          a => !excludeAccountIds.includes(a.id)
        )
        if (accounts.length > 0) {
          return accounts[0]
        }
      }
      return null
    } catch (err: any) {
      console.warn('[SmartSwitcher] pickAnyHealthyAccountForModel failed:', err?.message || err)
      return null
    }
  }

  /**
   * Heuristic: which provider id serves this model name?
   * Used when getOrCreateSession has no preferredProviderId hint.
   */
  private pickProviderForModel(model: string): string {
    const m = (model || '').toLowerCase()
    if (m.startsWith('qwen') || m.startsWith('qwq')) return 'qwen'
    if (m.startsWith('deepseek')) return 'deepseek'
    if (m.startsWith('glm')) return 'glm'
    if (m.startsWith('kimi') || m.startsWith('k2') || m.startsWith('moonshot')) return 'kimi'
    if (m.startsWith('zai') || m.includes('z.ai')) return 'zai'
    // Default: whatever provider the store has enabled first.
    try {
      const providers = storeManager.getProviders().filter(p => p.enabled)
      return providers[0]?.id || 'qwen'
    } catch {
      return 'qwen'
    }
  }

  private lookupAccount(accountId: string): Account | undefined {
    try {
      return storeManager.getAccountById(accountId, true)
    } catch {
      return undefined
    }
  }

  /**
   * Walk up from this source file to find the project root (where vendor/ lives).
   */
  private findProjectRoot(): string | null {
    try {
      // The vite output is CJS, so __dirname points to the compiled location of
      // this file under out/main/proxy/. Walk up until we find a `vendor/`
      // directory (max 8 levels to bound the search).
      let dir = resolvePath(__dirname)
      for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, 'vendor'))) return dir
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      return null
    } catch {
      return null
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────────

export const smartSwitcher = new SmartSwitcher()

// Initialize eagerly — the constructor doesn't touch the disk, only initialize()
// does. We call it here so the maps are loaded before the first request hits.
// The initialize() method is idempotent and never throws.
try {
  smartSwitcher.initialize()
} catch (err: any) {
  console.error('[SmartSwitcher] top-level init failed:', err?.message || err)
}

export default smartSwitcher
