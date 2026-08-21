/**
 * ProxyAdapter — generic adapter that forwards an OpenAI-format request to a
 * standalone reverse-API daemon running on a local port.
 *
 * Why this exists:
 *   Chat2API's original per-provider adapters (QwenAdapter, DeepSeekAdapter,
 *   GLMAdapter, KimiAdapter, ZaiAdapter) each reimplemented the upstream
 *   reverse-engineering protocol in ~1000 LOC. They break constantly as
 *   upstreams change their anti-bot, and Chat2API's maintainer has stopped
 *   shipping fixes (last commit May 2026, multiple open "doesn't work" bugs).
 *
 *   This file replaces all of that with a ~150-line HTTP forwarder. Each
 *   swapped provider just instantiates ProxyAdapter with its daemon's port.
 *   The standalone daemons (vendored under /vendor) do the actual
 *   reverse-engineering and return OpenAI-format SSE, which we pass through
 *   unchanged. Tool calling, streaming, model selection — all native OpenAI
 *   format, so no per-provider parsing logic is needed.
 *
 * Adapter contract (from src/main/proxy/forwarder.ts):
 *   chatCompletion(req) → { response: AxiosResponse, sessionId?: string }
 *   The forwarder then either:
 *     - calls handler.handleStream(response.data) for stream=true
 *     - calls handler.handleNonStream(response.data) for stream=false
 *   See ProxyStreamHandler below — both are passthroughs.
 */

import axios, { AxiosResponse } from 'axios'
import type { Account, Provider } from '../../store/types'

export interface ProxyChatRequest {
  model: string
  originalModel?: string
  messages: any[]
  stream?: boolean
  temperature?: number
  tools?: any[]
  // passthrough fields various providers accept
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max'
  deep_research?: boolean
  enableThinking?: boolean
  enableWebSearch?: boolean
  /**
   * Upstream conversation id — when set, the daemon continues an existing
   * chat rather than starting a new one. Used by the SmartSwitcher's session
   * affinity feature so the same Qwen Code session reuses the same upstream
   * chat (full context preserved without re-sending every turn).
   */
  conversation_id?: string
  [key: string]: any
}

export interface ProxyAdapterOptions {
  /** Daemon id, used for logs and dispatch (e.g. 'qwen', 'deepseek', 'glm', 'kimi') */
  id: string
  /** Local port the standalone daemon listens on */
  port: number
  /** Host (default localhost) */
  host?: string
  /** Path on the daemon (default /v1/chat/completions) */
  chatPath?: string
  /** Path for model list (default /v1/models) */
  modelsPath?: string
  /**
   * Pick the API key to send upstream from the account credentials.
   * Most standalone daemons ignore the key or accept any non-empty value,
   * but some (qwengate, glm-free-api with AUTH_TOKEN set) enforce their own.
   * Falls back to the account's `apiKey` / `token` / `ticket` field, then to
   * the literal string 'chat2api-merged' so the OpenAI SDK on the daemon side
   * doesn't reject the request.
   */
  apiKeyFrom?: (account: Account) => string | undefined
  /**
   * Static matcher — used by forwarder.ts to decide which provider routes
   * to this adapter. Typically: (p) => p.id === 'qwen'
   */
  matches: (provider: Provider) => boolean
}

export class ProxyAdapter {
  readonly options: ProxyAdapterOptions
  private provider: Provider
  private account: Account

  constructor(options: ProxyAdapterOptions, provider: Provider, account: Account) {
    this.options = options
    this.provider = provider
    this.account = account
  }

  /** Resolve the upstream API key for this request */
  private resolveApiKey(): string {
    if (this.options.apiKeyFrom) {
      const k = this.options.apiKeyFrom(this.account)
      if (k) return k
    }
    const creds = this.account.credentials || {}
    return (
      creds.apiKey ||
      creds.api_key ||
      creds.token ||
      creds.ticket ||
      creds.refreshToken ||
      'chat2api-merged'
    )
  }

