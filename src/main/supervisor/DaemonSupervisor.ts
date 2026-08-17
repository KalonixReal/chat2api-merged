/**
 * DaemonSupervisor — process supervisor for the 4 vendored standalone daemons.
 *
 * Each swapped provider (Qwen / DeepSeek / Z.ai-GLM / Kimi) forwards HTTP to a
 * standalone reverse-API daemon under vendor/. This supervisor:
 *
 *   1. Spawns the daemon child processes (via child_process.spawn).
 *   2. Pipes their stdout/stderr to logs/{id}.log under the project root.
 *   3. Polls each daemon's health endpoint every 15s after startAll().
 *   4. Detects unexpected child exits and auto-restarts (max 3 retries, 10s delay).
 *   5. Exposes a status-change subscription so the renderer can build a UI panel.
 *   6. Stops everything cleanly on app shutdown (SIGTERM → SIGKILL after 5s).
 *
 * The supervisor NEVER throws — all public methods resolve to either a result
 * or a void Promise. Failures are surfaced via DaemonStatus.detail so the UI
 * can show actionable error messages ("binary not built", "command not found", …).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import axios from 'axios'

// Node's ChildProcess type has a known typing quirk where `.on()` from EventEmitter
// isn't always resolved by tsc. We use a minimal structural type for storage and
// cast to `any` at the call site where we attach event listeners.
type AnyChild = ReturnType<typeof spawn>

/** Static configuration describing one vendored daemon. */
export interface DaemonSpec {
  /** Stable id used in logs and IPC (e.g. 'qwen-gate'). */
  id: string
  /** Human-readable label shown in the UI. */
  name: string
  /** Local TCP port the daemon listens on. */
  port: number
  /** HTTP path (no query) used for health checks. */
  healthPath: string
  /** Argv passed to spawn. [0] is the executable. */
  startCommand: string[]
  /** Working directory for the daemon. Resolved relative to project root. */
  cwd: string
  /** Extra environment variables for the daemon process. */
  env: Record<string, string>
  /** If false, the supervisor will still spawn the daemon but mark it optional. */
  required: boolean
}

/** Live status of a daemon at a point in time. */
export interface DaemonStatus {
  id: string
  name: string
  port: number
  /** True iff we believe the child process is currently running. */
  running: boolean
  /** OS pid of the spawned child, if any. */
  pid?: number
  /** True iff the health endpoint last responded 2xx within the timeout. */
  healthy: boolean
  /** Unix ms of the last health check. */
  lastCheck?: number
  /** Round-trip latency of the last successful health check, in ms. */
  latencyMs?: number
  /** Human-readable detail (error message, "binary not built", exit code, etc). */
  detail?: string
  /** Whether the supervisor will try to auto-restart on crash. */
  autoStart: boolean
}

/** Default daemon specs for the 4 vendored standalone projects. Windows-only. */
export const DEFAULT_DAEMON_SPECS: DaemonSpec[] = [
  {
    id: 'qwen-gate',
    name: 'Qwen Gate (Qwen)',
    port: 26405,
    healthPath: '/health',
    // bun.exe resolves via PATH (shell:true in spawn)
    startCommand: ['bun', 'src/index.tsx'],
    cwd: 'vendor/qwen-gate',
    env: { PORT: '26405' },
    required: true,
  },
  {
    id: 'deepseek-api',
    name: 'DeepSeek API (Python)',
    port: 8000,
    healthPath: '/v1/models',
    // Use the venv python — never the system python, so we don't pollute the
    // user's global env. On Windows, venv python lives at .venv/Scripts/python.exe.
    // app_windows.py imports the FastAPI app object directly (avoids uvicorn's
    // string-import resolution which fails on Windows with shell:true spawn).
    startCommand: ['.venv/Scripts/python.exe', 'app_windows.py'],
    cwd: 'vendor/deepseek-api',
    env: { PORT: '8000', HOST: '127.0.0.1' },
    required: true,
  },
  {
    id: 'glm-free-api',
    name: 'GLM-Free-API (Z.ai)',
    port: 3001,
    healthPath: '/v1/models',
    // Pre-built Windows binary (zai-api-windows-amd64.exe copied to zai-api.exe
    // by run.ts install). No Go runtime needed.
    startCommand: ['zai-api.exe'],
    cwd: 'vendor/glm-free-api',
    env: { PORT: '3001', AUTH_TOKEN: 'Waguri' },
    required: true,
  },
  {
    id: 'kimi-free-api',
    name: 'Kimi-Free-API',
    port: 5566,
    healthPath: '/v1/models',
    // Use 'start' (node dist/index.js) — dist/ is committed, no build needed.
    // 'dev' uses tsup --watch which is slow on Windows.
    startCommand: ['bun', 'run', 'start'],
    cwd: 'vendor/kimi-free-api',
    env: {},
    required: true,
  },
]

