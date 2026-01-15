import { Button } from "telegram/tl/custom/button.js";
import { SessionManager } from "./SessionManager.js";
import { client } from "../services/telegram.js";
import { CloudTool } from "../services/rclone.js";
import { runBotTask, runMtprotoTask, runBotTaskWithRetry, runMtprotoTaskWithRetry, PRIORITY } from "../utils/limiter.js";
import { DriveRepository } from "../repositories/DriveRepository.js";
import { SettingsRepository } from "../repositories/SettingsRepository.js";
import { STRINGS, format } from "../locales/zh-CN.js";
import { escapeHTML } from "../utils/common.js";

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
        const defaultDriveId = await SettingsRepository.get(`default_drive_${userId}`, null);
        
        let message = STRINGS.drive.menu_title;
        const buttons = [];

        if (drive) {
            const email = drive.name.split('-')[1] || drive.name;
            const isDefault = drive.id === defaultDriveId;
            message += format(STRINGS.drive.bound_info, { 
                type: drive.type.toUpperCase(), 
                account: escapeHTML(email) 
            });
            if (isDefault) {
                message += ` ${STRINGS.drive.is_default}`;
            } else {
                buttons.push([
                    Button.inline(STRINGS.drive.btn_set_default, Buffer.from(`drive_set_default_${drive.id}`)) 
                ]);
            }
            
            buttons.push([
                Button.inline(STRINGS.drive.btn_files, Buffer.from("files_page_0")),
                Button.inline(STRINGS.drive.btn_unbind, Buffer.from("drive_unbind_confirm"))
            ]);
        } else {
            message += STRINGS.drive.not_bound;
            buttons.push([
                Button.inline(STRINGS.drive.btn_bind_mega, Buffer.from("drive_bind_mega")) 
            ]);
        }
        await runBotTaskWithRetry(() => client.sendMessage(chatId, { message, buttons, parseMode: "html" }), userId, {}, false, 3);
    }

    /**
     * 处理管理面板的按钮回调
     * @param {Object} event Telegram 事件对象
     * @param {string} userId 
     * @returns {Promise<string|null>} 返回给用户的 Toast 提示
     */
    static async handleCallback(event, userId) {
        const data = event.data.toString();

        if (data.startsWith("drive_set_default_")) {
            const driveId = data.split("_")[3];
            await SettingsRepository.set(`default_drive_${userId}`, driveId);
            await this.sendDriveManager(event.userId, userId); // 刷新界面
            return STRINGS.drive.set_default_success;
        }

        if (data === "drive_unbind_confirm") {
            await runBotTaskWithRetry(() => client.editMessage(event.userId, {
                    message: event.msgId,
                    text: STRINGS.drive.unbind_confirm,
                    parseMode: "html",
                    buttons: [
                        [
                            Button.inline(STRINGS.drive.btn_confirm_unbind, Buffer.from("drive_unbind_execute")), 
                            Button.inline(STRINGS.drive.btn_cancel, Buffer.from("drive_manager_back"))
                        ]
                    ]
                }), userId, {}, false, 3);
            return STRINGS.drive.please_confirm;
        }

        if (data === "drive_unbind_execute") {
            await this.handleUnbind(event.userId, userId);
            return STRINGS.drive.success_unbind;
        }

        if (data === "drive_manager_back") {
            const drive = await DriveRepository.findByUserId(userId);
            const defaultDriveId = await SettingsRepository.get(`default_drive_${userId}`, null);

            let message = STRINGS.drive.menu_title;
            const buttons = [];
            if (drive) {
                const email = drive.name.split('-')[1] || drive.name;
                const isDefault = drive.id === defaultDriveId;
                message += format(STRINGS.drive.bound_info, { type: drive.type.toUpperCase(), account: escapeHTML(email) });
                if (isDefault) {
                    message += ` ${STRINGS.drive.is_default}`;
                } else {
                    buttons.push([
                        Button.inline(STRINGS.drive.btn_set_default, Buffer.from(`drive_set_default_${drive.id}`)) 
                    ]);
                }
                buttons.push([
                    Button.inline(STRINGS.drive.btn_files, Buffer.from("files_page_0")),
                    Button.inline(STRINGS.drive.btn_unbind, Buffer.from("drive_unbind_confirm"))
                ]);
            } else {
                message += STRINGS.drive.not_bound; 
                buttons.push([Button.inline(STRINGS.drive.btn_bind_mega, Buffer.from("drive_bind_mega"))]);
            }

            await runBotTask(() => client.editMessage(event.userId, { message: event.msgId, text: message, buttons, parseMode: "html" }), userId);
            return STRINGS.drive.returned;
        }

        if (data === "drive_bind_mega") { 
            await SessionManager.start(userId, "MEGA_WAIT_EMAIL");
            await runBotTask(() => client.sendMessage(event.userId, { message: STRINGS.drive.mega_input_email, parseMode: "html" }), userId, { priority: PRIORITY.HIGH }); // 👈 替换
            return STRINGS.drive.check_input;
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
            if (!text.includes("@")) {
                await runBotTask(() => client.sendMessage(peerId, { message: "❌ 邮箱格式看似不正确，请重新输入：" }), userId, { priority: PRIORITY.HIGH });
                return true;
            }
            
            await SessionManager.update(userId, "MEGA_WAIT_PASS", { email: text.trim() });
            await runBotTask(() => client.sendMessage(peerId, { message: STRINGS.drive.mega_input_pass, parseMode: "html" }), userId, { priority: PRIORITY.HIGH });
            return true;
        }

        if (step === "MEGA_WAIT_PASS") {
            const email = JSON.parse(session.temp_data).email;
            const password = text.trim();

            // 保护隐私：删除密码消息
            try { await runMtprotoTask(() => client.deleteMessages(peerId, [event.message.id], { revoke: true }), { priority: PRIORITY.HIGH }); } catch (error) {
                // 忽略删除消息失败的错误（可能权限不足或消息已不存在）
                // 这不影响绑定流程的继续执行
            }

            const tempMsg = await runBotTask(() => client.sendMessage(peerId, { message: "⏳ 正在验证账号，请稍候..." }), userId, { priority: PRIORITY.HIGH });

            const configObj = { user: email, pass: password };

            // 调用业务验证
            let result;
            try {
                result = await CloudTool.validateConfig('mega', configObj);
            } catch (e) {
                result = { success: false, reason: "ERROR", details: e.message };
            }

            if (!result.success) {
                // 错误处理逻辑
                let errorText = STRINGS.drive.bind_failed;
                const safeDetails = (result.details || '').replace(/`/g, "'").replace(/\n/g, " ").slice(-200); 

                if (result.reason === "2FA") {
                    errorText += `\n\n${STRINGS.drive.mega_fail_2fa}`;
                } else if (safeDetails.includes("Object (typically, node or user) not found") || safeDetails.includes("couldn't login")) {
                    errorText += `\n\n${STRINGS.drive.mega_fail_login}`;
                } else {
                    errorText += `\n\n网络或配置异常: <code>${escapeHTML(safeDetails)}</code>`;
                }
                
                await SessionManager.clear(userId);
                await runBotTask(() => client.editMessage(peerId, { message: tempMsg.id, text: errorText, parseMode: "html" }), userId, { priority: PRIORITY.HIGH });
                return true;
            }

            // ✅ 验证成功，通过 Repository 持久化
            await DriveRepository.create(userId, `Mega-${email}`, 'mega', configObj);

            await SessionManager.clear(userId);
            await runBotTask(() => client.editMessage(peerId, { 
                message: tempMsg.id, 
                text: format(STRINGS.drive.mega_success, { email: escapeHTML(email) }),
                parseMode: "html"
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
            return await runBotTask(() => client.sendMessage(chatId, { message: STRINGS.drive.no_drive_unbind, parseMode: "html" }), userId);
        }

        // 使用 Repository 删除
        await DriveRepository.delete(drive.id);
        await SettingsRepository.set(`default_drive_${userId}`, null);
        await SessionManager.clear(userId);

        await runBotTask(() => client.sendMessage(chatId, { 
                message: STRINGS.drive.unbind_success,
                parseMode: "html"
            }), userId
        );
    }
}