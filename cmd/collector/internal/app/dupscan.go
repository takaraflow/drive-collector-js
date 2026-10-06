package app

// /scan_dup —— 只读扫描网盘里的重复文件,列清单,不删任何东西。
//
// 与 JS 侧 DuplicateScanner + Dispatcher._runDupScan 逐条对齐:
//   - 判重分两档:后端给内容哈希就按哈希判重,不给就退化成按大小归组,
//     并把「判重依据不可靠」这件事明说 —— 否则用户会把「按大小猜」
//     误当成「网盘是干净的」。
//   - 状态放 Redis 而非内存:按钮回调可能落在另一台实例上,
//     进程重启也不该让用户拿不到已经扫出来的结果。
// ============================================================================

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

const (
	// dupScanStateTTL 与 JS 的 SCAN_STATE_TTL_SECONDS 一致。
	dupScanStateTTL = time.Hour
	// dupScanPerDriveTimeout 单盘硬上限。lsjson -R 会一直占着
	// drive-session mutex(Proton),超时前该用户的所有转存都在排队,
	// 所以宁可超时也不要长时间霸占 —— 与 JS PER_DRIVE_TIMEOUT_MS 一致。
	dupScanPerDriveTimeout = 120 * time.Second
	// dupScanPageSize 每页 3 组:一组里可能挂着几百个路径,
	// 6 组装不进 Telegram 的 4096 字符上限。
	dupScanPageSize = 3
	// dupScanEditThrottle 进度编辑的最小间隔 —— 慢盘连发多条编辑
	// 会撞上 Telegram 的 flood limit。
	dupScanEditThrottle = 3 * time.Second
	// dupScanMaxShownPaths 单组最多列几条路径,剩下的折叠成「另有 N 份」。
	dupScanMaxShownPaths = 6
)

// dupGroup 一组重复文件。
type dupGroup struct {
	// Basis 是 "hash" 或 "size" —— 决定这一组可不可信。
	Basis string   `json:"basis"`
	Algo  string   `json:"algo"`
	Size  int64    `json:"size"`
	Paths []string `json:"paths"`
}

// dupScanResult 一次扫描的结论。
type dupScanResult struct {
	Groups []dupGroup `json:"groups"`
	// Hashed / Total 用于「判重依据」那一行说明。
	Hashed int `json:"hashed"`
	Total  int `json:"total"`
	// HashAvailable 没有任何哈希就 false。这个信号必须传出去,
	// 否则上层会把「按大小归组」渲染成「未发现重复」。
	HashAvailable bool `json:"hashAvailable"`
}

// dupScanState 是 Redis 里的扫描状态,字段名与 JS 侧逐字一致 ——
// 切换期两边读写同一个 key。
type dupScanState struct {
	Status string `json:"status"` // running / done / cancelled
	// CancelAsked 是取消标志:运行中的循环在每个网盘之间检查它。
	// 正在跑的那一次由 rclone 超时兜底(它会 SIGKILL)。
	CancelAsked bool           `json:"cancelRequested"`
	DriveName   string         `json:"driveName"`
	Result      *dupScanResult `json:"result"`
}

func dupScanKey(userID string) string { return "dupscan:" + userID }

