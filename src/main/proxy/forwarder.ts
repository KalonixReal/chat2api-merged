/**
 * Proxy Service Module - Request Forwarder
 * Forwards requests to corresponding API based on provider configuration
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'
import http2 from 'http2'
import { PassThrough } from 'stream'
import { Account, Provider } from '../store/types'
import { ForwardResult, ChatCompletionRequest, ProxyContext } from './types'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { smartSwitcher } from './smartSwitcher'
import { DeepSeekAdapter } from './adapters/deepseek'
import { DeepSeekStreamHandler } from './adapters/deepseek-stream'
import { GLMAdapter, GLMStreamHandler } from './adapters/glm'
import { KimiAdapter, KimiStreamHandler } from './adapters/kimi'
import { MimoAdapter, MimoStreamHandler } from './adapters/mimo'
import { QwenAdapter, QwenStreamHandler } from './adapters/qwen'
import { QwenAiAdapter, QwenAiStreamHandler } from './adapters/qwen-ai'
import { ZaiAdapter, ZaiStreamHandler } from './adapters/zai'
import { MiniMaxAdapter, MiniMaxStreamHandler } from './adapters/minimax'
import { PerplexityAdapter } from './adapters/perplexity'
import { PerplexityStreamHandler } from './adapters/perplexity-stream'
import { ToolCallingEngine } from './toolCalling/ToolCallingEngine'
import type { ToolCallingTransformResult } from './toolCalling/types'
import { sessionManager } from './sessionManager'
import {
  createContextManagementService,
  SummaryGenerator,
  type ChatMessage as ContextChatMessage,
} from './services/contextManagementService'

function shouldDeleteSession(): boolean {
  return sessionManager.shouldDeleteAfterChat()
}

type ProviderForwarder = {
  name: string
  matches: (provider: Provider) => boolean
  forward: (
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ) => Promise<ForwardResult>
}

/**
 * Request Forwarder
 */
export class RequestForwarder {
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  private readonly providerForwarders: ProviderForwarder[] = [
    {
      name: 'deepseek',
      matches: DeepSeekAdapter.isDeepSeekProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardDeepSeek(request, account, provider, actualModel, startTime),
    },
    {
      name: 'glm',
      matches: GLMAdapter.isGLMProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardGLM(request, account, provider, actualModel, startTime),
    },
    {
      name: 'kimi',
      matches: KimiAdapter.isKimiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardKimi(request, account, provider, actualModel, startTime),
    },
    {
      name: 'qwen',
      matches: QwenAdapter.isQwenProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardQwen(request, account, provider, actualModel, startTime),
    },
    {
      name: 'qwen-ai-redirect',
      matches: QwenAiAdapter.isQwenAiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardQwen(request, account, provider, actualModel, startTime),
    },
    {
      name: 'zai',
      matches: ZaiAdapter.isZaiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardZai(request, account, provider, actualModel, startTime),
    },
    {
      name: 'minimax',
      matches: MiniMaxAdapter.isMiniMaxProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardMiniMax(request, account, provider, actualModel, startTime),
    },
    {
      name: 'mimo',
      matches: MimoAdapter.isMimoProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardMimo(request, account, provider, actualModel, startTime),
    },
    {
      name: 'perplexity',
      matches: PerplexityAdapter.isPerplexityProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardPerplexity(request, account, provider, actualModel, startTime),
    },
  ]

