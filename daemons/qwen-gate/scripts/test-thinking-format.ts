#!/usr/bin/env bun
/**
 * Test script: probe the running gateway with different `thinking_format` values
 * using a concurrent queue (8 parallel slots, one per account).
 *
 * Strategy: Send 8 requests in parallel. When one completes, immediately fire
 * the next value from the queue. No static delays — accounts handle their own
 * recovery naturally through round-robin rotation.
 *
 * Usage:
 *   bun run scripts/test-thinking-format.ts
 *   bun run scripts/test-thinking-format.ts --single "detailed"
 *   bun run scripts/test-thinking-format.ts --all          # includes long-tail values
 *   bun run scripts/test-thinking-format.ts --concurrency 4
 *   bun run scripts/test-thinking-format.ts --port 26405
 *   bun run scripts/test-thinking-format.ts --model qwen3.7-max
 */

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = (() => {
  const idx = process.argv.indexOf('--port');
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : '26405';
})();
const MODEL = (() => {
  const idx = process.argv.indexOf('--model');
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : 'qwen3.7-max';
})();
const SINGLE = (() => {
  const idx = process.argv.indexOf('--single');
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
})();
const INCLUDE_LONG_TAIL = process.argv.includes('--all');
const CONCURRENCY = (() => {
  const idx = process.argv.indexOf('--concurrency');
  return idx !== -1 && process.argv[idx + 1] ? parseInt(process.argv[idx + 1]) : 8;
})();

const GATEWAY_URL = `http://localhost:${PORT}/v1/chat/completions`;

// ─── Values to test ──────────────────────────────────────────────────────────
const CORE_VALUES = [
  // Tier 1: Known values
  'summary', // baseline — known to work
  'qwen', // vLLM legacy
  'qwen-chat-template', // vLLM legacy
  // Tier 2: Common verbosity/format patterns
  'full', // opposite of summary
  'detailed', // common verbosity term
  'verbose', // common verbosity term
  'none', // disable thinking output
  'minimal', // less than summary
  'compact', // condensed format
  'raw', // unprocessed thinking
  'complete', // full reasoning chain
  'brief', // shorter than summary
  'short', // concise format
  'extended', // longer than summary
  'structured', // organized format
  'simple', // simplified output
  // Tier 3: Formatting styles
  'markdown', // formatted thinking
  'plain', // plain text
  'tree', // tree-of-thought style
  'chain', // chain-of-thought style
  'steps', // step-by-step
  'outline', // outline format
  'bullet', // bullet points
  'paragraph', // prose format
  // Tier 4: Display modes
  'collapsed', // hidden/folded
  'expanded', // fully shown
  'hidden', // not displayed
  'visible', // always shown
  'inline', // inline with response
  'separate', // separate section
  // Tier 5: Other patterns
  'tagged', // XML/HTML tagged
  'annotated', // with annotations
  'key_points', // key takeaways only
  'highlight', // highlights only
  'thinking', // literal name match
  'reasoning', // synonym
  'analysis', // analysis format
  'reflection', // self-reflection style
  'debug', // debug-level output
  'trace', // execution trace
  'log', // log-style output
  'json', // JSON structured
  'xml', // XML structured
  'text', // plain text
  'formatted', // rich formatted
  'clean', // cleaned up
  'filtered', // filtered content
  'original', // original unmodified
  'translated', // translated thinking
  'streaming', // stream-friendly
];

const LONG_TAIL = [
  'tag',
  'tags',
  'stream',
  'true',
  'false',
  'concise',
  'extensive',
  'thorough',
  'comprehensive',
  'partial',
  'abbreviated',
  'truncated',
  'full_thinking',
  'chain_of_thought',
  'cot',
  'step_by_step',
  'internal',
  'external',
  'html',
  'latex',
  'yaml',
  'toml',
  'csv',
  'tags_only',
  'thinking_only',
  'no_thinking',
  'auto',
  'on',
  'off',
  'enabled',
  'disabled',
  'foo',
  'bar',
];

const VALUES_TO_TEST = SINGLE ? [SINGLE] : INCLUDE_LONG_TAIL ? [...CORE_VALUES, ...LONG_TAIL] : CORE_VALUES;

// ─── Types ───────────────────────────────────────────────────────────────────
interface TestResult {
  value: string;
  status: number;
  ok: boolean;
  error?: string;
  assistantContent?: string;
  durationMs?: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

// ─── Test function ───────────────────────────────────────────────────────────
async function testValue(value: string): Promise<TestResult> {
  const payload: Record<string, any> = {
    model: MODEL,
    stream: true,
    messages: [{ role: 'user', content: 'What is 2+2? Think step by step, then give the final answer.' }],
    _thinking_format: value,
  };

  const startMs = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000); // 90s timeout
    const resp = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // Streaming: read SSE chunks, collect content + usage
    const reader = resp.body?.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let usage: any = null;