// groupDuplicates 把 lsjson 条目按判重依据分组。
//
// 纯函数,不碰 rclone/Redis —— 这样「哈希为空时不能谎称无重复」
// 这条规则能被单独测到。
func groupDuplicates(entries []rclone.FileEntry) dupScanResult {
	// item 是「带哈希的文件 + 它的算法名」。不塞回 FileEntry:
	// 借 Path 字段带走算法名会让清单对象名不副实,读的人得跳三层
	// 才看明白那是哈希键不是路径。
	type item struct {
		file rclone.FileEntry
		algo string
		val  string
	}
	var hashed []item
	var unhashed []rclone.FileEntry

	for _, f := range entries {
		if f.IsDir || f.Size <= 0 {
			continue // 0 字节不参与,否则全是噪音
		}
		// Hashes 是 {算法名: 值};后端不支持时为空。
		algo, value := firstHash(f.Hashes)
		if value != "" {
			hashed = append(hashed, item{file: f, algo: algo, val: value})
		} else {
			unhashed = append(unhashed, f)
		}
	}

	res := dupScanResult{
		Groups:        []dupGroup{},
		Hashed:        len(hashed),
		Total:         len(hashed) + len(unhashed),
		HashAvailable: len(hashed) > 0,
	}

	// 内容级判重:同一后端哈希算法下的相同值 = 内容相同。
	byHash := map[string][]string{}
	hashMeta := map[string]item{}
	for _, it := range hashed {
		key := it.algo + ":" + it.val
		byHash[key] = append(byHash[key], dupPath(it.file))
		hashMeta[key] = it
	}
	for key, paths := range byHash {
		if len(paths) < 2 {
			continue
		}
		res.Groups = append(res.Groups, dupGroup{
			Basis: "hash", Algo: hashMeta[key].algo, Size: hashMeta[key].file.Size, Paths: paths,
		})
	}

	// 降级:无哈希的文件只能按大小归组,必须标注「可能内容不同」。
	bySize := map[int64][]string{}
	for _, f := range unhashed {
		bySize[f.Size] = append(bySize[f.Size], dupPath(f))
	}
	for size, paths := range bySize {
		if len(paths) < 2 {
			continue
		}
		res.Groups = append(res.Groups, dupGroup{Basis: "size", Size: size, Paths: paths})
	}

	// 大组在前:用户最想删的就是这批。末位的路径比较只为翻页稳定 ——
	// 不排它,map 的随机迭代顺序会让同一页两次刷新内容不一样。
	sort.Slice(res.Groups, func(i, j int) bool {
		if len(res.Groups[i].Paths) != len(res.Groups[j].Paths) {
			return len(res.Groups[i].Paths) > len(res.Groups[j].Paths)
		}
		if res.Groups[i].Size != res.Groups[j].Size {
			return res.Groups[i].Size > res.Groups[j].Size
		}
		return res.Groups[i].Paths[0] < res.Groups[j].Paths[0]
	})
	return res
}

// firstHash 取第一个非空哈希的算法名与值。
//
// Go 的 map 迭代顺序随机,而同一后端通常只有一个算法;真有多个时
// 排序取第一个,免得每次刷新页面算法名都在跳。
func firstHash(hashes map[string]string) (algo, value string) {
	names := make([]string, 0, len(hashes))
	for k, v := range hashes {
		if v != "" {
			names = append(names, k)
		}
	}
	if len(names) == 0 {
		return "", ""
	}
	sort.Strings(names)
	return names[0], hashes[names[0]]
}

// dupPath 取文件路径:递归清单有 Path,没有就退回 Name。
func dupPath(f rclone.FileEntry) string {
	if f.Path != "" {
		return f.Path
	}
	return f.Name
}

// ============================================================================
// 渲染
// ============================================================================

// dupScanTitle 与 JS STRINGS.dup_scan.title 一致。
const dupScanTitle = "🔍 <b>网盘重复文件扫描</b>\n\n"

// renderDupScanPage 渲染单页重复文件清单(纯函数,可测)。
func renderDupScanPage(driveName string, r dupScanResult, page int) (string, [][]tgclient.Button) {
	groups := r.Groups
	totalPages := (len(groups) + dupScanPageSize - 1) / dupScanPageSize
	if totalPages < 1 {
		totalPages = 1
	}
	if page < 0 {
		page = 0
	}
	if page > totalPages-1 {
		page = totalPages - 1
	}

	if len(groups) == 0 {
		return dupScanTitle + fmt.Sprintf(
			"✅ <b>未发现重复文件</b>\n\n📂 网盘: <code>%s</code>\n📄 扫描文件: %d 个\n\n%s",
			escapeHTMLText(driveName), r.Total, dupScanBasisNote(r)), nil
	}

	end := min((page+1)*dupScanPageSize, len(groups))
	lines := make([]string, 0, end-page*dupScanPageSize)
	for _, g := range groups[page*dupScanPageSize : end] {
		var header string
		if g.Basis == "hash" {
			header = fmt.Sprintf("🔁 <b>%d 份相同内容</b>（每个 %s，哈希 %s）",
				len(g.Paths), formatSize(g.Size), escapeHTMLText(g.Algo))
		} else {
			header = fmt.Sprintf("🔁 <b>%d 份相同大小</b>（每个 %s，内容可能不同）",
				len(g.Paths), formatSize(g.Size))
		}
		shown := make([]string, 0, dupScanMaxShownPaths+1)
		for _, p := range g.Paths[:min(dupScanMaxShownPaths, len(g.Paths))] {
			shown = append(shown, "    • "+escapeHTMLText(p))
		}
		if len(g.Paths) > dupScanMaxShownPaths {
			shown = append(shown, fmt.Sprintf("    <i>…另有 %d 份</i>", len(g.Paths)-dupScanMaxShownPaths))
		}
		lines = append(lines, header+"\n"+strings.Join(shown, "\n"))
	}

	text := strings.Join([]string{
		dupScanTitle,
		strings.Join(lines, "\n\n"),
		fmt.Sprintf("📊 <i>第 %d/%d 页 | 共 %d 组重复</i>", page+1, totalPages, len(groups)),
		dupScanBasisNote(r),
		"📌 清单仅供参考，<b>请自行到网盘里确认后再删除</b>。",
	}, "\n\n")

	var row []tgclient.Button
	if page > 0 {
		row = append(row, tgclient.Button{Text: "上一页", Data: fmt.Sprintf("dupscan_page_%d", page-1)})
	}
	if page < totalPages-1 {
		row = append(row, tgclient.Button{Text: "下一页", Data: fmt.Sprintf("dupscan_page_%d", page+1)})
	}
	row = append(row, tgclient.Button{Text: "重新扫描", Data: "dupscan_scope_default"})
	return text, [][]tgclient.Button{row}
}

