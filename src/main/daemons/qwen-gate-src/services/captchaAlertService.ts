export type CaptchaAlertSource = 'request' | 'login';
export type AccountAlertKind = 'captcha' | 'manual_login' | 'throttled';
export type AccountAlertSource = CaptchaAlertSource | 'account' | 'refresh';

export interface AccountAlert {
  id: number;
  timestamp: number;
  kind: AccountAlertKind;
  maskedEmail: string;
  source: AccountAlertSource;
  details: string;
  throttledUntil?: number;
}

export type CaptchaAlert = AccountAlert & { kind: 'captcha'; source: CaptchaAlertSource };

const MAX_ALERTS = 100;
const DEDUPE_WINDOW_MS = 30_000;
const alerts: AccountAlert[] = [];
const lastAlertByAccount = new Map<string, number>();
let lastId = 0;

export function maskCaptchaEmail(email: string): string {
  const normalized = email.trim();
  const at = normalized.indexOf('@');
  if (at <= 0) return normalized || 'unknown account';
  const local = normalized.slice(0, at);
  const visible = local.slice(0, Math.min(3, local.length));
  return `${visible}***${normalized.slice(at)}`;
}

export function publishCaptchaAlert(
  email: string,
  details = 'Human verification is required',
  source: CaptchaAlertSource = 'request',
  now = Date.now(),
): CaptchaAlert | null {
  return publishAccountAlert({ kind: 'captcha', email, details, source, now }) as CaptchaAlert | null;
}

export interface PublishAccountAlertInput {
  kind: AccountAlertKind;
  email: string;
  details: string;
  source?: AccountAlertSource;
  now?: number;
  throttledUntil?: number;
}

export function publishAccountAlert({
  kind,
  email,
  details,
  source = 'account',
  now = Date.now(),
  throttledUntil,
}: PublishAccountAlertInput): AccountAlert | null {
  const accountKey = email.trim().toLowerCase() || 'unknown';
  const dedupeKey = `${kind}:${source}:${accountKey}`;
  const previous = lastAlertByAccount.get(dedupeKey) || 0;
  if (now - previous < DEDUPE_WINDOW_MS) return null;

  lastAlertByAccount.set(dedupeKey, now);
  lastId = Math.max(lastId + 1, now);
  const alert: AccountAlert = {
    id: lastId,
    timestamp: now,
    kind,
    maskedEmail: maskCaptchaEmail(email),
    source,
    details: String(details).slice(0, 300),
    ...(throttledUntil ? { throttledUntil } : {}),
  };
  alerts.push(alert);
  if (alerts.length > MAX_ALERTS) alerts.splice(0, alerts.length - MAX_ALERTS);
  return alert;
}

export function getCaptchaAlerts(afterId = 0): CaptchaAlert[] {
  return alerts.filter((alert): alert is CaptchaAlert => alert.kind === 'captcha' && alert.id > afterId);
}

export function getAccountAlerts(afterId = 0): AccountAlert[] {
  return alerts.filter((alert) => alert.id > afterId);
}

export function publishManualLoginAlert(
  email: string,
  details = 'Automatic sign-in failed. Open Accounts and complete login manually.',
  source: AccountAlertSource = 'login',
  now = Date.now(),
): AccountAlert | null {
  return publishAccountAlert({ kind: 'manual_login', email, details, source, now });
}

export function publishThrottleAlert(
  email: string,
  throttledUntil: number,
  details = 'The account was throttled by Qwen.',
  now = Date.now(),
): AccountAlert | null {
  return publishAccountAlert({ kind: 'throttled', email, details, source: 'account', now, throttledUntil });
}

export function resetCaptchaAlertsForTests(): void {
  alerts.length = 0;
  lastAlertByAccount.clear();
  lastId = 0;
}
