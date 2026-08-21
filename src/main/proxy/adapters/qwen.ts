/**
 * QwenAdapter — in-process Qwen client.
 *
 * Calls Qwen's chat completions API directly with the account credentials.
 * The upstream returns SSE in a Qwen-native format; this adapter converts
 * it to standard OpenAI-format SSE using a PassThrough stream.
 */

import { PassThrough } from 'stream'
import type { Account, Provider } from '../../store/types'
import type { ProxyChatRequest } from './proxyAdapter'
import { ProxyStreamHandler } from './proxyStreamHandler'
import { wrapAsOpenAISSE } from './upstreamToOpenAISSE'

export class QwenStreamHandler extends ProxyStreamHandler {}

const QWEN_API_BASE = 'https://chat.qwen.ai'
const QWEN_CHAT_COMPLETIONS_URL = `${QWEN_API_BASE}/api/v2/chat/completions`
const QWEN_MODELS_URL = `${QWEN_API_BASE}/api/models`

/** Drain a stream into a string. Used to read upstream error bodies. */
async function drainStream(stream: NodeJS.ReadableStream): Promise<string> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of stream as any) {
    buf += decoder.decode(chunk, { stream: true })
  }
  return buf
}

export class QwenAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  static isQwenProvider(p: Provider): boolean {
    return p.id === 'qwen'
  }

  async chatCompletion(req: ProxyChatRequest): Promise<{
    response: any
    sessionId: string
  }> {
    const creds = this.account.credentials || {}
    const ticket = creds.ticket || creds.tongyi_sso_ticket || ''

    // Build the Qwen API request
    const body = {
      model: req.model || 'Qwen3.7-Max',
      messages: req.messages,
      stream: req.stream !== false,
      chat_type: 't2t',
      ...(req.conversation_id && { conversation_id: req.conversation_id }),
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Origin: 'https://www.qianwen.com',
      Referer: 'https://www.qianwen.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'X-Platform': 'pc_tongyi',
    }
    if (ticket) {
      headers['Cookie'] = `tongyi_sso_ticket=${ticket}`
    }

    const axios = (await import('axios')).default
    const resp = await axios.post(QWEN_CHAT_COMPLETIONS_URL, body, {
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
    const id = `chatcmpl-qwen-${Date.now()}`

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

export const qwenAdapter = { QwenAdapter, QwenStreamHandler }
export default qwenAdapter

import { ProxyStreamHandler } from './proxyStreamHandler'
