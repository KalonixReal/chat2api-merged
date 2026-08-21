/**
 * QwenAiAdapter — now redirects to QwenAdapter.
 * Qwen (International) and Qwen AI are the same provider: chat.qwen.ai
 */
export { QwenAdapter as QwenAiAdapter, qwenAdapter as qwenAiAdapter } from './qwen'
import { ProxyStreamHandler } from './proxyStreamHandler'
export class QwenAiStreamHandler extends ProxyStreamHandler {}
export default { QwenAiAdapter, QwenAiStreamHandler, qwenAiAdapter }
