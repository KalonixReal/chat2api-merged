/**
 * Browser Login IPC handlers — wires BrowserLoginManager into the IPC layer.
 *
 * Exposes:
 *   login:providers     → list supported providers + their login methods
 *   login:browser       → open a Playwright browser for the user to log in
 *   login:token         → save a token/cookie the user pasted manually
 *   login:email         → email + password login (Playwright fills the form)
 *   login:massImport    → mass-import accounts from JSON
 *
 * Every handler is wrapped in try/catch and resolves to a structured
 * response — never throws to the renderer.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { IpcChannels } from './channels'
import { browserLoginManager } from '../proxy/browserLoginManager'

export function registerBrowserLoginHandlers(_mainWindow: BrowserWindow | null): void {
  // 1. login:providers — list all supported providers
  ipcMain.handle(IpcChannels.LOGIN_PROVIDERS, async () => {
    try {
      return { success: true, providers: browserLoginManager.getProviders() }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'login:providers threw',
        providers: [],
      }
    }
  })

  // 2. login:browser — open a Playwright browser for the user to log in
  ipcMain.handle(
    IpcChannels.LOGIN_BROWSER,
    async (_, args: { providerId: string }): Promise<{ success: boolean; token?: string; message: string }> => {
      try {
        if (!args?.providerId) {
          return { success: false, message: 'providerId is required' }
        }
        return await browserLoginManager.loginWithBrowser(args.providerId)
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : 'login:browser threw',
        }
      }
    }
  )

  // 3. login:token — save a token the user pasted manually
  ipcMain.handle(
    IpcChannels.LOGIN_TOKEN,
    async (_, args: { providerId: string; token: string }): Promise<{ success: boolean; message: string }> => {
      try {
        if (!args?.providerId) {
          return { success: false, message: 'providerId is required' }
        }
        if (!args?.token) {
          return { success: false, message: 'token is required' }
        }
        return browserLoginManager.saveTokenManually(args.providerId, args.token)
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : 'login:token threw',
        }
      }
    }
  )

  // 4. login:email — email + password login (Playwright fills the form)
  ipcMain.handle(
    IpcChannels.LOGIN_EMAIL,
    async (
      _,
      args: { providerId: string; email: string; password: string }
    ): Promise<{ success: boolean; message: string }> => {
      try {
        if (!args?.providerId) {
          return { success: false, message: 'providerId is required' }
        }
        if (!args?.email || !args?.password) {
          return { success: false, message: 'email and password are required' }
        }
        return await browserLoginManager.loginWithEmailPassword(
          args.providerId,
          args.email,
          args.password,
        )
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : 'login:email threw',
        }
      }
    }
  )

  // 5. login:massImport — mass-import accounts from a JSON array
  ipcMain.handle(
    IpcChannels.LOGIN_MASS_IMPORT,
    async (
      _,
      args: { accounts: Array<{ providerId: string; token?: string; email?: string; password?: string; name?: string }> }
    ): Promise<{ success: number; failed: number; errors: string[] }> => {
      try {
        if (!Array.isArray(args?.accounts)) {
          return { success: 0, failed: 0, errors: ['accounts must be an array'] }
        }
        return await browserLoginManager.massImport(args.accounts)
      } catch (err) {
        return {
          success: 0,
          failed: 0,
          errors: [err instanceof Error ? err.message : 'login:massImport threw'],
        }
      }
    }
  )
}
