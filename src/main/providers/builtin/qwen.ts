import type { BuiltinProviderConfig } from '../../store/types'

export const qwenConfig: BuiltinProviderConfig = {
  id: 'qwen',
  name: 'Qwen',
  type: 'builtin',
  authType: 'jwt',
  apiEndpoint: 'https://chat.qwen.ai',
  chatPath: '/api/v2/chat/completions',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream, text/plain, */*',
    'source': 'web',
  },
  enabled: true,
  description: 'Qwen AI (International) — chat.qwen.ai',
  supportedModels: [
    'Qwen3.7-Max',
    'Qwen3.6-Plus',
    'Qwen3.6-35B-A3B',
    'Qwen3.6-27B',
    'Qwen3-Coder',
  ],
  modelMappings: {
    'Qwen3.7-Max': 'Qwen3.7-Max',
    'Qwen3.6-Plus': 'Qwen3.6-Plus',
    'Qwen3.6-35B-A3B': 'Qwen3.6-35B-A3B',
    'Qwen3.6-27B': 'Qwen3.6-27B',
    'Qwen3-Coder': 'Qwen3-Coder',
  },
  credentialFields: [
    {
      name: 'token',
      label: 'JWT Token (auto-obtained via email+password login)',
      type: 'password',
      required: false,
      placeholder: 'Auto-obtained — leave empty if using email+password',
      helpText: 'If you have a JWT token from chat.qwen.ai DevTools > Local Storage > token, paste it here. Otherwise, use email+password login.',
    },
    {
      name: 'email',
      label: 'Email',
      type: 'text',
      required: false,
      placeholder: 'your@email.com',
      helpText: 'Email for chat.qwen.ai login. The adapter will automatically login to obtain a session token.',
    },
    {
      name: 'password',
      label: 'Password',
      type: 'password',
      required: false,
      placeholder: '••••••••',
      helpText: 'Password for chat.qwen.ai login.',
    },
  ],
}

export default qwenConfig
