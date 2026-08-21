/**
 * LiveModelFetcher — fetches models directly from each provider's API.
 * No daemons needed — calls the upstream APIs directly.
 */
import axios from 'axios'
import { storeManager } from '../store/store'

export interface LiveModel { id: string; owned_by?: string; context_window?: number; description?: string }
export interface LiveModelsResult { providerId: string; models: LiveModel[]; fetchedAt: number; error?: string }

const URLS: Record<string, string> = {
  qwen: 'https://chat.qwen.ai/api/models',
  'qwen-ai': 'https://chat.qwen.ai/api/models',
  deepseek: 'https://chat.deepseek.com/api/v0/models',
  glm: 'https://chat.z.ai/api/models',
  zai: 'https://chat.z.ai/api/models',
  kimi: 'https://kimi.moonshot.cn/api/models',
}

export async function fetchLiveModels(providerId: string): Promise<LiveModelsResult> {
  const url = URLS[providerId]
  if (!url) return { providerId, models: [], fetchedAt: Date.now(), error: `no URL for ${providerId}` }
  try {
    const accounts = storeManager.getAccountsByProviderId(providerId, true)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (accounts.length > 0) {
      const token = accounts[0].credentials?.token || accounts[0].credentials?.ticket
      if (token) headers['Authorization'] = `Bearer ${token}`
    }
    const resp = await axios.get(url, { headers, timeout: 5000, validateStatus: () => true })
    if (resp.status >= 400) return { providerId, models: [], fetchedAt: Date.now(), error: `HTTP ${resp.status}` }
    const models: LiveModel[] = Array.isArray(resp.data?.data) ? resp.data.data.map((m: any) => ({ id: m.id || m.name || '' })) : Array.isArray(resp.data?.models) ? resp.data.models.map((id: string) => ({ id })) : []
    return { providerId, models, fetchedAt: Date.now() }
  } catch (err: any) { return { providerId, models: [], fetchedAt: Date.now(), error: err?.code || err?.message || 'unreachable' } }
}

export async function fetchAllLiveModels(): Promise<LiveModelsResult[]> {
  return Promise.all(Object.keys(URLS).map((id) => fetchLiveModels(id)))
}

export function mergeModels(hardcoded: string[], live: LiveModel[]) {
  const merged: { id: string; inHardcoded: boolean; live: boolean; contextWindow?: number; description?: string }[] = []
  const liveIds = new Set(live.map((m) => m.id))
  for (const id of hardcoded) merged.push({ id, inHardcoded: true, live: liveIds.has(id) })
  for (const m of live) if (!hardcoded.includes(m.id)) merged.push({ id: m.id, inHardcoded: false, live: true, contextWindow: m.context_window, description: m.description })
  return merged
}
