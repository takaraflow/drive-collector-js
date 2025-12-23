import { Button } from "telegram/tl/custom/button.js";
import { SessionManager } from "./SessionManager.js";
import { client } from "../services/telegram.js";
import { CloudTool } from "../services/rclone.js";
import { runBotTask, runMtprotoTask, PRIORITY } from "../utils/limiter.js";
import { DriveRepository } from "../repositories/DriveRepository.js"; // 👈 引入 Repo

/**
 * 驱动配置流程模块
 * 负责网盘的绑定、解绑以及相关会话交互
 */
export class DriveConfigFlow {
    static SUPPORTED_DRIVES = [
        { type: 'mega', name: 'Mega 网盘' },
    ];

    /**
     * 发送网盘管理面板
     * @param {string} chatId 
     * @param {string} userId 
     */
    static async sendDriveManager(chatId, userId) {
        // 使用 Repository 获取数据
        const drive = await DriveRepository.findByUserId(userId);
        
        let message = "🛠️ **网盘管理中心**\n\n";
        const buttons = [];

        if (drive) {
            const email = drive.name.split('-')[1] || drive.name;
            message += `✅ **已绑定服务：**\n类型：\`${drive.type.toUpperCase()}\`\n账号：\`${email}\`\n\n您可以选择管理文件或解绑当前网盘。`;
            
            buttons.push([
                Button.inline("📁 浏览文件", Buffer.from("files_page_0")),
                Button.inline("❌ 解绑网盘", Buffer.from("drive_unbind_confirm"))
            ]);
        } else {
            message += "目前尚未绑定任何网盘。请选择下方服务开始绑定：";
            buttons.push([
                Button.inline("➕ 绑定 Mega 网盘", Buffer.from("drive_bind_mega")) 
            ]);
        }
        await runBotTask(() => client.sendMessage(chatId, { message, buttons }), userId);
    }

    /**
     * 处理管理面板的按钮回调
     * @param {Object} event Telegram 事件对象
     * @param {string} userId 
     * @returns {Promise<string|null>} 返回给用户的 Toast 提示
     */
    static async handleCallback(event, userId) {
        const data = event.data.toString();

        if (data === "drive_unbind_confirm") {
            await runBotTask(() => client.editMessage(event.userId, {
                    message: event.msgId,
                    text: "⚠️ **确定要解绑该网盘吗？**\n\n解绑后将无法进行转存，且再次使用需重新输入密码。",
                    buttons: [
                        [
                            Button.inline("✅ 确定解绑", Buffer.from("drive_unbind_execute")), // 修正了前缀
                            Button.inline("🔙 取消", Buffer.from("drive_manager_back"))
                        ]
                    ]
                }), userId);
            return "请确认操作";
        }

        if (data === "drive_unbind_execute") {
            await this.handleUnbind(event.userId, userId);
            return "已成功解绑";
        }

        if (data === "drive_manager_back") {
            // 返回主菜单，直接复用 sendDriveManager 的逻辑稍显麻烦因为需要 editMessage
            // 这里为了简单，我们重新查一次库手动构造 editMessage
            // 原则上应该抽取 renderDriveMenuText 函数，这里为了代码紧凑直接写
            const drive = await DriveRepository.findByUserId(userId);
            let message = "🛠️ **网盘管理中心**\n\n";
            const buttons = [];
            if (drive) {
                const email = drive.name.split('-')[1] || drive.name;
                message += `✅ **已绑定服务：**\n类型：\`${drive.type.toUpperCase()}\`\n账号：\`${email}\`\n\n您可以选择管理文件或解绑当前网盘。`;
                buttons.push([
                    Button.inline("📁 浏览文件", Buffer.from("files_page_0")),
                    Button.inline("❌ 解绑网盘", Buffer.from("drive_unbind_confirm"))
                ]);
            } else {
                message += "目前尚未绑定任何网盘。请选择下方服务开始绑定：";
                buttons.push([Button.inline("➕ 绑定 Mega 网盘", Buffer.from("drive_bind_mega"))]);
            }

            await runBotTask(() => client.editMessage(event.userId, { message: event.msgId, text: message, buttons }), userId);
            return "已返回";
        }

        if (data === "drive_bind_mega") { 
            await SessionManager.start(userId, "MEGA_WAIT_EMAIL");
            await runBotTask(() => client.sendMessage(event.userId, { message: "📧 **请输入您的 Mega 登录邮箱**：" }), userId, { priority: PRIORITY.HIGH });
            return "请查看输入提示";
        }
        
        return null;
    }

