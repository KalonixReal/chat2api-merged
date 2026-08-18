import { describe, expect, test } from 'bun:test';
import type { AccountEntry, AuthState } from '../types/auth.ts';
import {
  attemptAutomaticAccountRecovery,
  type AccountRecoveryDependencies,
  type AccountRecoveryTrigger,
} from './accountRecovery.ts';

function account(overrides: Partial<AccountEntry> = {}): AccountEntry {
  return {
    email: 'recover@example.com',
    password: 'secret',
    state: { token: 'old-token', expiresAt: Date.now() + 60_000, refreshToken: 'refresh-token' },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    disabled: false,
    ...overrides,
  };
}

function state(token: string): AuthState {
  return { token, expiresAt: Date.now() + 3_600_000, refreshToken: `${token}-refresh` };
}

function dependencies(overrides: Partial<AccountRecoveryDependencies> = {}) {
  const events = { captcha: 0, manual: 0, persisted: 0, configured: 0, browser: 0, login: 0, refresh: 0 };
  const deps: AccountRecoveryDependencies = {
    tryRefreshToken: async () => {
      events.refresh++;
      return false;
    },
    loginFresh: async () => {
      events.login++;
      return null;
    },
    openBrowserProfile: async () => {
      events.browser++;
      return 'error';
    },
    loadCookiesFromProfile: async () => null,
    saveCookies: async () => {},
    configureAccount: async () => {
      events.configured++;
    },
    persistAccounts: () => {
      events.persisted++;
    },
    publishCaptchaAlert: () => {
      events.captcha++;
      return null;
    },
    publishManualLoginAlert: () => {
      events.manual++;
      return null;
    },
    ...overrides,
  };
  return { deps, events };
}

describe('automatic account recovery', () => {
  test('uses a refresh token before credential or browser login', async () => {
    const acct = account();
    const { deps, events } = dependencies({
      tryRefreshToken: async (entry) => {
        events.refresh++;
        entry.state = state('refreshed');
        return true;
      },
    });

    expect(await attemptAutomaticAccountRecovery(acct, 'token_refresh', deps)).toBe(true);
    expect(acct.state?.token).toBe('refreshed');
    expect(events.login).toBe(0);
    expect(events.browser).toBe(0);
    expect(events.manual).toBe(0);
  });

  test('falls back to automatic credential sign-in', async () => {
    const acct = account({ state: null });
    const { deps, events } = dependencies({
      loginFresh: async () => {
        events.login++;
        return state('signed-in');
      },
    });

    expect(await attemptAutomaticAccountRecovery(acct, 'auth_error', deps)).toBe(true);
    expect(acct.state?.token).toBe('signed-in');
    expect(events.browser).toBe(0);
    expect(events.configured).toBe(1);
  });

  test('asks for a human only when the automatic browser reports CAPTCHA', async () => {
    const acct = account({ state: null });
    const { deps, events } = dependencies({ openBrowserProfile: async () => 'captcha' });

    expect(await attemptAutomaticAccountRecovery(acct, 'captcha', deps)).toBe(false);
    expect(events.captcha).toBe(1);
    expect(events.manual).toBe(0);
  });

  test('publishes a manual-login alert after every automatic method fails', async () => {
    const acct = account({ state: null });
    const { deps, events } = dependencies();

    expect(await attemptAutomaticAccountRecovery(acct, 'session_error', deps)).toBe(false);
    expect(events.captcha).toBe(0);
    expect(events.manual).toBe(1);
  });

  test('preserves a genuine usage-quota cooldown after successful sign-in', async () => {
    const throttledUntil = Date.now() + 3_600_000;
    const acct = account({ state: null, throttledUntil });
    const { deps } = dependencies({
      loginFresh: async () => state('new-token'),
      saveCookies: async () => {
        acct.throttledUntil = 0;
      },
    });

    expect(await attemptAutomaticAccountRecovery(acct, 'rate_limit' as AccountRecoveryTrigger, deps)).toBe(true);
    expect(acct.throttledUntil).toBe(throttledUntil);
  });
});

