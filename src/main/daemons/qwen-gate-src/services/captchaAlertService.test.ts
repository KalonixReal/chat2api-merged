import { beforeEach, describe, expect, test } from 'bun:test';
import {
  getAccountAlerts,
  getCaptchaAlerts,
  maskCaptchaEmail,
  publishCaptchaAlert,
  publishManualLoginAlert,
  publishThrottleAlert,
  resetCaptchaAlertsForTests,
} from './captchaAlertService.ts';

describe('CAPTCHA alerts', () => {
  beforeEach(() => resetCaptchaAlertsForTests());

  test('publishes masked, structured alerts', () => {
    const alert = publishCaptchaAlert('person@example.com', 'Slider required', 'request', 100_000);

    expect(alert).toEqual({
      id: 100_000,
      timestamp: 100_000,
      kind: 'captcha',
      maskedEmail: 'per***@example.com',
      source: 'request',
      details: 'Slider required',
    });
    expect(getCaptchaAlerts()).toEqual([alert]);
  });

  test('deduplicates repeated alerts for the same account and source', () => {
    expect(publishCaptchaAlert('person@example.com', 'first', 'request', 100_000)).not.toBeNull();
    expect(publishCaptchaAlert('PERSON@example.com', 'repeat', 'request', 105_000)).toBeNull();
    expect(publishCaptchaAlert('person@example.com', 'login', 'login', 105_000)).not.toBeNull();
    expect(publishCaptchaAlert('person@example.com', 'later', 'request', 131_000)).not.toBeNull();
  });

  test('returns only alerts newer than the supplied id', () => {
    const first = publishCaptchaAlert('one@example.com', 'first', 'request', 100_000)!;
    const second = publishCaptchaAlert('two@example.com', 'second', 'request', 100_001)!;

    expect(getCaptchaAlerts(first.id)).toEqual([second]);
  });

  test('publishes manual-login and throttled account alerts', () => {
    const manual = publishManualLoginAlert('person@example.com', 'Open Accounts', 'login', 100_000)!;
    const throttled = publishThrottleAlert('person@example.com', 500_000, 'Quota reached', 100_001)!;

    expect(manual.kind).toBe('manual_login');
    expect(throttled).toMatchObject({ kind: 'throttled', throttledUntil: 500_000, details: 'Quota reached' });
    expect(getAccountAlerts()).toEqual([manual, throttled]);
    expect(getCaptchaAlerts()).toEqual([]);
  });

  test('deduplicates each alert kind independently', () => {
    expect(publishManualLoginAlert('person@example.com', 'first', 'login', 100_000)).not.toBeNull();
    expect(publishManualLoginAlert('person@example.com', 'repeat', 'login', 101_000)).toBeNull();
    expect(publishThrottleAlert('person@example.com', 500_000, 'throttled', 101_000)).not.toBeNull();
  });

  test('masks short and invalid account labels safely', () => {
    expect(maskCaptchaEmail('a@example.com')).toBe('a***@example.com');
    expect(maskCaptchaEmail('')).toBe('unknown account');
  });
});
