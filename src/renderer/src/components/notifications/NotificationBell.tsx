/**
 * NotificationBell — bell icon with a count badge, shown in the dashboard header.
 *
 * Clicking opens a dropdown panel listing recent notifications with dismiss buttons.
 * The bell icon shakes/pulses when there are new captcha/error notifications.
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { Bell, X, Check, AlertCircle, AlertTriangle, Info, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface AppNotification {
  id: string
  severity: 'info' | 'warn' | 'error' | 'captcha'
  title: string
  body: string
  providerId?: string
  accountId?: string
  timestamp: number
  dismissed: boolean
}

const SEVERITY_ICONS = {
  info: Info,
  warn: AlertTriangle,
  error: AlertCircle,
  captcha: ShieldAlert,
} as const

const SEVERITY_COLORS = {
  info: 'text-blue-500',
  warn: 'text-yellow-500',
  error: 'text-red-500',
  captcha: 'text-orange-500',
} as const

function formatTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString()
}

export function NotificationBell() {
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const all = (await (window as any).electronAPI?.invoke?.('notifications:list')) as AppNotification[]
      if (Array.isArray(all)) {
        setNotifications(all.slice(0, 50))
      }
    } catch {
      // non-fatal
    }
  }, [])

  useEffect(() => {
    refresh()
    const electronAPI = (window as any).electronAPI
    if (electronAPI?.receive) {
      const unsubscribe = electronAPI.receive('notifications:new', () => refresh())
      return () => {
        if (typeof unsubscribe === 'function') unsubscribe()
      }
    }
  }, [refresh])

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const dismissOne = useCallback(async (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
    try {
      await (window as any).electronAPI?.invoke?.('notifications:dismiss', { id })
    } catch {}
  }, [])

  const dismissAll = useCallback(async () => {
    setNotifications([])
    try {
      await (window as any).electronAPI?.invoke?.('notifications:dismissAll', {})
    } catch {}
  }, [])

  const undismissed = notifications.filter((n) => !n.dismissed)
  const count = undismissed.length
  const hasCritical = undismissed.some((n) => n.severity === 'error' || n.severity === 'captcha')

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        variant="ghost"
        size="icon"
        className="relative h-9 w-9"
        onClick={() => {
          setOpen((o) => !o)
          if (!open) refresh()
        }}
        aria-label={`Notifications${count > 0 ? ` (${count} new)` : ''}`}
      >
        <Bell className={cn('h-5 w-5', hasCritical && 'animate-pulse text-orange-500')} />
        {count > 0 && (
          <span
            className={cn(
              'absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-bold text-white',
              hasCritical ? 'bg-orange-500' : 'bg-primary',
            )}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-96 max-h-[500px] rounded-lg border bg-popover shadow-lg z-50 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h3 className="text-sm font-semibold">Notifications</h3>
            {count > 0 && (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={dismissAll}>
                <Check className="h-3 w-3 mr-1" />
                Dismiss all
              </Button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">No notifications</p>
            ) : (
              notifications.map((notif) => {
                const Icon = SEVERITY_ICONS[notif.severity] || Info
                const color = SEVERITY_COLORS[notif.severity] || 'text-blue-500'
                return (
                  <div
                    key={notif.id}
                    className={cn(
                      'flex items-start gap-3 border-b px-4 py-3 last:border-0 hover:bg-accent/50 transition-colors',
                      notif.dismissed && 'opacity-50',
                    )}
                  >
                    <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', color)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{notif.title}</p>
                      {notif.body && (
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{notif.body}</p>
                      )}
                      <p className="mt-1 text-xs text-muted-foreground/70">{formatTime(notif.timestamp)}</p>
                    </div>
                    {!notif.dismissed && (
                      <button
                        onClick={() => dismissOne(notif.id)}
                        className="shrink-0 rounded-sm opacity-40 hover:opacity-100 transition-opacity"
                        aria-label="Dismiss"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
