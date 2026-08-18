#!/usr/bin/env npx tsx
/**
 * Test multi-turn via the running server's API
 *
 * Uses the existing session pool infrastructure to verify proper multi-turn works.
 * The server should use chat_id + parent_id chain automatically.
 */

const SERVER = 'http://localhost:26405';

async function sendChat(session: string, message: string): Promise<{ response: string; chatId?: string; parentId?: string }> {
  const response = await fetch(`${SERVER}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
    },
    body: JSON.stringify({
      model: 'qwen3.7-max',
      messages: [{ role: 'user', content: message }],
      stream: true,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`HTTP ${response.status}: ${err.substring(0, 200)}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.delta?.content;
          if (content) fullResponse += content;
        } catch {}
      }
    }
  }

  return { response: fullResponse };
}

async function main() {
  console.log('=== Multi-Turn Test via Server API ===\n');

  // Turn 1
  console.log('--- Turn 1 ---');
  console.log('Sending: "My favorite color is blue. Remember this."');
  const t1 = await sendChat('', 'My favorite color is blue. Remember this.');
  console.log(`Response: "${t1.response.substring(0, 200)}..."`);
  console.log(`Length: ${t1.response.length} chars\n`);

  // Turn 2 (follow-up, same session)
  console.log('--- Turn 2 ---');
  console.log('Sending: "What did I just say my favorite color is?"');
  const t2 = await sendChat('', 'What did I just say my favorite color is?');
  console.log(`Response: "${t2.response.substring(0, 200)}..."`);
  console.log(`Length: ${t2.response.length} chars\n`);

  // Check if color was recalled
  if (t2.response.toLowerCase().includes('blue')) {
    console.log('✅ PASS: Server remembered context across turns');
  } else {
    console.log('❌ FAIL: Server did NOT remember context across turns');
    console.log('   This confirms the flattening bug - all history is lost each turn');
  }

  // Turn 3
  console.log('\n--- Turn 3 ---');
  console.log('Sending: "Now change it to red."');
  const t3 = await sendChat('', 'Now change it to red.');
  console.log(`Response: "${t3.response.substring(0, 200)}..."`);

  if (t3.response.toLowerCase().includes('red')) {
    console.log('✅ Turn 3 context works');
  } else {
    console.log('❌ Turn 3 context lost');
  }
}

main().catch(console.error);
