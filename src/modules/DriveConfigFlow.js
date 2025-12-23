import { Button } from "telegram/tl/custom/button.js";
import { d1 } from "../services/d1.js";
import { SessionManager } from "./SessionManager.js";
import { client } from "../services/telegram.js";
import { CloudTool } from "../services/rclone.js";
import { runBotTask } from "../utils/limiter.js";

export class DriveConfigFlow {
    // 支持的网盘列表
    static SUPPORTED_DRIVES = [
        { type: 'mega', name: 'Mega 网盘' },
        // { type: 'drive', name: 'Google Drive' } // 后续开发
    ];

    /**
     * 网盘管理中心
     */
    static async sendDriveManager(chatId, userId) {
        const drive = await d1.fetchOne("SELECT * FROM user_drives WHERE user_id = ?", [userId.toString()]);
        
        let message = "🛠️ **网盘管理中心**\n\n";
        const buttons = [];

        if (drive) {
            const email = drive.name.split('-')[1] || drive.name;
            message += `✅ **已绑定服务：**\n类型：\`${drive.type.toUpperCase()}\`\n账号：\`${email}\`\n\n您可以选择管理文件或解绑当前网盘。`;
            
            buttons.push([
                Button.inline("📁 浏览文件", Buffer.from("files_page_0")),
                Button.inline("❌ 解绑网盘", Buffer.from("drive_unbind_confirm")) // 👈 增加 drive_ 前缀保持统一
            ]);
        } else {
            message += "目前尚未绑定任何网盘。请选择下方服务开始绑定：";
            buttons.push([
                // 💡 使用 bind 明确这是一个具体的“绑定”动作，避免歧义
                Button.inline("➕ 绑定 Mega 网盘", Buffer.from("drive_bind_mega")) 
            ]);
        }
        await runBotTask(() => client.sendMessage(chatId, { message, buttons }), userId);
    }

    /**
     * 处理按钮回调
     */
    static async handleCallback(event, userId) {
        const data = event.data.toString();

        // 1. 二次确认解绑
        if (data === "drive_unbind_confirm") {
            await runBotTask(() => client.editMessage(event.userId, {
                    message: event.msgId,
                    text: "⚠️ **确定要解绑该网盘吗？**\n\n解绑后将无法进行转存，且再次使用需重新输入密码。",
                    buttons: [
                        [
                            Button.inline("✅ 确定解绑", Buffer.from("unbind_execute")),
                            Button.inline("🔙 取消", Buffer.from("drive_manager_back"))
                        ]
                    ]
                }),
                userId
            );
            return "请确认操作";
        }

        // 2. 执行解绑
        if (data === "drive_unbind_execute") {
            await this.handleUnbind(event.userId, userId);
            return "已成功解绑";
        }

        // 3. 返回管理面板
        if (data === "drive_manager_back") {
            const drive = await d1.fetchOne("SELECT * FROM user_drives WHERE user_id = ?", [userId.toString()]);
            let message = "🛠️ **网盘管理中心**\n\n";
            const buttons = [];

            if (drive) {
                const email = drive.name.split('-')[1] || drive.name;
                message += `✅ **已绑定服务：**\n类型：\`${drive.type.toUpperCase()}\`\n账号：\`${email}\`\n\n您可以选择管理文件或解绑当前网盘。`;
                buttons.push([
                    Button.inline("📁 浏览文件", Buffer.from("files_page_0")),
                    Button.inline("❌ 解绑网盘", Buffer.from("drive_unbind_confirm")) // 👈 修正：加上 drive_ 前缀
                ]);
            } else {
                message += "目前尚未绑定任何网盘。请选择下方服务开始绑定：";
                buttons.push([Button.inline("➕ 绑定 Mega 网盘", Buffer.from("drive_bind_mega"))]); // 👈 修正：动作名对齐
            }

            await runBotTask(() => client.editMessage(event.userId, { message: event.msgId, text: message, buttons }), userId);
            return "已返回";
        }

        // 绑定 Mega (语义清晰：在 drive 模块下执行 bind mega 动作)
        if (data === "drive_bind_mega") { 
            await SessionManager.start(userId, "MEGA_WAIT_EMAIL");
            await runBotTask(() => client.sendMessage(event.userId, { message: "📧 **请输入您的 Mega 登录邮箱**：" }), userId);
            return "请查看输入提示";
        }
        
        return null;
    }

