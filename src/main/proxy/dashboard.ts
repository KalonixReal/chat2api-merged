/**
 * Dashboard HTML — served at GET /dashboard
 *
 * A single-page web dashboard (like qwengate's dashboard) that exposes all
 * the features of the former Electron UI via HTTP. No build step, no React —
 * just vanilla HTML + CSS + JS that talks to the /v0/management/dashboard/*
 * API routes.
 *
 * Features:
 *   - Daemon health overview (qwen-gate, deepseek-api, glm-free-api, kimi-free-api)
 *   - Provider Setup cards (add Qwen accounts, DeepSeek login, Z.ai/Kimi tokens)
 *   - Models page with live model discovery from daemons
 *   - Notifications (bell icon with badge, CAPTCHA banner, toast popups)
 *   - Session management (active sessions, throttled accounts)
 *   - Logs viewer
 *   - Real-time refresh (polls every 5s)
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'koa'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Serve the dashboard HTML. */
export async function serveDashboard(ctx: Context): Promise<void> {
  try {
    const htmlPath = join(__dirname, 'dashboard.html')
    const html = readFileSync(htmlPath, 'utf-8')
    ctx.type = 'text/html; charset=utf-8'
    ctx.body = html
  } catch (err: any) {
    ctx.status = 500
    ctx.type = 'text/plain'
    ctx.body = `Failed to load dashboard: ${err?.message || 'unknown error'}`
  }
}
