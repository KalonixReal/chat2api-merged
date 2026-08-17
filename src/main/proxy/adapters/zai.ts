/**
 * Z.ai adapter — also proxies to GLM-Free-API on :3001.
 *
 * izaart95-jpg/GLM-Free-API serves both the Chinese zhipuai glm.ai endpoint
 * and the international chat.z.ai endpoint; z.ai JWT tokens unlock all
 * models. We route both Chat2API provider ids ('glm' and 'zai') to the same
 * daemon. The ZAI_TOKEN env var (or account credential) selects guest vs
 * authenticated mode.
 */

import { ProxyAdapter } from './proxyAdapter'
import { ProxyStreamHandler } from './proxyStreamHandler'
import type { Account, Provider } from '../../store/types'
import { GLM_FREE_API_PORT } from './glm'

export class ZaiAdapter extends ProxyAdapter {
  constructor(provider: Provider, account: Account) {
    super(
      {
        id: 'zai',
        port: GLM_FREE_API_PORT,
        matches: ZaiAdapter.isZaiProvider,
        apiKeyFrom: (account) =>
          account.credentials?.zaiToken ||
          account.credentials?.token ||
          account.credentials?.authToken,
      },
      provider,
      account,
    )
  }

  static isZaiProvider(p: Provider): boolean {
    return p.id === 'zai'
  }
}

export class ZaiStreamHandler extends ProxyStreamHandler {}

export const zaiAdapter = {
  ZaiAdapter,
  ZaiStreamHandler,
}

export default zaiAdapter
