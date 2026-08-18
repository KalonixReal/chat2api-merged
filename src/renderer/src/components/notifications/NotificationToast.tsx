/**
 * NotificationToast — listens to the `notifications:new` IPC push channel
 * and shows a toast in the bottom-right corner for each new notification.
 *
 * - info/warn: auto-dismiss after 10s
 * - error/captcha: sticky until user dismisses or clicks "Solve"
 *
 * Used in the app root (App.tsx) so it's active on every page.
 */

import { useEffect, useState, useCallback } from 'react'
import { X, AlertTriangle, AlertCircle, Info, ShieldAlert, ExternalLink } from 'lucide-react'
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

const SEVERITY_CONFIG = {
  info: {
    icon: Info,
    bg: 'bg-blue-50 dark:bg-blue-950/50',
    border: 'border-blue-200 dark:border-blue-900',
    iconColor: 'text-blue-600 dark:text-blue-400',
    titleColor: 'text-blue-900 dark:text-blue-100',
  },
  warn: {
    icon: AlertTriangle,
    bg: 'bg-yellow-50 dark:bg-yellow-950/50',
    border: 'border-yellow-200 dark:border-yellow-900',
    iconColor: 'text-yellow-600 dark:text-yellow-400',
    titleColor: 'text-yellow-900 dark:text-yellow-100',
  },
  error: {
    icon: AlertCircle,
    bg: 'bg-red-50 dark:bg-red-950/50',
    border: 'border-red-200 dark:border-red-900',
    iconColor: 'text-red-600 dark:text-red-400',
    titleColor: 'text-red-900 dark:text-red-100',
  },
  captcha: {
    icon: ShieldAlert,
    bg: 'bg-orange-50 dark:bg-orange-950/50',
    border: 'border-orange-300 dark:border-orange-800',
    iconColor: 'text-orange-600 dark:text-orange-400',
    titleColor: 'text-orange-900 dark:text-orange-100',
  },
} as const

const AUTO_DISMISS_MS = 10_000

export function NotificationToast() {
  const [toasts, setToasts] = useState<AppNotification[]>([])

  // Subscribe to new notifications via IPC push
  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.receive) return

    const unsubscribe = electronAPI.receive('notifications:new', (notif: AppNotification) => {
      setToasts((prev) => [...prev.filter((t) => t.id !== notif.id), notif])

      // Auto-dismiss info/warn after 10s. error/captcha are sticky.
      if (notif.severity === 'info' || notif.severity === 'warn') {
        setTimeout(() => dismissToast(notif.id), AUTO_DISMISS_MS)
      }
    })

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  const dismissToast = useCallback(async (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    try {
      await (window as any).electronAPI?.invoke?.('notifications:dismiss', { id })
    } catch {
      // non-fatal — the toast is already removed from UI
    }
  }, [])

  const solveCaptcha = useCallback(async (notif: AppNotification) => {
    try {
      await (window as any).electronAPI?.invoke?.('notifications:solveCaptcha', {
        providerId: notif.providerId,
        accountId: notif.accountId,
      })
    } catch {
      // non-fatal
    }
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map((toast) => {
        const config = SEVERITY_CONFIG[toast.severity] || SEVERITY_CONFIG.info
        const Icon = config.icon
        const isCaptcha = toast.severity === 'captcha'

        return (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto rounded-lg border p-4 shadow-lg',
              'animate-in slide-in-from-right-5 fade-in duration-300',
              config.bg,
              config.border,
            )}
          >
            <div className="flex items-start gap-3">
              <Icon className={cn('h-5 w-5 mt-0.5 shrink-0', config.iconColor)} />
              <div className="flex-1 min-w-0">
                <p className={cn('text-sm font-semibold', config.titleColor)}>{toast.title}</p>
                {toast.body && (
                  <p className="mt-1 text-xs text-muted-foreground line-clamp-3">{toast.body}</p>
                )}
                {isCaptcha && toast.providerId && (
                  <Button
                    size="sm"
                    className="mt-2 h-7 text-xs"
                    onClick={() => solveCaptcha(toast)}
                  >
                    <ExternalLink className="h-3 w-3 mr-1" />
                    Solve CAPTCHA
                  </Button>
                )}
              </div>
              <button
                onClick={() => dismissToast(toast.id)}
                className="shrink-0 rounded-sm opacity-60 hover:opacity-100 transition-opacity"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
