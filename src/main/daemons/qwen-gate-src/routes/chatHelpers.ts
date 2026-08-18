import { randomUUID } from 'node:crypto';
import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { modelRouter } from '../services/modelRouter.ts';
import { buildFeatureConfig, createQwenStream, fetchQwenModels } from '../services/qwen.ts';
import { getContinuationMessages, sessionPool } from '../services/sessionPool.ts';
import { THINK_TAG_NAMES, TOOL_CALL_KEYWORDS } from '../utils/tagNames.ts';
import { pendingCorrections } from './chatHelpersCore.ts';
import { compressToolResult } from './compressToolResult.ts';
import { getAiAuthoredToolSummary, UNMAPPED_TOOL_DESCRIPTION } from './toolDescriptionSummaries.ts';

/** Escape special XML characters in a string (for safe attribute & element content). */
function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Re-export everything from core utilities
export * from './chatHelpersCore.ts';

/** Pre-compiled regex patterns for user content sanitization */
const SYSTEM_REMINDER_RE = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder>/gi;
const TAG_STRIP_RE = /<(?:system|instruction|prompt|rule)\b[^>]*>[\s\S]*?<\/(?:system|instruction|prompt|rule)>/gi;
const THINK_TAG_STRIP_RE = new RegExp(`<(?:${THINK_TAG_NAMES.join('|')})\\b[^>]*>[\\s\\S]*?<\/(?:${THINK_TAG_NAMES.join('|')})>`, 'gi');
const ROLE_PREFIX_RE = /^(?:System|Assistant|User|Human):\s*/gim;
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

function summarizeToolParameters(schema: any): string {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return '';
  return Object.entries(properties)
    .map(([name, property]: [string, any]) => {
      if (Array.isArray(property?.enum) && property.enum.length > 0) return `${name}=${property.enum.join('|')}`;
      if (typeof property?.const === 'string') return `${name}=${property.const}`;
      return name;
    })
    .join(', ');
}

// ── Types ─────────────────────────────────────────────────────────

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user' | 'assistant' | 'function';
  content: string | Record<string, any>;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: Record<string, any>;
  extra: Record<string, any>;
  sub_chat_type: string;
  parent_id: string | null;
  // Function-specific fields (only for role: 'function')
  model?: string;
  modelName?: string;
  modelIdx?: number;
  userContext?: any;
  info?: Record<string, any>;
}

export interface BuildQwenMessagesResult {
  qwenMessages: QwenMessage[];
  systemContent?: string;
  toolResultsContent?: string;
}

// ── Business logic ───────────────────────────────────────────────

