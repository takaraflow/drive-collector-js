export const STRINGS = {
    input_username: "👤 <b>请输入 Proton 账号用户名</b>\n\n通常是邮箱，例如 <code>you@proton.me</code>。",
    input_password: "🔑 <b>请输入 Proton 登录密码</b>",
    input_use_2fa: "🛡️ <b>这个账号是否开启了两步验证（2FA）？</b>\n\n请点下方按钮，或输入 <code>yes</code> / <code>no</code>。",
    input_2fa_code: "🔢 <b>请输入当前 6 位 2FA 验证码</b>\n\n打开 Authenticator / Proton 验证器，输入当前动态码。\n验证码大约 30 秒刷新一次，请尽快提交。",
    input_otp_secret_key_optional: "🔐 <b>长期自动验证（可选，高级）</b>\n\n这是 TOTP 密钥（OTP Secret Key），不是日常 6 位验证码。\n默认请跳过：绑定成功后会保存登录会话，一般不需要密钥。\n仅在会话失效、你又无法重新绑定时才考虑填写。\n⚠️ 密钥等同于可无限生成 2FA 的种子，泄露后他人可任意生成验证码；仅建议可信自托管环境使用。",
    input_mailbox_password_optional: "📬 <b>Mailbox Password（可选）</b>\n\n仅当你的 Proton 账号单独设置了邮箱密码时才需要填写。\n大多数账号没有这个密码，请直接跳过。",
    verifying: "⏳ 正在验证 Proton Drive 配置，请稍候...",
    success: "✅ <b>Proton Drive 绑定成功！</b>\n\n账号: <code>{{username}}</code>\n\n登录会话已保存，后续转存不需要再输入 2FA 验证码。\n现在可以直接发送文件或链接开始转存。",
    fail_login: "⚠️ <b>Proton Drive 登录或配置验证失败</b>\n\n请检查用户名、密码、2FA 验证码，以及是否误填了 Mailbox Password。",
    fail_2fa: "⚠️ <b>需要有效的 2FA 验证码</b>\n\n请重新绑定，并输入当前 6 位动态验证码。\n绑定成功后系统会保存登录会话，后续转存不再使用这次验证码。\n如果验证码已过期，打开验证器刷新后再试。",
    fail_network: "🌐 网络连接超时或配置异常，请稍后重试。",
    fail_unknown: "❌ 发生未知错误，请重试。",
    username_invalid: "❌ 用户名不能为空，请重新输入。",
    password_invalid: "❌ 密码不能为空，请重新输入。",
    use_2fa_invalid: "❌ 请选择是否开启 2FA，或输入 yes / no。",
    use_2fa_required: "❌ 当前账号已开启 2FA，请输入当前 6 位验证码。",
    two_factor_invalid: "❌ 2FA 验证码格式不正确，请输入 6 位数字。"
};
