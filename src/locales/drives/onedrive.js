export const STRINGS = {
    // 绑定流程
    input_token: "🔑 <b>请输入 OneDrive 的 JSON Token</b>\n\n请从 rclone 已配置的 OneDrive remote 中复制完整 token，需包含 access_token 和 refresh_token。",
    input_drive_id: "🆔 <b>请输入 OneDrive drive_id</b>\n\n可从 rclone config dump 或 rclone 配置文件中复制。",
    input_drive_type: "☁️ <b>请输入 OneDrive drive_type</b>\n\n可选: personal / business / documentLibrary",
    verifying: "⏳ 正在验证 Token，请稍候...",
    success: "✅ <b>绑定成功！</b>\n\nOneDrive 已连接",
    bind_failed: "❌ <b>绑定失败</b>",
    
    // 错误消息
    fail_token: "⚠️ <b>Token 无效或已过期</b>\n请检查您输入的 JSON 格式。",
    fail_network: "网络或配置异常",
    fail_unknown: "未知错误",
    
    // 验证消息
    token_invalid: "❌ Token 格式不正确，必须是有效的 JSON 字符串，包含 access_token 和 refresh_token。",
    drive_id_invalid: "❌ drive_id 不能为空，请从 rclone 配置中复制。",
    drive_type_invalid: "❌ drive_type 不支持，请输入 personal、business 或 documentLibrary。"
};
