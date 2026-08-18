import type { AccountEntry, AuthState } from '../types/auth.ts';
import type { LoginResult } from './browserProfiles.ts';
import { publishCaptchaAlert, publishManualLoginAlert } from './captchaAlertService.ts';
import { logStore } from './logStore.ts';

export type AccountRecoveryTrigger =
  | 'startup'
  | 'throttled'
  | 'rate_limit'
  | 'captcha'
  | 'auth_error'
  | 'session_error'
  | 'token_refresh';

export interface AccountRecoveryDependencies {
  tryRefreshToken: (acct: AccountEntry) => Promise<boolean>;
  loginFresh: (email: string, password: string) => Promise<AuthState | null>;
  openBrowserProfile: (email: string, password: string, options: { headless: boolean }) => Promise<LoginResult>;
  loadCookiesFromProfile: (email: string) => Promise<AuthState | null>;
  saveCookies: (email: string, token: string, refreshToken?: string | null, expiresAt?: number) => Promise<void>;
  configureAccount: (email: string) => Promise<void>;
  persistAccounts: () => void;
  publishCaptchaAlert: typeof publishCaptchaAlert;
  publishManualLoginAlert: typeof publishManualLoginAlert;
}

const recoveryInFlight = new Map<string, Promise<boolean>>();
const lastRecoveryAttempt = new Map<string, number>();
const RECOVERY_DEDUPE_MS = 60_000;

async function getDefaultDependencies(): Promise<AccountRecoveryDependencies> {
  const [
    { tryRefreshToken },
    { loadCookiesFromProfile, saveCookies },
    { configureAccount },
    { accounts, saveAccountsToFile },
    { loginFresh },
    { openBrowserProfile },
  ] =
    await Promise.all([
      import('./tokenRefresh.ts'),
      import('./auth.ts'),
      import('./qwenModels.ts'),
      import('./accountManager.ts'),
      import('./loginService.ts'),
      import('./browserProfiles.ts'),
    ]);

  return {
    tryRefreshToken,
    loginFresh,
    openBrowserProfile,
    loadCookiesFromProfile,
    saveCookies,
    configureAccount,
    persistAccounts: () => saveAccountsToFile(accounts),
    publishCaptchaAlert,
    publishManualLoginAlert,
  };
}

function restoreQuotaThrottle(acct: AccountEntry, trigger: AccountRecoveryTrigger, throttledUntil: number): void {
  if (trigger === 'rate_limit' && throttledUntil > Date.now()) acct.throttledUntil = throttledUntil;
}

async function finishSuccessfulRecovery(
  acct: AccountEntry,
  trigger: AccountRecoveryTrigger,
  throttledUntil: number,
  deps: AccountRecoveryDependencies,
  method: string,
): Promise<boolean> {
  restoreQuotaThrottle(acct, trigger, throttledUntil);
  deps.persistAccounts();
  logStore.log('info', 'auth', `Automatic account recovery succeeded for ${acct.email} via ${method}`);

  if (trigger !== 'rate_limit' && trigger !== 'startup') {
    await deps.configureAccount(acct.email).catch((err: any) =>
      logStore.log('warn', 'auth', `Post-recovery account configuration failed for ${acct.email}: ${err.message}`),
    );
  }
  return true;
}

export async function attemptAutomaticAccountRecovery(
  acct: AccountEntry,
  trigger: AccountRecoveryTrigger,
  suppliedDependencies?: AccountRecoveryDependencies,
): Promise<boolean> {
  if (acct.disabled) return false;
  if (!acct.password) {
    publishManualLoginAlert(acct.email, 'Automatic sign-in cannot run because no password is stored.', 'account');
    return false;
  }

  const deps = suppliedDependencies || (await getDefaultDependencies());
  const throttledUntil = acct.throttledUntil;
  logStore.log('info', 'auth', `Starting automatic account recovery for ${acct.email} (${trigger})`);

  if (acct.state?.refreshToken) {
    try {
      if (await deps.tryRefreshToken(acct)) {
        return await finishSuccessfulRecovery(acct, trigger, throttledUntil, deps, 'refresh token');
      }
    } catch (err: any) {
      logStore.log('warn', 'auth', `Automatic refresh failed for ${acct.email}: ${err.message || String(err)}`);
    }
  }

  try {
    const newState = await deps.loginFresh(acct.email, acct.password);
    if (newState) {
      acct.state = newState;
      await deps.saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt);
      return await finishSuccessfulRecovery(acct, trigger, throttledUntil, deps, 'credential sign-in');
    }
  } catch (err: any) {
    logStore.log('warn', 'auth', `Automatic credential sign-in failed for ${acct.email}: ${err.message || String(err)}`);
  }

  let browserResult: LoginResult = 'error';
  try {
    browserResult = await deps.openBrowserProfile(acct.email, acct.password, { headless: true });
  } catch (err: any) {
    logStore.log('warn', 'auth', `Automatic profile sign-in failed for ${acct.email}: ${err.message || String(err)}`);
  }

  if (browserResult === 'captcha') {
    deps.publishCaptchaAlert(
      acct.email,
      'Automatic sign-in reached a CAPTCHA. Open Accounts and complete human verification.',
      'login',
    );
    logStore.log('warn', 'auth', `Automatic recovery for ${acct.email} requires human CAPTCHA verification`);
    return false;
  }

  if (browserResult === 'success') {
    const profileState = acct.state || (await deps.loadCookiesFromProfile(acct.email));
    if (profileState) {
      acct.state = profileState;
      return await finishSuccessfulRecovery(acct, trigger, throttledUntil, deps, 'browser profile');
    }
  }

  deps.publishManualLoginAlert(
    acct.email,
    'Automatic refresh, credential sign-in, and browser-profile sign-in all failed. Open Accounts and click Login.',
    'login',
  );
  logStore.log('warn', 'auth', `Automatic account recovery exhausted for ${acct.email}`);
  return false;
}

export function scheduleAutomaticAccountRecovery(acct: AccountEntry, trigger: AccountRecoveryTrigger): void {
  if (acct.disabled) return;
  const key = acct.email.toLowerCase().trim();
  if (recoveryInFlight.has(key) || acct.refreshInFlight) {
    logStore.log('debug', 'auth', `Automatic recovery already running for ${acct.email}`);
    return;
  }

  const now = Date.now();
  const previousAttempt = lastRecoveryAttempt.get(key) || 0;
  if (now - previousAttempt < RECOVERY_DEDUPE_MS) {
    logStore.log('debug', 'auth', `Automatic recovery recently attempted for ${acct.email}; suppressing duplicate`);
    return;
  }
  lastRecoveryAttempt.set(key, now);

  const recovery = attemptAutomaticAccountRecovery(acct, trigger)
    .catch((err: any) => {
      logStore.log('error', 'auth', `Automatic recovery crashed for ${acct.email}: ${err.message || String(err)}`);
      publishManualLoginAlert(acct.email, 'Automatic sign-in failed unexpectedly. Open Accounts and click Login.', 'login');
      return false;
    })
    .finally(() => {
      recoveryInFlight.delete(key);
    });
  recoveryInFlight.set(key, recovery);
}
