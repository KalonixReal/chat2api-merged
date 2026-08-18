import { describe, expect, test } from 'bun:test';
import { detectIncompleteAgentCompletion } from './falseCompletionGuard.ts';

describe('detectIncompleteAgentCompletion', () => {
  test('detects the Qwen progress-only stop', () => {
    expect(
      detectIncompleteAgentCompletion({
        content: 'Now let me read the full injection code in the service worker.',
        hasAvailableTools: true,
        toolCallCount: 0,
      }),
    ).toBe('action_only');
  });

  test('detects equivalent first-person action promises', () => {
    expect(
      detectIncompleteAgentCompletion({
        content: "I'll inspect the manifest next.",
        hasAvailableTools: true,
        toolCallCount: 0,
      }),
    ).toBe('action_only');
  });

  test('detects an empty agent turn', () => {
    expect(
      detectIncompleteAgentCompletion({
        content: '   ',
        hasAvailableTools: true,
        toolCallCount: 0,
      }),
    ).toBe('empty');
  });

  test('does not intercept normal answers', () => {
    expect(
      detectIncompleteAgentCompletion({
        content: 'The extension uses Manifest V3 and requests storage permission.',
        hasAvailableTools: true,
        toolCallCount: 0,
      }),
    ).toBeNull();
  });

  test('does not intercept a response with substantive findings', () => {
    expect(
      detectIncompleteAgentCompletion({
        content: "I'll inspect the manifest. The issue is an invalid host permission.",
        hasAvailableTools: true,
        toolCallCount: 0,
      }),
    ).toBeNull();
  });

  test('does not intercept when no tools were supplied', () => {
    expect(
      detectIncompleteAgentCompletion({
        content: 'Let me explain the difference.',
        hasAvailableTools: false,
        toolCallCount: 0,
      }),
    ).toBeNull();
  });

  test('does not intercept when a tool call exists', () => {
    expect(
      detectIncompleteAgentCompletion({
        content: 'Now let me read the file.',
        hasAvailableTools: true,
        toolCallCount: 1,
      }),
    ).toBeNull();
  });
});
