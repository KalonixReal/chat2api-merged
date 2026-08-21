/**
 * Notifications IPC handlers — exposes NotificationManager to the renderer.
 *
 * Channels:
 *   notifications:list             → AppNotification[]   (one-shot, last 50)
 *   notifications:dismiss(id)      → void
 *   notifications:dismissAll(s?)   → void
 *   notifications:subscribe        → sets up push: webContents.send('notifications:new', notif)
 *   notifications:solveCaptcha     → opens a browser window for the provider
 *   notifications:recoveryComplete → triggers smartSwitcher.recoverySequence()
 *
 * The push channel is set up the FIRST time `notifications:subscribe` is
 * invoked by any renderer. After that, every new notification is forwarded
 * to every non-destroyed BrowserWindow.
 *
 * CAPTCHA solve flow per provider:
 *   - qwen     → new BrowserWindow to https://chat.qwen.ai/  (qwengate picks up the session)
 *   - deepseek → spawn `.venv/bin/python -m deepseek.auth` in vendor/deepseek-api
 *   - glm      → new BrowserWindow to https://chat.z.ai/      (user copies JWT from DevTools)
 *   - kimi     → new BrowserWindow to https://kimi.com/
 *
 * The BrowserWindow is created with `nodeIntegration: false` and a normal
 * webPreferences profile — we are NOT trying to scrape cookies; the user solves
 * the CAPTCHA in their normal browser session and the standalone daemon
 * (qwengate / deepseek.auth / GLM / Kimi-Free-API) handles persistence.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { IpcChannels } from './channels'
import { notificationManager, type AppNotification, type NotificationSeverity } from '../notifications/NotificationManager'
import { daemonSupervisor } from '../supervisor'

// ---------------------------------------------------------------------------
// CAPTCHA solve — provider URL map
// ---------------------------------------------------------------------------

/** Per-provider target URL for the "Solve CAPTCHA" button (Qwen / GLM / Kimi). */
const CAPTCHA_URLS: Record<string, string> = {
  qwen: 'https://chat.qwen.ai/',
  glm: 'https://chat.z.ai/',
  zai: 'https://chat.z.ai/',
  kimi: 'https://kimi.com/',
}

// DeepSeek uses a python auth module — no URL, we spawn the venv python.
const DEEPSEEK_DAEMON_ID = 'deepseek-api'
const IS_WIN = process.platform === 'win32'
const DEEPSEEK_VENV_PYTHON = IS_WIN ? '.venv/Scripts/python.exe' : '.venv/bin/python'

// ---------------------------------------------------------------------------
// Push subscription (set up exactly once)
// ---------------------------------------------------------------------------

let pushWired = false

function wirePushToAllWindows(): void {
  if (pushWired) return
  pushWired = true
  // Every new notification → broadcast to every BrowserWindow that's not destroyed.
  notificationManager.onNew((notif: AppNotification) => {
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IpcChannels.NOTIFICATIONS_NEW, notif)
        }
      }
    } catch (err) {
      console.error('[IPC notifications] push to windows failed:', err)
    }
  })
}

// ---------------------------------------------------------------------------
// CAPTCHA solve — open a browser window for the provider
// ---------------------------------------------------------------------------

