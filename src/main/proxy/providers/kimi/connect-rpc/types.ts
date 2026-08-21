/**
 * Connect RPC Protocol Types
 * 
 * TypeScript type definitions for Connect RPC protocol
 */

/**
 * Connect RPC 配置
 */
export interface ConnectConfig {
    /** API 基础 URL */
    baseUrl: string;
    /** JWT 认证 Token (从环境变量或配置文件获取) */
    authToken?: string;
    /** 设备 ID (可选，自动生成) */
    deviceId?: string;
    /** 会话 ID (可选，自动生成) */
    sessionId?: string;
    /** 用户 ID (可选，从 Token 解析) */
    userId?: string;
}

/**
 * 聊天选项
 */
export interface ChatOptions {
    /** 场景类型 */
    scenario?: 'SCENARIO_K2' | 'SCENARIO_SEARCH' | 'SCENARIO_RESEARCH' | 'SCENARIO_K1';
    /** 是否启用思考模式 */
    thinking?: boolean;
    /** 是否流式响应 */
    stream?: boolean;
}

/**
 * 消息块
 */
export interface MessageBlock {
    message_id: string;
    text: {
        content: string;
    };
}

/**
 * 聊天消息
 */
export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    blocks: MessageBlock[];
    scenario: string;
}

/**
 * 聊天请求
 */
export interface ChatRequest {
    scenario: string;
    message: ChatMessage;
    options: {
        thinking: boolean;
    };
}

/**
 * Connect 响应消息
 */
export interface ConnectMessage {
    /** 操作类型 */
    op?: 'set' | 'append';
    /** 事件偏移 */
    eventOffset?: number;
    /** 掩码 */
    mask?: string;
    /** 聊天信息 */
    chat?: {
        id: string;
        name: string;
        createTime?: string;
    };
    /** 消息信息 */
    message?: {
        id: string;
        parentId?: string;
        role: string;
        status: string;
        scenario?: string;
        createTime?: string;
    };
    /** 块信息 */
    block?: {
        id: string;
        parentId?: string;
        text?: {
            content: string;
        };
        createTime?: string;
    };
    /** 心跳 */
    heartbeat?: {};
    /** 完成标记 */
    done?: {};
}

/**
 * 提取的文本响应
 */
export interface TextResponse {
    /** 完整文本 */
    text: string;
    /** 聊天 ID */
    chatId?: string;
    /** 消息 ID */
    messageId?: string;
}
