/**
 * Connect RPC Protocol Implementation
 * 
 * Implements Connect RPC binary protocol encoding and decoding
 * Protocol format: [1 byte flags][4 bytes length][JSON data]
 */

import type { ConnectMessage } from './types.ts';

/**
 * 编码 Connect RPC 消息
 * 
 * @param data - 要编码的数据对象
 * @returns 编码后的 Buffer
 */
export function encodeConnectMessage(data: any): Buffer {
    // 转换为 JSON 字符串
    const jsonStr = JSON.stringify(data);
    const jsonBuffer = Buffer.from(jsonStr, 'utf-8');

    // 计算长度
    const length = jsonBuffer.length;

    // 创建消息 Buffer: [flags(1)][length(4)][data(n)]
    const message = Buffer.allocUnsafe(5 + length);

    // Flags: 0x00 表示普通消息
    message.writeUInt8(0x00, 0);

    // Length: 大端序 32 位无符号整数
    message.writeUInt32BE(length, 1);

    // Data: JSON 数据
    jsonBuffer.copy(message, 5);

    return message;
}

/**
 * 解码 Connect RPC 消息
 * 
 * @param data - 二进制数据
 * @returns 解码后的对象，失败返回 null
 */
export function decodeConnectMessage(data: Buffer): any | null {
    // 检查最小长度
    if (data.length < 5) {
        return null;
    }

    try {
        // 读取 flags (1 byte)
        const flags = data.readUInt8(0);

        // 读取长度 (4 bytes, big-endian)
        const length = data.readUInt32BE(1);

        // 检查数据完整性
        if (data.length < 5 + length) {
            return null;
        }

        // 读取 JSON 数据
        const jsonBuffer = data.slice(5, 5 + length);
        const jsonStr = jsonBuffer.toString('utf-8');

        // 解析 JSON
        return JSON.parse(jsonStr);
    } catch (error) {
        console.error('Connect message decode error:', error);
        return null;
    }
}

/**
 * 解析流式响应
 * 
 * Connect RPC 流式响应包含多个连续的消息
 * 
 * @param responseData - 响应的二进制数据
 * @returns 解码后的消息数组
 */
export function parseStreamingResponse(responseData: Buffer): ConnectMessage[] {
    const messages: ConnectMessage[] = [];
    let offset = 0;
    const dataLen = responseData.length;

    while (offset < dataLen) {
        // 检查是否有足够的数据读取头部
        if (offset + 5 > dataLen) {
            break;
        }

        // 读取消息长度
        const length = responseData.readUInt32BE(offset + 1);

        // 检查是否有完整的消息
        if (offset + 5 + length > dataLen) {
            break;
        }

        // 提取消息数据
        const messageData = responseData.slice(offset, offset + 5 + length);
        const message = decodeConnectMessage(messageData);

        if (message) {
            messages.push(message);
        }

        // 移动到下一个消息
        offset += 5 + length;
    }

    return messages;
}

/**
 * 从响应消息中提取文本内容
 * 
 * @param messages - Connect 响应消息数组
 * @returns 提取的完整文本
 */
export function extractTextFromMessages(messages: ConnectMessage[]): string {
    const textParts: string[] = [];

    for (const msg of messages) {
        // 提取 block 中的文本
        if (msg.block?.text?.content) {
            const content = msg.block.text.content;
            const op = msg.op || '';

            // set 或 append 操作都添加文本
            if (op === 'set' || op === 'append') {
                textParts.push(content);
            }
        }

        // 检查是否完成
        if (msg.done) {
            break;
        }
    }

    return textParts.join('');
}

/**
 * 从响应消息中提取聊天 ID
 * 
 * @param messages - Connect 响应消息数组
 * @returns 聊天 ID，未找到返回 undefined
 */
export function extractChatId(messages: ConnectMessage[]): string | undefined {
    for (const msg of messages) {
        if (msg.chat?.id) {
            return msg.chat.id;
        }
    }
    return undefined;
}

/**
 * 从响应消息中提取消息 ID
 * 
 * @param messages - Connect 响应消息数组
 * @returns 消息 ID，未找到返回 undefined
 */
export function extractMessageId(messages: ConnectMessage[]): string | undefined {
    for (const msg of messages) {
        if (msg.message?.id && msg.message.role === 'assistant') {
            return msg.message.id;
        }
    }
    return undefined;
}
