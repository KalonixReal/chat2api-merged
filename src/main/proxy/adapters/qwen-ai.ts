/**
 * Qwen AI (International) adapter — also proxies to qwen-gate.
 *
 * qwengate supports both the China (chat.qwen.ai SSO) and International
 * (chat.qwen.ai JWT) Qwen logins; we route both Qwen provider variants to the
 * same daemon on :26405. The account's auth method (SSO ticket vs JWT) is
 * configured in qwengate's own dashboard, not here.
 */

import { ProxyAdapter } from './proxyAdapter'
import { ProxyStreamHandler } from './proxyStreamHandler'
import type { Account, Provider } from '../../store/types'
import { QWEN_GATE_PORT } from './qwen'

export class QwenAiAdapter extends ProxyAdapter {
  constructor(provider: Provider, account: Account) {
    super(
      {
        id: 'qwen-ai',
        port: QWEN_GATE_PORT,
        matches: QwenAiAdapter.isQwenAiProvider,
      },
      provider,
      account,
    )
  }

  static isQwenAiProvider(p: Provider): boolean {
    return p.id === 'qwen-ai'
  }
}

export class QwenAiStreamHandler extends ProxyStreamHandler {}

export const qwenAiAdapter = {
  QwenAiAdapter,
  QwenAiStreamHandler,
}

export default qwenAiAdapter
