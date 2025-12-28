export const STRINGS = {
    // --- 系统/全局 ---
    system: {
        startup: "🚀 Telegram 客户端已连接",
        help: "📖 <b>云转存助手 使用帮助</b> (v{{version}})\n\n" +
              "您可以直接向我发送<b>文件、视频、图片</b>或支持的<b>链接</b>，我会自动帮您转存到绑定的网盘中。\n\n" +
              "<b>常用命令：</b>\n" +
              "/drive - 🔑 绑定或管理您的网盘\n" +
              "/files - 📁 浏览已转存的文件\n" +
              "/status - 📊 查看系统状态与任务历史\n" +
              "/help - 📖 显示此帮助菜单\n" +
              "/logout - ❌ 解绑当前网盘\n\n" +
              "<b>管理员命令：</b>\n" +
              "/open_service - 🔓 开启服务 (公开模式)\n" +
              "/close_service - 🔒 关闭服务 (维护模式)\n" +
               "/diagnosis - 🩺 系统诊断\n\n" +
              "<b>支持的链接类型：</b>\n" +
              "• Telegram 消息链接\n" +
              "• 直链 (部分支持)\n\n" +
              "如有疑问或建议，请联系管理员。",
        maintenance_mode: "🚧 <b>系统维护中</b>\n\n当前 Bot 仅限管理员使用，请稍后访问。",
        maintenance_alert: "🚧 系统维护中",
        welcome: "👋 <b>欢迎使用云转存助手</b>\n\n可以直接发送文件或链接给我，我会帮您转存。\n\n/drive - 🔑 绑定网盘\n/files - 📁 浏览文件\n/status - 📊 查看系统状态",
        unknown_error: "❌ 发生未知错误，请稍后重试。",
        // 🆕 新增
        node_service_active: "Node Service Active",
        health_check_ready: "📡 健康检查端口 {{port}} 已就绪",
        init_history_complete: "✅ 历史任务初始化扫描完成",
        init_error: "❌ 任务初始化过程中发生错误:",
        critical_error: "Critical: Unhandled Dispatcher Error:",
    },

    // --- 任务相关 ---
    task: {
        captured: "🚀 <b>已捕获{{label}}任务</b>\n正在排队处理...",
        queued: "🕒 <b>任务排队中...</b>\n\n当前顺位: <code>第 {{rank}} 位</code>",
        cancelled: "🚫 任务已取消。",
        cancel_btn: "🚫 取消排队",
        create_failed: "❌ <b>任务创建失败</b>\n\n数据库连接异常，请稍后重试。",
        restore: "🔄 <b>系统重启，检测到任务中断，已自动恢复...</b>",
        downloading: "📥 正在下载资源...",
        downloaded_waiting_upload: "📥 <b>下载完成，等待转存...</b>",
        uploading: "📤 <b>资源拉取完成，正在启动转存...</b>",
        verifying: "⚙️ <b>转存完成，正在确认数据完整性...</b>",
        success_sec_transfer: "✨ <b>文件已秒传成功</b>\n\n📄 名称: <code>{{name}}</code>\n📂 目录: <code>{{folder}}</code>",
        success: "✅ <b>文件转存成功</b>\n\n📄 名称: <code>{{name}}</code>\n📂 目录: <code>{{folder}}</code>",
        duplicate: "⚠️ <b>文件已存在</b>\n\n📄 名称: <code>{{name}}</code>\n📂 目录: <code>{{folder}}</code>\n\n该文件之前已成功转存，无需重复处理。",
        failed_validation: "⚠️ <b>校验异常</b>: <code>{{name}}</code>",
        failed_upload: "❌ <b>同步终止</b>\n原因: <code>{{reason}}</code>",
        parse_failed: "❌ 无法解析该媒体文件信息。",
        link_limit: "⚠️ 仅处理前 10 个媒体。",
        cmd_sent: "指令已下达",
        task_not_found: "任务已不存在或无权操作",
        cancel_transfer_btn: "🚫 取消转存", 
        cancel_task_btn: "🚫 取消任务",
        error_prefix: "⚠️ 处理异常: ",
        batch_captured: "🚀 <b>已捕获媒体组任务 ({{count}}个)</b>\n正在排队处理...",
        batch_monitor: "📊 <b>媒体组转存看板 ({{current}}/{{total}})</b>\n━━━━━━━━━━━━━━\n{{statusText}}\n━━━━━━━━━━━━━━\n💡 进度条仅显示当前正在处理的文件",
        focus_downloading: "📥 <b>正在下载</b>: <code>{{name}}</code>",
        focus_uploading: "📤 <b>正在上传</b>: <code>{{name}}</code>",
        focus_waiting: "🕒 <b>等待处理</b>: <code>{{name}}</code>",
        focus_completed: "✅ <b>已完成</b>: <code>{{name}}</code>",
        focus_failed: "❌ <b>处理失败</b>: <code>{{name}}</code>",
    },

    // --- 网盘管理 ---
    drive: {
        menu_title: "🛠️ <b>网盘管理中心</b>\n\n",
        bound_info: "✅ <b>已绑定服务：</b>\n类型：<code>{{type}}</code>\n账号：<code>{{account}}</code>\n\n您可以选择管理文件或解绑当前网盘。",
        not_bound: "目前尚未绑定任何网盘。请选择下方服务开始绑定：",
        btn_files: "📁 浏览文件",
        btn_unbind: "❌ 解绑网盘",
        btn_bind_mega: "➕ 绑定 Mega 网盘",
        unbind_confirm: "⚠️ <b>确定要解绑该网盘吗？</b>\n\n解绑后将无法进行转存，且再次使用需重新输入密码。",
        unbind_success: "✅ <b>解绑成功</b>\n\n您的账号信息已从本系统中移除。",
        no_drive_unbind: "⚠️ 您当前未绑定任何网盘，无需解绑。",
        no_drive_found: "🚫 <b>未检测到绑定的网盘</b>\n\n请先发送 /drive 绑定网盘，然后再发送文件/链接。",
        
        // 绑定流程
        mega_input_email: "📧 <b>请输入您的 Mega 登录邮箱</b>：",
        mega_input_pass: "🔑 <b>请输入密码</b>\n(输入后消息会被立即删除以保护隐私)",
        mega_verifying: "⏳ 正在验证账号，请稍候...",
        mega_success: "✅ <b>绑定成功！</b>\n\n账号: <code>{{email}}</code>",
        mega_fail_2fa: "⚠️ <b>检测到您的账号开启了两步验证 (2FA)</b>。\n请先关闭 2FA 后重试。",
        mega_fail_login: "⚠️ <b>登录失败</b>\n账号/密码错误或开启了 2FA。",
        email_invalid: "❌ 邮箱格式看似不正确，请重新输入：",
        // 🆕 新增
        bind_failed: "❌ <b>绑定失败</b>",
        please_confirm: "请确认操作",
        success_unbind: "已成功解绑",
        returned: "已返回",
        check_input: "请查看输入提示",
        btn_confirm_unbind: "✅ 确定解绑",
        btn_cancel: "🔙 取消",
        user_id_required: "User ID is required",
        // 默认网盘
        btn_set_default: "设为默认网盘",
        is_default: "(默认)",
        set_default_success: "✅ 默认网盘设置成功！",
    },

    // --- 文件浏览 ---
    files: {
        fetching: "⏳ 正在拉取云端文件列表...",
        syncing: "🔄 正在同步最新数据...",
        refresh_limit: "🕒 刷新太快了，请 {{seconds}} 秒后再试",
        refresh_success: "刷新成功",
        // 🆕 新增
        directory_prefix: "📂 <b>目录</b>: <code>{{folder}}</code>\n\n",
        dir_empty_or_loading: "ℹ️ 目录为空或尚未加载。",
        page_info: "📊 <i>第 {{current}}/{{total}} 页 | 共 {{count}} 个文件</i>",
        btn_home: "⏮️",
        btn_prev: "⬅️",
        btn_refresh: "🔄",
        btn_next: "➡️",
        btn_end: "⏭️",
    },

    // --- 状态相关 ---
    status: {
        header: "📊 <b>系统状态</b>",
        queue_title: "📦 任务队列",
        waiting_tasks: "🕒 等待中的任务: {{count}}",
        current_task: "🔄 当前正在处理: {{count}}",
        current_file: "📄 当前任务: <code>{{name}}</code>",
        user_history: "👤 您的任务历史",
        no_tasks: "尚无任务记录。",
        task_item: "{{index}}. {{status}} <code>{{name}}</code> ({{statusText}})",
        drive_status: "🔑 网盘绑定: {{status}}",
        system_info: "💻 系统信息",
        uptime: "⏱️ 运行时间: {{uptime}}",
        service_status: "📡 服务状态: {{status}}",
        mode_changed: "✅ <b>访问模式已切换</b>\n\n当前模式: <code>{{mode}}</code>",
        no_permission: "❌ <b>无权限</b>\n\n此操作仅限管理员执行。",
        btn_diagnosis: "🩺 系统诊断",
    },

    // --- 系统诊断 ---
    diagnosis: {
        title: "🔍 <b>系统诊断报告</b>",
        multi_instance_title: "🏗️ <b>多实例状态</b>",
        network_title: "🌐 <b>网络诊断</b>",
        system_resources_title: "💾 <b>系统资源</b>",
        current_instance: "当前实例",
        leader_status: "领导者状态",
        tg_connection: "TG 连接",
        tg_lock_holder: "TG 锁持有",
        active_instances: "活跃实例",
        memory_usage: "内存",
        uptime: "运行",
        connected: "已连接",
        disconnected: "已断开",
        yes: "是",
        no: "否",
        leader: "(👑)",
        no_active_instances: "无活跃实例",
    }
};

/**
 * 简单的字符串插值工具
 * 用法: format(STRINGS.task.queued, { rank: 1 })
 */
export function format(template, vars = {}) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] !== undefined && vars[key] !== null) ? vars[key] : `{{${key}}}`);
}