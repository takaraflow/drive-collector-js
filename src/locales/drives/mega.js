export const STRINGS = {
    // 绑定流程
    input_email: "📧 <b>请输入您的 Mega 登录邮箱</b>：",
    input_pass: "🔑 <b>请输入密码</b>\n(输入后消息会被立即删除以保护隐私)",
    verifying: "⏳ 正在验证账号，请稍候...",
    success: "✅ <b>绑定成功！</b>\n\n账号: <code>{{email}}</code>",
    bind_failed: "❌ <b>绑定失败</b>",
    
    // 错误消息
    fail_2fa: "⚠️ <b>检测到您的账号开启了两步验证 (2FA)</b>。\n请先关闭 2FA 后重试。",
    fail_login: "⚠️ <b>登录失败</b>\n账号/密码错误或开启了 2FA。",
    fail_network: "网络或配置异常",
    fail_unknown: "未知错误",
    
    // 验证消息
    email_invalid: "❌ 邮箱格式看似不正确，请重新输入："
};