// dupScanBasisNote 说明这一页的判重依据。哈希不可用时必须明说,
// 否则用户会误以为网盘是干净的。
func dupScanBasisNote(r dupScanResult) string {
	switch {
	case r.Hashed == 0:
		return "⚠️ 判重依据: <b>文件大小</b>。该网盘后端不返回内容哈希，无法做内容级判重，<b>下面同大小的文件内容可能不同</b>。"
	case r.Hashed < r.Total:
		return fmt.Sprintf("⚠️ 判重依据: <b>混合</b>。该网盘仅 %d/%d 个文件带内容哈希：带哈希的按内容判重，其余按大小归组（内容可能不同）。", r.Hashed, r.Total)
	default:
		return "✅ 判重依据: <b>内容哈希</b>，结果准确。"
	}
}

// ============================================================================
// 状态(Redis)
// ============================================================================

func (a *App) readDupScanState(ctx context.Context, userID string) *dupScanState {
	if a.cfg.Redis == nil {
		return nil
	}
	raw, err := a.cfg.Redis.Get(ctx, dupScanKey(userID)).Result()
	if err != nil || raw == "" {
		return nil
	}
	var st dupScanState
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		return nil
	}
	return &st
}

func (a *App) writeDupScanState(ctx context.Context, userID string, st dupScanState) {
	if a.cfg.Redis == nil {
		return
	}
	blob, err := json.Marshal(st)
	if err != nil {
		a.log.Error("序列化扫描状态失败", "err", err)
		return
	}
	if err := a.cfg.Redis.Set(ctx, dupScanKey(userID), blob, dupScanStateTTL).Err(); err != nil {
		a.log.Error("写扫描状态失败", "err", err)
	}
}

// ============================================================================
// 命令与回调
// ============================================================================

// handleScanDupCommand 处理 /scan_dup —— 先问范围,不直接开扫。
func (a *App) handleScanDupCommand(ctx context.Context, msg messageInfo) error {
	// 没有 Redis 就直接拒:取消标志与「已在扫」去重都存在 Redis 里,
	// 没有它们,用户每按一次范围按钮就多开一条扫描,而每条扫描都占着
	// 该网盘的上传会话锁 —— 结果是他的转存全被堵死,还停不下来。
	// 说清楚比让它半残着跑好。
	if a.cfg.Redis == nil {
		return a.tg.SendMessage(ctx, msg.ChatID,
			"⚠️ 重复文件扫描需要 Redis 记录进度，当前未配置，功能暂不可用。")
	}
	userID := fmt.Sprintf("%d", msg.SenderID)
	drives, err := a.drives.DrivesByUser(ctx, userID)
	if err != nil {
		a.log.Error("查询网盘列表失败", "err", err)
		return a.tg.SendMessage(ctx, msg.ChatID, "❌ 查询网盘列表失败,请稍后重试。")
	}
	if len(drives) == 0 {
		return a.tg.SendMessage(ctx, msg.ChatID,
			"🚫 <b>还没有绑定网盘</b>\n\n请先发送 /drive 绑定网盘。")
	}
	return a.tg.SendWithButtons(ctx, msg.ChatID,
		dupScanTitle+"扫描整个网盘，找出重复的文件，<b>只列清单，不会删除任何东西</b>。\n请选择扫描范围：",
		[][]tgclient.Button{{
			{Text: "当前默认网盘", Data: "dupscan_scope_default"},
			{Text: "扫描所有网盘", Data: "dupscan_scope_all"},
		}})
}

