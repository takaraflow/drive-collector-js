import { Button } from "telegram/tl/custom/button.js";
import { d1 } from "../services/d1.js";
import { SessionManager } from "./SessionManager.js";
import { client } from "../services/telegram.js";
import { CloudTool } from "../services/rclone.js";

export class DriveConfigFlow {
    // 支持的网盘列表
    static SUPPORTED_DRIVES = [
        { type: 'mega', name: 'Mega 网盘' },
        // { type: 'drive', name: 'Google Drive' } // 后续开发
    ];

    /**
     * 1. 渲染 /login 面板
     */
    static async sendLoginPanel(chatId, userId) {
        // 查库：看用户绑定了哪些
        const existing = await d1.fetchAll("SELECT type FROM user_drives WHERE user_id = ?", [userId.toString()]);
        const boundTypes = new Set(existing.map(e => e.type));

        const buttons = [];
        for (const drive of this.SUPPORTED_DRIVES) {
            const isBound = boundTypes.has(drive.type);
            buttons.push(Button.inline(
                isBound ? `✅ ${drive.name} (已绑定)` : `➕ ${drive.name}`,
                Buffer.from(isBound ? "login_noop" : `login_select_${drive.type}`)
            ));
        }

        // 两列布局
        const rows = [];
        for (let i = 0; i < buttons.length; i += 2) {
            rows.push(buttons.slice(i, i + 2));
        }

        await client.sendMessage(chatId, {
            message: "🔐 **请选择要绑定的网盘服务**\n\n绑定后，您的文件将自动转存到该网盘。",
            buttons: rows
        });
    }

    /**
     * 2. 处理按钮点击
     */
    static async handleCallback(event, userId) {
        const data = event.data.toString();
        
        // 点击了“已绑定”的按钮
        if (data === "login_noop") {
            return "⚠️ 该网盘已绑定，无需重复操作。";
        }

        // 选择 Mega
        if (data === "login_select_mega") {
            await SessionManager.start(userId, "MEGA_WAIT_EMAIL");
            await client.sendMessage(event.userId, { message: "📧 **请输入您的 Mega 登录邮箱**：" });
            return "请查看聊天窗口输入提示";
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
            if (!text.includes("@")) return await client.sendMessage(peerId, { message: "❌ 邮箱格式看似不正确，请重新输入：" });
            
            await SessionManager.update(userId, "MEGA_WAIT_PASS", { email: text.trim() });
            await client.sendMessage(peerId, { message: "🔑 **请输入密码**\n(输入后消息会被立即删除以保护隐私)" });
            return true; // 拦截成功
        }

        if (step === "MEGA_WAIT_PASS") {
            const email = JSON.parse(session.temp_data).email;
            const password = text.trim();

            // 立即删除用户的密码消息
            try { await client.deleteMessages(peerId, [event.message.id], { revoke: true }); } catch (e) {}

            // 1. 发送验证提示
            const tempMsg = await client.sendMessage(peerId, { message: "⏳ 正在验证账号，请稍候..." });

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
                
                await client.editMessage(peerId, { 
                    message: tempMsg.id, 
                    text: errorText
                });
                return true;
            }

            // ✅ 验证成功
            const configJson = JSON.stringify(configObj);

            await d1.run(`
                INSERT INTO user_drives (user_id, name, type, config_data, status, created_at)
                VALUES (?, ?, 'mega', ?, 'active', ?)
            `, [userId.toString(), `Mega-${email}`, configJson, Date.now()]);

            await SessionManager.clear(userId);
            
            await client.editMessage(peerId, { 
                message: tempMsg.id, 
                text: `✅ **绑定成功！**\n\n验证通过，现在您可以发送文件给我了。\n账号: \`${email}\`` 
            });
            return true;
        }

        return false; 
    }

    /**
     * 处理 /logout 逻辑
     */
    static async handleLogout(chatId, userId) {
        const drive = await d1.fetchOne("SELECT id FROM user_drives WHERE user_id = ?", [userId.toString()]);
        
        if (!drive) {
            return await client.sendMessage(chatId, { message: "⚠️ 您当前未绑定任何网盘，无需退出。" });
        }

        // 删除绑定记录
        await d1.run("DELETE FROM user_drives WHERE user_id = ?", [userId.toString()]);
        // 清理会话
        await SessionManager.clear(userId);

        await client.sendMessage(chatId, { 
            message: "✅ **登出成功**\n\n您的账号信息已从本系统中移除。如需再次使用，请发送 /login 重新绑定。" 
        });
    }
}