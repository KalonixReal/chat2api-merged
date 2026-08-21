/**
 * DeepSeekAdapter — in-process DeepSeek client (no external daemon).
 *
 * Ported from deepseek-api (Python) to TypeScript. Uses:
 *   - DeepSeekClient (axios HTTP + WASM PoW solver)
 *   - Account credentials from the store (token + cookies from browser login)
 *
 * No daemon process needed. Everything runs in-process.
 */

import { PassThrough } from 'stream'
import type { Account, Provider } from '../../store/types'
import { DeepSeekClient } from '../providers/deepseek/client'
import type { ProxyChatRequest } from './proxyAdapter'
import { ProxyStreamHandler } from './proxyStreamHandler'

export class DeepSeekStreamHandler extends ProxyStreamHandler {}

export class DeepSeekAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  static isDeepSeekProvider(p: Provider): boolean {
    return p.id === 'deepseek'
  }

  async chatCompletion(req: ProxyChatRequest): Promise<{
    response: any
    sessionId: string
  }> {
    const creds = (this.account.credentials || {}) as Record<string, any>
    const token = creds.token || creds.userToken || ''
    if (!token) {
      throw new Error('DeepSeek token not configured. Use Browser Login to get a session.')
    }

    const client = new DeepSeekClient({
      token,
      cookies: (creds.cookies as Record<string, string>) || {},
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    })
    await client.init()

    const prompt = req.messages.map((m: any) => m.content).join('\n')
    const { stream, conversationId } = await client.stream(
      prompt,
      req.conversation_id,
      req.model === 'deepseek-expert' ? 'expert' : 'default',
      req.reasoning_effort === 'high' || req.reasoning_effort === 'max',
      req.web_search === true,
    )

    // Create a PassThrough stream that we'll write OpenAI-format SSE to
    const passThrough = new PassThrough()
    const model = req.model || 'deepseek-chat'
    const id = `chatcmpl-deepseek-${Date.now()}`

    ;(async () => {
      for await (const chunk of stream) {
        const sseData = JSON.stringify({
          id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        })
        passThrough.write(`data: ${sseData}\n\n`)
      }
      passThrough.write(`data: {"id":"${id}","object":"chat.completion.chunk","created":${Math.floor(Date.now() / 1000)},"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`)
      passThrough.write('data: [DONE]\n\n')
      passThrough.end()
    })().catch((err) => {
      passThrough.destroy(err)
    })

    return {
      response: {
        status: 200,
        data: passThrough,
        headers: {},
      },
      sessionId: conversationId,
    }
  }

  async deleteSession(_sessionId: string): Promise<void> {}
  async deleteAllChats(): Promise<boolean> { return true }
}

export const deepSeekAdapter = { DeepSeekAdapter, DeepSeekStreamHandler }
export default deepSeekAdapter