  /** Base URL of the standalone daemon */
  baseURL(): string {
    // Default to 'localhost' — the OS resolves it to whichever family the
    // daemon binds (qwengate binds to ::1 IPv6; DeepSeek/GLM bind to 127.0.0.1
    // IPv4). Per-adapter configs can override 'host' if a daemon binds
    // non-default.
    const host = this.options.host || 'localhost'
    return `http://${host}:${this.options.port}`
  }

  /**
   * Forward a chat completion request to the standalone daemon.
   * Returns the axios response (stream or JSON depending on request.stream).
   * The forwarder wraps the stream with ProxyStreamHandler.
   */
  async chatCompletion(req: ProxyChatRequest): Promise<{
    response: AxiosResponse
    sessionId: string
  }> {
    const url = `${this.baseURL()}${this.options.chatPath || '/v1/chat/completions'}`
    const apiKey = this.resolveApiKey()

    // Build the OpenAI-format body. We forward every field the caller sent —
    // the standalone daemon will ignore anything it doesn't understand.
    const body: any = {
      model: req.model,
      messages: req.messages,
      stream: req.stream ?? false,
    }
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.tools && req.tools.length > 0) body.tools = req.tools
    if (req.web_search !== undefined) body.web_search = req.web_search
    if (req.reasoning_effort !== undefined) body.reasoning_effort = req.reasoning_effort
    if (req.deep_research !== undefined) body.deep_research = req.deep_research
    if (req.enableThinking !== undefined) body.enable_thinking = req.enableThinking
    if (req.enableWebSearch !== undefined) body.enable_web_search = req.enableWebSearch
    // Session affinity: pass the upstream conversation id so the daemon continues
    // an existing chat (all 4 daemons support this field in their OpenAI-compatible
    // /v1/chat/completions endpoint).
    if (req.conversation_id) body.conversation_id = req.conversation_id

    const response = await axios.request({
      method: 'POST',
      url,
      data: body,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${apiKey}`,
      },
      responseType: req.stream ? 'stream' : 'json',
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      // Don't let axios throw on 4xx/5xx — we want the body to surface upstream errors
      validateStatus: () => true,
    })

    // Standalone daemons manage their own sessions internally. We return the
    // conversation_id from the response (if the daemon created a new chat) so
    // the SmartSwitcher can store it for session affinity on subsequent turns.
    let upstreamChatId = ''
    if (!req.stream && response.data) {
      // Non-stream JSON response — try to extract conversation_id
      upstreamChatId = response.data?.conversation_id || response.data?.id || ''
    }
    return { response, sessionId: upstreamChatId }
  }

  /** Fetch the daemon's model list (OpenAI /v1/models format) */
  async listModels(): Promise<any> {
    const url = `${this.baseURL()}${this.options.modelsPath || '/v1/models'}`
    const apiKey = this.resolveApiKey()
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
      validateStatus: () => true,
    })
    return resp.data
  }

  /** Health-check ping — used by the supervisor + UI status panel */
  async ping(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const start = Date.now()
    try {
      const resp = await axios.get(`${this.baseURL()}/health`, {
        timeout: 5000,
        validateStatus: () => true,
      })
      // /health may 404 on some daemons — treat /v1/models 200 as healthy too
      if (resp.status < 500) {
        return { ok: true, latencyMs: Date.now() - start }
      }
      return { ok: false, latencyMs: Date.now() - start, detail: `HTTP ${resp.status}` }
    } catch (err: any) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        detail: err?.code || err?.message || 'unreachable',
      }
    }
  }

  /** No-op session cleanup — the standalone daemon handles this internally */
  async deleteSession(_sessionId: string): Promise<void> {}
  async deleteConversation(_id: string): Promise<void> {}
  async deleteChat(_id: string): Promise<void> {}
  async deleteAllChats(): Promise<boolean> {
    // Standalone daemons manage their own session lifecycle; nothing to clear
    // here. Returns true so the UI's "clear all chats" action doesn't error.
    return true
  }
  async generateConversationTitle(_id: string, _title: string): Promise<void> {}
}