type StatusListener = (statuses: DaemonStatus[]) => void

interface ManagedDaemon {
  spec: DaemonSpec
  process: AnyChild | null
  /** OS-level fd of the open log file (closed on stop). */
  logFd: number | null
  /** Consecutive unexpected-exit restart attempts since last healthy check. */
  restartAttempts: number
  /** True if the user explicitly stopped the daemon — suppress auto-restart. */
  stopped: boolean
  /** Last known status (used for diffing before notifying listeners). */
  lastStatus: DaemonStatus
  /** Pending SIGKILL timer when stopOne issues SIGTERM. */
  killTimer: NodeJS.Timeout | null
}

const POLL_INTERVAL_MS = 15_000
const HEALTH_TIMEOUT_MS = 3_000
const RESTART_DELAY_MS = 10_000
const MAX_RESTART_ATTEMPTS = 3
const SIGKILL_GRACE_MS = 5_000

/**
 * File where user-set daemon env overrides are persisted so they survive app
 * restarts (e.g. ZAI_TOKEN for glm-free-api). Lives under config/ next to the
 * project root. Plain JSON — values may be secrets, but the file is on the
 * user's local disk, same as electron-store.
 */
const DAEMON_ENV_CONFIG_REL = 'config/daemon-env.json'

export class DaemonSupervisor {
  private readonly specs: DaemonSpec[]
  private readonly daemons: Map<string, ManagedDaemon> = new Map()
  private readonly listeners: Set<StatusListener> = new Set()
  private pollTimer: NodeJS.Timeout | null = null
  private readonly logsDir: string
  private readonly projectRoot: string

  constructor(specs: DaemonSpec[] = DEFAULT_DAEMON_SPECS, projectRoot?: string) {
    this.specs = specs
    // Resolve project root: prefer explicit, fall back to cwd (electron-vite
    // launches from project root, so process.cwd() is correct in dev).
    this.projectRoot = projectRoot || process.cwd()
    this.logsDir = join(this.projectRoot, 'logs')

    // Load any persisted env overrides (e.g. ZAI_TOKEN set by the user via the
    // Provider Setup page) so the saved config survives app restarts.
    const persistedEnv = this.loadPersistedEnv()
    for (const spec of specs) {
      if (persistedEnv[spec.id]) {
        spec.env = { ...spec.env, ...persistedEnv[spec.id] }
      }
      this.daemons.set(spec.id, {
        spec,
        process: null,
        logFd: null,
        restartAttempts: 0,
        stopped: true,
        killTimer: null,
        lastStatus: {
          id: spec.id,
          name: spec.name,
          port: spec.port,
          running: false,
          healthy: false,
          autoStart: spec.required,
        },
      })
    }
  }

