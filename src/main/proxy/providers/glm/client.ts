/**
 * GLM Client — TypeScript port of glm-free-api/main.go
 *
 * Pure-HTTP Z.ai (GLM) chat client. Speaks chat.z.ai's internal API:
 *   1. Initializes guest session (POST /api/v1/auths/guest)
 *   2. Sends chat completion (POST /api/chat/completions)
 *   3. Parses the SSE stream
 *
 * Uses axios + node:crypto instead of Go's http/2 + crypto packages.
 * The Aliyun captcha token harvesting is skipped for now — guest mode
 * works without it (glm-4.7 only). For full models, a ZAI_TOKEN is needed.
 */

import axios, { type AxiosInstance } from 'axios'

const BASE_URL = 'https://chat.z.ai'

interface Message {
  role: string
  content: string | any[]
}

interface GLMOptions {
  model?: string
  chatId?: string
  stream?: boolean
  reasoningEffort?: string
  zaiToken?: string
}

export class GLMClient {
  private http: AxiosInstance
  private token: string | null
  private guestId: string | null = null

  constructor(zaiToken?: string) {
    this.token = zaiToken || null
    this.http = axios.create({
      baseURL: BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
      },
      timeout: 120000,
    })
  }

  async initGuest(): Promise<void> {
    if (this.token) return // Skip if we have a JWT
    try {
      const r = await this.http.post('/api/v1/auths/guest', {})
      if (r.data?.token) {
        this.token = r.data.token
        this.guestId = r.data?.user?.id || null
      }
    } catch (err: any) {
      console.error('[GLM] Guest init failed:', err?.message)
    }
  }

  async stream(
    messages: Message[],
    options: GLMOptions = {},
  ): Promise<{ stream: AsyncGenerator<string>; chatId: string }> {
    await this.initGuest()

    const chatId = options.chatId || crypto.randomUUID()
    const model = options.model || 'glm-4.7'
    const stream = options.stream !== false

    const body: any = {
      model,
      messages,
      stream,
      chat_id: chatId,
      ...(options.reasoningEffort && { reasoning_effort: options.reasoningEffort }),
    }

    const headers: Record<string, string> = {}
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }

    const r = await this.http.post('/api/chat/completions', body, {
      headers,
      responseType: 'stream',
    })

    const result = (async function* () {
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

    return { stream: result, chatId }
  }

  async chat(messages: Message[], options: GLMOptions = {}): Promise<{ text: string; chatId: string }> {
    const { stream, chatId } = await this.stream(messages, { ...options, stream: false })
    let text = ''
    for await (const chunk of stream) {
      text += chunk
    }
    return { text, chatId }
  }

  async getModels(): Promise<any[]> {
    await this.initGuest()
    const headers: Record<string, string> = {}
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    const r = await this.http.get('/api/models', { headers })
    return r.data?.data || []
  }
}
