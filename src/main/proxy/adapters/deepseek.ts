/**
 * DeepSeek adapter — proxy to sums001/Deepseek-API (vendored under
 * daemons/deepseek-api).
 *
 * Replaces the original 474-LOC DeepSeekAdapter + 637-LOC DeepSeekStreamHandler.
 * sums001/Deepseek-API runs a FastAPI server on :8000 speaking OpenAI
 * /v1/chat/completions. It handles DeepSeek's PoW WASM solver via wasmtime and
 * Playwright session refresh internally.
 */

import { ProxyAdapter } from './proxyAdapter'
import { ProxyStreamHandler } from './proxyStreamHandler'
import type { Account, Provider } from '../../store/types'

export const DEEPSEEK_API_PORT = 8000

export class DeepSeekAdapter extends ProxyAdapter {
  constructor(provider: Provider, account: Account) {
    super(
      {
        id: 'deepseek',
        port: DEEPSEEK_API_PORT,
        matches: DeepSeekAdapter.isDeepSeekProvider,
      },
      provider,
      account,
    )
  }

  static isDeepSeekProvider(p: Provider): boolean {
    return p.id === 'deepseek'
  }
}

export class DeepSeekStreamHandler extends ProxyStreamHandler {}

export const deepSeekAdapter = {
  DeepSeekAdapter,
  DeepSeekStreamHandler,
}

export default deepSeekAdapter
