/**
 * Provider Setup page — single dashboard for configuring credentials for the
 * 4 vendored standalone daemons (Qwen / DeepSeek / Z.ai-GLM / Kimi).
 *
 * Each card lets the user add credentials in the daemon's native format:
 *   - Qwen:      email + password → qwengate REST API (POST /api/accounts)
 *   - DeepSeek:  "Login with DeepSeek" button → spawns `python -m deepseek.auth`
 *   - Z.ai/GLM:  JWT textarea → supervisor.setDaemonEnv('glm-free-api', { ZAI_TOKEN })
 *   - Kimi:      JWT/refresh_token textarea → Account store with providerId='kimi'
 *
 * Every card also exposes a "Test" button that hits the daemon's
 * /v1/chat/completions endpoint directly (bypassing the Chat2API proxy) so we
 * get a true end-to-end "does my credential work" check, independent of
 * whether the Chat2API proxy server is currently running.
 *
 * All IPC errors are surfaced as toast notifications — the page itself never
 * throws.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, Trash2, Plus, FlaskConical, KeyRound, ExternalLink } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { CaptchaBanner } from '@/components/notifications/CaptchaBanner'
import { cn } from '@/lib/utils'
import { toast } from '@/hooks/use-toast'

// ---- IPC shapes (mirror src/main/ipc/providerSetup.ts) ---------------------

interface ProviderSetupDetail {
  configured: boolean
  daemonUp: boolean
  detail?: string
  accountCount?: number
}

interface ProviderSetupStatus {
  qwen: ProviderSetupDetail
  deepseek: ProviderSetupDetail
  glm: ProviderSetupDetail
  kimi: ProviderSetupDetail
}

interface QwenAccount {
  email: string
  passwordMasked: string
  authenticated: boolean
  tokenExpiresAt: number | null
  throttled: boolean
  throttledUntil: number | null
  throttledUnlockAt: string | null
  inFlight: number
  totalRequests: number
  startupStatus: string | null
}

interface TestChatResult {
  ok: boolean
  reply?: string
  raw?: string
  status?: number
  error?: string
}

// ---- helpers ---------------------------------------------------------------

const IPC = {
  getStatus: () => invoke<ProviderSetupStatus>('providerSetup:getStatus'),
  addQwen: (email: string, password: string) =>
    invoke<{ success: boolean; loginSucceeded?: boolean; loginError?: string; error?: string }>(
      'providerSetup:addQwenAccount',
      { email, password }
    ),
  removeQwen: (email: string) =>
    invoke<{ success: boolean; error?: string }>('providerSetup:removeQwenAccount', { email }),
  listQwen: () => invoke<{ accounts: QwenAccount[]; error?: string }>('providerSetup:listQwenAccounts'),
  loginDeepSeek: () =>
    invoke<{ spawned: boolean; error?: string }>('providerSetup:loginDeepSeek'),
  setZaiToken: (token: string) =>
    invoke<{ success: boolean; error?: string }>('providerSetup:setZaiToken', { token }),
  setKimiToken: (token: string) =>
    invoke<{ success: boolean; accountId?: string; error?: string }>(
      'providerSetup:setKimiToken',
      { token }
    ),
  testChat: (provider: 'qwen' | 'deepseek' | 'glm' | 'kimi', model?: string, message?: string) =>
    invoke<TestChatResult>('providerSetup:testChat', { provider, model, message }),
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.electronAPI?.invoke) {
    throw new Error('Electron bridge not available')
  }
  // electronAPI.invoke is typed as (channel, ...args) => Promise<unknown>
  return (await window.electronAPI.invoke(channel, ...args)) as T
}

// ---- small UI primitives ---------------------------------------------------

function StatusBadge({ configured, daemonUp }: { configured: boolean; daemonUp: boolean }) {
  const { t } = useTranslation()
  if (!daemonUp) {
    return <Badge variant="destructive">{t('providerSetup.daemonDown')}</Badge>
  }
  if (configured) {
    return <Badge variant="default">{t('providerSetup.configured')}</Badge>
  }
  return <Badge variant="secondary">{t('providerSetup.notConfigured')}</Badge>
}

function TestSection({
  provider,
  defaultModel,
}: {
  provider: 'qwen' | 'deepseek' | 'glm' | 'kimi'
  defaultModel: string
}) {
  const { t } = useTranslation()
  const [model, setModel] = useState(defaultModel)
  const [message, setMessage] = useState('')
  const [testing, setTesting] = useState(false)

  const runTest = useCallback(async () => {
    setTesting(true)
    try {
      const result = await IPC.testChat(provider, model || defaultModel, message || undefined)
      if (result.ok) {
        toast({
          title: t('providerSetup.test.button'),
          description: t('providerSetup.test.success', {
            reply: (result.reply || '').slice(0, 200) || '(empty)',
          }),
        })
      } else {
        toast({
          title: t('providerSetup.test.button'),
          description: t('providerSetup.test.error', {
            error: result.error || `HTTP ${result.status ?? '?'}`,
          }),
          variant: 'destructive',
        })
      }
    } catch (err) {
      toast({
        title: t('providerSetup.test.button'),
        description: t('providerSetup.test.error', {
          error: err instanceof Error ? err.message : 'unknown',
        }),
        variant: 'destructive',
      })
    } finally {
      setTesting(false)
    }
  }, [provider, model, message, defaultModel, t])

  return (
    <div className="space-y-2 pt-2">
      <Separator />
      <div className="grid gap-2 sm:grid-cols-2 pt-2">
        <div className="space-y-1">
          <Label htmlFor={`test-model-${provider}`} className="text-xs">
            {t('providerSetup.test.defaultModel')}
          </Label>
          <Input
            id={`test-model-${provider}`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={t('providerSetup.test.defaultModelPlaceholder')}
            className="h-9"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`test-msg-${provider}`} className="text-xs">
            {t('providerSetup.test.messageLabel')}
          </Label>
          <Input
            id={`test-msg-${provider}`}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('providerSetup.test.messagePlaceholder')}
            className="h-9"
          />
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={runTest} disabled={testing}>
        <FlaskConical className={cn('h-4 w-4 mr-2', testing && 'animate-pulse')} />
        {testing ? t('providerSetup.test.testing') : t('providerSetup.test.button')}
      </Button>
    </div>
  )
}

// ---- per-provider cards -----------------------------------------------------

function QwenCard({ detail }: { detail: ProviderSetupDetail }) {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [adding, setAdding] = useState(false)
  const [accounts, setAccounts] = useState<QwenAccount[]>([])
  const [listError, setListError] = useState<string | undefined>(undefined)
  const loadedRef = useRef(false)

  const refreshAccounts = useCallback(async () => {
    try {
      const result = await IPC.listQwen()
      setAccounts(result.accounts)
      setListError(result.error)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'unknown')
    }
  }, [])

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    refreshAccounts()
  }, [refreshAccounts])

  const handleAdd = useCallback(async () => {
    if (!email.trim() || !password) {
      toast({
        title: t('providerSetup.qwen.addAccount'),
        description: t('providerSetup.qwen.addError', { error: 'email and password required' }),
        variant: 'destructive',
      })
      return
    }
    setAdding(true)
    try {
      const result = await IPC.addQwen(email.trim(), password)
      if (result.success) {
        toast({ title: t('providerSetup.qwen.addAccount'), description: t('providerSetup.qwen.addSuccess') })
        setEmail('')
        setPassword('')
        await refreshAccounts()
      } else {
        toast({
          title: t('providerSetup.qwen.addAccount'),
          description: t('providerSetup.qwen.addError', {
            error: result.error || result.loginError || 'unknown',
          }),
          variant: 'destructive',
        })
      }
    } catch (err) {
      toast({
        title: t('providerSetup.qwen.addAccount'),
        description: t('providerSetup.qwen.addError', {
          error: err instanceof Error ? err.message : 'unknown',
        }),
        variant: 'destructive',
      })
    } finally {
      setAdding(false)
    }
  }, [email, password, refreshAccounts, t])

  const handleRemove = useCallback(
    async (acctEmail: string) => {
      const result = await IPC.removeQwen(acctEmail)
      if (result.success) {
        toast({ title: t('providerSetup.qwen.remove'), description: t('providerSetup.qwen.removeSuccess') })
        await refreshAccounts()
      } else {
        toast({
          title: t('providerSetup.qwen.remove'),
          description: t('providerSetup.qwen.removeError', { error: result.error || 'unknown' }),
          variant: 'destructive',
        })
      }
    },
    [refreshAccounts, t]
  )

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]">
              <KeyRound className="h-4 w-4" />
            </span>
            {t('providerSetup.qwen.name')}
          </CardTitle>
          <StatusBadge configured={detail.configured} daemonUp={detail.daemonUp} />
        </div>
        <CardDescription>{t('providerSetup.qwen.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="qwen-email" className="text-xs">
              {t('providerSetup.qwen.email')}
            </Label>
            <Input
              id="qwen-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="alice@example.com"
              autoComplete="email"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="qwen-password" className="text-xs">
              {t('providerSetup.qwen.password')}
            </Label>
            <Input
              id="qwen-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>
        </div>
        <Button onClick={handleAdd} disabled={adding} size="sm">
          <Plus className="h-4 w-4 mr-2" />
          {adding ? t('providerSetup.qwen.adding') : t('providerSetup.qwen.addAccount')}
        </Button>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">{t('providerSetup.qwen.configuredAccounts')}</Label>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={refreshAccounts}>
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
          {listError && (
            <p className="text-xs text-destructive">{t('providerSetup.qwen.removeError', { error: listError })}</p>
          )}
          {accounts.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('providerSetup.qwen.noAccounts')}</p>
          ) : (
            <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
              {accounts.map((acct) => (
                <div
                  key={acct.email}
                  className="flex items-center justify-between rounded-md border border-input/40 bg-muted/30 px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{acct.email}</span>
                      {acct.authenticated ? (
                        <Badge variant="default" className="text-[10px] py-0 px-1.5">
                          {t('providerSetup.qwen.authenticated')}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
                          {t('providerSetup.qwen.unauthenticated')}
                        </Badge>
                      )}
                      {acct.throttled && (
                        <Badge variant="destructive" className="text-[10px] py-0 px-1.5">
                          {t('providerSetup.qwen.throttled')}
                        </Badge>
                      )}
                    </div>
                    {acct.tokenExpiresAt && (
                      <p className="truncate text-[10px] text-muted-foreground">
                        expires {new Date(acct.tokenExpiresAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:bg-destructive/10"
                    onClick={() => handleRemove(acct.email)}
                    title={t('providerSetup.qwen.remove')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <TestSection provider="qwen" defaultModel="qwen-plus" />
      </CardContent>
    </Card>
  )
}

function DeepSeekCard({ detail }: { detail: ProviderSetupDetail }) {
  const { t } = useTranslation()
  const [opening, setOpening] = useState(false)

  const handleLogin = useCallback(async () => {
    setOpening(true)
    try {
      const result = await IPC.loginDeepSeek()
      if (result.spawned) {
        toast({ title: t('providerSetup.deepseek.loginButton'), description: t('providerSetup.deepseek.openSuccess') })
      } else {
        toast({
          title: t('providerSetup.deepseek.loginButton'),
          description: t('providerSetup.deepseek.openError', {
            error: result.error || 'unknown',
          }),
          variant: 'destructive',
        })
      }
    } catch (err) {
      toast({
        title: t('providerSetup.deepseek.loginButton'),
        description: t('providerSetup.deepseek.openError', {
          error: err instanceof Error ? err.message : 'unknown',
        }),
        variant: 'destructive',
      })
    } finally {
      setOpening(false)
    }
  }, [t])

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]">
              <ExternalLink className="h-4 w-4" />
            </span>
            {t('providerSetup.deepseek.name')}
          </CardTitle>
          <StatusBadge configured={detail.configured} daemonUp={detail.daemonUp} />
        </div>
        <CardDescription>{t('providerSetup.deepseek.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-4">
        <div className="rounded-md border border-input/40 bg-muted/20 p-3 text-xs text-muted-foreground">
          {detail.configured
            ? t('providerSetup.deepseek.sessionReady')
            : t('providerSetup.deepseek.sessionMissing')}
          {detail.detail && <span className="block mt-1 text-[10px]">{detail.detail}</span>}
        </div>
        <Button onClick={handleLogin} disabled={opening} size="sm">
          <ExternalLink className="h-4 w-4 mr-2" />
          {opening ? t('providerSetup.deepseek.opening') : t('providerSetup.deepseek.loginButton')}
        </Button>
        <TestSection provider="deepseek" defaultModel="deepseek-chat" />
      </CardContent>
    </Card>
  )
}

function ZaiCard({ detail }: { detail: ProviderSetupDetail }) {
  const { t } = useTranslation()
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    if (!token.trim()) {
      toast({
        title: t('providerSetup.zai.saveButton'),
        description: t('providerSetup.zai.saveError', { error: 'token is required' }),
        variant: 'destructive',
      })
      return
    }
    setSaving(true)
    try {
      const result = await IPC.setZaiToken(token.trim())
      if (result.success) {
        toast({ title: t('providerSetup.zai.saveButton'), description: t('providerSetup.zai.saveSuccess') })
      } else {
        toast({
          title: t('providerSetup.zai.saveButton'),
          description: t('providerSetup.zai.saveError', { error: result.error || 'unknown' }),
          variant: 'destructive',
        })
      }
    } catch (err) {
      toast({
        title: t('providerSetup.zai.saveButton'),
        description: t('providerSetup.zai.saveError', {
          error: err instanceof Error ? err.message : 'unknown',
        }),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }, [token, t])

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]">
              <KeyRound className="h-4 w-4" />
            </span>
            {t('providerSetup.zai.name')}
          </CardTitle>
          <StatusBadge configured={detail.configured} daemonUp={detail.daemonUp} />
        </div>
        <CardDescription>{t('providerSetup.zai.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="zai-token" className="text-xs">
            {t('providerSetup.zai.tokenLabel')}
          </Label>
          <Textarea
            id="zai-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('providerSetup.zai.tokenPlaceholder')}
            className="min-h-[80px] font-mono text-xs"
          />
          <p className="text-[11px] text-muted-foreground">{t('providerSetup.zai.helpText')}</p>
        </div>
        <Button onClick={handleSave} disabled={saving} size="sm">
          <RefreshCw className={cn('h-4 w-4 mr-2', saving && 'animate-spin')} />
          {saving ? t('providerSetup.zai.saving') : t('providerSetup.zai.saveButton')}
        </Button>
        <TestSection provider="glm" defaultModel="glm-4.7" />
      </CardContent>
    </Card>
  )
}

function KimiCard({ detail }: { detail: ProviderSetupDetail }) {
  const { t } = useTranslation()
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    if (!token.trim()) {
      toast({
        title: t('providerSetup.kimi.saveButton'),
        description: t('providerSetup.kimi.saveError', { error: 'token is required' }),
        variant: 'destructive',
      })
      return
    }
    setSaving(true)
    try {
      const result = await IPC.setKimiToken(token.trim())
      if (result.success) {
        toast({ title: t('providerSetup.kimi.saveButton'), description: t('providerSetup.kimi.saveSuccess') })
        setToken('')
      } else {
        toast({
          title: t('providerSetup.kimi.saveButton'),
          description: t('providerSetup.kimi.saveError', { error: result.error || 'unknown' }),
          variant: 'destructive',
        })
      }
    } catch (err) {
      toast({
        title: t('providerSetup.kimi.saveButton'),
        description: t('providerSetup.kimi.saveError', {
          error: err instanceof Error ? err.message : 'unknown',
        }),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }, [token, t])

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]">
              <KeyRound className="h-4 w-4" />
            </span>
            {t('providerSetup.kimi.name')}
          </CardTitle>
          <StatusBadge configured={detail.configured} daemonUp={detail.daemonUp} />
        </div>
        <CardDescription>{t('providerSetup.kimi.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="kimi-token" className="text-xs">
            {t('providerSetup.kimi.tokenLabel')}
          </Label>
          <Textarea
            id="kimi-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('providerSetup.kimi.tokenPlaceholder')}
            className="min-h-[80px] font-mono text-xs"
          />
          <p className="text-[11px] text-muted-foreground">{t('providerSetup.kimi.helpText')}</p>
        </div>
        <Button onClick={handleSave} disabled={saving} size="sm">
          <Plus className="h-4 w-4 mr-2" />
          {saving ? t('providerSetup.kimi.saving') : t('providerSetup.kimi.saveButton')}
        </Button>
        <TestSection provider="kimi" defaultModel="kimi-k2.6" />
      </CardContent>
    </Card>
  )
}

// ---- main page -------------------------------------------------------------

export function ProviderSetup() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<ProviderSetupStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const loadedRef = useRef(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const s = await IPC.getStatus()
      setStatus(s)
    } catch (err) {
      console.error('[ProviderSetup] getStatus failed:', err)
      setStatus({
        qwen: { configured: false, daemonUp: false, detail: 'unreachable' },
        deepseek: { configured: false, daemonUp: false, detail: 'unreachable' },
        glm: { configured: false, daemonUp: false, detail: 'unreachable' },
        kimi: { configured: false, daemonUp: false, detail: 'unreachable' },
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    refresh()
    // Refresh every 30s — daemons may take a while to come up after install.
    const interval = setInterval(() => {
      refresh()
    }, 30_000)
    return () => clearInterval(interval)
  }, [refresh])

  const isElectron = !!window.electronAPI?.invoke

  return (
    <div className="space-y-6">
      <CaptchaBanner />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{t('providerSetup.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('providerSetup.description')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4 mr-2', loading && 'animate-spin')} />
          {t('providerSetup.refresh')}
        </Button>
      </div>

      {!isElectron && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400">
          <p className="font-medium">{t('dashboard.browserMode')}</p>
          <p>{t('dashboard.browserModeDesc')}</p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {status ? (
          <>
            <QwenCard detail={status.qwen} />
            <DeepSeekCard detail={status.deepseek} />
            <ZaiCard detail={status.glm} />
            <KimiCard detail={status.kimi} />
          </>
        ) : (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="h-72 animate-pulse bg-muted/30" />
          ))
        )}
      </div>
    </div>
  )
}

export default ProviderSetup
