/**
 * Kimi adapter — proxy to xiaoY233/Kimi-Free-API (vendored under
 * vendor/kimi-free-api).
 *
 * Replaces the original 956-LOC KimiAdapter. The Koa server on :5566 speaks
 * OpenAI /v1/chat/completions, handles Kimi's Connect-RPC protocol, JWT auth,
 * and the K2 thinking models.
 */

import { ProxyAdapter } from './proxyAdapter'
import { ProxyStreamHandler } from './proxyStreamHandler'
import type { Account, Provider } from '../../store/types'

export const KIMI_FREE_API_PORT = 5566

export class KimiAdapter extends ProxyAdapter {
  constructor(provider: Provider, account: Account) {
    super(
      {
        id: 'kimi',
        port: KIMI_FREE_API_PORT,
        matches: KimiAdapter.isKimiProvider,
        apiKeyFrom: (account) =>
          account.credentials?.jwtToken ||
          account.credentials?.token ||
          account.credentials?.refreshToken,
      },
      provider,
      account,
    )
  }

  static isKimiProvider(p: Provider): boolean {
    return p.id === 'kimi'
  }
}

export class KimiStreamHandler extends ProxyStreamHandler {}

export const kimiAdapter = {
  KimiAdapter,
  KimiStreamHandler,
}

export default kimiAdapter
