export const STRINGS = {
    // --- 系统/全局 ---
    system: {
        startup: "🚀 Telegram 客户端已连接",
        help: "📖 <b>可以做什么</b> (v{{version}})\n\n" +
              "直接发送文件、图片、视频或支持的链接，我会转存到你的网盘。\n\n" +
              "<b>常用操作</b>\n" +
              "• 绑定或管理网盘\n" +
              "• 查看已转存文件\n" +
              "• 查看我的任务进度\n" +
              "• 设置保存目录\n\n" +
              "遇到问题请联系管理员。",
        help_admin: "\n\n<b>管理员工具</b>\n" +
                    "/users - 查看用户列表\n" +
                    "/task_queue - 查看全局任务队列\n" +
                    "/diagnosis - 系统诊断\n" +
                    "/open_service - 开启公开访问\n" +
                    "/close_service - 进入维护模式\n" +
                    "/ban - 封禁用户\n" +
                    "/unban - 解封用户",
        help_owner: "\n" +
                    "/pro_admin - 设置管理员\n" +
                    "/de_admin - 取消管理员",
        maintenance_mode: "🚧 <b>系统维护中</b>\n\n当前 Bot 仅限管理员使用，请稍后访问。",
        maintenance_alert: "🚧 系统维护中",
        welcome: "👋 <b>欢迎使用云转存助手</b>\n\n直接发送文件、图片、视频或支持的链接，我会转存到你的网盘。",
        unknown_input: "🤔 <b>没有识别这个操作</b>\n\n你可以直接发送文件或链接，或使用下面的常用操作。",
        btn_bind_drive: "绑定网盘",
        btn_help: "帮助",
        unknown_error: "❌ 发生未知错误，请稍后重试。",
        // 🆕 新增
        node_service_active: "Node Service Active",
        health_check_ready: "📡 健康检查端口 {{port}} 已就绪",
        init_history_complete: "✅ 历史任务初始化扫描完成",
        init_error: "❌ 任务初始化过程中发生错误:",
        critical_error: "Critical: Unhandled Dispatcher Error:",
        integration_help: "🤖 <b>高级接入</b>\n\n" +
                  "可把本服务连接到受信任的自动化客户端。\n\n" +
                  "配置地址请向管理员确认。需要访问密钥时发送 /mcp_token。",
        integration_token: "🔑 <b>您的专属访问密钥</b>\n\n" +
                   "<code>{{token}}</code>\n\n" +
                   "此密钥可代表你访问已绑定网盘。只在你信任的客户端中使用，不要转发给他人。\n" +
                   "如需停用或更换密钥，请联系管理员。",
    },

    // --- 任务相关 ---
    task: {
        captured: "🚀 <b>已捕获{{label}}任务</b>\n正在排队处理...",
        queued: "🕒 <b>任务排队中...</b>\n\n当前顺位: <code>第 {{rank}} 位</code>",
        cancelled: "🚫 任务已取消。",
        cancel_btn: "🚫 取消排队",
        create_failed: "❌ <b>暂时无法创建任务</b>\n\n请稍后重试；如果连续失败，请联系管理员。",
        external_confirm: "🌐 <b>确认离线下载外部链接？</b>\n\n📄 名称: <code>{{name}}</code>\n📦 大小: <code>{{size}}</code>\n🔗 来源: <code>{{url}}</code>",
        external_captured: "🌐 <b>已创建外部链接任务</b>\n\n📄 名称: <code>{{name}}</code>\n正在排队处理...",
        external_admin_only: "🔒 <b>外部链接离线下载暂未开放</b>\n\n当前仅管理员可创建外部链接任务。",
        external_unsupported: "⚠️ <b>暂不支持这个链接</b>\n\n目前仅支持 HTTP/HTTPS 直链；P2P、种子、磁力和私有网络地址不会处理。",
        external_probe_failed: "❌ <b>无法检查这个外部链接</b>\n\n请确认链接可公开访问，且不是内网、鉴权或重定向到受限地址。",
        external_limit: "⚠️ 一次只处理 1 个外部链接，请拆开发送。",
        btn_confirm_external: "确认下载",
        restore: "🔄 <b>系统重启，检测到任务中断，已自动恢复...</b>",
        downloading: "📥 正在下载资源...",
        downloaded_waiting_upload: "📥 <b>下载完成，等待转存...</b>",
        uploading: "📤 <b>资源拉取完成，正在启动转存...</b>",
        verifying: "⚙️ <b>转存完成，正在确认数据完整性...</b>",
        success_sec_transfer: "✨ <b>文件已秒传成功</b>\n\n📄 名称: {{name}}\n📂 目录: <code>{{folder}}</code>",
        success: "✅ <b>文件转存成功</b>\n\n📄 名称: {{name}}\n📂 目录: <code>{{folder}}</code>",
        duplicate: "⚠️ <b>文件已存在</b>\n\n📄 名称: {{name}}\n📂 目录: <code>{{folder}}</code>\n\n该文件之前已成功转存，无需重复处理。",
        failed_validation: "⚠️ <b>校验异常</b>: {{name}}",
        failed_action_required: "❌ <b>处理失败</b>\n\n{{reason}}",
        failed_upload: "❌ <b>转存失败</b>\n\n原因: <code>{{reason}}</code>\n你可以重试，或重新发送文件。",
        failed_upload_action_required: "❌ <b>转存失败</b>\n\n{{reason}}",
        upload_error_drive_auth_invalid: "当前绑定的网盘无法登录。请重新绑定网盘后再重试。",
        upload_error_drive_quota_exceeded: "目标网盘空间不足。请清理空间或更换保存目录后再重试。",
        upload_error_drive_permission_denied: "目标网盘拒绝写入。请检查绑定账号权限或保存目录后再重试。",
        upload_error_transient: "网盘连接暂时异常，系统已自动重试但仍失败。请稍后再试。",
        parse_failed: "❌ 无法解析该媒体文件信息。",
        link_parse_failed: "❌ <b>无法解析这个链接</b>\n\n请确认链接可访问，或重新发送文件本身。",
        link_limit: "⚠️ 仅处理前 10 个媒体。",
        cmd_sent: "指令已下达",
        task_not_found: "任务已不存在或无权操作",
        action_cancelled: "已取消操作",
        cancel_confirm: "⚠️ <b>确认取消这个任务？</b>\n\n取消后需要重新发送文件或链接才能再次转存。",
        retry_confirm: "⚠️ <b>确认重试这个任务？</b>\n\n我会重新排队处理该任务。",
        btn_confirm_cancel: "确认取消",
        btn_confirm_retry: "确认重试",
        btn_keep_task: "保留任务",
        btn_cancel_active: "取消当前任务",
        btn_retry_failed: "重试失败任务",
        cancel_transfer_btn: "🚫 取消转存",
        cancel_task_btn: "🚫 取消任务",
        retry_btn: "🔄 重试",
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
        bound_list_title: "✅ 已绑定网盘列表：",
        bound_info: "✅ <b>已绑定服务：</b>\n类型：<code>{{type}}</code>\n账号：<code>{{account}}</code>\n\n您可以选择管理文件或解绑当前网盘。",
        not_bound: "目前尚未绑定任何网盘。请选择下方服务开始绑定：",
        btn_files: "📁 浏览文件",
        btn_unbind: "❌ 解绑网盘",
        btn_bind_mega: "➕ 绑定 Mega 网盘",
        cancel_prompt: "发送 /cancel 或输入 取消 可随时退出绑定流程。",
        credential_notice: "为减少暴露，我会在提交后尝试删除这条敏感消息。请只在可信聊天中输入。",
        cancelled: "绑定流程已取消，输入 /drive 可重新开始。",
        not_found: "🚫 未找到对应网盘",
        unbind_confirm: "⚠️ <b>确认解绑这个网盘？</b>\n\n网盘：<code>{{type}}</code>\n账号：<code>{{account}}</code>\n\n解绑后不能继续转存到这个网盘，已转存文件不会从云端删除。",
        unbind_all_confirm: "⚠️ <b>确认解绑所有网盘？</b>\n\n解绑后需要重新绑定网盘才能继续转存，已转存文件不会从云端删除。",
        unbind_success: "✅ <b>解绑成功</b>\n\n您的账号信息已从本系统中移除。",
        no_drive_unbind: "⚠️ 您当前未绑定任何网盘，无需解绑。",
        no_drive_found: "🚫 <b>还没有绑定网盘</b>\n\n请先绑定网盘，然后再发送文件或链接。",
        
        // 绑定流程
        mega_input_email: "📧 <b>请输入您的 Mega 登录邮箱</b>：",
        mega_input_pass: "🔑 <b>请输入密码</b>",
        mega_verifying: "⏳ 正在验证账号，请稍候...",
        mega_success: "✅ <b>绑定成功！</b>\n\n账号: <code>{{email}}</code>\n\n现在可以直接发送文件或链接开始转存。",
        mega_fail_2fa: "⚠️ <b>暂不支持开启两步验证的账号</b>\n\n请使用支持应用密码或 Token 的方式绑定，或换用其他网盘。不建议长期关闭两步验证。",
        mega_fail_login: "⚠️ <b>登录失败</b>\n\n请检查账号和密码，或换用支持的登录方式。",
        email_invalid: "❌ 邮箱格式看似不正确，请重新输入：",
        // 🆕 新增
        bind_failed: "❌ <b>绑定失败</b>",
        bind_error: "❌ <b>绑定过程中出现问题</b>\n\n请重新尝试；如果仍失败，请联系管理员。",
        bind_failed_help: "❌ <b>绑定失败</b>\n\n{{reason}}\n\n你可以重新绑定，或换用其他网盘。",
        please_confirm: "请确认操作",
        success_unbind: "已成功解绑",
        returned: "已返回",
        check_input: "请查看输入提示",
        btn_confirm_unbind: "确认解绑",
        btn_confirm_unbind_all: "确认全部解绑",
        btn_keep_drive: "保留网盘",
        btn_cancel: "返回",
        user_id_required: "User ID is required",
        // 默认网盘
        btn_set_default: "设为默认",
        is_default: "(默认)",
        set_default_success: "✅ 默认网盘设置成功！",
        btn_bind_other: "绑定其他网盘",
        btn_more_drives: "更多网盘",
        btn_recommended_drives: "推荐网盘",
        select_type_title: "➕ <b>选择要绑定的网盘</b>",
        select_type_recommended_hint: "推荐先选择常用网盘；需要 Token 或对象存储时再打开更多网盘。",
        select_type_more_hint: "这些网盘通常需要 JSON Token、Access Key、Bucket 或 WebDAV 地址。",
        advanced_config_badge: "需高级配置",
        advanced_config_hint: "标记为“需高级配置”的网盘依赖 rclone 导出的完整凭证，未覆盖所有账号类型。",
    },

    // --- 文件浏览 ---
    files: {
        fetching: "⏳ 正在加载文件列表...",
        load_failed: "❌ <b>无法获取文件列表</b>\n\n请重新加载；如果连续失败，请联系管理员。",
        syncing: "🔄 正在同步最新数据...",
        refresh_limit: "🕒 刷新太快了，请 {{seconds}} 秒后再试",
        refresh_success: "刷新成功",
        // 🆕 新增
        directory_prefix: "📂 <b>目录</b>: <code>{{folder}}</code>\n\n",
        dir_empty: "ℹ️ 目录为空。您可以直接发送文件给我，将其转存到此目录。",
        batch_empty: "ℹ️ 尚无文件排队或加载中。您可以直接向我发送文件或链接来开始转存。",
        page_info: "📊 <i>第 {{current}}/{{total}} 页 | 共 {{count}} 个文件</i>",
        btn_home: "首页",
        btn_prev: "上一页",
        btn_refresh: "刷新",
        btn_retry_load: "重新加载文件列表",
        btn_next: "下一页",
        btn_end: "末页",
    },

    // --- 状态相关 ---
    status: {
        header: "📊 <b>我的状态</b>",
        user_header: "📊 <b>我的状态</b>",
        admin_header: "📊 <b>系统状态</b>",
        queue_title: "📦 您的任务队列",
        waiting_tasks: "🕒 排队中: {{count}}",
        current_task: "🔄 处理中: {{count}}",
        current_file: "📄 当前任务: <code>{{name}}</code>",
        active_tasks: "⚡ 活跃任务",
        user_history: "👤 您的任务历史",
        no_tasks: "尚无任务记录。请直接向我发送文件、图片或链接来开始转存。",
        no_active_tasks: "✅ 当前没有排队或处理中任务。",
        task_item: "{{index}}. {{status}} <code>{{name}}</code> ({{statusText}})",
        active_action_hint: "可直接取消当前仍在排队或处理的任务。",
        failed_action_hint: "最近有失败任务，可从这里重新排队。",
        drive_status: "🔑 网盘绑定: {{status}}",
        system_info: "💻 管理员诊断信息",
        uptime: "⏱️ 运行时间: {{uptime}}",
        service_status: "📡 服务状态: {{status}}",
        mode_changed: "✅ <b>访问模式已切换</b>\n\n当前模式: <code>{{mode}}</code>",
        no_permission: "❌ <b>无权限</b>\n\n此操作仅限管理员执行。",
        action_confirm: "⚠️ <b>确认执行此管理操作？</b>\n\n操作: <code>{{action}}</code>\n目标: <code>{{target}}</code>",
        action_failed: "❌ <b>管理操作未完成</b>\n\n请确认用户 ID 或当前权限后重试。",
        user_id_required: "❌ <b>请提供用户 ID</b>\n\n用法: <code>{{command}} [用户 ID]</code>",
        invalid_user_id: "❌ <b>用户 ID 无效</b>\n\n请检查后重试。",
        admin_granted: "✅ <b>管理员已设置</b>\n\n用户: <code>{{userId}}</code>",
        admin_revoked: "✅ <b>管理员已取消</b>\n\n用户: <code>{{userId}}</code>",
        user_banned: "🚫 <b>用户已封禁</b>\n\n用户: <code>{{userId}}</code>",
        user_unbanned: "✅ <b>用户已解封</b>\n\n用户: <code>{{userId}}</code>",
        cannot_ban_self: "❌ <b>不能封禁自己</b>",
        cannot_ban_owner: "❌ <b>不能封禁系统所有者</b>",
        btn_confirm_action: "确认执行",
        btn_cancel_action: "取消",
        btn_diagnosis: "🩺 系统诊断",
        btn_my_status: "我的状态",
        btn_task_queue: "全局队列",
        btn_user_list: "用户列表",
    },

    // --- 系统诊断 ---
    diagnosis: {
        title: "🔍 <b>系统诊断报告</b>",
        multi_instance_title: "🏗️ <b>多实例状态</b>",
        network_title: "🌐 <b>网络诊断</b>",
        system_resources_title: "💾 <b>系统资源</b>",
        current_instance: "当前实例",
        version_label: "版本",
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
    },

    // --- 全局任务队列 ---
    task_queue: {
        title: "📊 <b>全局任务队列</b>",
        loading: "🔍 正在查询任务队列...",
        status_dist: "📈 <b>状态分布</b>",
        status_row: "<code>{{status}}: {{count}}</code>",
        active_tasks: "⚡ <b>活跃任务</b> (最近 {{limit}} 条)",
        task_row: "<code>{{index}}.</code> {{statusIcon}} <code>{{name}}</code> | 👤 <code>{{user}}</code> | {{time}}",
        user_dist: "👥 <b>用户活跃分布</b> (Top 5)",
        user_row: "<code>{{index}}.</code> 👤 <code>{{userId}}</code> — {{count}} 个任务",
        no_active: "✅ 当前无活跃任务。请发送文件或链接来创建新任务。",
        no_data: "📭 暂无任务记录。快发送文件或链接开始您的第一次转存吧！",
        error: "❌ <b>暂时无法查询任务队列</b>\n\n请重新加载；如果连续失败，请查看系统诊断。",
        status_labels: {
            queued: "🕒 排队中",
            downloading: "⬇️ 下载中",
            downloaded: "📦 已下载",
            uploading: "⬆️ 上传中",
            completed: "✅ 已完成",
            failed: "❌ 失败",
            cancelled: "🚫 已取消"
        },
        detail_title: "📊 任务队列 — {{status}} (共 {{total}} 条)",
        detail_page_info: "第 {{current}}/{{total}} 页 | 共 {{count}} 条",
        task_detail_row: "<code>{{index}}.</code> {{statusIcon}} <code>{{name}}</code> | 👤 <code>{{user}}</code> | {{time}}",
        task_error_row: "   ⚠️ {{error}}",
        task_size_row: "   📦 {{size}}",
        btn_back: "返回",
        btn_refresh: "刷新",
        btn_retry_failed_page: "重试本页失败任务",
        no_tasks_in_status: "📭 该状态下暂无任务。您可以发送文件或链接来创建新任务。",
    },

    // --- 管理员用户列表 ---
    admin_users: {
        title: "👥 <b>用户列表</b>",
        loading: "🔍 正在查询用户列表...",
        error: "❌ <b>暂时无法查询用户列表</b>\n\n请重新加载；如果连续失败，请查看系统诊断。",
        empty: "当前没有可显示的用户。\n用户绑定网盘、提交任务或被设置角色后，会出现在这里。",
        summary: "共 {{total}} 位用户 · 活跃 {{active}} · 管理 {{admins}} · 封禁 {{banned}}",
        filter_line: "筛选: {{filter}} · 第 {{current}}/{{totalPages}} 页",
        user_row: "<code>{{index}}.</code> {{roleIcon}} <code>{{userId}}</code> · {{role}}",
        user_meta: "   网盘 {{drives}} · 任务 {{tasks}} · 活跃 {{activeTasks}} · 最近 {{lastSeen}}",
        user_result_meta: "   完成 {{completed}} · 失败 {{failed}}",
        filters: {
            all: "全部",
            active: "活跃",
            admin: "管理",
            banned: "封禁",
            nodrive: "未绑盘"
        },
        roles: {
            owner: "所有者",
            admin: "管理员",
            trusted: "可信用户",
            user: "普通用户",
            banned: "已封禁"
        },
        btn_all: "全部",
        btn_active: "活跃",
        btn_admin: "管理",
        btn_banned: "封禁",
        btn_nodrive: "未绑盘",
        btn_back: "返回",
        btn_refresh: "刷新",
        btn_prev: "上一页",
        btn_next: "下一页",
    },

    // --- 保存目录设置 ---
    remote_folder: {
        help: "📁 <b>保存目录</b>\n\n" +
              "后续文件会转存到这里。\n" +
              "点击“设置保存目录”后发送新目录，例如 <code>/Movies/2024</code>。",
        menu_hint: "后续文件会转存到这里。\n点击“设置保存目录”后发送新目录，例如 <code>/Movies/2024</code>。",
        set_success: "✅ <b>保存目录已设置</b>\n\n" +
                     "新目录: <code>{{path}}</code>\n" +
                     "后续文件会转存到此目录。",
        reset_success: "✅ <b>已重置为默认路径</b>\n\n" +
                        "文件会转存到默认目录: <code>{{path}}</code>",
        reset_confirm: "⚠️ <b>确认重置保存目录？</b>\n\n后续文件会转存到默认目录: <code>{{path}}</code>",
        show_current: "当前目录: <code>{{path}}</code>",
        invalid_path: "⚠️ <b>路径格式无效</b>\n\n" +
                      "路径应以 / 开头，且不包含特殊字符。\n" +
                      "示例: /Movies/2024",
        no_permission: "🚫 <b>还不能设置保存目录</b>\n\n请先绑定网盘，然后再设置保存目录。",
        error_saving: "❌ <b>保存失败</b>\n\n" +
                      "无法保存路径设置，请稍后重试。",
        error_reading: "❌ <b>读取失败</b>\n\n" +
                       "无法读取当前路径设置，请稍后重试。",
        // 交互式设置相关
        menu_title: "📁 <b>保存目录</b>\n\n",
        btn_set_path: "设置保存目录",
        btn_reset_path: "重置为默认",
        btn_confirm_reset: "确认重置",
        btn_cancel: "返回",
        input_prompt: "📝 <b>请输入保存目录</b>\n\n" +
                      "必须以 / 开头，可包含多级目录。\n" +
                      "示例: <code>/Movies/2024</code>\n\n" +
                      "发送 /cancel 可取消。",
        input_cancelled: "已取消保存目录设置。",
        waiting_for_input: "等待输入..."
    }
};

/**
 * 简单的字符串插值工具
 * 用法: format(STRINGS.task.queued, { rank: 1 })
 */
export function format(template, vars = {}) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] !== undefined && vars[key] !== null) ? vars[key] : `{{${key}}}`);
}
