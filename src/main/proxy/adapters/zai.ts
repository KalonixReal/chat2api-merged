export { GLMAdapter as ZaiAdapter, glmAdapter as zaiAdapter } from './glm'
import { ProxyStreamHandler } from './proxyStreamHandler'
export class ZaiStreamHandler extends ProxyStreamHandler {}
export default { ZaiAdapter, ZaiStreamHandler, zaiAdapter }
