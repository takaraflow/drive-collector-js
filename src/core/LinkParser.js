import { client } from "../services/telegram.js";
import { runMtprotoTask } from "../utils/limiter.js";

/**
 * --- 链接解析与消息探测逻辑 (LinkParser) ---
 */
export class LinkParser {
    /**
     * 核心解析函数：从文本中探测链接并提取相关媒体消息
     */
    static async parse(text, userId = null) {
        // 匹配 Telegram 消息链接逻辑
        const match = text.match(/https:\/\/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/);
        if (!match) return null;

        const [_, channel, msgIdStr] = match;
        const msgId = parseInt(msgIdStr);

        try {
            // 构建 ID 探测范围 (±9)，用于捕获关联的消息组
            const ids = Array.from({ length: 19 }, (_, i) => msgId - 9 + i);
            const result = await runMtprotoTask(() => client.getMessages(channel, { ids }));

            if (!result || !Array.isArray(result) || result.length === 0) return null;

            const validMsgs = result.filter(m => m && typeof m === 'object');
            const targetMsg = validMsgs.find(m => m.id === msgId);

            if (!targetMsg) return null;

            let toProcess = [];
            if (targetMsg.groupedId) {
                // 逻辑：如果存在媒体组，提取同一组内的所有带媒体的消息
                toProcess = validMsgs.filter(m => 
                    m.groupedId && 
                    m.groupedId.toString() === targetMsg.groupedId.toString() && 
                    m.media
                );
            } else if (targetMsg.media) {
                // 逻辑：如果不是组，但本身带媒体，则单选
                toProcess = [targetMsg];
            }

            return toProcess;
        } catch (e) {
            throw new Error(`链接解析失败: ${e.message}`);
        }
    }
}