    /**
     * 3. 处理文本输入 (拦截消息)
     */
    static async handleInput(event, userId, session) {
        const text = event.message.message;
        const step = session.current_step;
        const peerId = event.message.peerId; 

        // --- Mega 流程 ---
        if (step === "MEGA_WAIT_EMAIL") {
            // 简单的邮箱验证
            if (!text.includes("@")) return await runBotTask(() => client.sendMessage(peerId, { message: "❌ 邮箱格式看似不正确，请重新输入：" }), userId);
            
            await SessionManager.update(userId, "MEGA_WAIT_PASS", { email: text.trim() });
            await runBotTask(() => client.sendMessage(peerId, { message: "🔑 **请输入密码**\n(输入后消息会被立即删除以保护隐私)" }), userId);
            return true; // 拦截成功
        }

        if (step === "MEGA_WAIT_PASS") {
            const email = JSON.parse(session.temp_data).email;
            const password = text.trim();

            // 立即删除用户的密码消息
            try { await runMtprotoTask(() => client.deleteMessages(peerId, [event.message.id], { revoke: true })); } catch (e) {}

            // 1. 发送验证提示
            const tempMsg = await runBotTask(() => client.sendMessage(peerId, { message: "⏳ 正在验证账号，请稍候..." }), userId);

            // 2. 构造临时配置对象
            const configObj = { user: email, pass: password };

            // 3. 调用 Rclone 进行验证
            const result = await CloudTool.validateConfig('mega', configObj);

            if (!result.success) {
                // ❌ 验证失败处理
                let errorText = "❌ **绑定失败**";

                // 清洗错误日志
                const safeDetails = (result.details || '')
                    .replace(/`/g, "'") 
                    .replace(/\n/g, " ") 
                    .slice(-200); 

                if (result.reason === "2FA") {
                    errorText += "\n\n⚠️ **检测到您的账号开启了两步验证 (2FA)**。\n目前的自动化流程暂不支持 2FA。\n\n请去 Mega 网页版设置中关闭 2FA，或使用无 2FA 的小号重试。";
                } else if (safeDetails.includes("Object (typically, node or user) not found") || safeDetails.includes("couldn't login")) {
                    errorText += "\n\n⚠️ **登录失败**\n\n**可能原因**：\n1. 账号或密码错误\n2. **开启了两步验证 (2FA)** (Rclone 在此模式下也会报这个错)\n\n请务必**关闭 2FA** 并且确认密码正确后重试。";
                } else {
                    errorText += `\n\n可能是网络问题或配置异常。\n错误信息: \`${safeDetails}\``;
                }
                
                await SessionManager.clear(userId);
                
                await runBotTask(() => client.editMessage(peerId, { 
                        message: tempMsg.id, 
                        text: errorText
                    }),
                    userId
                );
                return true;
            }

            // ✅ 验证成功
            const configJson = JSON.stringify(configObj);

            await d1.run(`
                INSERT INTO user_drives (user_id, name, type, config_data, status, created_at)
                VALUES (?, ?, 'mega', ?, 'active', ?)
            `, [userId.toString(), `Mega-${email}`, configJson, Date.now()]);

            await SessionManager.clear(userId);
            
            await runBotTask(() => client.editMessage(peerId, { 
                    message: tempMsg.id, 
                    text: `✅ **绑定成功！**\n\n验证通过，现在您可以发送文件给我了。\n账号: \`${email}\`` 
                }),
                userId
            );
            return true;
        }

        return false; 
    }

    /**
     * 处理解绑逻辑
     */
    static async handleUnbind(chatId, userId) { 
        const drive = await d1.fetchOne("SELECT id FROM user_drives WHERE user_id = ?", [userId.toString()]);
        
        if (!drive) {
            return await runBotTask(() => client.sendMessage(chatId, { message: "⚠️ 您当前未绑定任何网盘，无需解绑。" }), userId);
        }

        // 删除绑定记录
        await d1.run("DELETE FROM user_drives WHERE user_id = ?", [userId.toString()]);
        // 清理会话
        await SessionManager.clear(userId);

        await runBotTask(() => client.sendMessage(chatId, { 
                // 💡 提示词全面语义化
                message: "✅ **解绑成功**\n\n您的账号信息已从本系统中移除。如需再次使用，请发送 /drive 重新绑定。" 
            }),
            userId
        );
    }
}