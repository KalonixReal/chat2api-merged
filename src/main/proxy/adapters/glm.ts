/**
 * GLMAdapter — in-process Z.ai (GLM) client (no external daemon).
 *
 * Ported from glm-free-api (Go) to TypeScript. Uses:
 *   - GLMClient (axios HTTP + guest/JWT auth)
 *   - Account credentials from the store
 *
 * No daemon process needed. Everything runs in-process.
 */

import { PassThrough } from 'stream'
import type { Account, Provider } from '../../store/types'
import { GLMClient } from '../providers/glm/client'
import type { ProxyChatRequest } from './proxyAdapter'
import { ProxyStreamHandler } from './proxyStreamHandler'

export class GLMStreamHandler extends ProxyStreamHandler {}

export class GLMAdapter {
  private provider: Provider
  private account: Account
  private zaiToken?: string

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    this.zaiToken = account.credentials?.zaiToken || account.credentials?.token
  }

  static isGLMProvider(p: Provider): boolean {
    return p.id === 'glm' || p.id === 'zai'
  }

  async chatCompletion(req: ProxyChatRequest): Promise<{
    response: any
    sessionId: string
  }> {
    const client = new GLMClient(this.zaiToken)
    const messages = req.messages.map((m: any) => ({
      role: m.role,
      content: m.content,
    }))

    const { stream, chatId } = await client.stream(messages, {
      model: req.model || 'glm-4.7',
      stream: req.stream !== false,
      reasoningEffort: req.reasoning_effort,
    })

    const passThrough = new PassThrough()
    const model = req.model || 'glm-4.7'
    const id = `chatcmpl-glm-${Date.now()}`

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
      sessionId: chatId,
    }
  }

  async deleteSession(_sessionId: string): Promise<void> {}
  async deleteAllChats(): Promise<boolean> { return true }
}

export const glmAdapter = { GLMAdapter, GLMStreamHandler }
export default glmAdapter

import { ProxyStreamHandler } from './proxyStreamHandler'
