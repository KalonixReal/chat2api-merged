#!/usr/bin/env npx tsx
/**
 * Test cross-account chat_id sharing
 *
 * Hypothesis: Can Account B continue a conversation started by Account A?
 * Test: Create chat with Account A → send turn 1 → try turn 2 with Account B
 */

import crypto from 'node:crypto';

const QWEN_API_BASE = 'https://chat.qwen.ai';
const QWEN_CHAT_COMPLETIONS = `${QWEN_API_BASE}/api/v2/chat/completions`;
const QWEN_CHATS_NEW = `${QWEN_API_BASE}/api/v2/chats/new`;

const ACCOUNTS = ['tubby-stray-sherry@duck.com', 'surfer-word-slacks@duck.com', 'evasion-lip-bottle@duck.com'];

// Import from project to reuse existing auth infrastructure
async function getHeaders(email: string) {
  const { getBasicHeaders } = await import('../src/services/playwright.ts');
  return getBasicHeaders(email);
}

// Create a new chat using full headers from browser profile
async function createChat(headers: {
  cookie: string;
  userAgent: string;
  bxUa?: string;
  bxUmidtoken?: string;
  bxV?: string;
}): Promise<string | null> {
  const requestId = crypto.randomUUID();
  const response = await fetch(QWEN_CHATS_NEW, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      cookie: headers.cookie,
      origin: QWEN_API_BASE,
      referer: `${QWEN_API_BASE}/`,
      'user-agent': headers.userAgent,
      'x-request-id': requestId,
      source: 'web',
      ...(headers.bxUmidtoken ? { 'bx-umidtoken': headers.bxUmidtoken } : {}),
      ...(headers.bxUa ? { 'bx-ua': headers.bxUa } : {}),
      ...(headers.bxV ? { 'bx-v': headers.bxV } : {}),
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`  createChat HTTP ${response.status}: ${text.substring(0, 200)}`);
    return null;
  }

  const json = await response.json();
  if (!json.data?.id) {
    console.error('  createChat no id:', JSON.stringify(json).substring(0, 200));
    return null;
  }

  return json.data.id;
}

// Send a message using full headers
async function sendMessage(
  headers: { cookie: string; userAgent: string; bxUa?: string; bxUmidtoken?: string; bxV?: string },
  chatId: string,
  parentId: string | null,
  content: string,
  model: string = 'qwen3.7-max',
): Promise<{ responseId: string; fullResponse: string } | null> {
  const userMsgId = crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);

  const payload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: 'normal',
    model: model,
    parent_id: parentId,
    messages: [
      {
        fid: userMsgId,
        parentId: parentId,
        childrenIds: [],
        role: 'user',
        content: content,
        user_action: 'chat',
        files: [],
        timestamp,
        models: [model],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: true,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_mode: 'Thinking',
          thinking_format: 'summary',
          auto_search: false,
        },
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t',
        parent_id: parentId,
      },
    ],
    timestamp: timestamp + 1,
  };

  const url = new URL(QWEN_CHAT_COMPLETIONS);
  if (chatId) url.searchParams.set('chat_id', chatId);

  const requestId = crypto.randomUUID();
  const response = await fetch(url.href, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: headers.cookie,
      origin: QWEN_API_BASE,
      referer: `${QWEN_API_BASE}/c/${chatId}`,
      'user-agent': headers.userAgent,
      'x-request-id': requestId,
      'x-accel-buffering': 'no',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(headers.bxUmidtoken ? { 'bx-umidtoken': headers.bxUmidtoken } : {}),
      ...(headers.bxUa ? { 'bx-ua': headers.bxUa } : {}),
      ...(headers.bxV ? { 'bx-v': headers.bxV } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`  sendMessage HTTP ${response.status}: ${errText.substring(0, 300)}`);
    return null;
  }

  // Parse SSE stream
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let responseId = '';
  let fullResponse = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const json = JSON.parse(data);

        // Capture response_id from response.created or response.completed
        if (json.type === 'response.created' && json.response?.id) {
          responseId = json.response.id;
        }
        if (json.type === 'response.completed' && json.response?.id && !responseId) {
          responseId = json.response.id;
        }

        // Capture streaming content
        if (json.choices?.[0]?.delta?.content) {
          fullResponse += json.choices[0].delta.content;
        }
        // Also check for output_text.delta format
        if (json.type === 'response.output_text.delta' && json.delta) {
          fullResponse += json.delta;
        }
      } catch {}
    }
  }

  return { responseId, fullResponse };
}