  /** Subscribe to status changes. Returns an unsubscribe function. */
  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener)
    // Emit a snapshot immediately so the new listener can render.
    try {
      listener(this.snapshot())
    } catch (err) {
      console.error('[DaemonSupervisor] status listener threw:', err)
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Snapshot of every daemon's current status. */
  snapshot(): DaemonStatus[] {
    return Array.from(this.daemons.values()).map((d) => ({ ...d.lastStatus }))
  }

  /** Spawn every daemon and start the background health poller. */
  async startAll(): Promise<void> {
    try {
      if (!existsSync(this.logsDir)) {
        mkdirSync(this.logsDir, { recursive: true })
      }
    } catch (err) {
      console.error('[DaemonSupervisor] failed to create logs dir:', err)
      // Continue anyway — log files are best-effort.
    }

    for (const spec of this.specs) {
      try {
        await this.startOne(spec.id)
      } catch (err) {
        // startOne is supposed to never throw, but be defensive.
        console.error(`[DaemonSupervisor] startOne(${spec.id}) threw:`, err)
      }
    }

    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        this.checkAll().catch((err) => {
          console.error('[DaemonSupervisor] background checkAll failed:', err)
        })
      }, POLL_INTERVAL_MS)
      // Don't keep the Electron process alive on its own; we run as long as app lives.
      this.pollTimer.unref?.()
    }
  }

  /** Spawn a single daemon by id. Idempotent: returns early if already running. */
  async startOne(id: string): Promise<DaemonStatus | null> {
    const entry = this.daemons.get(id)
    if (!entry) {
      console.warn(`[DaemonSupervisor] unknown daemon id: ${id}`)
      return null
    }

    if (entry.process && !entry.process.killed) {
      return { ...entry.lastStatus }
    }

    const { spec } = entry

    // Pre-flight checks for known missing artifacts.
    const detail = this.preflight(spec)
    if (detail) {
      entry.lastStatus = {
        ...entry.lastStatus,
        running: false,
        healthy: false,
        pid: undefined,
        detail,
        lastCheck: Date.now(),
      }
      this.notify()
      console.warn(`[DaemonSupervisor] ${spec.id} preflight failed: ${detail}`)
      return { ...entry.lastStatus }
    }

    const cwd = resolve(this.projectRoot, spec.cwd)
    if (!existsSync(cwd)) {
      entry.lastStatus = {
        ...entry.lastStatus,
        running: false,
        healthy: false,
        pid: undefined,
        detail: `cwd missing: ${cwd}`,
        lastCheck: Date.now(),
      }
      this.notify()
      console.warn(`[DaemonSupervisor] ${spec.id} cwd missing: ${cwd}`)
      return { ...entry.lastStatus }
    }

    try {
      const logPath = join(this.logsDir, `${spec.id}.log`)
      const logFd = openSync(logPath, 'a')
      entry.logFd = logFd

      const childEnv = { ...process.env, ...spec.env } as NodeJS.ProcessEnv
      // On Windows, normalize the executable path to backslashes so cmd.exe
      // (used when shell:true) can resolve relative paths like
      // .venv\Scripts\python.exe. Forward slashes work in Node's spawn
      // without shell, but with shell:true cmd.exe handles them poorly.
      const isWin = process.platform === 'win32'
      const cmd0 = isWin ? spec.startCommand[0].replace(/\//g, '\\') : spec.startCommand[0]
      const cmdRest = isWin
        ? spec.startCommand.slice(1).map((a) => a.replace(/\//g, '\\'))
        : spec.startCommand.slice(1)
      // shell:true on Windows so bun.exe / python.exe / zai-api.exe resolve via PATHEXT
      const child = spawn(cmd0, cmdRest, {
        cwd,
        env: childEnv,
        stdio: ['ignore', logFd, logFd],
        detached: false,
        windowsHide: true,
        shell: true,
      })

      entry.process = child
      entry.stopped = false
      entry.restartAttempts = 0

      const pid = child.pid
      entry.lastStatus = {
        ...entry.lastStatus,
        running: true,
        healthy: false,
        pid,
        detail: undefined,
        lastCheck: Date.now(),
      }
      this.notify()
      console.log(
        `[DaemonSupervisor] started ${spec.id} pid=${pid} cmd=${spec.startCommand.join(' ')}`
      )

      (child as any).on('exit', (code, signal) => {
        // Cancel any pending SIGKILL timer.
        if (entry.killTimer) {
          clearTimeout(entry.killTimer)
          entry.killTimer = null
        }
        const wasRunning = !entry.stopped
        entry.process = null
        entry.lastStatus = {
          ...entry.lastStatus,
          running: false,
          healthy: false,
          pid: undefined,
          lastCheck: Date.now(),
          detail: `exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`,
        }
        this.notify()
        console.warn(`[DaemonSupervisor] ${spec.id} exited code=${code} signal=${signal}`)

        // Auto-restart only if the user did not explicitly stop us, and we
        // haven't exhausted the retry budget.
        if (wasRunning && entry.restartAttempts < MAX_RESTART_ATTEMPTS) {
          entry.restartAttempts += 1
          const attempt = entry.restartAttempts
          console.log(
            `[DaemonSupervisor] ${spec.id} auto-restart attempt ${attempt}/${MAX_RESTART_ATTEMPTS} in ${RESTART_DELAY_MS}ms`
          )
          const timer = setTimeout(() => {
            // Re-check that the user hasn't stopped us in the meantime.
            if (entry.stopped) {
              console.log(`[DaemonSupervisor] ${spec.id} cancel restart — user stopped`)
              return
            }
            this.startOne(spec.id).catch((err) => {
              console.error(`[DaemonSupervisor] ${spec.id} restart failed:`, err)
            })
          }, RESTART_DELAY_MS)
          timer.unref?.()
        } else if (wasRunning) {
          console.warn(
            `[DaemonSupervisor] ${spec.id} gave up after ${MAX_RESTART_ATTEMPTS} restart attempts`
          )
        }
      })

      (child as any).on('error', (err: NodeJS.ErrnoException) => {
        if (entry.killTimer) {
          clearTimeout(entry.killTimer)
          entry.killTimer = null
        }
        const detail =
          err.code === 'ENOENT'
            ? `command not found: ${spec.startCommand[0]} (PATH may not include bun/python/go)`
            : err.message
        entry.lastStatus = {
          ...entry.lastStatus,
          running: false,
          healthy: false,
          pid: undefined,
          detail,
          lastCheck: Date.now(),
        }
        this.notify()
        console.error(`[DaemonSupervisor] ${spec.id} spawn error:`, err)
      })

      return { ...entry.lastStatus }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      entry.lastStatus = {
        ...entry.lastStatus,
        running: false,
        healthy: false,
        pid: undefined,
        detail: `spawn failed: ${detail}`,
        lastCheck: Date.now(),
      }
      this.notify()
      console.error(`[DaemonSupervisor] ${spec.id} spawn threw:`, err)
      return { ...entry.lastStatus }
    }
  }

  /** Stop every daemon and stop the background poller. */
  async stopAll(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    await Promise.all(
      Array.from(this.daemons.keys()).map((id) =>
        this.stopOne(id).catch((err) => {
          console.error(`[DaemonSupervisor] stopOne(${id}) threw:`, err)
        })
      )
    )
  }

  /** Stop a single daemon gracefully (SIGTERM, then SIGKILL after 5s). */
  async stopOne(id: string): Promise<boolean> {
    const entry = this.daemons.get(id)
    if (!entry) {
      console.warn(`[DaemonSupervisor] unknown daemon id: ${id}`)
      return false
    }
    entry.stopped = true
    if (entry.killTimer) {
      clearTimeout(entry.killTimer)
      entry.killTimer = null
    }
    const child = entry.process
    if (!child || child.killed) {
      entry.process = null
      if (entry.logFd !== null) {
        try {
          closeSync(entry.logFd)
        } catch {
          // ignore
        }
        entry.logFd = null
      }
      return true
    }

    return new Promise<boolean>((resolveStop) => {
      let resolved = false
      const finish = () => {
        if (resolved) return
        resolved = true
        if (entry.killTimer) {
          clearTimeout(entry.killTimer)
          entry.killTimer = null
        }
        if (entry.logFd !== null) {
          try {
            closeSync(entry.logFd)
          } catch {
            // ignore
          }
          entry.logFd = null
        }
        resolveStop(true)
      }

      (child as any).once('exit', finish)

      try {
        child.kill('SIGTERM')
      } catch (err) {
        console.warn(`[DaemonSupervisor] ${id} SIGTERM failed:`, err)
      }

      entry.killTimer = setTimeout(() => {
        if (entry.process && !entry.process.killed) {
          try {
            entry.process.kill('SIGKILL')
          } catch (err) {
            console.warn(`[DaemonSupervisor] ${id} SIGKILL failed:`, err)
          }
        }
        // Give the SIGKILL a moment to take effect before resolving.
        setTimeout(finish, 200).unref?.()
      }, SIGKILL_GRACE_MS)
      // Don't keep the event loop alive just for the kill grace.
      entry.killTimer.unref?.()
    })
  }

  /** Ping every daemon's health endpoint and emit a status snapshot. */
  async checkAll(): Promise<DaemonStatus[]> {
    const results = await Promise.all(
      Array.from(this.daemons.values()).map((entry) => this.checkOne(entry.spec))
    )
    // Merge into stored status and notify if anything changed.
    let changed = false
    for (const status of results) {
      const entry = this.daemons.get(status.id)
      if (!entry) continue
      const prev = entry.lastStatus
      const processRunning = entry.process !== null && !entry.process.killed
      const nextDetail = status.detail ?? entry.lastStatus.detail
      if (
        prev.healthy !== status.healthy ||
        prev.latencyMs !== status.latencyMs ||
        prev.detail !== nextDetail
      ) {
        // Preserve pid/running from spawn tracking if the process is still alive.
        entry.lastStatus = {
          ...entry.lastStatus,
          healthy: status.healthy,
          latencyMs: status.latencyMs,
          lastCheck: status.lastCheck,
          detail: nextDetail,
          // If we believe the process is still alive but the health endpoint
          // is unreachable, keep running=true so the UI can show "degraded".
          running: processRunning ? true : status.running,
          pid: processRunning ? prev.pid : undefined,
        }
        changed = true
      } else {
        entry.lastStatus.lastCheck = status.lastCheck
      }
    }
    if (changed) {
      this.notify()
    }
    return this.snapshot()
  }

  // ---- public env + lifecycle mutators -----------------------------------

  /**
   * Merge environment-variable updates into a daemon's spec.env (in memory and
   * persisted to config/daemon-env.json so they survive restarts of both the
   * daemon and the Electron app itself). Used by the Provider Setup page when
   * the user saves a ZAI_TOKEN, e.g.
   *
   *   setDaemonEnv('glm-free-api', { ZAI_TOKEN: '<jwt>' })
   *
   * Does NOT restart the daemon — pair with restartDaemon(id) to apply.
   */
  setDaemonEnv(id: string, envUpdates: Record<string, string>): void {
    try {
      const entry = this.daemons.get(id)
      if (!entry) {
        console.warn(`[DaemonSupervisor] setDaemonEnv: unknown id ${id}`)
        return
      }
      entry.spec.env = { ...entry.spec.env, ...envUpdates }
      this.persistEnv(id, entry.spec.env)
      console.log(`[DaemonSupervisor] updated env for ${id}:`, Object.keys(envUpdates).join(', '))
    } catch (err) {
      console.error(`[DaemonSupervisor] setDaemonEnv(${id}) failed:`, err)
    }
  }

  /**
   * Read back the current spec.env for a daemon (used by the Provider Setup
   * page to decide if ZAI_TOKEN is configured).
   */
  getDaemonEnv(id: string): Record<string, string> {
    const entry = this.daemons.get(id)
    if (!entry) return {}
    return { ...entry.spec.env }
  }

  /**
   * Stop and restart a single daemon. Used by the Provider Setup page after
   * mutating env (e.g. saving a new ZAI_TOKEN). Returns the new status, or
   * null on unknown id.
   */
  async restartDaemon(id: string): Promise<boolean> {
    try {
      await this.stopOne(id)
      const status = await this.startOne(id)
      return status !== null
    } catch (err) {
      console.error(`[DaemonSupervisor] restartDaemon(${id}) failed:`, err)
      return false
    }
  }

  /**
   * Spawn a one-off command in the daemon's cwd, with stdio INHERITED from
   * the parent process. Used for browser-login flows where the daemon's
   * authentication requires an interactive browser window (e.g. DeepSeek's
   * `python -m deepseek.auth` opens Playwright).
   *
   * The returned promise resolves true as soon as the child has been spawned
   * — it does NOT wait for the auth flow to finish. The renderer is expected
   * to poll getStatus afterwards.
   */
  async spawnAuthWindow(id: string, command: string[]): Promise<boolean> {
    try {
      const entry = this.daemons.get(id)
      if (!entry) {
        console.warn(`[DaemonSupervisor] spawnAuthWindow: unknown id ${id}`)
        return false
      }
      const cwd = resolve(this.projectRoot, entry.spec.cwd)
      if (!existsSync(cwd)) {
        console.error(`[DaemonSupervisor] spawnAuthWindow: cwd missing: ${cwd}`)
        return false
      }

      const childEnv = { ...process.env, ...entry.spec.env } as NodeJS.ProcessEnv
      const useShell = process.platform === 'win32'
      const child = spawn(command[0], command.slice(1), {
        cwd,
        env: childEnv,
        // 'inherit' lets the auth subprocess open a browser window and stream
        // its stdout/stderr to the parent terminal so the user can see what
        // Playwright is doing.
        stdio: 'inherit',
        detached: true,
        windowsHide: false,
        shell: useShell,
      })

      (child as any).on('error', (err: NodeJS.ErrnoException) => {
        console.error(`[DaemonSupervisor] spawnAuthWindow(${id}) child error:`, err)
      })
      (child as any).on('exit', (code, signal) => {
        console.log(
          `[DaemonSupervisor] spawnAuthWindow(${id}) exited code=${code} signal=${signal}`
        )
      })

      // Detach so the auth subprocess keeps running even after the Electron
      // app exits (rare, but a user may quit while browser is open).
      try {
        child.unref()
      } catch {
        // ignore — unref is best-effort
      }

      console.log(
        `[DaemonSupervisor] spawnAuthWindow(${id}) spawned pid=${child.pid} cmd=${command.join(' ')}`
      )
      return true
    } catch (err) {
      console.error(`[DaemonSupervisor] spawnAuthWindow(${id}) threw:`, err)
      return false
    }
  }

  // ---- internals -----------------------------------------------------------

  private async checkOne(spec: DaemonSpec): Promise<DaemonStatus> {
    const url = `http://localhost:${spec.port}${spec.healthPath}`
    const start = Date.now()
    try {
      const resp = await axios.get(url, {
        timeout: HEALTH_TIMEOUT_MS,
        validateStatus: () => true,
      })
      const latencyMs = Date.now() - start
      const healthy = resp.status >= 200 && resp.status < 400
      return {
        id: spec.id,
        name: spec.name,
        port: spec.port,
        running: true,
        healthy,
        latencyMs,
        lastCheck: Date.now(),
        detail: healthy ? undefined : `HTTP ${resp.status}`,
        autoStart: spec.required,
      }
    } catch (err: unknown) {
      const latencyMs = Date.now() - start
      const detail =
        err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
          ? (err as { code: string }).code
          : err instanceof Error
            ? err.message
            : String(err)
      return {
        id: spec.id,
        name: spec.name,
        port: spec.port,
        running: false,
        healthy: false,
        latencyMs,
        lastCheck: Date.now(),
        detail,
        autoStart: spec.required,
      }
    }
  }

  /**
   * Pre-flight checks for known build/install artifacts.
   * install.sh creates all of these — if any are missing, the user hasn't run
   * install.sh yet. The supervisor surfaces a clear actionable message rather
   * than letting spawn fail cryptically.
   *
   * Returns a human-readable detail string if the daemon should not be started,
   * or empty string if preflight passed.
   */
  private preflight(spec: DaemonSpec): string {
    const cwd = resolve(this.projectRoot, spec.cwd)
    if (spec.id === 'glm-free-api') {
      // run.ts copies zai-api-windows-amd64.exe → zai-api.exe
      const binaryPath = join(cwd, 'zai-api.exe')
      if (!existsSync(binaryPath)) {
        return 'pre-built binary not found — run start.bat (or: bun run.ts install)'
      }
    }
    if (spec.id === 'kimi-free-api') {
      const nm = join(cwd, 'node_modules')
      if (!existsSync(nm)) {
        return 'deps not installed — run start.bat (or: bun run.ts install)'
      }
    }
    if (spec.id === 'deepseek-api') {
      const venvPython = join(cwd, '.venv', 'Scripts', 'python.exe')
      if (!existsSync(venvPython)) {
        return 'python venv not created — run start.bat (or: bun run.ts install)'
      }
    }
    if (spec.id === 'qwen-gate') {
      const nm = join(cwd, 'node_modules')
      if (!existsSync(nm)) {
        return 'deps not installed — run start.bat (or: bun run.ts install)'
      }
    }
    return ''
  }

  private notify(): void {
    const snapshot = this.snapshot()
    // Copy to a plain array first — tsconfig.node.json's target defaults to
    // ES3, which doesn't allow `for...of` on Set iterators.
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(snapshot)
      } catch (err) {
        console.error('[DaemonSupervisor] status listener threw:', err)
      }
    }
  }

  /**
   * Read the persisted env-override file (config/daemon-env.json) from disk.
   * Returns {} on missing/corrupt file — never throws.
   *
   * Shape: { '<daemonId>': { KEY: 'value', ... }, ... }
   */
  private loadPersistedEnv(): Record<string, Record<string, string>> {
    try {
      const path = join(this.projectRoot, DAEMON_ENV_CONFIG_REL)
      if (!existsSync(path)) return {}
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const out: Record<string, Record<string, string>> = {}
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (v && typeof v === 'object') {
            out[k] = v as Record<string, string>
          }
        }
        return out
      }
      return {}
    } catch (err) {
      console.warn('[DaemonSupervisor] failed to load persisted env:', err)
      return {}
    }
  }

  /** Persist env overrides for a single daemon to config/daemon-env.json. */
  private persistEnv(daemonId: string, env: Record<string, string>): void {
    try {
      const path = join(this.projectRoot, DAEMON_ENV_CONFIG_REL)
      const dir = join(this.projectRoot, 'config')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      const all = this.loadPersistedEnv()
      all[daemonId] = { ...env }
      writeFileSync(path, JSON.stringify(all, null, 2), 'utf8')
    } catch (err) {
      console.error(`[DaemonSupervisor] failed to persist env for ${daemonId}:`, err)
    }
  }
}

/** Singleton supervisor instance used by the Electron main process. */
export const daemonSupervisor = new DaemonSupervisor()

export default daemonSupervisor
