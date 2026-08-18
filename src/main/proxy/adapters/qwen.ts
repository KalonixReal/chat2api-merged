/**
 * Qwen adapter — proxy to youssefvdel/qwen-gate (vendored under daemons/qwen-gate)
 *
 * Replaces the original 1180-LOC QwenAdapter. qwengate speaks OpenAI
 * /v1/chat/completions natively and handles the chat.qwen.ai reverse protocol
 * (browserless wreq-js + Playwright login, bx-ua captcha token generation,
 * multi-account round-robin).
 */

import { ProxyAdapter } from './proxyAdapter'
import { ProxyStreamHandler } from './proxyStreamHandler'
import type { Account, Provider } from '../../store/types'

export const QWEN_GATE_PORT = 26405

export class QwenAdapter extends ProxyAdapter {
  constructor(provider: Provider, account: Account) {
    super(
      {
        id: 'qwen',
        port: QWEN_GATE_PORT,
        matches: QwenAdapter.isQwenProvider,
      },
      provider,
      account,
    )
  }

  static isQwenProvider(p: Provider): boolean {
    return p.id === 'qwen' || p.id === 'qwen-ai'
  }
}

export class QwenStreamHandler extends ProxyStreamHandler {}

export const qwenAdapter = {
  QwenAdapter,
  QwenStreamHandler,
}

export default qwenAdapter