export function buildQwenMessages(
  messages: any[],
  body: any,
  availableTokens: number,
  _toolCalling: boolean,
  includeToolSystemPrompt: boolean = true,
): BuildQwenMessagesResult {
  const timestamp = Math.floor(Date.now() / 1000);
  const model = (body.model || '').replace('-no-thinking', '');

  const segments: string[] = [];
  const systemParts: string[] = [];
  const toolResultObjects: any[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    let contentStr = '';
    if (Array.isArray(msg.content)) {
      contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
    } else if (typeof msg.content === 'object' && msg.content !== null) {
      contentStr = JSON.stringify(msg.content);
    } else {
      contentStr = msg.content || '';
    }

    if (msg.role === 'system') {
      systemParts.push((contentStr || '').trim());
    } else if (msg.role === 'user') {
      // Extract <system-reminder> blocks to systemParts instead of stripping them
      let text = contentStr;
      const sysReminders: string[] = [];
      text = text.replace(SYSTEM_REMINDER_RE, (_m: string, inner: string) => {
        sysReminders.push(inner.trim());
        return '';
      });
      sysReminders.forEach((r) => systemParts.push(r));

      let sanitized = text
        .replace(TAG_STRIP_RE, '')
        .replace(THINK_TAG_STRIP_RE, '')
        .replace(ROLE_PREFIX_RE, '')
        .replace(CONTROL_CHAR_RE, '')
        .trim();

      if (sanitized.length === 0) continue;

      const charLimit = Math.floor(availableTokens * 3.0);
      const truncated =
        sanitized.length > charLimit
          ? sanitized.substring(0, charLimit) +
            `\n\n[TRUNCATED: input exceeded ${charLimit} characters (model: ${body.model}, available tokens: ${availableTokens})]`
          : sanitized;

      segments.push(`<user>\n${truncated}\n</user>`);
    } else if (msg.role === 'assistant') {
      let assistantContent = contentStr || '';
      const reasoning = msg.reasoning_content;
      if (reasoning) assistantContent = `<thinking>\n${reasoning}\n</thinking>\n\n${assistantContent}`;

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let parsedArgs: any = {};
          const args = tc.function?.arguments;
          if (typeof args === 'string') {
            try {
              parsedArgs = JSON.parse(args);
            } catch {
              parsedArgs = {};
            }
          } else if (args && typeof args === 'object') {
            parsedArgs = args;
          }
          const FKW = TOOL_CALL_KEYWORDS[0];
          const PKW = TOOL_CALL_KEYWORDS[1];
          const xmlParams = Object.entries(parsedArgs)
            .map(([k, v]) => `<${PKW}=${k}>${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}</${PKW}>`)
            .join('\n');
          const xmlPayload = `<${FKW}=${tc.function?.name}>\n${xmlParams}\n</${FKW}>`;
          assistantContent = assistantContent ? assistantContent + '\n' + xmlPayload : xmlPayload;
        }
      }

      segments.push(`<assist>\n${assistantContent}\n</assist>`);
    } else if (msg.role === 'tool' || msg.role === 'function') {
      let toolName = msg.name;
      if (!toolName && msg.tool_call_id) {
        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = messages[j];
          if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
            const call = prevMsg.tool_calls.find((tc: any) => tc.id === msg.tool_call_id);
            if (call) {
              toolName = call.function?.name;
              break;
            }
          }
        }
      }

      const truncated = compressToolResult(contentStr || '');
      // Inline tool result so the model sees it directly in the prompt.
      // Without this, results live ONLY in context.txt and the model loops
      // calling the same tool when the file is missing/stale (issue #44).
      // The context.txt copy is kept as a fallback for long conversations.
      const inlineName = escXml(toolName || 'unknown');
      const inlineResult = escXml(truncated);
      segments.push(`<tool-result tool="${inlineName}">\n${inlineResult}\n</tool-result>`);
      toolResultObjects.push({
        type: 'function',
        tool: toolName || 'unknown',
        result: {
          success: true,
          stdout: truncated,
          stderr: '',
          command: toolName || '',
        },
      });
    }
  }

  // Single user message with all history wrapped in <user>/<assist> tags
  let prompt = segments.length > 0 ? segments.join('\n\n') : '';

  const featureConfig = buildFeatureConfig(true);

  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const localMcp: Record<string, any> = {};
    localMcp['★'] = {};
    const unmappedToolNames: string[] = [];
    for (const t of body.tools) {
      const fn = t.function || {};
      const aiAuthoredSummary = getAiAuthoredToolSummary(fn.name || '');
      const description = aiAuthoredSummary || fn.description || '';
      localMcp['★'][fn.name] = {
        description,
        input_schema: fn.parameters || { type: 'object', properties: {} },
      };
      if (!aiAuthoredSummary) unmappedToolNames.push(fn.name);
    }

    // chat.qwen.ai can return HTTP 200 with an empty stream when local_mcp is
    // too large. Known Qwen Code tools use concise, manually authored
    // summaries above. If custom/MCP descriptions still exceed the safe
    // budget, replace them as a group with an explicit generic description;
    // never slice description text because that can corrupt exact values.
    const mcpBudget = Math.max(10_000, config.getInt('LOCAL_MCP_MAX_CHARS', 70_000));
    let mcpJson = JSON.stringify(localMcp);
    if (mcpJson.length > mcpBudget && unmappedToolNames.length > 0) {
      for (const name of unmappedToolNames) localMcp['★'][name].description = UNMAPPED_TOOL_DESCRIPTION;
      mcpJson = JSON.stringify(localMcp);
      logStore.log(
        'debug',
        'chat',
        `[Tools] Replaced ${unmappedToolNames.length} oversized custom/MCP descriptions with the explicit fallback`,
      );
    }

    if (mcpJson.length > mcpBudget) {
      const message =
        `[Tools] local_mcp is ${mcpJson.length}B after AI-authored summaries; ` +
        `the complete tool schemas still exceed the ${mcpBudget}B safe budget. Disable some tools or raise LOCAL_MCP_MAX_CHARS.`;
      logStore.log('error', 'chat', message);
      throw new Error(message);
    }

    logStore.log('debug', 'chat', `[Tools] local_mcp is ${mcpJson.length}B (budget ${mcpBudget}B)`);

    featureConfig.local_mcp = localMcp;
    // ponytail: tool schema in system prompt as textual fallback for models
    // that don't honor feature_config.local_mcp consistently
    const toolDescriptions = Object.entries(localMcp['★'])
      .map(([name, definition]: [string, any]) => {
        const params = summarizeToolParameters(definition.input_schema);
        return `- ${name}${definition.description ? `: ${definition.description}` : ''}${params ? ` (params: ${params})` : ''}`;
      })
      .join('\n');
    if (includeToolSystemPrompt) {
      systemParts.push(
        `You have access to the following tools:\n${toolDescriptions}\n\nTo call a tool, respond with the tool call in the appropriate format.`,
      );
    }
  }

  // Single message (Qwen API only accepts 1 message per chat)
  const fid = randomUUID();
  const systemContent = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
  const formatToolResult = (r: {
    type: string;
    tool: string;
    result: { success: boolean; stdout?: string; stderr?: string; command?: string };
  }) =>
    `<tool_result tool="${r.tool}" success="${r.result.success}">\n<command>${escXml(r.result.command || '')}</command>\n<stdout>${escXml(r.result.stdout || '')}</stdout>\n<stderr>${escXml(r.result.stderr || '')}</stderr>\n</tool_result>`;
  const toolResultsContent = toolResultObjects.length > 0 ? toolResultObjects.map(formatToolResult).join('\n\n') : undefined;
  const qwenMessages: QwenMessage[] = [
    {
      fid,
      parentId: null,
      childrenIds: [randomUUID()],
      role: 'user',
      content: prompt || '\n',
      user_action: 'chat',
      files: [],
      timestamp,
      models: [model],
      chat_type: 't2t',
      feature_config: featureConfig,
      extra: { meta: { subChatType: 't2t' } },
      sub_chat_type: 't2t',
      parent_id: null,
    },
  ];

  return { qwenMessages, systemContent, toolResultsContent };
}

