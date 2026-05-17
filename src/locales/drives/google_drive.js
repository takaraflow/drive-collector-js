export const STRINGS = {
    // 绑定流程
    input_token: "🔑 <b>请输入 Google Drive 的 JSON Token</b>\n\n请确保包含 access_token, refresh_token 等字段。",
    verifying: "⏳ 正在验证 Token，请稍候...",
    success: "✅ <b>绑定成功！</b>\n\nGoogle Drive 已连接",
    bind_failed: "❌ <b>绑定失败</b>",
    
    // 错误消息
    fail_token: "⚠️ <b>Token 无效或已过期</b>\n请检查您输入的 JSON 格式。",
    fail_network: "网络或配置异常",
    fail_unknown: "未知错误",
    
    // 验证消息
    token_invalid: "❌ Token 格式不正确，必须是有效的 JSON 字符串，包含 access_token 和 refresh_token。"
};
