import { describe, expect, test } from 'bun:test';
import { prepareQwenTurn } from '../routes/chatHelpers.ts';
import { buildConversationAnchors, getContinuationMessages } from './sessionPool.ts';

describe('persistent Qwen conversation helpers', () => {
  test('conversation lineage grows with user turns but ignores assistant normalization', () => {
    const first = buildConversationAnchors([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ]);
    const next = buildConversationAnchors([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'answer formatted differently' },
      { role: 'user', content: 'follow up' },
    ]);

    expect(next.slice(0, first.length)).toEqual(first);
    expect(next.length).toBe(first.length + 1);
  });

  test('continued turns send only content after the latest assistant response', () => {
    const messages = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'follow up' },
    ];

    expect(getContinuationMessages(messages)).toEqual([{ role: 'user', content: 'follow up' }]);
  });

  test('continued tool results retain the tool name without resending the assistant call', () => {
    const messages = [
      { role: 'user', content: 'inspect it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'file contents' },
    ];

    expect(getContinuationMessages(messages)).toEqual([
      { role: 'tool', tool_call_id: 'call-1', name: 'read_file', content: 'file contents' },
    ]);
  });

  test('continued turns avoid context.txt material and omit old history', () => {
    const messages = [
      { role: 'system', content: 'large system instructions' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: '<system-reminder>current workspace note</system-reminder>follow up' },
    ];
    const body = {
      model: 'qwen3.7-plus',
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
        },
      ],
    };

    const continued = prepareQwenTurn(messages, body, 100_000, true, true);
    expect(continued.qwenMessages[0].content).toContain('follow up');
    expect(continued.qwenMessages[0].content).toContain('current workspace note');
    expect(continued.qwenMessages[0].content).not.toContain('first question');
    expect(continued.systemContent).toBeUndefined();
    expect(continued.toolResultsContent).toBeUndefined();
    expect(continued.chatHistoryContent).toBe('');
  });
});
