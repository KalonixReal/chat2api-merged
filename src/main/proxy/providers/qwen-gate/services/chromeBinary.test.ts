import { describe, expect, test } from 'bun:test';
import { findChromeBinary, getChromeCandidates } from './chromeBinary.ts';

describe('Chrome binary discovery', () => {
  const windowsEnv: NodeJS.ProcessEnv = {
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  };

  test('finds standard Windows Chrome and Edge installations', () => {
    const candidates = getChromeCandidates('chromium', 'win32', windowsEnv);

    expect(candidates).toContain('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(candidates).toContain('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    expect(candidates.indexOf('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).toBeLessThan(
      candidates.indexOf('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'),
    );
  });

  test('honors the Edge preference', () => {
    const candidates = getChromeCandidates('edge', 'win32', windowsEnv);

    expect(candidates.indexOf('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')).toBeLessThan(
      candidates.indexOf('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
    );
  });

  test('checks an explicit CHROME_BIN override first', () => {
    const candidates = getChromeCandidates('chromium', 'win32', {
      ...windowsEnv,
      CHROME_BIN: 'D:\\Browsers\\Chrome\\chrome.exe',
    });

    expect(candidates[0]).toBe('D:\\Browsers\\Chrome\\chrome.exe');
  });

  test('returns the first candidate accepted by the probe', () => {
    const expected = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const found = findChromeBinary('chromium', 'win32', windowsEnv, (candidate) => candidate === expected);

    expect(found).toBe(expected);
  });

  test('returns null when no Chromium browser can launch', () => {
    expect(findChromeBinary('chromium', 'win32', windowsEnv, () => false)).toBeNull();
  });
});
