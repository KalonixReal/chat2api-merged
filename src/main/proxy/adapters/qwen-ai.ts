/**
 * QwenAiAdapter — in-process Qwen AI (International) client.
 * Uses JWT token from account credentials.
 *
 * Calls the Qwen international API directly and converts the upstream SSE to
 * standard OpenAI-format SSE using a PassThrough stream.
 */

import type { Account, Provider } from '../../store/types'
import type { ProxyChatRequest } from './proxyAdapter'
import { ProxyStreamHandler } from './proxyStreamHandler'
import { wrapAsOpenAISSE } from './upstreamToOpenAISSE'

export class QwenAiStreamHandler extends ProxyStreamHandler {}

const QWEN_AI_BASE = 'https://chat.qwen.ai'

/** Drain a stream into a string. Used to read upstream error bodies. */
async function drainStream(stream: NodeJS.ReadableStream): Promise<string> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of stream as any) {
    buf += decoder.decode(chunk, { stream: true })
  }
  return buf
}

export class QwenAiAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  static isQwenAiProvider(p: Provider): boolean {
    return p.id === 'qwen-ai'
  }

  async chatCompletion(req: ProxyChatRequest): Promise<{
    response: any
    sessionId: string
  }> {
    const creds = this.account.credentials || {}
    const token = creds.token || creds.jwt || ''

    const body = {
      model: req.model || 'Qwen3.7-Max',
      messages: req.messages,
      stream: req.stream !== false,
      ...(req.conversation_id && { conversation_id: req.conversation_id }),
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      source: 'web',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const axios = (await import('axios')).default
    const resp = await axios.post(`${QWEN_AI_BASE}/api/v2/chat/completions`, body, {
      headers,
      responseType: 'stream',
      timeout: 120000,
      validateStatus: () => true,
    })

    // On error, drain the body and return a structured error object so the
    // forwarder's extractErrorMessage() can pull the message out.
    if (resp.status >= 400) {
      const raw = await drainStream(resp.data as NodeJS.ReadableStream)
      let parsed: any = raw
      try { parsed = JSON.parse(raw) } catch { /* keep raw */ }
      return {
        response: {
          status: resp.status,
          data: parsed,
          headers: resp.headers,
        },
        sessionId: req.conversation_id || '',
      }
    }

    const model = req.model || 'Qwen3.7-Max'
    const id = `chatcmpl-qwenai-${Date.now()}`

    // Wrap the upstream SSE in an OpenAI-format PassThrough so the
    // ProxyStreamHandler can pass it through unchanged.
    const passThrough = wrapAsOpenAISSE(
      resp.data as NodeJS.ReadableStream,
      model,
      id,
    )

    return {
      response: {
        status: resp.status,
        data: passThrough,
        headers: resp.headers,
      },
      sessionId: req.conversation_id || '',
    }
  }

  async deleteSession(_sessionId: string): Promise<void> {}
  async deleteAllChats(): Promise<boolean> { return true }
}

export const qwenAiAdapter = { QwenAiAdapter, QwenAiStreamHandler }
export default qwenAiAdapter

import { ProxyStreamHandler } from './proxyStreamHandler'
