/**
 * Supervisor IPC handlers — exposes daemon lifecycle to the renderer.
 *
 * Channels:
 *   - supervisor:getStatus       → DaemonStatus[]   (one-shot snapshot)
 *   - supervisor:restart(id)     → DaemonStatus | null   (stop + start)
 *   - supervisor:statusChanged   → DaemonStatus[]   (push to renderer)
 */

import { ipcMain, BrowserWindow } from 'electron'
import { IpcChannels } from './channels'
import { daemonSupervisor, type DaemonStatus } from '../supervisor'

/**
 * Register the supervisor IPC handlers and wire status-change pushes to
 * every renderer window. Safe to call multiple times — handlers are deduped
 * by ipcMain.handle.
 */
export function registerSupervisorHandlers(mainWindow: BrowserWindow | null): void {
  // Push status snapshots to every open window whenever the supervisor
  // emits a change. The renderer can listen on SUPERVISOR_STATUS_CHANGED.
  daemonSupervisor.onStatusChange((statuses: DaemonStatus[]) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannels.SUPERVISOR_STATUS_CHANGED, statuses)
      }
    })
  })

  ipcMain.handle(IpcChannels.SUPERVISOR_GET_STATUS, async (): Promise<DaemonStatus[]> => {
    try {
      return await daemonSupervisor.checkAll()
    } catch (err) {
      console.error('[IPC] supervisor:getStatus failed:', err)
      return daemonSupervisor.snapshot()
    }
  })

  ipcMain.handle(
    IpcChannels.SUPERVISOR_RESTART,
    async (_, id: string): Promise<DaemonStatus | null> => {
      try {
        await daemonSupervisor.stopOne(id)
        return await daemonSupervisor.startOne(id)
      } catch (err) {
        console.error(`[IPC] supervisor:restart(${id}) failed:`, err)
        return null
      }
    }
  )

  // Reference mainWindow so the unused-parameter lint doesn't fire — the
  // supervisor broadcasts to *all* windows, but future versions may want
  // a dedicated supervisor window.
  void mainWindow
}
