/**
 * ProxyStreamHandler — passthrough stream/non-stream handler.
 *
 * The original Chat2API had a bespoke XxxStreamHandler per provider that parsed
 * the upstream's proprietary SSE format (Qwen's chat2-api, DeepSeek's PoW
 * protocol, GLM's z.ai format, Kimi's Connect-RPC) and converted it to OpenAI
 * format. The standalone daemons already do this conversion internally and
 * return OpenAI-format SSE — so we just pass the bytes through.
 *
 * Handler contract (from src/main/proxy/forwarder.ts):
 *   handleStream(stream) → NodeJS.ReadableStream   (for stream=true)
 *   handleNonStream(stream) → Promise<any>         (for stream=false, returns full JSON)
 */

import { PassThrough } from 'stream'

export class ProxyStreamHandler {
  private model: string

  constructor(model: string) {
    this.model = model
  }

  /**
   * Pass the upstream SSE stream through unchanged. The forwarder will pipe
   * this into the HTTP response to the OpenAI client (Qwen Code, curl, etc.).
   */
  async handleStream(stream: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream> {
    const passThrough = new PassThrough()
    stream.on('data', (chunk: Buffer) => {
      passThrough.write(chunk)
    })
    stream.on('end', () => {
      passThrough.end()
    })
    stream.on('error', (err: Error) => {
      passThrough.destroy(err)
    })
    return passThrough
  }

  /**
   * Collect the full response body and return it as parsed JSON.
   * Used for non-streaming requests. The upstream already returns OpenAI
   * format, so we just parse and return.
   */
  async handleNonStream(stream: NodeJS.ReadableStream): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        try {
          const parsed = JSON.parse(raw)
          resolve(parsed)
        } catch {
          // Upstream returned non-JSON (error page?). Wrap it.
          resolve({
            id: `chatcmpl-proxy-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: this.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: raw },
                finish_reason: 'stop',
              },
            ],
            _proxy_warning: 'upstream returned non-JSON body',
          })
        }
      })
      stream.on('error', reject)
    })
  }
}