// handleDupScanCallback 处理范围选择 / 取消 / 翻页。
func (a *App) handleDupScanCallback(ctx context.Context, cb tgclient.CallbackContext, data string) error {
	userID := fmt.Sprintf("%d", cb.UserID)
	answer := func(text string, alert bool) {
		if err := a.tg.AnswerCallback(ctx, cb.CallbackID, text, alert); err != nil {
			a.log.Warn("回应按钮失败", "err", err)
		}
	}

	switch {
	case data == "dupscan_cancel":
		st := a.readDupScanState(ctx, userID)
		if st == nil || st.Status != "running" {
			answer("没有正在进行的扫描", true)
			return nil
		}
		st.CancelAsked = true
		a.writeDupScanState(ctx, userID, *st)
		answer("已请求停止", false)
		return nil

	case strings.HasPrefix(data, "dupscan_page_"):
		page, err := strconv.Atoi(strings.TrimPrefix(data, "dupscan_page_"))
		if err != nil {
			return nil
		}
		st := a.readDupScanState(ctx, userID)
		if st == nil || st.Status != "done" || st.Result == nil {
			answer("没有扫描结果,请重新发送 /scan_dup", true)
			return nil
		}
		text, buttons := renderDupScanPage(st.DriveName, *st.Result, page)
		if err := a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, text, buttons); err != nil {
			a.log.Warn("翻页编辑失败", "err", err)
		}
		answer("", false)
		return nil

	case data == "dupscan_scope_default", data == "dupscan_scope_all":
		// 同一用户只允许一个扫描:两个扫描是两个 msgId,互相不保护。
		if st := a.readDupScanState(ctx, userID); st != nil && st.Status == "running" {
			return a.editScanText(ctx, cb, "🕒 <b>已有扫描在进行中</b>\n\n请等待当前扫描结束，或点击它消息里的「停止扫描」。", nil)
		}
		drives, err := a.resolveScanDrives(ctx, userID, data == "dupscan_scope_all")
		if err != nil {
			a.log.Error("解析扫描范围失败", "err", err)
			return a.editScanText(ctx, cb, "❌ 查询网盘列表失败,请稍后重试。", nil)
		}
		if len(drives) == 0 {
			return a.editScanText(ctx, cb, "🚫 <b>还没有绑定网盘</b>\n\n请先发送 /drive 绑定网盘。", nil)
		}
		// 立刻刷成「已在扫」,让用户看到反应。必须带上停止按钮 ——
		// 文案里写着「可随时点下方按钮停止」,按钮没了就是骗人。
		if err := a.editScanText(ctx, cb, fmt.Sprintf(
			"🔍 <b>正在扫描重复文件</b>\n\n📂 网盘: <code>%s</code>\n📄 已扫描: 0/%d\n⏱ 用时: 0 秒\n\n<i>可随时点下方按钮停止</i>",
			escapeHTMLText(driveLabel(drives[0])), len(drives)), dupScanCancelButtons()); err != nil {
			return err
		}
		// 后台跑,不阻塞这次回调响应。
		go a.runDupScan(context.WithoutCancel(ctx), userID, cb.ChatID, cb.MsgID, drives)
		answer("", false)
		return nil
	}
	return nil
}

// dupScanCancelButtons 是「停止扫描」那一枚按钮。
func dupScanCancelButtons() [][]tgclient.Button {
	return [][]tgclient.Button{{{Text: "🚫 停止扫描", Data: "dupscan_cancel"}}}
}

func (a *App) editScanText(ctx context.Context, cb tgclient.CallbackContext, text string, buttons [][]tgclient.Button) error {
	a.editScanMessage(ctx, cb.ChatID, cb.MsgID, text, buttons)
	return a.tg.AnswerCallback(ctx, cb.CallbackID, "", false)
}

// resolveScanDrives 按范围选出要扫的网盘。
func (a *App) resolveScanDrives(ctx context.Context, userID string, all bool) ([]drive.Drive, error) {
	if all {
		return a.drives.DrivesByUser(ctx, userID)
	}
	d, err := a.drives.DefaultDrive(ctx, userID)
	if err != nil {
		return nil, err
	}
	if d == nil {
		return nil, nil
	}
	return []drive.Drive{*d}, nil
}

func driveLabel(d drive.Drive) string {
	if d.Name != "" {
		return d.Name
	}
	return d.Type
}

