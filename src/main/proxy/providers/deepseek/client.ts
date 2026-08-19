/**
 * DeepSeekClient — TypeScript port of deepseek-api/deepseek/client.py
 *
 * Pure-HTTP DeepSeek chat client. Speaks chat.deepseek.com's internal API:
 *   1. creates a chat session   (POST /api/v0/chat_session/create)
 *   2. fetches a PoW challenge   (POST /api/v0/chat/create_pow_challenge)
 *   3. solves it via the WASM    (DeepSeekPow)
 *   4. POSTs the completion       with the x-ds-pow-response header
 *   5. parses the SSE stream
 *
 * No Python, no wasmtime — uses axios + WebAssembly API.
 */

import axios, { type AxiosInstance } from 'axios'
import { DeepSeekPow } from './pow'

const BASE = 'https://chat.deepseek.com'
const COMPLETION_PATH = '/api/v0/chat/completion'
const DEFAULT_MODEL_TYPE = 'default'

interface Session {
  token: string
  cookies: Record<string, string>
  userAgent: string
}

interface Reply {
  text: string
  conversationId: string
}

export class DeepSeekClient {
  private session: Session
  private pow: DeepSeekPow
  private http: AxiosInstance

  constructor(session: Session) {
    this.session = session
    this.pow = new DeepSeekPow()
    this.http = axios.create({
      baseURL: BASE,
      headers: {
        authorization: `Bearer ${session.token}`,
        accept: '*/*',
        'content-type': 'application/json',
        'user-agent': session.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        origin: BASE,
        referer: `${BASE}/`,
        'x-app-version': '2.0.0',
        'x-client-version': '2.0.0',
        'x-client-platform': 'web',
        'x-client-locale': 'en_US',
        'x-client-bundle-id': 'com.deepseek.chat',
        'x-client-timezone-offset': '0',
      },
      timeout: 120000,
    })
  }

  async init(): Promise<void> {
    await this.pow.init()
  }

  private async createChatSession(): Promise<string> {
    const r = await this.http.post('/api/v0/chat_session/create', {})
    const biz = r.data?.data?.biz_data
    return biz?.chat_session?.id
  }

  private async powHeader(targetPath: string = COMPLETION_PATH): Promise<string> {
    const r = await this.http.post('/api/v0/chat/create_pow_challenge', { target_path: targetPath })
    const challenge = r.data?.data?.biz_data?.challenge
    return this.pow.makeHeader(challenge)
  }

  async stream(
    prompt: string,
    conversationId?: string,
    model?: string,
    thinking: boolean = false,
    search: boolean = false,
  ): Promise<{ stream: AsyncGenerator<string>; conversationId: string }> {
    let sessionId: string | undefined
    let parentId: number | undefined
    if (conversationId) {
      const [sid, mid] = conversationId.split(':')
      sessionId = sid
      parentId = mid ? parseInt(mid) : undefined
    }
    if (!sessionId) {
      sessionId = await this.createChatSession()
    }

    const powResponse = await this.powHeader()
    const body: any = {
      chat_session_id: sessionId,
      prompt,
      ...(parentId !== undefined && { parent_message_id: parentId }),
      ...(model && !conversationId && { model_type: model || DEFAULT_MODEL_TYPE }),
      thinking,
      search,
    }

    const r = await this.http.post(COMPLETION_PATH, body, {
      headers: { 'x-ds-pow-response': powResponse },
      responseType: 'stream',
    })

    const convId = parentId !== undefined ? `${sessionId}:${parentId}` : sessionId

    const stream = (async function* () {
      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of r.data as any) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '[DONE]') return
            try {
              const parsed = JSON.parse(data)
              const content = parsed?.choices?.[0]?.delta?.content
              if (content) yield content
              if (parsed?.choices?.[0]?.finish_reason === 'stop') return
            } catch {}
          }
        }
      }
    })()

    return { stream, conversationId: convId }
  }

  async chat(prompt: string, conversationId?: string, model?: string, thinking?: boolean, search?: boolean): Promise<Reply> {
    const { stream, conversationId: convId } = await this.stream(prompt, conversationId, model, thinking, search)
    let text = ''
    for await (const chunk of stream) {
      text += chunk
    }
    return { text, conversationId: convId }
  }
}