async function main() {
  console.log('=== Cross-Account chat_id Sharing Test ===\n');

  // Load headers from 2 accounts
  console.log('Loading account headers...');
  const accountHeaders: { email: string; headers: Awaited<ReturnType<typeof getHeaders>> }[] = [];

  for (const email of ACCOUNTS) {
    try {
      console.log(`  Loading ${email}...`);
      const headers = await getHeaders(email);
      console.log(`    ✓ Cookie length: ${headers.cookie.length}, UA: ${headers.userAgent.substring(0, 30)}...`);
      accountHeaders.push({ email, headers });
    } catch (err: any) {
      console.error(`    ✗ Failed: ${err.message}`);
    }
  }

  if (accountHeaders.length < 2) {
    console.error('\nNeed at least 2 accounts to test. Exiting.');
    process.exit(1);
  }

  const acctA = accountHeaders[0];
  const acctB = accountHeaders[1];

  // ── Test 1: Account A creates chat + sends turn 1 ──
  console.log(`\n--- Test 1: ${acctA.email} creates chat & sends turn 1 ---`);
  const chatId = await createChat(acctA.headers);
  if (!chatId) {
    console.error('Failed to create chat. Exiting.');
    process.exit(1);
  }
  console.log(`  Chat ID: ${chatId}`);

  const turn1 = await sendMessage(acctA.headers, chatId, null, 'Hello! What is 2+2?');
  if (!turn1) {
    console.error('  Failed to send turn 1. Exiting.');
    process.exit(1);
  }
  console.log(`  Response ID: ${turn1.responseId}`);
  console.log(`  Response: "${turn1.fullResponse.substring(0, 120)}..."`);

  // ── Test 2: Account B tries to continue (cross-account) ──
  console.log(`\n--- Test 2: ${acctB.email} continues conversation (cross-account) ---`);
  const turn2 = await sendMessage(acctB.headers, chatId, turn1.responseId, 'And what is 3+3?');
  if (turn2) {
    console.log(`  ✅ SUCCESS: Account B could continue the conversation!`);
    console.log(`  Response ID: ${turn2.responseId}`);
    console.log(`  Response: "${turn2.fullResponse.substring(0, 120)}..."`);
  } else {
    console.log(`  ❌ FAILED: Account B could NOT continue Account A's conversation`);
    console.log(`  → chat_id is bound to the creating account`);
  }

  // ── Test 3: Account A continues (control - should always work) ──
  console.log(`\n--- Test 3: ${acctA.email} continues (control test) ---`);
  const parentForTurn3 = turn2?.responseId || turn1.responseId;
  const turn3 = await sendMessage(acctA.headers, chatId, parentForTurn3, 'And 5+5?');
  if (turn3) {
    console.log(`  ✅ Account A continuation works`);
    console.log(`  Response: "${turn3.fullResponse.substring(0, 120)}..."`);
  } else {
    console.log(`  ❌ Account A continuation failed`);
  }

  // ── Test 4: Same account, new chat - verify proper multi-turn ──
  console.log(`\n--- Test 4: ${acctA.email} proper multi-turn in new chat ---`);
  const chatId2 = await createChat(acctA.headers);
  if (chatId2) {
    const t1 = await sendMessage(acctA.headers, chatId2, null, 'My favorite color is blue.');
    if (t1) {
      console.log(`  Turn 1 response: "${t1.fullResponse.substring(0, 80)}..."`);
      const t2 = await sendMessage(acctA.headers, chatId2, t1.responseId, 'What did I just say my favorite color is?');
      if (t2) {
        console.log(`  Turn 2 response: "${t2.fullResponse.substring(0, 80)}..."`);
        if (t2.fullResponse.toLowerCase().includes('blue')) {
          console.log(`  ✅ Qwen remembers context via parent_id chain!`);
        } else {
          console.log(`  ⚠️ Qwen didn't recall "blue" — may need proper history`);
        }
      }
    }
  }

  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