export interface PreparedQwenTurn extends BuildQwenMessagesResult {
  chatHistoryContent: string;
}

/**
 * A continued chat already contains its earlier turns on chat.qwen.ai, so only
 * send the content after the latest assistant response. Fresh chats retain the
 * full-history/context.txt fallback.
 */
export function prepareQwenTurn(
  messages: any[],
  body: any,
  availableTokens: number,
  toolCalling: boolean,
  isContinuation: boolean,
): PreparedQwenTurn {
  const requestMessages = isContinuation ? getContinuationMessages(messages) : messages;
  const built = buildQwenMessages(requestMessages, body, availableTokens, toolCalling, !isContinuation);
  const processedMessages = built.qwenMessages;
  if (isContinuation && built.systemContent) {
    const existing = typeof processedMessages[0].content === 'string' ? processedMessages[0].content : '';
    processedMessages[0] = {
      ...processedMessages[0],
      content: `<system-reminder>\n${built.systemContent}\n</system-reminder>\n\n${existing}`,
    };
  }
  let inlineContent = processedMessages[0].content as string;
  let chatHistoryContent = '';

  if (typeof inlineContent === 'string' && inlineContent.length > 50_000) {
    const parts = inlineContent.split(/\n\n(?=<user>|<assist>)/);
    let keptLen = 0;
    let splitIdx = parts.length;
    for (let i = parts.length - 1; i >= 0; i--) {
      const addLen = parts[i].length + (keptLen > 0 ? 2 : 0);
      if (keptLen + addLen > 50_000) break;
      keptLen += addLen;
      splitIdx = i;
    }
    if (splitIdx > 0) {
      chatHistoryContent = parts.slice(0, splitIdx).join('\n\n');
      inlineContent = parts.slice(splitIdx).join('\n\n');
      processedMessages[0] = { ...processedMessages[0], content: inlineContent };
    }
  }

  return {
    qwenMessages: processedMessages,
    systemContent: isContinuation ? undefined : built.systemContent,
    // Tool results are already compressed and inlined. The file copy is only
    // needed when reconstructing a fresh chat from a full client history.
    toolResultsContent: isContinuation ? undefined : built.toolResultsContent,
    chatHistoryContent,
  };
}

