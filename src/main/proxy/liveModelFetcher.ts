/**
 * LiveModelFetcher — fetches the actual model list from each running daemon's
 * /v1/models endpoint. This complements the hardcoded supportedModels in
 * builtin/*.ts — live models from daemons are always more accurate because
 * daemons talk to the upstream API and know what's actually available right now.
 *
 * For example: qwengate now serves qwen3.8-max, but the hardcoded list in
 * builtin/qwen.ts only goes up to Qwen3.7-Max. This fetcher bridges that gap
 * so the dashboard always shows what the daemon can actually serve.
 */

import axios from 'axios'

export interface LiveModel {
  id: string
  object?: string
  owned_by?: string
  context_window?: number
  description?: string
}

export interface LiveModelsResult {
  providerId: string
  models: LiveModel[]
  fetchedAt: number
  error?: string
}

interface DaemonModelConfig {
  providerId: string
  port: number
  auth?: string
}

const DAEMON_CONFIGS: DaemonModelConfig[] = [
  { providerId: 'qwen', port: 26405 },
  { providerId: 'qwen-ai', port: 26405 },
  { providerId: 'deepseek', port: 8000 },
  { providerId: 'glm', port: 3001, auth: 'Waguri' },
  { providerId: 'zai', port: 3001, auth: 'Waguri' },
  { providerId: 'kimi', port: 5566 },
]

/** Fetch live models from a single daemon with a 5s timeout. */
export async function fetchLiveModels(providerId: string): Promise<LiveModelsResult> {
  const cfg = DAEMON_CONFIGS.find((c) => c.providerId === providerId)
  if (!cfg) {
    return { providerId, models: [], fetchedAt: Date.now(), error: `no daemon config for ${providerId}` }
  }

  try {
    const headers: Record<string, string> = {}
    if (cfg.auth) headers['Authorization'] = `Bearer ${cfg.auth}`

    const resp = await axios.get(`http://localhost:${cfg.port}/v1/models`, {
      headers,
      timeout: 5000,
      validateStatus: () => true,
    })

    if (resp.status >= 400) {
      return { providerId, models: [], fetchedAt: Date.now(), error: `HTTP ${resp.status}` }
    }

    const data = resp.data
    const models: LiveModel[] = Array.isArray(data?.data)
      ? data.data.map((m: any) => ({
          id: m.id || m.name || '',
          object: m.object,
          owned_by: m.owned_by,
          context_window: m.context_window,
          description: m.description,
        }))
      : Array.isArray(data?.models)
        ? data.models.map((id: string) => ({ id }))
        : []

    return { providerId, models, fetchedAt: Date.now() }
  } catch (err: any) {
    return {
      providerId,
      models: [],
      fetchedAt: Date.now(),
      error: err?.code || err?.message || 'unreachable',
    }
  }
}

/** Fetch live models from ALL daemons in parallel. */
export async function fetchAllLiveModels(): Promise<LiveModelsResult[]> {
  return Promise.all(DAEMON_CONFIGS.map((c) => fetchLiveModels(c.providerId)))
}

/**
 * Merge live daemon models with the hardcoded supportedModels.
 * Live models that aren't in the hardcoded list are marked as "discovered"
 * so the UI can prompt the user to add them.
 */
export function mergeModels(
  hardcoded: string[],
  live: LiveModel[]
): { id: string; inHardcoded: boolean; live: boolean; contextWindow?: number; description?: string }[] {
  const merged: { id: string; inHardcoded: boolean; live: boolean; contextWindow?: number; description?: string }[] = []
  const liveIds = new Set(live.map((m) => m.id))

  // Hardcoded models (mark live=true if daemon also reports them)
  for (const id of hardcoded) {
    const liveModel = live.find((m) => m.id === id)
    merged.push({
      id,
      inHardcoded: true,
      live: liveIds.has(id),
      contextWindow: liveModel?.context_window,
      description: liveModel?.description,
    })
  }

  // Live-only models (not in hardcoded list) — "discovered" models
  for (const m of live) {
    if (!hardcoded.includes(m.id)) {
      merged.push({
        id: m.id,
        inHardcoded: false,
        live: true,
        contextWindow: m.context_window,
        description: m.description,
      })
    }
  }

  return merged
}
