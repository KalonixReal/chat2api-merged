/**
 * NotificationManager — lightweight in-app notification system.
 *
 * Surfaces CAPTCHA blocks, throttle events, recovery outcomes, and daemon
 * crash/restart events to the user via two channels:
 *
 *   1. A persistent in-memory list (last 200, queried via IPC `notifications:list`)
 *   2. A push channel — every new notification is emitted as a 'new' event that
 *      the IPC layer forwards to every BrowserWindow via webContents.send.
 *
 * For severity 'error' or 'captcha', we ALSO fire a native OS desktop
 * notification via Electron's `Notification` API — but only if the main window
 * is not focused (we don't want to spam the user while they're looking at the
 * dashboard).
 *
 * Persistence: the notification list is debounced-written to
 * `<projectRoot>/data/notifications.json` (last 200, rotated). On boot, the
 * file is loaded back so notifications survive app restarts.
 *
 * The manager subscribes to two upstream event sources:
 *   - The Smart Switcher (src/main/proxy/smartSwitcher.ts, Task 6 — may not
 *     exist yet) — emits 'captcha-required', 'throttled', 'recovery-success',
 *     'recovery-failed'. Subscribed via dynamic import + try/catch so the
 *     notification system keeps working even if the switcher isn't built.
 *   - The DaemonSupervisor (onStatusChange) — diffs daemon status snapshots
 *     and emits notifications on crash (running true→false) and recovery
 *     (healthy false→true).
 *
 * The class extends EventEmitter so the IPC layer can subscribe to 'new'
 * events with `notificationManager.onNew(callback)` without coupling to
 * Node's EventEmitter directly.
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationSeverity = 'info' | 'warn' | 'error' | 'captcha'

export interface AppNotification {
  /** Stable unique id (uuid v4 string). */
  id: string
  /** Severity — drives icon, color, and whether a desktop notification fires. */
  severity: NotificationSeverity
  /** Short one-line title. */
  title: string
  /** Longer multi-line description (kept under ~300 chars). */
  body: string
  /** Optional provider id ('qwen' | 'deepseek' | 'glm' | 'kimi' | …). */
  providerId?: string
  /** Optional account id (for per-account CAPTCHA / throttle events). */
  accountId?: string
  /** Unix ms of creation. */
  timestamp: number
  /** True once the user has dismissed / acknowledged the notification. */
  dismissed: boolean
}

/** Shape accepted by `add()` — id/timestamp/dismissed are auto-populated. */
export type NewNotification = Omit<AppNotification, 'id' | 'timestamp' | 'dismissed'>

/** Minimal structural interface for the main BrowserWindow we care about. */
interface MainWindowLike {
  isFocused: () => boolean
}

/** Minimal structural interface for the smart switcher (Task 6). */
interface SmartSwitcherLike {
  on?(event: string, listener: (...args: unknown[]) => void): unknown
  off?(event: string, listener: (...args: unknown[]) => void): unknown
  once?(event: string, listener: (...args: unknown[]) => void): unknown
  /** Optional — called by `notifications:recoveryComplete` IPC handler. */
  recoverySequence?(providerId: string, accountId?: string): Promise<unknown>
}

