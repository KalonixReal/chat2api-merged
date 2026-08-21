/**
 * CaptchaBanner — sticky banner shown at the top of the Provider Setup page
 * when there are unresolved `severity: 'captcha'` notifications.
 *
 * Shows the provider name + a "Solve Now" button that opens the appropriate
 * login page (Qwen/DeepSeek/Z.ai/Kimi) for the user to solve the CAPTCHA.
 * After the user solves it, they click "I've solved it — retry" to trigger
 * the recovery sequence on the affected account.
 */

import { useEffect, useState, useCallback } from 'react'
import { ShieldAlert, ExternalLink, RefreshCw } from 'lucide-react'
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

const PROVIDER_LABELS: Record<string, string> = {
  qwen: 'Qwen',
  'qwen-ai': 'Qwen AI',
  deepseek: 'DeepSeek',
  glm: 'Z.ai (GLM)',
  zai: 'Z.ai',
  kimi: 'Kimi',
}

export function CaptchaBanner() {
  const [captchaNotifs, setCaptchaNotifs] = useState<AppNotification[]>([])
  const [retrying, setRetrying] = useState<string | null>(null)

  // Load initial + subscribe to new
  const refresh = useCallback(async () => {
    try {
      const all = (await (window as any).electronAPI?.invoke?.('notifications:list')) as AppNotification[]
      if (Array.isArray(all)) {
        setCaptchaNotifs(all.filter((n) => n.severity === 'captcha' && !n.dismissed))
      }
    } catch {
      // non-fatal
    }
  }, [])

  useEffect(() => {
    refresh()
    const electronAPI = (window as any).electronAPI
    if (electronAPI?.receive) {
      const unsubscribe = electronAPI.receive('notifications:new', (notif: AppNotification) => {
        if (notif.severity === 'captcha') refresh()
      })
      return () => {
        if (typeof unsubscribe === 'function') unsubscribe()
      }
    }
  }, [refresh])

  const solveNow = useCallback(async (notif: AppNotification) => {
    try {
      await (window as any).electronAPI?.invoke?.('notifications:solveCaptcha', {
        providerId: notif.providerId,
        accountId: notif.accountId,
      })
    } catch {
      // non-fatal
    }
  }, [])

  const retryRecovery = useCallback(async (notif: AppNotification) => {
    setRetrying(notif.id)
    try {
      await (window as any).electronAPI?.invoke?.('notifications:recoveryComplete', {
        providerId: notif.providerId,
        accountId: notif.accountId,
      })
      // Dismiss this captcha notification after retry
      await (window as any).electronAPI?.invoke?.('notifications:dismiss', { id: notif.id })
      refresh()
    } catch {
      // non-fatal
    } finally {
      setRetrying(null)
    }
  }, [refresh])

  if (captchaNotifs.length === 0) return null

  return (
    <div className="mb-4 space-y-2">
      {captchaNotifs.map((notif) => {
        const providerLabel = notif.providerId ? PROVIDER_LABELS[notif.providerId] || notif.providerId : 'Unknown provider'
        return (
          <div
            key={notif.id}
            className="rounded-lg border border-orange-300 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/50 p-4 shadow-sm"
          >
            <div className="flex items-start gap-3">
              <ShieldAlert className="h-5 w-5 mt-0.5 shrink-0 text-orange-600 dark:text-orange-400" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-orange-900 dark:text-orange-100">
                  CAPTCHA Required — {providerLabel}
                </p>
                <p className="mt-1 text-xs text-orange-700 dark:text-orange-300">
                  {notif.body || `Automated recovery failed for ${providerLabel}. Please solve the CAPTCHA manually, then click "I've solved it — retry".`}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" className="h-7 text-xs" onClick={() => solveNow(notif)}>
                    <ExternalLink className="h-3 w-3 mr-1" />
                    Open login page
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 text-xs"
                    onClick={() => retryRecovery(notif)}
                    disabled={retrying === notif.id}
                  >
                    <RefreshCw className={cn('h-3 w-3 mr-1', retrying === notif.id && 'animate-spin')} />
                    I've solved it — retry
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
