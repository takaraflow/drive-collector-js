export const STRINGS = {
    input_token: "🔑 <b>请输入 pCloud 的 JSON Token</b>\n\n请从 rclone 已配置的 pCloud remote 中复制完整 token，需包含 access_token。",
    input_hostname: "🌐 <b>请输入 pCloud API hostname</b>\n\n默认区输入 api.pcloud.com；EU 区通常输入 eapi.pcloud.com。直接发送空消息不可用，请输入默认值。",
    success: "✅ <b>绑定成功！</b>\n\npCloud 已连接",
    bind_failed: "❌ <b>绑定失败</b>",
    fail_token: "⚠️ <b>Token 无效或已过期</b>\n请检查您输入的 JSON 格式。",
    fail_2fa: "⚠️ <b>需要两步验证</b>\n暂不支持开启 2FA 的账号。",
    fail_network: "网络或配置异常",
    fail_unknown: "未知错误",
    token_invalid: "❌ Token 格式不正确，必须是有效的 JSON 字符串，包含 access_token。",
    hostname_invalid: "❌ hostname 格式不正确，请输入类似 api.pcloud.com 或 eapi.pcloud.com 的主机名。"
};
