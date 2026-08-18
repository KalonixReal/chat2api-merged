/**
 * GLM adapter — proxy to izaart95-jpg/GLM-Free-API (vendored under
 * daemons/glm-free-api).
 *
 * Replaces the original 1097-LOC GLMAdapter. The Go server on :3001 speaks
 * OpenAI /v1/chat/completions AND Anthropic /v1/messages, handles z.ai captcha
 * token harvesting into SQLite, and supports both guest mode (glm-4.7) and
 * authenticated mode (ZAI_TOKEN env var for all models).
 */

import { ProxyAdapter } from './proxyAdapter'
import { ProxyStreamHandler } from './proxyStreamHandler'
import type { Account, Provider } from '../../store/types'

export const GLM_FREE_API_PORT = 3001

export class GLMAdapter extends ProxyAdapter {
  constructor(provider: Provider, account: Account) {
    super(
      {
        id: 'glm',
        port: GLM_FREE_API_PORT,
        matches: GLMAdapter.isGLMProvider,
        // GLM-Free-API defaults AUTH_TOKEN to 'Waguri'; if user set it in
        // their account credentials, use that, else fall through to default.
        apiKeyFrom: (account) =>
          account.credentials?.authToken ||
          account.credentials?.token ||
          account.credentials?.zaiToken,
      },
      provider,
      account,
    )
  }

  static isGLMProvider(p: Provider): boolean {
    return p.id === 'glm'
  }
}

export class GLMStreamHandler extends ProxyStreamHandler {}

export const glmAdapter = {
  GLMAdapter,
  GLMStreamHandler,
}

export default glmAdapter
