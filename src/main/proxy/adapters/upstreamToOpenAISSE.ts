/**
 * upstreamToOpenAISSE — generic upstream-SSE → OpenAI-SSE converter.
 *
 * Many reverse-API providers (Qwen, Qwen-AI, Kimi) return SSE in their
 * native format which isn't always 1:1 OpenAI-compatible. This helper reads
 * each `data:` line from the upstream stream, extracts the assistant content
 * delta (trying several common shapes), and rewrites the line as a standard
 * OpenAI chat.completion.chunk.
 *
 * Supported upstream payload shapes (tried in order):
 *   - OpenAI:    {choices:[{delta:{content:"..."}}]}
 *   - OpenAI non-stream: {choices:[{message:{content:"..."}}]}
 *   - Top-level: {content:"..."}
 *   - Top-level: {delta:{content:"..."}}
 *   - Plain string: data:<text>
 *
 * Anything that doesn't match is silently dropped (likely a usage chunk,
 * role chunk, or finish_reason chunk).
 */

import { PassThrough } from 'stream'

export function pipeUpstreamToOpenAISSE(
  upstream: NodeJS.ReadableStream,
  passThrough: PassThrough,
  model: string,
  id: string,
): void {
  const decoder = new TextDecoder()
  let buffer = ''
  const created = Math.floor(Date.now() / 1000)

  const emitChunk = (content: string) => {
    if (!content) return
    const payload = JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })
    passThrough.write(`data: ${payload}\n\n`)
  }

  upstream.on('data', (chunk: Buffer) => {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          passThrough.write('data: [DONE]\n\n')
          return
        }
        try {
          const parsed = JSON.parse(data)
          // OpenAI-style: choices[0].delta.content
          const choice = parsed?.choices?.[0]
          if (choice?.delta?.content) {
            emitChunk(choice.delta.content)
            continue
          }
          // OpenAI-style: choices[0].message.content (non-streamed chunks)
          if (choice?.message?.content) {
            emitChunk(choice.message.content)
            continue
          }
          // Some providers emit {content: "..."} at top level
          if (typeof parsed?.content === 'string') {
            emitChunk(parsed.content)
            continue
          }
          // Some emit {delta: {content: "..."}} at top level
          if (parsed?.delta?.content) {
            emitChunk(parsed.delta.content)
            continue
          }
          // Otherwise — silently drop (likely a usage chunk, role chunk, etc.)
        } catch {
          // Non-JSON payload — treat the raw string as content.
          if (data && data !== '[DONE]') emitChunk(data)
        }
      } else if (line.startsWith('event:')) {
        // Event-type line — ignore (we keep OpenAI format which only uses data:)
        continue
      } else {
        // Unknown line — ignore.
      }
    }
  })

  upstream.on('end', () => {
    // Flush the final stop chunk
    const stopPayload = JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })
    passThrough.write(`data: ${stopPayload}\n\n`)
    passThrough.write('data: [DONE]\n\n')
    passThrough.end()
  })

  upstream.on('error', (err: Error) => {
    passThrough.destroy(err)
  })
}

/** Build the OpenAI-format PassThrough stream for an upstream SSE response. */
export function wrapAsOpenAISSE(
  upstream: NodeJS.ReadableStream,
  model: string,
  id: string,
): PassThrough {
  const passThrough = new PassThrough()
  pipeUpstreamToOpenAISSE(upstream, passThrough, model, id)
  return passThrough
}
