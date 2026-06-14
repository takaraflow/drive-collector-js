export const STRINGS = {
    input_username: "👤 <b>请输入 Proton 账号用户名</b>\n\n严格按 rclone Proton Drive 后端填写 `username`。",
    input_password: "🔑 <b>请输入 Proton 登录密码</b>\n\n严格按 rclone Proton Drive 后端填写 `password`。",
    input_use_2fa: "🛡️ <b>这个账号是否开启了 2FA？</b>\n\n请输入：`yes` / `no`",
    input_otp_secret_key_optional: "🔐 <b>OTP Secret Key（可选，2FA 用户推荐）</b>\n\n对应 rclone 的 `otp_secret_key`。填写后 rclone 会自动生成验证码，无需每次手动输入。\n如果没有，留空发送。",
    input_2fa_optional: "🔢 <b>请输入当前 2FA 验证码</b>\n\n你没有提供 OTP Secret Key，所以需要手动输入当前 6 位动态验证码。\n注意：此验证码 30 秒过期，后续运行可能需要更新。",
    input_mailbox_password_optional: "📬 <b>请输入 Mailbox Password（可选）</b>\n\n对应 rclone 的 `mailbox_password`。只有你的 Proton 账号单独设置了邮箱密码时才需要填写；否则留空发送。",
    verifying: "⏳ 正在按 rclone Proton Drive 后端验证配置，请稍候...",
    success: "✅ <b>Proton Drive 绑定成功！</b>\n\n账号: <code>{{username}}</code>\n\n现在可以直接发送文件或链接开始转存。",
    fail_login: "⚠️ <b>Proton Drive 登录或配置验证失败</b>\n\n请检查 username/password、2FA 验证码、OTP Secret Key、Mailbox Password 是否与 rclone 配置一致。",
    username_invalid: "❌ 用户名不能为空，请重新输入。",
    password_invalid: "❌ 密码不能为空，请重新输入。",
    use_2fa_invalid: "❌ 请输入 yes 或 no。",
    use_2fa_required: "❌ 当前账号已标记开启 2FA，请输入当前验证码。"
};
