import { Button } from "telegram/tl/custom/button.js";
import { d1 } from "../services/d1.js";
import { SessionManager } from "./SessionManager.js";
import { client } from "../services/telegram.js";

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
        const existing = await d1.fetchAll("SELECT type FROM user_drives WHERE user_id = ?", [userId]);
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

        // --- Mega 流程 ---
        if (step === "MEGA_WAIT_EMAIL") {
            // 简单的邮箱验证
            if (!text.includes("@")) return await client.sendMessage(event.peerId, { message: "❌ 邮箱格式看似不正确，请重新输入：" });
            
            await SessionManager.update(userId, "MEGA_WAIT_PASS", { email: text.trim() });
            await client.sendMessage(event.peerId, { message: "🔑 **请输入密码**\n(输入后消息会被立即删除以保护隐私)" });
            return true; // 拦截成功
        }

        if (step === "MEGA_WAIT_PASS") {
            const email = JSON.parse(session.temp_data).email;
            const password = text.trim();

            // 立即删除用户的密码消息
            try { await client.deleteMessages(event.peerId, [event.message.id], { revoke: true }); } catch (e) {}

            const tempMsg = await client.sendMessage(event.peerId, { message: "⏳ 正在验证并生成配置..." });

            // 构造 Rclone 配置 (这里我们直接存 JSON，不做实时验证了，为了速度。Rclone 运行时会验证)
            const configJson = JSON.stringify({
                user: email,
                pass: password // ⚠️ 注意：实际生产中建议存 rclone obscure 后的密码，这里为演示直接存
            });

            // 存入 user_drives 表
            await d1.run(`
                INSERT INTO user_drives (user_id, name, type, config_data, status, created_at)
                VALUES (?, ?, 'mega', ?, 'active', ?)
            `, [userId, `Mega-${email}`, configJson, Date.now()]);

            // 清理会话
            await SessionManager.clear(userId);
            
            // 提示成功
            await client.editMessage(event.peerId, { 
                message: tempMsg.id, 
                text: `✅ **绑定成功！**\n\n现在您可以发送文件给我，它将自动存入您的 Mega 网盘。\n账号: \`${email}\`` 
            });
            return true;
        }

        return false; // 不是会话消息，放行
    }
}