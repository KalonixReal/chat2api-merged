import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';

export type ChromeBinaryProbe = (candidate: string) => boolean;

/** Return browser candidates in preference order for the current platform. */
export function getChromeCandidates(
  browserPreference = 'chromium',
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = [];
  const add = (...values: Array<string | undefined>): void => {
    for (const value of values) {
      if (value && !candidates.includes(value)) candidates.push(value);
    }
  };

  add(env.CHROME_BIN, env.CHROME_PATH);

  if (platform === 'win32') {
    const programFiles = env.PROGRAMFILES || env.ProgramFiles;
    const programFilesX86 = env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'];
    const localAppData = env.LOCALAPPDATA || env.LocalAppData;
    const chrome = [
      programFiles ? win32.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
      programFilesX86 ? win32.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
      localAppData ? win32.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    ];
    const edge = [
      programFilesX86 ? win32.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
      programFiles ? win32.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
      localAppData ? win32.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
    ];

    if (browserPreference.toLowerCase() === 'edge') add(...edge, ...chrome);
    else add(...chrome, ...edge);
    add('chrome.exe', 'msedge.exe', 'chromium.exe');
    return candidates;
  }

  if (platform === 'darwin') {
    if (browserPreference.toLowerCase() === 'edge') {
      add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    }
    add(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'google-chrome',
      'chromium',
    );
    return candidates;
  }

  const home = env.HOME;
  if (home) {
    add(
      `${home}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`,
      `${home}/.cache/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome`,
    );
  }
  add(
    'chromium-browser',
    'chromium',
    'google-chrome',
    'google-chrome-stable',
    'microsoft-edge',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/microsoft-edge',
  );
  return candidates;
}

function defaultProbe(candidate: string): boolean {
  if (isAbsolute(candidate) && existsSync(candidate)) return true;
  try {
    execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function findChromeBinary(
  browserPreference = 'chromium',
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  probe: ChromeBinaryProbe = defaultProbe,
): string | null {
  for (const candidate of getChromeCandidates(browserPreference, platform, env)) {
    if (probe(candidate)) return candidate;
  }
  return null;
}