    /**
     * 处理用户输入的绑定凭证
     * @param {Object} event 
     * @param {string} userId 
     * @param {Object} session 当前会话状态
     * @returns {Promise<boolean>} 是否拦截了消息
     */
    static async handleInput(event, userId, session) {
        const text = event.message.message;
        const step = session.current_step;
        const peerId = event.message.peerId; 

        if (step === "MEGA_WAIT_EMAIL") {
            if (!text.includes("@")) return await runBotTask(() => client.sendMessage(peerId, { message: "❌ 邮箱格式看似不正确，请重新输入：" }), userId, { priority: PRIORITY.HIGH });
            
            await SessionManager.update(userId, "MEGA_WAIT_PASS", { email: text.trim() });
            await runBotTask(() => client.sendMessage(peerId, { message: "🔑 **请输入密码**\n(输入后消息会被立即删除以保护隐私)" }), userId, { priority: PRIORITY.HIGH });
            return true;
        }

        if (step === "MEGA_WAIT_PASS") {
            const email = JSON.parse(session.temp_data).email;
            const password = text.trim();

            // 保护隐私：删除密码消息
            try { await runMtprotoTask(() => client.deleteMessages(peerId, [event.message.id], { revoke: true }), { priority: PRIORITY.HIGH }); } catch (e) {}

            const tempMsg = await runBotTask(() => client.sendMessage(peerId, { message: "⏳ 正在验证账号，请稍候..." }), userId, { priority: PRIORITY.HIGH });

            const configObj = { user: email, pass: password };
            
            // 调用业务验证
            const result = await CloudTool.validateConfig('mega', configObj);

            if (!result.success) {
                // 错误处理逻辑
                let errorText = "❌ **绑定失败**";
                const safeDetails = (result.details || '').replace(/`/g, "'").replace(/\n/g, " ").slice(-200); 

                if (result.reason === "2FA") {
                    errorText += "\n\n⚠️ **检测到您的账号开启了两步验证 (2FA)**。\n请先关闭 2FA 后重试。";
                } else if (safeDetails.includes("Object (typically, node or user) not found") || safeDetails.includes("couldn't login")) {
                    errorText += "\n\n⚠️ **登录失败**\n账号/密码错误或开启了 2FA。";
                } else {
                    errorText += `\n\n网络或配置异常: \`${safeDetails}\``;
                }
                
                await SessionManager.clear(userId);
                await runBotTask(() => client.editMessage(peerId, { message: tempMsg.id, text: errorText }), userId, { priority: PRIORITY.HIGH });
                return true;
            }

            // ✅ 验证成功，通过 Repository 持久化
            await DriveRepository.create(userId, `Mega-${email}`, 'mega', configObj);

            await SessionManager.clear(userId);
            await runBotTask(() => client.editMessage(peerId, { 
                message: tempMsg.id, 
                text: `✅ **绑定成功！**\n\n账号: \`${email}\`` 
            }), userId, { priority: PRIORITY.HIGH });
            return true;
        }

        return false; 
    }

    /**
     * 处理解绑动作
     */
    static async handleUnbind(chatId, userId) { 
        const drive = await DriveRepository.findByUserId(userId);
        
        if (!drive) {
            return await runBotTask(() => client.sendMessage(chatId, { message: "⚠️ 您当前未绑定任何网盘，无需解绑。" }), userId);
        }

        // 使用 Repository 删除
        await DriveRepository.deleteByUserId(userId);
        await SessionManager.clear(userId);

        await runBotTask(() => client.sendMessage(chatId, { 
                message: "✅ **解绑成功**\n\n您的账号信息已从本系统中移除。" 
            }), userId
        );
    }
}