/** Minimal structural interface for the DaemonSupervisor we subscribe to. */
interface SupervisorLike {
  onStatusChange(
    listener: (statuses: Array<{
      id: string
      name: string
      port: number
      running: boolean
      healthy: boolean
      detail?: string
    }>) => void
  ): () => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PERSISTED = 200
const MAX_LIST_RETURN = 50
const PERSIST_DEBOUNCE_MS = 400
const DATA_DIR_REL = 'data'
const PERSIST_FILE_NAME = 'notifications.json'

// Smart-switcher event names we try to subscribe to. Any missing event is
// silently skipped — Task 6 may rename or add events; we degrade gracefully.
const SMART_SWITCHER_EVENTS: ReadonlyArray<{
  event: string
  build: (args: unknown[]) => NewNotification
}> = [
  {
    event: 'captcha-required',
    build: (args) => {
      const a = pickArgs(args)
      return {
        severity: 'captcha',
        title: 'CAPTCHA required',
        body: a.message || `Manual intervention needed for ${a.providerId || 'provider'}${a.accountId ? ` (${a.accountId})` : ''}.`,
        providerId: a.providerId,
        accountId: a.accountId,
      }
    },
  },
  {
    event: 'throttled',
    build: (args) => {
      const a = pickArgs(args)
      const untilStr = a.until ? ` until ${new Date(a.until as number).toLocaleString()}` : ''
      return {
        severity: 'warn',
        title: 'Account throttled',
        body: `${a.providerId || 'Provider'}${a.accountId ? ` account ${a.accountId}` : ''} is throttled${untilStr}.`,
        providerId: a.providerId,
        accountId: a.accountId,
      }
    },
  },
  {
    event: 'recovery-success',
    build: (args) => {
      const a = pickArgs(args)
      return {
        severity: 'info',
        title: 'Recovery succeeded',
        body: `${a.providerId || 'Provider'}${a.accountId ? ` account ${a.accountId}` : ''} recovered successfully.`,
        providerId: a.providerId,
        accountId: a.accountId,
      }
    },
  },
  {
    event: 'recovery-failed',
    build: (args) => {
      const a = pickArgs(args)
      return {
        severity: 'error',
        title: 'Recovery failed',
        body: `${a.providerId || 'Provider'}${a.accountId ? ` account ${a.accountId}` : ''} recovery failed${a.error ? `: ${a.error}` : '.'}`,
        providerId: a.providerId,
        accountId: a.accountId,
      }
    },
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull common fields out of a variadic event payload. */
function pickArgs(args: unknown[]): {
  providerId?: string
  accountId?: string
  message?: string
  error?: string
  until?: number
} {
  const first = args[0]
  if (first && typeof first === 'object') {
    const o = first as Record<string, unknown>
    return {
      providerId: typeof o.providerId === 'string' ? o.providerId : undefined,
      accountId: typeof o.accountId === 'string' ? o.accountId : undefined,
      message: typeof o.message === 'string' ? o.message : undefined,
      error: typeof o.error === 'string' ? o.error : undefined,
      until: typeof o.until === 'number' ? o.until : undefined,
    }
  }
  if (typeof first === 'string') {
    return { message: first }
  }
  return {}
}

/** Map a daemon id from the supervisor to a providerId used by the smart switcher. */
function daemonIdToProviderId(daemonId: string): string | undefined {
  switch (daemonId) {
    case 'qwen-gate':
      return 'qwen'
    case 'deepseek-api':
      return 'deepseek'
    case 'glm-free-api':
      return 'glm'
    case 'kimi-free-api':
      return 'kimi'
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// NotificationManager
// ---------------------------------------------------------------------------

export class NotificationManager extends EventEmitter {
  private readonly notifications: AppNotification[] = []
  private readonly projectRoot: string
  private readonly dataDir: string
  private readonly persistPath: string
  private persistTimer: NodeJS.Timeout | null = null
  private mainWindowRef: (() => MainWindowLike | null) | null = null
  private smartSwitcherRef: SmartSwitcherLike | null = null
  private lastSupervisorSnapshot: Map<string, { running: boolean; healthy: boolean }> = new Map()

  constructor(projectRoot?: string) {
    super()
    this.projectRoot = projectRoot || process.cwd()
    this.dataDir = join(this.projectRoot, DATA_DIR_REL)
    this.persistPath = join(this.dataDir, PERSIST_FILE_NAME)
    this.loadFromDisk()
  }

  /**
   * Inject a getter for the main BrowserWindow so we can check `isFocused()`
   * before firing desktop notifications. Decoupled from Electron's BrowserWindow
   * type so unit tests don't need to mock Electron.
   */
  setMainWindowGetter(getter: (() => MainWindowLike | null)): void {
    this.mainWindowRef = getter
  }

  /**
   * Add a notification. Persists (debounced), emits 'new', and fires a desktop
   * notification if severity is 'error' or 'captcha' AND the main window is
   * not focused.
   */
  add(notif: NewNotification): AppNotification {
    const full: AppNotification = {
      ...notif,
      id: randomUUID(),
      timestamp: Date.now(),
      dismissed: false,
    }
    this.notifications.unshift(full)
    // Cap the in-memory list — older entries are dropped silently.
    if (this.notifications.length > MAX_PERSISTED) {
      this.notifications.length = MAX_PERSISTED
    }
    this.schedulePersist()

    // Notify in-process subscribers (the IPC layer wires this to renderer push).
    try {
      this.emit('new', full)
    } catch (err) {
      console.error('[NotificationManager] emit new threw:', err)
    }

    // Desktop notification for high-severity events when window not focused.
    if (full.severity === 'error' || full.severity === 'captcha') {
      const focused = this.mainWindowRef?.()?.isFocused() ?? false
      if (!focused) {
        this.fireDesktopNotification(full)
      }
    }
    return full
  }

  /** Returns the most recent N notifications, newest first. */
  list(): AppNotification[] {
    return this.notifications.slice(0, MAX_LIST_RETURN)
  }

  /** Returns all undismissed notifications (no cap). */
  listUndismissed(): AppNotification[] {
    return this.notifications.filter((n) => !n.dismissed)
  }

  /** Mark a single notification as dismissed by id. */
  dismiss(id: string): void {
    const n = this.notifications.find((x) => x.id === id)
    if (n && !n.dismissed) {
      n.dismissed = true
      this.schedulePersist()
      this.emit('dismissed', n)
    }
  }

  /** Mark all (or all of a given severity) as dismissed. */
  dismissAll(severity?: NotificationSeverity): void {
    let changed = false
    for (const n of this.notifications) {
      if (!n.dismissed && (!severity || n.severity === severity)) {
        n.dismissed = true
        changed = true
      }
    }
    if (changed) {
      this.schedulePersist()
      this.emit('dismissedAll', { severity })
    }
  }

  /** Subscribe to new notifications. Returns an unsubscribe function. */
  onNew(callback: (notif: AppNotification) => void): () => void {
    const wrapped = (n: AppNotification): void => {
      try {
        callback(n)
      } catch (err) {
        console.error('[NotificationManager] onNew listener threw:', err)
      }
    }
    this.on('new', wrapped)
    return () => {
      this.off('new', wrapped)
    }
  }

  /**
   * Dynamically import the smart switcher (Task 6) and subscribe to its
   * events. Wrapped in try/catch — if the module doesn't exist yet, or any
   * event subscription fails, we log a warning and continue. The
   * notification system still works for daemon events.
   */
  async subscribeToSmartSwitcher(): Promise<void> {
    try {
      // `import()` of a possibly-missing module returns `any` — cast through
      // `unknown` first so TypeScript doesn't try to verify the structural shape
      // of the smartSwitcher module against our local SmartSwitcherLike.
      //
      // `.catch(() => null)` converts a missing-module rejection into `null`
      // so we can detect "module not present" without throwing.
      const mod = (await import('../proxy/smartSwitcher').catch(() => null)) as unknown as {
        smartSwitcher?: SmartSwitcherLike
        default?: SmartSwitcherLike
      } | null
      if (!mod) {
        console.warn(
          '[NotificationManager] smartSwitcher module not found — Task 6 not yet built. CAPTCHA/throttle notifications will not fire from the switcher (daemon events still work).'
        )
        return
      }
      const sw = mod.smartSwitcher || mod.default
      if (!sw) {
        console.warn('[NotificationManager] smartSwitcher module loaded but no singleton exported — skipping subscription')
        return
      }
      this.smartSwitcherRef = sw

      for (const cfg of SMART_SWITCHER_EVENTS) {
        if (typeof sw.on !== 'function') continue
        const listener = (...args: unknown[]): void => {
          try {
            const built = cfg.build(args)
            this.add(built)
          } catch (err) {
            console.error(`[NotificationManager] smartSwitcher '${cfg.event}' handler threw:`, err)
          }
        }
        try {
          sw.on(cfg.event, listener)
        } catch (err) {
          console.warn(`[NotificationManager] smartSwitcher.on('${cfg.event}') failed:`, err)
        }
      }
      console.log('[NotificationManager] subscribed to smartSwitcher events')
    } catch (err) {
      // Module not found or import failed — expected during Task 6 build phase.
      console.warn(
        '[NotificationManager] smartSwitcher not available (will not emit captcha/throttle notifications from switcher):',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  /**
   * Subscribe to daemon supervisor status changes. Emits notifications on:
   *   - Crash: running true → false (and not user-initiated)
   *   - Recovered: healthy false → true
   *   - Restarted after crash (running false → true after a recent crash)
   */
  subscribeToSupervisor(supervisor: SupervisorLike): void {
    try {
      supervisor.onStatusChange((statuses) => {
        try {
          for (const s of statuses) {
            const prev = this.lastSupervisorSnapshot.get(s.id)
            this.lastSupervisorSnapshot.set(s.id, { running: s.running, healthy: s.healthy })
            if (!prev) continue
            // Crash: was running, now not.
            if (prev.running && !s.running) {
              this.add({
                severity: 'error',
                title: `Daemon crashed: ${s.name}`,
                body: `${s.name} (port ${s.port}) exited unexpectedly. The supervisor will try to auto-restart (max 3 attempts).${s.detail ? ` Detail: ${s.detail}` : ''}`,
                providerId: daemonIdToProviderId(s.id),
              })
            }
            // Recovered: was not healthy, now healthy.
            else if (!prev.healthy && s.healthy) {
              this.add({
                severity: 'info',
                title: `Daemon recovered: ${s.name}`,
                body: `${s.name} (port ${s.port}) is healthy again.`,
                providerId: daemonIdToProviderId(s.id),
              })
            }
          }
        } catch (err) {
          console.error('[NotificationManager] supervisor onStatusChange handler threw:', err)
        }
      })
    } catch (err) {
      console.error('[NotificationManager] subscribeToSupervisor failed:', err)
    }
  }

  /**
   * Trigger the smart switcher's recovery sequence for a specific provider/account.
   * Called by the `notifications:recoveryComplete` IPC handler when the user
   * clicks "I've solved it" in the CAPTCHA banner. Returns whatever the smart
   * switcher returns (or `{ ok: false, error: 'unavailable' }` if it's missing).
   */
  async triggerRecovery(
    providerId: string,
    accountId?: string
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    try {
      if (!this.smartSwitcherRef) {
        // Try one more lazy import in case the manager started before the
        // smart switcher module was on disk (Task 6 might land later).
        await this.subscribeToSmartSwitcher()
      }
      const sw = this.smartSwitcherRef
      if (!sw) {
        return { ok: false, error: 'smartSwitcher unavailable — Task 6 not yet built' }
      }
      if (typeof sw.recoverySequence !== 'function') {
        return { ok: false, error: 'smartSwitcher does not expose recoverySequence()' }
      }
      const result = await sw.recoverySequence(providerId, accountId)
      return { ok: true, result }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // ---- internals -----------------------------------------------------------

  private fireDesktopNotification(notif: AppNotification): void {
    // Dynamic import — Electron's Notification only works in the main process
    // and only when the app is ready. Don't crash the manager if it fails.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Notification: ElectronNotification } = require('electron') as {
        Notification: new (opts: {
          title: string
          body: string
          urgency?: 'normal' | 'critical'
        }) => {
          show: () => void
          on: (event: string, cb: () => void) => void
        }
      }
      if (typeof ElectronNotification !== 'function') {
        return
      }
      const n = new ElectronNotification({
        title: notif.title,
        body: notif.body,
        urgency: notif.severity === 'captcha' ? 'critical' : 'normal',
      })
      n.on('click', () => {
        // Best-effort: focus the main window on click. The IPC layer wires the
        // actual focus — we just emit so the renderer can pick it up.
        try {
          this.emit('clicked', notif)
        } catch {
          // ignore
        }
      })
      n.show()
    } catch (err) {
      console.warn('[NotificationManager] desktop notification failed:', err)
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, PERSIST_DEBOUNCE_MS)
    // Don't keep the event loop alive for a debounce timer.
    this.persistTimer.unref?.()
  }

  private persistNow(): void {
    try {
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true })
      }
      const slice = this.notifications.slice(0, MAX_PERSISTED)
      writeFileSync(this.persistPath, JSON.stringify(slice, null, 2), 'utf8')
    } catch (err) {
      console.error('[NotificationManager] persist failed:', err)
    }
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.persistPath)) return
      const raw = readFileSync(this.persistPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      for (const n of parsed) {
        if (n && typeof n === 'object' && typeof n.id === 'string' && typeof n.timestamp === 'number') {
          this.notifications.push(n as AppNotification)
        }
      }
      // Already newest-first on disk; if not, sort.
      this.notifications.sort((a, b) => b.timestamp - a.timestamp)
      // Cap to MAX_PERSISTED in case the file was hand-edited.
      if (this.notifications.length > MAX_PERSISTED) {
        this.notifications.length = MAX_PERSISTED
      }
    } catch (err) {
      console.warn('[NotificationManager] failed to load persisted notifications:', err)
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const notificationManager = new NotificationManager()
export default notificationManager
