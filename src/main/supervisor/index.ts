/**
 * DaemonSupervisor stub — no external daemons needed anymore.
 *
 * The reverse-engineering logic is now in-process in the adapters
 * (DeepSeekAdapter, GLMAdapter, KimiAdapter, QwenAdapter, QwenAiAdapter,
 * ZaiAdapter). Each adapter makes direct HTTP calls to its provider's public
 * API — there is no local daemon process to spawn, supervise, or health-check.
 *
 * The supervisor's API surface is preserved for backwards compatibility with
 * the IPC layer (registerSupervisorHandlers, notificationManager, etc.),
 * but `checkAll()` returns an empty array — there are no daemons to report
 * on. `startAll()`/`stopAll()` are no-ops.
 *
 * `DEFAULT_DAEMON_SPECS` is empty because no daemons need to be spawned.
 */

export interface DaemonStatus {
  id: string; name: string; port: number; running: boolean; pid?: number;
  healthy: boolean; lastCheck?: number; latencyMs?: number; detail?: string; autoStart: boolean;
}
export interface DaemonSpec {
  id: string; name: string; port: number; healthPath: string;
  startCommand: string[]; cwd: string; env: Record<string, string>; required: boolean;
}
export const DEFAULT_DAEMON_SPECS: DaemonSpec[] = []

export class DaemonSupervisor {
  async startAll(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async startOne(_id: string): Promise<DaemonStatus | null> { return null }
  async stopOne(_id: string): Promise<boolean> { return true }
  async restartDaemon(_id: string): Promise<boolean> { return true }
  /**
   * Returns an empty array — there are no daemons to report on.
   * Everything is in-process (in the adapters) so there's no live status
   * to surface here. The renderer's ProviderSetup page reports per-provider
   * `daemonUp: true` because all checks are now in-process; nothing here is
   * surfaced to the UI directly.
   */
  async checkAll(): Promise<DaemonStatus[]> {
    return []
  }
  /** Snapshot is also empty — same reason as checkAll(). */
  snapshot(): DaemonStatus[] { return [] }
  onStatusChange(_cb: (s: DaemonStatus[]) => void): () => void { return () => {} }
  setDaemonEnv(_id: string, _env: Record<string, string>): void {}
  getDaemonEnv(_id: string): Record<string, string> { return {} }
  async spawnAuthWindow(_id: string, _cmd: string[]): Promise<boolean> { return false }
}

export const daemonSupervisor = new DaemonSupervisor()
export async function ensureInstalled(): Promise<boolean> { return true }
export function needsInstall(): boolean { return false }