  /**
   * Transform request for prompt-based tool calling
   * For models that don't support native function calling
   * Delegates tool normalization, prompt injection, and parser planning to ToolCallingEngine.
   */
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider
  ): ToolCallingTransformResult {
    const config = storeManager.getConfig().toolCallingConfig
    const engine = new ToolCallingEngine(config)

    return engine.transformRequest({
      request,
      provider: provider ?? {
        id: 'custom',
        name: 'Custom',
        type: 'custom',
        authType: 'token',
        apiEndpoint: '',
        headers: {},
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
      actualModel: request.model,
    })
  }

  private applyToolCallsToResponse(result: any, transformed: ToolCallingTransformResult): void {
    const engine = new ToolCallingEngine(storeManager.getConfig().toolCallingConfig)
    engine.applyNonStreamResponse(result, transformed.plan)
  }

  /**
   * Create summary generator function for context management
   * Uses the current provider and account to generate summaries
   */
  private createSummaryGenerator(
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): SummaryGenerator {
    return async (messages: ContextChatMessage[], prompt?: string): Promise<string> => {
      try {
        console.log('[SummaryGenerator] Generating summary for', messages.length, 'messages')

        const summaryPrompt = prompt || 'Please summarize the following conversation concisely, keeping key information and context:'

        const conversationText = messages
          .map(msg => {
            const role = msg.role.toUpperCase()
            const content = typeof msg.content === 'string'
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content
                    .filter(part => part.type === 'text' && part.text)
                    .map(part => part.text)
                    .join('\n')
                : ''
            return `${role}: ${content}`
          })
          .join('\n\n')

        const summaryRequest: ChatCompletionRequest = {
          model: actualModel,
          messages: [
            {
              role: 'system',
              content: summaryPrompt,
            },
            {
              role: 'user',
              content: conversationText,
            },
          ],
          stream: false,
          temperature: 0.3,
        }

        const result = await this.doForward(
          summaryRequest,
          account,
          provider,
          actualModel,
          context
        )

        if (result.success && result.body) {
          const summaryContent = result.body.choices?.[0]?.message?.content || ''
          console.log('[SummaryGenerator] Summary generated successfully, length:', summaryContent.length)
          return summaryContent
        }

        console.warn('[SummaryGenerator] Failed to generate summary:', result.error)
        return 'Failed to generate conversation summary.'
      } catch (error) {
        console.error('[SummaryGenerator] Error generating summary:', error)
        return 'Failed to generate conversation summary due to an error.'
      }
    }
  }

  /**
   * Forward Chat Completions Request
   */
  async forwardChatCompletion(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()
    const config = storeManager.getConfig()
    const maxRetries = config.retryCount

    let lastError: string | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await this.delay(5000)
      }

      let modifiedRequest = request

      if (config.contextManagement?.enabled && modifiedRequest.messages && modifiedRequest.messages.length > 0) {
        try {
          const summaryGenerator = this.createSummaryGenerator(
            account,
            provider,
            actualModel,
            context
          )

          const contextService = createContextManagementService(
            config.contextManagement || {},
            summaryGenerator
          )

          const originalCount = modifiedRequest.messages.length
          const contextMessages: ContextChatMessage[] = modifiedRequest.messages.map(msg => ({
            role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
            content: msg.content,
            timestamp: Date.now(),
          }))

          const processResult = await contextService.process(contextMessages)

          if (processResult.finalCount !== originalCount) {
            console.log(
              `[Forwarder] Context management applied: ${originalCount} -> ${processResult.finalCount} messages`
            )

            processResult.strategyResults.forEach(result => {
              if (result.trimmed) {
                console.log(
                  `[Forwarder] Strategy ${result.strategyName}: ${result.originalCount} -> ${result.processedCount} messages`
                )
              }
            })

            modifiedRequest = {
              ...modifiedRequest,
              messages: processResult.messages.map(msg => ({
                role: msg.role,
                content: msg.content,
              })),
            }
          }
        } catch (error) {
          console.error('[Forwarder] Context management failed:', error)
        }
      }

      try {
        const result = await this.doForward(modifiedRequest, account, provider, actualModel, context)

        if (result.success) {
          return result
        }

        lastError = result.error

        if (result.status && result.status < 500 && result.status !== 429) {
          break
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error'
      }
    }

    return {
      success: false,
      error: lastError || 'Request failed after retries',
      latency: Date.now() - startTime,
    }
  }

  /**
   * Execute Forward
   */
  private async doForward(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    const dedicatedForwarder = this.providerForwarders.find(forwarder => forwarder.matches(provider))
    if (dedicatedForwarder) {
      return dedicatedForwarder.forward(request, account, provider, actualModel, startTime)
    }

    try {
      const chatPath = provider.chatPath || '/chat/completions'
      const url = this.buildUrl(provider, chatPath)
      const headers = this.buildHeaders(provider, account)
      const body = this.buildRequestBody(request, actualModel, account)

      const axiosConfig: AxiosRequestConfig = {
        method: 'POST',
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: request.stream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(axiosConfig)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (request.stream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      if (error instanceof AxiosError) {
        return {
          success: false,
          status: error.response?.status,
          error: error.message,
          latency,
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * DeepSeek Dedicated Forward — delegates to the unified ProxyAdapter forwarder.
   * The DeepSeekAdapter is an in-process HTTP+PoW client that talks directly to
   * chat.deepseek.com (no external daemon process needed).
   */
  private async forwardDeepSeek(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    return this.forwardProxy(
      DeepSeekAdapter,
      DeepSeekStreamHandler,
      request,
      account,
      provider,
      actualModel,
      startTime,
      '[DeepSeek]'
    )
  }

  /**
   * Unified proxy forwarder — shared by all swapped providers (Qwen, DeepSeek,
   * GLM, Zai, Kimi). Each swapped adapter is a ProxyAdapter subclass that
   * talks directly to the provider's public API in-process; the upstream SSE
   * is converted to OpenAI format by the adapter's PassThrough stream and
   * ProxyStreamHandler passes it through unchanged.
   *
   * Smart switching integration:
   *   1. Compute session hash from the request (system prompt + first user
   *      message + tool signatures).
   *   2. getOrCreateSession() — returns a SessionMapping with the bound account
   *      + upstream conversation_id (for session affinity / chat reuse).
   *   3. Forward with conversation_id set so the provider continues the same chat.
   *   4. On throttle (429/403/401 or SSE error markers) → failover to a healthy
   *      account, re-forward. If mid-stream (partial output sent), switch to
   *      context.txt mode (push full message history to the new chat).
   *   5. If all accounts down → run recoverySequence, retry once. If still
   *      failing → emit CAPTCHA-required event (notifications system handles it).
   *   6. On success → updateUpstreamChatId() so next turn reuses the same chat.
   */
  private async forwardProxy(
    AdapterClass: new (provider: Provider, account: Account) => any,
    HandlerClass: new (model: string) => { handleStream(s: any): Promise<any>; handleNonStream(s: any): Promise<any> },
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    logTag: string
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      // ─── Smart switching: session affinity ───────────────────────────────
      // Compute a session hash and get-or-create a mapping. If a mapping exists
      // and the account is healthy, we reuse the upstream conversation_id so
      // the provider continues the same chat (full context, no re-send).
      let sessionMapping: import('./smartSwitcher').SessionMapping | null = null
      let activeAccount = account
      let activeProvider = provider
      let activeModel = actualModel
      let upstreamChatId = ''

      try {
        // smartSwitcher is statically imported at top of file
        sessionMapping = await smartSwitcher.getOrCreateSession({
          model: request.model,
          messages: transformedRequest.messages as any,
          tools: transformedRequest.tools as any,
        })
        if (sessionMapping) {
          upstreamChatId = sessionMapping.upstreamChatId || ''
          // Use the session's bound account if it differs from the loadbalancer's pick.
          // (The loadbalancer may have picked a now-throttled account; the switcher
          // knows which account is actually healthy for this session.)
          if (sessionMapping.accountId && sessionMapping.accountId !== account.id) {
            const switchedAccount = storeManager.getAccountById(sessionMapping.accountId)
            if (switchedAccount) activeAccount = switchedAccount
          }
        }
      } catch (swErr) {
        // SmartSwitcher is optional — if it fails, fall through to the original flow.
        console.warn(`${logTag} SmartSwitcher session lookup failed (non-fatal):`, swErr)
      }

      // ─── Forward to the provider API ──────────────────────────────────────
      const adapter = new AdapterClass(activeProvider, activeAccount)

      const { response, sessionId } = await adapter.chatCompletion({
        model: activeModel,
        originalModel: request.model,
        messages: transformedRequest.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        tools: transformedRequest.tools,
        web_search: transformedRequest.web_search,
        reasoning_effort: transformedRequest.reasoning_effort,
        deep_research: (transformedRequest as any).deep_research,
        enableThinking: (transformedRequest as any).enableThinking,
        enableWebSearch: (transformedRequest as any).enableWebSearch,
        conversation_id: upstreamChatId || undefined,
      })

      const latency = Date.now() - startTime

      // ─── Throttle / error detection ────────────────────────────────────
      // Detect: HTTP 429 (rate limit), 403 (forbidden/blocked), 401 (auth expired),
      // or SSE stream containing error markers.
      const isThrottled = response.status === 429 || response.status === 403 || response.status === 401
      const errorMessage = response.status >= 400
        ? this.extractErrorMessage(response)
        : ''

      if (isThrottled && sessionMapping) {
        console.warn(`${logTag} account ${activeAccount.id} throttled (HTTP ${response.status}), attempting failover...`)
        try {
          // smartSwitcher is statically imported at top of file
          const failoverResult = await smartSwitcher.failover(sessionMapping, `HTTP ${response.status}: ${errorMessage}`)

          if (failoverResult.session) {
            // Retry with the new account/chat
            const newSession = failoverResult.session
            const newAccount = storeManager.getAccountById(newSession.accountId) || activeAccount
            const newAdapter = new AdapterClass(activeProvider, newAccount)

            console.log(`${logTag} failover → account ${newAccount.id}, crossProvider=${failoverResult.crossProvider}`)

            const retryResponse = await newAdapter.chatCompletion({
              model: failoverResult.crossProvider ? newSession.modelId : activeModel,
              originalModel: request.model,
              messages: transformedRequest.messages as any,
              stream: request.stream,
              temperature: request.temperature,
              tools: transformedRequest.tools,
              web_search: transformedRequest.web_search,
              reasoning_effort: transformedRequest.reasoning_effort,
              deep_research: (transformedRequest as any).deep_research,
              enableThinking: (transformedRequest as any).enableThinking,
              enableWebSearch: (transformedRequest as any).enableWebSearch,
              conversation_id: newSession.upstreamChatId || undefined,
            })

            // Use the retry response going forward
            const retryLatency = Date.now() - startTime
            if (retryResponse.response.status < 400) {
              // Failover succeeded — update session + return the retry's response
              if (retryResponse.sessionId) {
                smartSwitcher.updateUpstreamChatId(newSession.sessionHash, retryResponse.sessionId)
              }
              return this.buildForwardResult(retryResponse.response, retryResponse, HandlerClass, activeModel, request.stream, transformed, retryLatency)
            }

            // Failover also failed — try recovery sequence
            console.warn(`${logTag} failover retry also failed (HTTP ${retryResponse.response.status}), running recovery...`)
            const recovery = await smartSwitcher.recoverySequence(activeProvider.id, activeAccount.id)
            if (recovery.recovered) {
              console.log(`${logTag} recovery succeeded via ${recovery.method}, retrying once more...`)
              const finalResponse = await newAdapter.chatCompletion({
                model: activeModel,
                originalModel: request.model,
                messages: transformedRequest.messages as any,
                stream: request.stream,
                temperature: request.temperature,
                tools: transformedRequest.tools,
                conversation_id: undefined,
              })
              if (finalResponse.response.status < 400) {
                return this.buildForwardResult(finalResponse.response, finalResponse, HandlerClass, activeModel, request.stream, transformed, Date.now() - startTime)
              }
            }

            // Recovery failed → emit CAPTCHA-required event
            console.error(`${logTag} all recovery failed — emitting CAPTCHA-required event`)
            smartSwitcher.emitCaptchaRequired(activeProvider.id, activeAccount.id, `All accounts throttled, recovery failed: ${recovery.detail || 'unknown'}`)
            return {
              success: false,
              status: 503,
              error: `All accounts for ${activeProvider.id} are throttled and recovery failed. A CAPTCHA or manual intervention may be required — check the dashboard for alerts.`,
              latency: Date.now() - startTime,
            }
          }
        } catch (failoverErr) {
          console.error(`${logTag} failover threw (non-fatal):`, failoverErr)
        }
      }

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      // ─── Success: update session mapping with the new chat id ──────────
      if (sessionMapping && sessionId) {
        try {
          // smartSwitcher is statically imported at top of file
          smartSwitcher.updateUpstreamChatId(sessionMapping.sessionHash, sessionId)
        } catch {}
      }

      return this.buildForwardResult(response, { response, sessionId }, HandlerClass, actualModel, request.stream, transformed, latency)
    } catch (error) {
      const latency = Date.now() - startTime
      console.error(`${logTag} proxy forward failed:`, error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Build a ForwardResult from a successful adapter response. Shared between
   * the initial forward and the failover retry.
   */
  private async buildForwardResult(
    response: any,
    adapterResult: { response: any; sessionId: string },
    HandlerClass: new (model: string) => { handleStream(s: any): Promise<any>; handleNonStream(s: any): Promise<any> },
    actualModel: string,
    isStream: boolean | undefined,
    transformed: any,
    latency: number
  ): Promise<ForwardResult> {
    const handler = new HandlerClass(actualModel)

    if (isStream) {
      const stream = await handler.handleStream(response.data)
      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        stream,
        skipTransform: true,
        latency,
        providerSessionId: adapterResult.sessionId || undefined,
      }
    }

    const result = await handler.handleNonStream(response.data)
    this.applyToolCallsToResponse(result, transformed)
    return {
      success: true,
      status: response.status,
      headers: this.extractHeaders(response.headers),
      body: result,
      latency,
      providerSessionId: adapterResult.sessionId || undefined,
    }
  }

  // extractErrorMessage is defined further down (single shared impl that
  // accepts the response object directly — either an AxiosResponse or the
  // adapter's wrapped `{status, data, headers}` shape). The forwardProxy
  // method calls it with the adapter's response object.

  /**
   * GLM Dedicated Forward — delegates to the unified ProxyAdapter forwarder.
   * The GLMAdapter is an in-process HTTP client that talks directly to
   * chat.z.ai (no external daemon process needed).
   */
  private async forwardGLM(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    return this.forwardProxy(
      GLMAdapter,
      GLMStreamHandler,
      request,
      account,
      provider,
      actualModel,
      startTime,
      '[GLM]'
    )
  }

  /**
   * Kimi Dedicated Forward — delegates to the unified ProxyAdapter forwarder.
   * The KimiAdapter is an in-process HTTP client that talks directly to
   * kimi.moonshot.cn (no external daemon process needed).
   */
  private async forwardKimi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    return this.forwardProxy(
      KimiAdapter,
      KimiStreamHandler,
      request,
      account,
      provider,
      actualModel,
      startTime,
      '[Kimi]'
    )
  }

  /**
   * Qwen Dedicated Forward — delegates to the unified ProxyAdapter forwarder.
   * The QwenAdapter is an in-process HTTP client that talks directly to
   * chat.qwen.ai (no external daemon process needed).
   */
  private async forwardQwen(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    return this.forwardProxy(
      QwenAdapter,
      QwenStreamHandler,
      request,
      account,
      provider,
      actualModel,
      startTime,
      '[Qwen]'
    )
  }

  /**
   * Qwen AI (International) Dedicated Forward — delegates to the unified
   * ProxyAdapter forwarder. The QwenAiAdapter is an in-process HTTP client
   * that talks directly to chat.qwen.ai (no external daemon process needed).
   */
  private async forwardQwen(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    return this.forwardProxy(
      QwenAiAdapter,
      QwenAiStreamHandler,
      request,
      account,
      provider,
      actualModel,
      startTime,
      '[QwenAi]'
    )
  }

  /**
   * Z.ai Dedicated Forward — delegates to the unified ProxyAdapter forwarder.
   * The ZaiAdapter is an in-process HTTP client that talks directly to
   * chat.z.ai (no external daemon process needed).
   */
  private async forwardZai(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    return this.forwardProxy(
      ZaiAdapter,
      ZaiStreamHandler,
      request,
      account,
      provider,
      actualModel,
      startTime,
      '[Zai]'
    )
  }

  /**
   * MiniMax Dedicated Forward
   */
  private async forwardMiniMax(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardMiniMax] actualModel:', actualModel)
    console.log('[forwardMiniMax] provider.modelMappings:', provider.modelMappings)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new MiniMaxAdapter(provider, account)
      const { response, stream, chatId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
      })

      const latency = Date.now() - startTime

      if (response && response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[MiniMax] Failed to delete chat:', error)
            }
          }
        : undefined

      if (request.stream === true && stream) {
        console.log('[forwardMiniMax] Using polling stream')
        
        if (deleteChatCallback) {
          const originalStream = stream.stream as unknown as PassThrough
          const originalEnd = originalStream.end.bind(originalStream)
          originalStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            deleteChatCallback(chatId).catch(err => {
              console.error('[MiniMax] Failed to delete chat:', err)
            })
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: stream.stream as any,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      if (response) {
        this.applyToolCallsToResponse(response.data, transformed)
        
        if (deleteChatCallback) {
          await deleteChatCallback(chatId)
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          body: response.data,
          latency,
          providerSessionId: chatId,
        }
      }

      return {
        success: false,
        error: 'No response or stream received',
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Mimo Dedicated Forward
   * Uses Mimo adapter for Xiaomi AI Studio
   */
  private async forwardMimo(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }
      const adapter = new MimoAdapter(provider, account)

      const { response, conversationId, query } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.originalModel,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteSessionCallback = shouldDeleteSession()
        ? async (sessionId: string) => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[Mimo] Failed to delete session:', error)
            }
          }
        : undefined

      const handler = new MimoStreamHandler(actualModel, conversationId, 'separate', transformed.plan)

      if (request.stream) {
        const transformedStream = new PassThrough()
        const openAIStream = handler.handleStream(response.data)

        ;(async () => {
          try {
            for await (const chunk of openAIStream) {
              transformedStream.write(chunk)
            }
            await adapter.generateConversationTitle(
              conversationId,
              query,
              handler.getAssistantContentForTitle()
            )
            if (deleteSessionCallback) {
              await deleteSessionCallback(conversationId)
            }
            transformedStream.end()
          } catch (error) {
            console.error('[Mimo] Stream error:', error)
            transformedStream.end()
          }
        })()

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: conversationId,
        }
      }

      const result = await handler.handleNonStream(response.data)
      const parsedResult = JSON.parse(result)
      this.applyToolCallsToResponse(parsedResult, transformed)
      await adapter.generateConversationTitle(
        conversationId,
        query,
        handler.getAssistantContentForTitle()
      )
      if (deleteSessionCallback) {
        await deleteSessionCallback(conversationId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: parsedResult,
        skipTransform: true,
        latency,
        providerSessionId: conversationId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      console.error('[Mimo] Forward error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Perplexity Dedicated Forward
   * Uses Electron's net API to bypass Cloudflare protection
   */
  private async forwardPerplexity(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardPerplexity] actualModel:', actualModel)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new PerplexityAdapter(provider, account)
      
      const { stream, sessionId } = await adapter.chatCompletion({
        model: actualModel,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
      })

      const latency = Date.now() - startTime

      if (request.stream === true) {
        const deleteSessionCallback = shouldDeleteSession()
          ? async () => {
              try {
                await adapter.deleteSession(sessionId)
              } catch (error) {
                console.error('[Perplexity] Failed to delete session:', error)
              }
            }
          : undefined

        const handler = new PerplexityStreamHandler(actualModel, sessionId, deleteSessionCallback, adapter)
        const transformedStream = await handler.handleStream(stream)
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: transformedStream as any,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const handler = new PerplexityStreamHandler(actualModel, sessionId, undefined, adapter)
      const result = await handler.handleNonStream(stream)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (shouldDeleteSession()) {
        await adapter.deleteSession(sessionId)
      }
      
      return {
        success: true,
        status: 200,
        headers: {},
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Build URL
   */
  private buildUrl(provider: Provider, path: string): string {
    let baseUrl = provider.apiEndpoint

    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1)
    }

    if (!path.startsWith('/')) {
      path = '/' + path
    }

    if (baseUrl.includes('/v1') && path.startsWith('/v1')) {
      path = path.slice(3)
    }

    return `${baseUrl}${path}`
  }

  /**
   * Build Request Headers
   */
  private buildHeaders(provider: Provider, account: Account): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...provider.headers,
    }

    const credentials = account.credentials

    if (credentials.token) {
      headers['Authorization'] = `Bearer ${credentials.token}`
    } else if (credentials.apiKey) {
      headers['Authorization'] = `Bearer ${credentials.apiKey}`
    } else if (credentials.accessToken) {
      headers['Authorization'] = `Bearer ${credentials.accessToken}`
    } else if (credentials.refreshToken) {
      headers['Authorization'] = `Bearer ${credentials.refreshToken}`
    }

    if (credentials.cookie) {
      headers['Cookie'] = credentials.cookie
    }

    if (credentials.sessionKey) {
      headers['X-Session-Key'] = credentials.sessionKey
    }

    return headers
  }

  /**
   * Build Request Body
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    actualModel: string,
    account: Account
  ): any {
    const body: any = {
      model: actualModel,
      messages: request.messages,
      stream: request.stream || false,
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p
    }

    if (request.n !== undefined) {
      body.n = request.n
    }

    if (request.stop !== undefined) {
      body.stop = request.stop
    }

    if (request.max_tokens !== undefined) {
      body.max_tokens = request.max_tokens
    }

    if (request.presence_penalty !== undefined) {
      body.presence_penalty = request.presence_penalty
    }

    if (request.frequency_penalty !== undefined) {
      body.frequency_penalty = request.frequency_penalty
    }

    if (request.logit_bias !== undefined) {
      body.logit_bias = request.logit_bias
    }

    if (request.user !== undefined) {
      body.user = request.user
    }

    return body
  }

  /**
   * Extract Response Headers
   */
  private extractHeaders(headers: any): Record<string, string> {
    const result: Record<string, string> = {}

    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result[key] = value
      } else if (Array.isArray(value)) {
        result[key] = value.join(', ')
      }
    }

    return result
  }

  /**
   * Extract Error Message
   *
   * Accepts either a standard AxiosResponse or the adapter's wrapped
   * `{status, data, headers}` shape (used by the in-process adapters that
   * wrap the upstream stream in a PassThrough). `any` is intentional — the
   * shape varies per caller.
   */
  private extractErrorMessage(response: any): string {
    if (response?.data) {
      if (typeof response.data === 'string') {
        return response.data
      }

      if (response.data.error?.message) {
        return response.data.error.message
      }

      if (response.data.message) {
        return response.data.message
      }

      if (response.data.msg) {
        return response.data.msg
      }

      try {
        return JSON.stringify(response.data)
      } catch {
        return 'Unknown error'
      }
    }

    return `HTTP ${response?.status ?? 'unknown'}`
  }

  /**
   * Delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Forward Request to Specified URL
   */
  async forwardToUrl(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: any,
    isStream: boolean = false
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    try {
      const config: AxiosRequestConfig = {
        method,
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: isStream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(config)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (isStream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }
}

export const requestForwarder = new RequestForwarder()
export default requestForwarder