    if (reader) {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        const text = decoder.decode(chunk, { stream: true });
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) fullContent += delta;
              // Capture usage from final chunk
              if (parsed.usage) usage = parsed.usage;
            } catch {
              /* not JSON */
            }
          }
        }
      }
    }

    return {
      value,
      status: resp.status,
      ok: resp.ok,
      assistantContent: fullContent ? fullContent.slice(0, 200) : undefined,
      usage,
      durationMs: Date.now() - startMs,
    };
  } catch (err: any) {
    return {
      value,
      status: 0,
      ok: false,
      error: err.name === 'AbortError' ? 'TIMEOUT (90s)' : err.message || String(err),
      durationMs: Date.now() - startMs,
    };
  }
}

// ─── Concurrent Queue Runner ─────────────────────────────────────────────────
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<TestResult>,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const executing = new Set<Promise<void>>();
  let nextIndex = 0;

  console.log(`\n🚀 Running ${items.length} values with ${concurrency} concurrent slots\n`);

  function scheduleNext(): Promise<void> | undefined {
    if (nextIndex >= items.length) return undefined;
    const idx = nextIndex++;
    const item = items[idx];

    const p = fn(item, idx).then((result) => {
      results.push(result);
      executing.delete(p);
      // Schedule next immediately
      const next = scheduleNext();
      if (next) executing.add(next);
    });

    return p;
  }

  // Fill initial slots
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    const p = scheduleNext();
    if (p) executing.add(p);
  }

  // Wait for all to drain
  while (executing.size > 0) {
    await Promise.race(executing);
  }

  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🧪 Qwen thinking_format concurrent probe (via gateway)`);
  console.log(`   Gateway: ${GATEWAY_URL}`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Values to test: ${VALUES_TO_TEST.length}`);
  console.log(`   Concurrency: ${CONCURRENCY}`);
  console.log(`   Mode: ${SINGLE ? 'single' : INCLUDE_LONG_TAIL ? 'all' : 'core'}\n`);

  // Check gateway is reachable
  try {
    const health = await fetch(`http://localhost:${PORT}/v1/models`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
    console.log('✅ Gateway is reachable\n');
  } catch (err: any) {
    console.error(`❌ Cannot reach gateway at ${GATEWAY_URL}: ${err.message}`);
    console.error('   Make sure the gateway is running: bun src/index.tsx');
    process.exit(1);
  }

  const startAll = Date.now();

  const results = await runWithConcurrency(VALUES_TO_TEST, CONCURRENCY, async (value, index) => {
    process.stdout.write(`[${index + 1}/${VALUES_TO_TEST.length}] "${value}" ... `);
    const result = await testValue(value);

    if (result.ok) {
      const reasoning = result.usage?.completion_tokens_details?.reasoning_tokens;
      const completion = result.usage?.completion_tokens;
      const duration = result.durationMs ? ` ${(result.durationMs / 1000).toFixed(1)}s` : '';
      const hasThinking = reasoning && reasoning > 0 ? `🧠 reasoning:${reasoning}` : '⬜ no reasoning';
      console.log(`✅ 200  ${hasThinking}  completion:${completion ?? '?'}${duration}`);
    } else {
      const duration = result.durationMs ? ` ${(result.durationMs / 1000).toFixed(1)}s` : '';
      console.log(`❌ ${result.status || 'ERR'}  ${result.error}${duration}`);
    }

    return result;
  });

  const totalDuration = ((Date.now() - startAll) / 1000).toFixed(1);

  // ─── Summary ────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log(`RESULTS SUMMARY  (total time: ${totalDuration}s)`);
  console.log('='.repeat(80));

  const accepted = results.filter((r) => r.ok);
  const rejected = results.filter((r) => !r.ok);
  const withReasoning = accepted.filter((r) => (r.usage?.completion_tokens_details?.reasoning_tokens ?? 0) > 0);

  console.log(`\n✅ ACCEPTED (${accepted.length}):`);
  for (const r of accepted) {
    const reasoning = r.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const completion = r.usage?.completion_tokens ?? '?';
    const thinking = reasoning > 0 ? ` 🧠 reasoning:${reasoning}` : '';
    const duration = r.durationMs ? ` ${(r.durationMs / 1000).toFixed(1)}s` : '';
    const contentPreview = r.assistantContent
      ? ` → "${r.assistantContent.slice(0, 80)}${r.assistantContent.length > 80 ? '...' : ''}"`
      : ' → (empty)';
    console.log(`   "${r.value}" [${r.status}]  completion:${completion}${thinking}${duration}${contentPreview}`);
  }

  console.log(`\n❌ REJECTED (${rejected.length}):`);
  for (const r of rejected) {
    const duration = r.durationMs ? ` ${(r.durationMs / 1000).toFixed(1)}s` : '';
    console.log(`   "${r.value}" [${r.status}] ${r.error}${duration}`);
  }

  if (withReasoning.length > 0) {
    console.log('\n' + '='.repeat(80));
    console.log('VALUES THAT PRODUCED REASONING TOKENS');
    console.log('='.repeat(80));
    for (const r of withReasoning) {
      const reasoning = r.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      console.log(`   "${r.value}" → ${reasoning} reasoning tokens`);
    }
  }

  // Save results
  const outPath = `network-captures/thinking-format-results-${Date.now()}.json`;
  const { writeFileSync, mkdirSync } = await import('fs');
  const { dirname } = await import('path');
  try {
    mkdirSync(dirname(outPath), { recursive: true });
  } catch {}
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n📁 Full results saved to: ${outPath}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