export async function handleImageModelFallback(body: any, messages: any[]): Promise<void> {
  const hasImages = messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url'));
  if (hasImages) {
    const modelId = (body.model as string)
      .toLowerCase()
      .replace(/\./g, '-')
      .replace(/-no-thinking$/, '');
    const models = await fetchQwenModels();
    const specs = models.find((m: any) => m.id === modelId || m.id === body.model);
    const supportsImages = specs?.modalities?.includes('image');
    if (!supportsImages) {
      const original = body.model;
      body.model = 'qwen3.7-plus' + (original.includes('-no-thinking') ? '-no-thinking' : '');
    }
  }
}

export async function getModelSpecs(body: any): Promise<{ maxContext: number; maxOutput: number }> {
  const modelId = (body.model as string)
    .toLowerCase()
    .replace(/\./g, '-')
    .replace(/-no-thinking$/, '');
  const models = await fetchQwenModels();
  const specs = models.find((m: any) => m.id === modelId || m.id === body.model);
  return {
    maxContext: specs?.context_window || 250000,
    maxOutput: specs?.max_output_tokens || 65000,
  };
}

export async function acquireSessionWithCorrections(
  accountEmail: string | undefined,
  qwenMessages: QwenMessage[],
): Promise<{
  session: any;
  qwenMessages: QwenMessage[];
  nextParentId: string | null;
  sessionHeaders: any;
  resolvedEmail: string;
}> {
  const session = await sessionPool.acquire(accountEmail);
  const qwenMessagesWithCorrections = applySessionCorrections(session, qwenMessages, accountEmail);
  const nextParentId: string | null = session.parentId;
  const sessionHeaders = session.cachedHeaders || {};
  const resolvedEmail = session.accountEmail || accountEmail || '';
  return { session, qwenMessages: qwenMessagesWithCorrections, nextParentId, sessionHeaders, resolvedEmail };
}

export function applySessionCorrections(session: any, qwenMessages: QwenMessage[], accountEmail?: string): QwenMessage[] {
  const prevCorrections =
    pendingCorrections.get(session.chatId) ||
    (accountEmail ? pendingCorrections.get(accountEmail) : undefined) ||
    pendingCorrections.get('__echo_retry__');
  if (prevCorrections && prevCorrections.length > 0) {
    pendingCorrections.delete(session.chatId);
    if (accountEmail) pendingCorrections.delete(accountEmail);
    pendingCorrections.delete('__echo_retry__');
    const correctionsBlock = prevCorrections.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n');
    const correctionText = `### FEEDBACK FROM PREVIOUS TURN\nThe following issues were detected in your previous response. Address them now:\n${correctionsBlock}\n\n`;

    // Prepend correction text to the first message's content
    qwenMessages = qwenMessages.map((m, idx) => {
      if (idx === 0 && typeof m.content === 'string') {
        return { ...m, content: correctionText + m.content };
      }
      return m;
    });
  }
  return qwenMessages;
}

export async function createQwenStreamWithRetry(
  qwenMessages: QwenMessage[],
  isThinkingModel: boolean,
  routedModel: string,
  chatId: string,
  nextParentId: string | null,
  resolvedEmail: string,
  tools?: unknown[],
  toolChoice?: unknown,
): Promise<{ stream: ReadableStream; abortController: AbortController; qwenLogFile?: string }> {
  try {
    const result = await createQwenStream(
      qwenMessages,
      isThinkingModel,
      routedModel,
      chatId,
      nextParentId,
      resolvedEmail,
      tools,
      toolChoice,
    );
    modelRouter.recordSuccess(routedModel);
    return { stream: result.stream, abortController: result.abortController, qwenLogFile: result.qwenLogFile };
  } catch (err: any) {
    modelRouter.recordError(routedModel);
    // ponytail: caller (chat.ts) handles session release — don't double-release
    throw err;
  }
}
