import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  decrementInFlight,
  getAccountByEmail,
  getAllAccountEmails,
  incrementInFlight,
  incrementTotalRequests,
  isAvailable,
  pickAccount,
  throttleAccount,
} from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { config } from './configService.ts';
import { logStore } from './logStore.ts';
import { type BasicHeaders, getBasicHeaders } from './playwright.ts';
import { QWEN_API_BASE } from './qwen.ts';
import { projectPath } from '../utils/paths.ts';

export interface PoolEntry {
  chatId: string;
  parentId: string | null;
  inUse: boolean;
  cachedHeaders: { cookie: string; userAgent: string };
  /** Which account email this session is bound to */
  accountEmail?: string;
  /** True when this request continues an existing chat.qwen.ai conversation. */
  reused?: boolean;
}

interface PersistentConversation {
  chatId: string;
  parentId: string | null;
  accountEmail: string;
  anchors: string[];
  updatedAt: number;
  inUse: boolean;
  cachedHeaders?: { cookie: string; userAgent: string };
}

const CONVERSATIONS_FILE = projectPath('.qwen', 'conversations.json');
const MAX_SAVED_CONVERSATIONS = 200;
const MAX_CONVERSATION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ACQUIRE_TIMEOUT_MS = 30_000;

async function withSessionTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), SESSION_ACQUIRE_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stableContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function messageAnchor(message: any): string {
  const payload = JSON.stringify({
    role: message?.role || '',
    content: stableContent(message?.content),
    name: message?.name || '',
    tool_call_id: message?.tool_call_id || '',
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * System/user/tool messages form a stable lineage across compatible requests.
 * Assistant messages are deliberately excluded because they are already stored
 * by chat.qwen.ai and may be normalized differently by each client.
 */
export function buildConversationAnchors(messages: any[]): string[] {
  return messages
    .filter(
      (message) =>
        message?.role === 'system' || message?.role === 'user' || message?.role === 'tool' || message?.role === 'function',
    )
    .map(messageAnchor);
}

function anchorsAreStrictPrefix(previous: string[], current: string[]): boolean {
  if (previous.length === 0 || previous.length >= current.length) return false;
  return previous.every((anchor, index) => current[index] === anchor);
}

/** Return only the client content added after Qwen's most recent assistant turn. */
export function getContinuationMessages(messages: any[]): any[] {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0 || lastAssistant >= messages.length - 1) return messages;

  return messages.slice(lastAssistant + 1).map((message) => {
    if ((message?.role !== 'tool' && message?.role !== 'function') || message.name || !message.tool_call_id) return message;
    for (let i = lastAssistant; i >= 0; i--) {
      const call = messages[i]?.tool_calls?.find?.((candidate: any) => candidate?.id === message.tool_call_id);
      if (call?.function?.name) return { ...message, name: call.function.name };
    }
    return message;
  });
}

export function formatQwenEnvelopeError(json: any): string {
  const code = json?.data?.code || json?.code || 'unknown';
  const details = json?.data?.details || json?.details || json?.message || '';
  return details ? `${code}: ${details}` : String(code);
}

export class SessionPool {
  private activeSessions = new Set<string>();
  private activeCount = 0;
  private releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private conversations = new Map<string, PersistentConversation>();

  constructor() {
    this.loadConversations();
  }

  async initialize(): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      return;
    }
  }

  private loadConversations(): void {
    if (!existsSync(CONVERSATIONS_FILE)) return;
    try {
      const parsed = JSON.parse(readFileSync(CONVERSATIONS_FILE, 'utf8'));
      if (!Array.isArray(parsed)) return;
      const cutoff = Date.now() - MAX_CONVERSATION_AGE_MS;
      for (const item of parsed) {
        if (
          typeof item?.chatId === 'string' &&
          typeof item?.accountEmail === 'string' &&
          Array.isArray(item?.anchors) &&
          Number(item?.updatedAt) >= cutoff
        ) {
          this.conversations.set(item.chatId, {
            chatId: item.chatId,
            parentId: typeof item.parentId === 'string' ? item.parentId : null,
            accountEmail: item.accountEmail,
            anchors: item.anchors.filter((anchor: unknown) => typeof anchor === 'string'),
            updatedAt: Number(item.updatedAt),
            inUse: false,
          });
        }
      }
    } catch (err: any) {
      logStore.log('warn', 'pool', `[SessionPool] Could not load saved conversations: ${err.message || err}`);
    }
  }

  private saveConversations(): void {
    try {
      const saved = [...this.conversations.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_SAVED_CONVERSATIONS)
        .map(({ cachedHeaders: _cachedHeaders, inUse: _inUse, ...entry }) => entry);
      mkdirSync(dirname(CONVERSATIONS_FILE), { recursive: true });
      writeFileSync(CONVERSATIONS_FILE, JSON.stringify(saved, null, 2) + '\n', 'utf8');
    } catch (err: any) {
      logStore.log('warn', 'pool', `[SessionPool] Could not save conversations: ${err.message || err}`);
    }
  }

  private findContinuation(messages: any[], excludeEmail?: string): PersistentConversation | null {
    const anchors = buildConversationAnchors(messages);
    const candidates = [...this.conversations.values()]
      .filter((entry) => {
        if (entry.inUse || entry.accountEmail === excludeEmail) return false;
        const account = getAccountByEmail(entry.accountEmail);
        return !!account && isAvailable(account) && anchorsAreStrictPrefix(entry.anchors, anchors);
      })
      .sort((a, b) => b.anchors.length - a.anchors.length || b.updatedAt - a.updatedAt);
    return candidates[0] || null;
  }

  /**
   * Continue a matching Qwen website chat when possible. If the lineage is new,
   * busy, or tied to an unavailable account, create a separate website chat.
   */
  async acquireForConversation(messages: any[], excludeEmail?: string): Promise<PoolEntry> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      const mockId = process.env.TEST_SESSION_ID || 'mock-session';
      return {
        chatId: mockId,
        parentId: null,
        inUse: true,
        cachedHeaders: { cookie: '', userAgent: '' },
        accountEmail: 'mock@test',
        reused: false,
      };
    }

    const continuation = this.findContinuation(messages, excludeEmail);
    if (continuation) {
      incrementInFlight(continuation.accountEmail);
      try {
        const headers = await withSessionTimeout(
          getBasicHeaders(continuation.accountEmail),
          `Session continuation timed out for ${continuation.accountEmail}`,
        );
        continuation.inUse = true;
        continuation.anchors = buildConversationAnchors(messages);
        continuation.cachedHeaders = { cookie: headers.cookie, userAgent: headers.userAgent };
        continuation.updatedAt = Date.now();
        this.activeSessions.add(continuation.chatId);
        this.activeCount++;
        logStore.log('info', 'pool', `[SessionPool] Continued Qwen chat ${continuation.chatId.substring(0, 8)} for ${continuation.accountEmail.split('@')[0]}`);
        return {
          chatId: continuation.chatId,
          parentId: continuation.parentId,
          inUse: true,
          cachedHeaders: continuation.cachedHeaders,
          accountEmail: continuation.accountEmail,
          reused: true,
        };
      } catch (err) {
        decrementInFlight(continuation.accountEmail);
        continuation.inUse = false;
        if (err && typeof err === 'object') (err as any).accountEmail = continuation.accountEmail;
        throw err;
      }
    }

    const selected = await pickAccount(excludeEmail);
    if (!selected) throw new Error('All accounts are rate-limited or unavailable. Please wait and try again later.');
    const accountEmail = selected.email;
    try {
      const { headers, chatId } = await withSessionTimeout(
        (async () => {
          const headers = await getBasicHeaders(accountEmail);
          const chatId = await this.createSessionWithHeaders(accountEmail, headers);
          return { headers, chatId };
        })(),
        `Session acquire timed out for ${accountEmail}`,
      );
      const entry: PersistentConversation = {
        chatId,
        parentId: null,
        accountEmail,
        anchors: buildConversationAnchors(messages),
        updatedAt: Date.now(),
        inUse: true,
        cachedHeaders: { cookie: headers.cookie, userAgent: headers.userAgent },
      };
      this.conversations.set(chatId, entry);
      this.activeSessions.add(chatId);
      this.activeCount++;
      logStore.log('info', 'pool', `[SessionPool] Created persistent Qwen chat ${chatId.substring(0, 8)} for ${accountEmail.split('@')[0]}`);
      return {
        chatId: entry.chatId,
        parentId: entry.parentId,
        inUse: true,
        cachedHeaders: { cookie: headers.cookie, userAgent: headers.userAgent },
        accountEmail: entry.accountEmail,
        reused: false,
      };
    } catch (err) {
      decrementInFlight(accountEmail);
      if (/pending activation|Bad_Request|Chats\/new returned no id/i.test((err as any)?.message || '')) {
        throttleAccount(accountEmail, 30 * 60 * 1000, 'session_error');
      }
      if (err && typeof err === 'object') (err as any).accountEmail = accountEmail;
      throw err;
    }
  }

  /**
   * Acquire a fresh session. If email is provided, use that specific account.
   * Otherwise, pick the best available account (round-robin, non-throttled).
   */
  async acquire(email?: string): Promise<PoolEntry> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      const mockId = process.env.TEST_SESSION_ID || 'mock-session';
      return { chatId: mockId, parentId: null, inUse: true, cachedHeaders: { cookie: '', userAgent: '' }, accountEmail: 'mock@test' };
    }

    const maxAttempts = email ? 1 : Math.max(1, getAllAccountEmails().length);
    let lastErr: unknown;
    const ACQUIRE_TIMEOUT = 30_000; // ponytail: overall timeout to prevent hanging session creation

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const resolvedEmail = email || (await pickAccount())?.email;

      try {
        // Fetch headers once, pass to createSessionWithHeaders (no duplicate getBasicHeaders call)
        const result = await Promise.race([
          (async () => {
            const headers = await getBasicHeaders(resolvedEmail);
            const chatId = await this.createSessionWithHeaders(resolvedEmail, headers);
            return { headers, chatId };
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Session acquire timed out for ${resolvedEmail || '?'} after ${ACQUIRE_TIMEOUT}ms`)),
              ACQUIRE_TIMEOUT,
            ),
          ),
        ]);
        const { headers, chatId } = result;
        const entry: PoolEntry = {
          chatId,
          parentId: null,
          inUse: true,
          cachedHeaders: { cookie: headers.cookie, userAgent: headers.userAgent },
          accountEmail: headers.email || resolvedEmail,
        };
        this.activeSessions.add(chatId);
        this.activeCount++;
        logStore.log('info', 'pool', 'Session acquired' + (entry.accountEmail ? ': ' + entry.accountEmail.split('@')[0] : ''));
        return entry;
      } catch (err: any) {
        lastErr = err;
        if (resolvedEmail) {
          decrementInFlight(resolvedEmail);
          if (!email && /pending activation|Bad_Request|Chats\/new returned no id/i.test(err?.message || '')) {
            throttleAccount(resolvedEmail, 30 * 60 * 1000, 'session_error');
            logStore.log('warn', 'pool', `Skipping account ${resolvedEmail}: ${err.message}`);
            continue;
          }
        }
        throw err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error('Failed to acquire session');
  }

  async release(
    chatId: string,
    newParentId: string | null,
    cachedHeaders?: { cookie: string; userAgent: string },
    accountEmail?: string,
    isSuccess: boolean = true,
  ): Promise<void> {
    // Idempotency guard: if chatId not tracked as active, this session was already released.
    // Prevents double-release from competing cleanup paths (setTimeout + finally).
    if (!this.activeSessions.has(chatId)) {
      return;
    }

    // Track completed request — decrement in-flight, bump total count
    // Only count successful completions toward totalRequests
    if (accountEmail) {
      decrementInFlight(accountEmail);
      if (isSuccess) {
        incrementTotalRequests(accountEmail);
      }
    }

    this.activeSessions.delete(chatId);
    if (this.activeCount > 0) this.activeCount--;
    const conversation = this.conversations.get(chatId);
    if (conversation && isSuccess) {
      conversation.parentId = newParentId;
      conversation.updatedAt = Date.now();
      conversation.inUse = false;
      if (cachedHeaders) conversation.cachedHeaders = cachedHeaders;
      this.saveConversations();
    } else {
      if (conversation) this.conversations.delete(chatId);
      const existingTimer = this.releaseTimers.get(chatId);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        this.deleteSession(chatId, cachedHeaders, accountEmail);
        this.releaseTimers.delete(chatId);
      }, 0);
      if (typeof timer.unref === 'function') timer.unref();
      this.releaseTimers.set(chatId, timer);
      if (conversation) this.saveConversations();
    }

    logStore.log('info', 'pool', 'Session released' + (accountEmail ? ': ' + accountEmail.split('@')[0] : ''));
  }

  async deleteSession(chatId: string, cachedHeaders?: { cookie: string; userAgent: string }, accountEmail?: string): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) return;
    if (config.get('DELETE_SESSION', 'true') === 'false') return;

    // Ensure we have an email for browser context lookup
    let email = accountEmail;
    if (!email) {
      try {
        const headers = await getBasicHeaders();
        email = headers.email;
      } catch {
        console.error('[SessionPool] Failed to get email for session deletion');
        return;
      }
    }

    try {
      const tokenInfo = email ? await import('./auth.ts').then((m) => m.getTokenWithAccount(email!)) : null;
      const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';
      const response = await browserlessFetch(`${QWEN_API_BASE}/api/v2/chats/${chatId}`, {
        method: 'DELETE',
        headers: {
          accept: 'application/json, text/plain, */*',
          source: 'web',
          cookie: cookieStr,
          origin: QWEN_API_BASE,
        },
        accountEmail: email,
      });
      if (!response.ok) {
        logStore.log('debug', 'pool', `[SessionPool] Delete returned ${response.status} for ${chatId.substring(0, 8)}...`);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        logStore.log('debug', 'pool', `[SessionPool] Delete timeout for ${chatId.substring(0, 8)}...`);
      } else {
        logStore.log('debug', 'pool', `[SessionPool] Delete failed for ${chatId.substring(0, 8)}...: ${err.message}`);
      }
    }
  }

  /** Forget local continuation mappings after chats were deleted externally. */
  forgetConversations(accountEmail?: string): void {
    for (const [chatId, conversation] of this.conversations) {
      if (!accountEmail || conversation.accountEmail === accountEmail) this.conversations.delete(chatId);
    }
    this.saveConversations();
  }

  getStats(): { total: number; available: number; inUse: number; waiting: number } {
    return {
      total: this.activeSessions.size,
      available: this.activeSessions.size - this.activeCount,
      inUse: this.activeCount,
      waiting: 0,
    };
  }

  /**
   * Create a session using pre-fetched headers (avoids duplicate getBasicHeaders call).
   */
  private async createSessionWithHeaders(email: string | undefined, headers: BasicHeaders): Promise<string> {
    const acct = email ? getAccountByEmail(email) : null;

    const sessionBody = JSON.stringify({
      title: 'New Chat',
      models: [acct?.state?.token ? 'qwen3.7-plus' : 'qwen3.5-flash'],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    });

    const tokenInfo = email ? await import('./auth.ts').then((m) => m.getTokenWithAccount(email!)) : null;
    const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';

    const response = await browserlessFetch(`${QWEN_API_BASE}/api/v2/chats/new`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
        source: 'web',
        cookie: cookieStr,
        origin: QWEN_API_BASE,
        referer: 'https://chat.qwen.ai/',
      },
      body: sessionBody,
      accountEmail: email,
    });

    if (!response.ok) {
      const bodySnippet = await response
        .text()
        .then((t) => t.substring(0, 200))
        .catch(() => 'unknown');
      logStore.log('warn', 'session', `Chats/new returned ${response.status}: ${bodySnippet.substring(0, 100)}`);
      throw new Error(`Chats/new returned ${response.status}`);
    }

    const responseText = await response.text();
    if (responseText.startsWith('<')) {
      logStore.log('warn', 'session', `Chats/new returned HTML instead of JSON (${responseText.substring(0, 80)}...) — baxia challenge`);
      throw new Error(`Chats/new blocked by WAF — cookies may be expired`);
    }
    let json: any;
    try {
      json = JSON.parse(responseText);
    } catch {
      logStore.log('warn', 'session', `Chats/new returned non-JSON: ${responseText.substring(0, 120)}`);
      throw new Error(`Chats/new returned non-JSON response`);
    }
    if (!json.data?.id) {
      const message = formatQwenEnvelopeError(json);
      throw new Error(`Chats/new returned no id: ${message}`);
    }

    return json.data.id;
  }

  /**
   * Convenience wrapper: fetches headers then delegates to createSessionWithHeaders.
   */
  private async createSession(email?: string): Promise<string> {
    const headers = await getBasicHeaders(email);
    return this.createSessionWithHeaders(email || '', headers);
  }
}

export const sessionPool = new SessionPool();