function openCaptchaWindow(providerId: string): { opened: boolean; error?: string } {
  const url = CAPTCHA_URLS[providerId]
  if (!url) {
    return { opened: false, error: `no CAPTCHA URL for provider '${providerId}'` }
  }
  try {
    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      title: `Solve CAPTCHA — ${providerId}`,
      autoHideMenuBar: true,
      webPreferences: {
        // No nodeIntegration — this is the user's normal browser session
        // on the upstream provider's site, not a privileged app window.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    void win.loadURL(url)
    // Bring to front so the user actually sees it.
    win.focus()
    return { opened: true }
  } catch (err) {
    return {
      opened: false,
      error: err instanceof Error ? err.message : 'failed to open BrowserWindow',
    }
  }
}

async function spawnDeepSeekAuth(): Promise<{ opened: boolean; error?: string }> {
  try {
    // Reuse the supervisor's spawnAuthWindow helper — it resolves cwd, sets env,
    // and pipes stdio to the parent terminal. The python module opens a
    // Playwright browser window where the user logs in.
    const ok = await daemonSupervisor.spawnAuthWindow(DEEPSEEK_DAEMON_ID, [
      DEEPSEEK_VENV_PYTHON,
      '-m',
      'deepseek.auth',
    ])
    return { opened: ok, error: ok ? undefined : 'spawn failed — see main log' }
  } catch (err) {
    return {
      opened: false,
      error: err instanceof Error ? err.message : 'deepseek.auth spawn threw',
    }
  }
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register the notifications IPC handlers + wire the push channel. Safe to
 * call multiple times — ipcMain.handle dedupes by channel name, and the push
 * subscription is guarded by `pushWired`.
 */
export function registerNotificationHandlers(_mainWindow: BrowserWindow | null): void {
  // Inject the mainWindow getter into the notification manager so it can
  // check `isFocused()` before firing desktop notifications. We use a getter
  // (not a captured ref) because the window can be recreated (e.g. after a
  // crash) and we want to always check the current focused window.
  notificationManager.setMainWindowGetter(() => {
    try {
      const focused = BrowserWindow.getFocusedWindow()
      return focused ? { isFocused: () => true } : null
    } catch {
      return null
    }
  })

  // Push subscription is wired once, regardless of whether the renderer has
  // asked for it yet. The renderer's `notifications:subscribe` call is a
  // no-op marker so the renderer can wait for the round-trip before
  // assuming push is live. Doing the wire here ensures that even multiple
  // windows (or windows opened later) get the push.
  wirePushToAllWindows()

  // 1. list — one-shot pull of the most recent notifications
  ipcMain.handle(IpcChannels.NOTIFICATIONS_LIST, async (): Promise<AppNotification[]> => {
    try {
      return notificationManager.list()
    } catch (err) {
      console.error('[IPC] notifications:list failed:', err)
      return []
    }
  })

  // 2. dismiss — mark one as read
  ipcMain.handle(
    IpcChannels.NOTIFICATIONS_DISMISS,
    async (_, args: { id: string }): Promise<{ success: boolean; error?: string }> => {
      try {
        if (!args?.id) {
          return { success: false, error: 'id is required' }
        }
        notificationManager.dismiss(args.id)
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'dismiss threw',
        }
      }
    }
  )

  // 3. dismissAll — mark all (optionally by severity) as read
  ipcMain.handle(
    IpcChannels.NOTIFICATIONS_DISMISS_ALL,
    async (_, args: { severity?: NotificationSeverity }): Promise<{ success: boolean }> => {
      try {
        notificationManager.dismissAll(args?.severity)
        return { success: true }
      } catch (err) {
        console.error('[IPC] notifications:dismissAll failed:', err)
        return { success: false }
      }
    }
  )

  // 4. subscribe — renderer ack that it wants push. Wire is already done
  //    (in `wirePushToAllWindows` above), but we return immediately with the
  //    current list so the renderer can hydrate its UI without a second IPC.
  ipcMain.handle(
    IpcChannels.NOTIFICATIONS_SUBSCRIBE,
    async (): Promise<{ ok: true; initial: AppNotification[] }> => {
      return { ok: true, initial: notificationManager.list() }
    }
  )

  // 5. solveCaptcha — open a BrowserWindow for the provider's login page
  ipcMain.handle(
    IpcChannels.NOTIFICATIONS_SOLVE_CAPTCHA,
    async (_, args: { providerId: string; accountId?: string }): Promise<{
      opened: boolean
      error?: string
    }> => {
      try {
        if (!args?.providerId) {
          return { opened: false, error: 'providerId is required' }
        }
        if (args.providerId === 'deepseek') {
          return spawnDeepSeekAuth()
        }
        return openCaptchaWindow(args.providerId)
      } catch (err) {
        return {
          opened: false,
          error: err instanceof Error ? err.message : 'solveCaptcha threw',
        }
      }
    }
  )

  // 6. recoveryComplete — user clicked "I've solved it", trigger recovery
  ipcMain.handle(
    IpcChannels.NOTIFICATIONS_RECOVERY_COMPLETE,
    async (_, args: { providerId: string; accountId?: string }): Promise<{
      ok: boolean
      result?: unknown
      error?: string
    }> => {
      try {
        if (!args?.providerId) {
          return { ok: false, error: 'providerId is required' }
        }
        return await notificationManager.triggerRecovery(args.providerId, args.accountId)
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'recoveryComplete threw',
        }
      }
    }
  )
}