// ============================================================================
// 扫描主循环
// ============================================================================

// runDupScan 逐盘扫描。每个网盘之间检查取消标志。
func (a *App) runDupScan(ctx context.Context, userID string, chatID int64, msgID int, drives []drive.Drive) {
	startedAt := time.Now()
	lastEdit := time.Time{}

	a.writeDupScanState(ctx, userID, dupScanState{Status: "running"})
	cancelButtons := dupScanCancelButtons()

	for i, d := range drives {
		// 取消检查放在扫描之间:正在跑的那次由 rclone 超时兜底。
		if st := a.readDupScanState(ctx, userID); st != nil && st.CancelAsked {
			a.writeDupScanState(ctx, userID, dupScanState{Status: "cancelled"})
			a.editScanMessage(ctx, chatID, msgID,
				"🚫 <b>扫描已停止</b>\n\n已扫描部分的结果不会被保留，重新发送 /scan_dup 可以再扫一次。", nil)
			return
		}

		// 节流:每盘至少间隔 3s,避免慢盘连发多条编辑。
		if time.Since(lastEdit) >= dupScanEditThrottle {
			lastEdit = time.Now()
			a.editScanMessage(ctx, chatID, msgID, fmt.Sprintf(
				"🔍 <b>正在扫描重复文件</b>\n\n📂 网盘: <code>%s</code>\n📄 已扫描: %d/%d\n⏱ 用时: %d 秒\n\n<i>可随时点下方按钮停止</i>",
				escapeHTMLText(driveLabel(d)), i, len(drives), int(time.Since(startedAt).Seconds())), cancelButtons)
		}

		result, err := a.scanDrive(ctx, &d)
		if err != nil {
			// 单盘失败不中断整体,但必须如实告诉用户这一盘没扫成。
			a.log.Error("重复文件扫描失败", "userId", userID, "driveId", d.ID, "err", err)
			a.editScanMessage(ctx, chatID, msgID, fmt.Sprintf(
				"❌ <b>扫描失败</b>\n\n📂 网盘: <code>%s</code>\n原因: %s\n\n其他网盘仍会继续扫描。",
				escapeHTMLText(driveLabel(d)), escapeHTMLText(err.Error())), cancelButtons)
			continue
		}

		name := driveLabel(d)
		a.writeDupScanState(ctx, userID, dupScanState{Status: "done", DriveName: name, Result: result})
		text, buttons := renderDupScanPage(name, *result, 0)
		a.editScanMessage(ctx, chatID, msgID, text, buttons)
	}
}

// scanDrive 扫一个网盘。
//
// 必须与上传同等待遇:进程内会话锁 + 跑完收割写回。少任何一样,
// 一次 /scan_dup 就可能把账号砖化 —— 而「只是看看有没有重复文件」的
// 用户什么都没做错(记忆 proton-refresh-token-race / PR#446)。
func (a *App) scanDrive(ctx context.Context, d *drive.Drive) (*dupScanResult, error) {
	key := drive.Key(drive.Type(d.Type), d.UserID)
	var result *dupScanResult
	err := a.locks.WithSession(ctx, key, func() error {
		cfg, harvest, err := a.buildRuntime(ctx, d)
		if err != nil {
			return err
		}
		cfg.Timeout = dupScanPerDriveTimeout
		// 扫的是网盘根(remotePath 留空),与 JS scanDrive 传
		// runtime.connectionString 一致 —— 不是用户那个子目录。
		entries, err := a.rclone.ScanFiles(ctx, cfg, "")
		// 收割与成败无关:rclone 跑完可能已经旋转过 token,
		// 不写回就等于把它扔了。
		if harvest != nil {
			if herr := harvest(); herr != nil {
				a.log.Error("收割 Proton session 失败,下次操作可能因 token 过期而失败", "err", herr)
			}
		}
		if err != nil {
			return err
		}
		r := groupDuplicates(entries)
		result = &r
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (a *App) editScanMessage(ctx context.Context, chatID int64, msgID int, text string, buttons [][]tgclient.Button) {
	var err error
	if len(buttons) == 0 {
		err = a.tg.EditMessage(ctx, chatID, msgID, text)
	} else {
		err = a.tg.EditWithButtons(ctx, chatID, msgID, text, buttons)
	}
	if err != nil {
		// 编辑失败不该打断扫描 —— 下一盘还会再刷一次。
		a.log.Warn("刷新扫描进度失败", "err", err)
	}
}
