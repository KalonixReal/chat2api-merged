/**
 * Detects the narrow failure mode where an agent announces a tool-backed next
 * action, but the model ends the turn before emitting a tool call or result.
 *
 * Keep this deliberately conservative: ordinary short answers must still be
 * allowed to finish, and the guard is only enabled on requests that supplied
 * tools.
 */
const ACTION_INTENT_RE =
  /^\s*(?:(?:ok(?:ay)?|sure|first|next|now|then)[,.:\s\-\u2014]*)*(?:(?:let me)|(?:i\s*(?:'ll|will|'m going to|am going to|need to)))\s+(?:quickly\s+|now\s+)*(?:read|inspect|check|search|find|look(?:\s+at|\s+through)?|open|run|test|analy[sz]e|review|examine|trace|verify|continue|investigate)\b/i;

const SUBSTANTIVE_RESULT_RE =
  /```|(?:^|\n)\s*(?:[-*+]\s+|\d+[.)]\s+)|\b(?:i found|the (?:cause|issue|problem|result) is|this (?:shows|means)|because|therefore|completed|finished|fixed)\b/i;

export interface FalseCompletionInput {
  content: string;
  hasAvailableTools: boolean;
  toolCallCount: number;
}

export type IncompleteAgentCompletionReason = 'empty' | 'action_only';

export function detectIncompleteAgentCompletion(input: FalseCompletionInput): IncompleteAgentCompletionReason | null {
  if (!input.hasAvailableTools || input.toolCallCount > 0) return null;

  const content = input.content.replace(/\s+/g, ' ').trim();
  if (!content) return 'empty';
  if (content.length < 8 || content.length > 600) return null;
  if (!ACTION_INTENT_RE.test(content)) return null;
  if (SUBSTANTIVE_RESULT_RE.test(input.content)) return null;

  return 'action_only';
}

export const FALSE_COMPLETION_RETRY_PROMPT =
  'The previous response ended without completing the agent step: it was empty or only announced a next action. Continue now and perform the pending action. If it requires one of the provided tools, emit the tool call in this response. Do not merely describe what you will do, and do not repeat the progress sentence.';
