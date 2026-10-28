package app

// /scan_dup 的最小可跑检查。命令入口要真连 Telegram,测不到;能测的
// 是判重(纯函数)、翻页渲染,以及「扫的是网盘根且走会话锁」——
// 后者错了就是把用户的整个网盘重扫一遍,或把 Proton 账号砖掉。

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/gotd/td/telegram/message/entity"
	"github.com/gotd/td/telegram/message/html"
	"github.com/gotd/td/telegram/message/styling"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
)

func hashed(path, algo, val string, size int64) rclone.FileEntry {
	return rclone.FileEntry{
		Path: path, Size: size, IsDir: false,
		Hashes: map[string]string{algo: val},
	}
}

// TestGroupDuplicatesByHash —— 同哈希归一组,并带上算法名与大小。
func TestGroupDuplicatesByHash(t *testing.T) {
	got := groupDuplicates([]rclone.FileEntry{
		hashed("a.mp4", "md5", "aaa", 100),
		hashed("b.mp4", "md5", "aaa", 100),
		hashed("c.mp4", "md5", "bbb", 200),
	})

	if len(got.Groups) != 1 {
		t.Fatalf("只应有一组重复,得到 %+v", got.Groups)
	}
	g := got.Groups[0]
	if g.Basis != "hash" || g.Algo != "md5" || g.Size != 100 || len(g.Paths) != 2 {
		t.Errorf("分组不对: %+v", g)
	}
	if !got.HashAvailable || got.Hashed != 3 || got.Total != 3 {
		t.Errorf("哈希统计不对: %+v", got)
	}
}

// TestGroupDuplicatesFallsBackToSize —— 后端不给哈希时必须降级到按大小,
// 且如实说「内容可能不同」,不能谎称网盘干净。
func TestGroupDuplicatesFallsBackToSize(t *testing.T) {
	got := groupDuplicates([]rclone.FileEntry{
		{Path: "a.bin", Size: 100},
		{Path: "b.bin", Size: 100},
		{Path: "c.bin", Size: 300},
	})

	if got.HashAvailable {
		t.Error("没有哈希却报 HashAvailable,上层会误以为判重可靠")
	}
	if len(got.Groups) != 1 || got.Groups[0].Basis != "size" || len(got.Groups[0].Paths) != 2 {
		t.Fatalf("应按大小归出一组,得到 %+v", got.Groups)
	}
	if note := dupScanBasisNote(got); !strings.Contains(note, "内容可能不同") {
		t.Errorf("降级时必须说清「内容可能不同」,得到 %q", note)
	}
}

// TestGroupDuplicatesIgnoresDirsAndEmptyFiles —— 目录项与 0 字节文件不参与,
// 否则清单全是噪音。
func TestGroupDuplicatesIgnoresDirsAndEmptyFiles(t *testing.T) {
	got := groupDuplicates([]rclone.FileEntry{
		{Path: "dir", IsDir: true, Size: 4096},
		{Path: "empty1", Size: 0},
		{Path: "empty2", Size: 0},
	})
	if len(got.Groups) != 0 || got.Total != 0 {
		t.Errorf("目录与 0 字节不该参与判重,得到 %+v", got)
	}
}

// twoGroups 造出「两组重复」:x 组 2 份、y 组 3 份,大小不同。
// 大小必须不同 —— 同样大小本来就该归成一组。
func twoGroups() dupScanResult {
	return groupDuplicates([]rclone.FileEntry{
		{Path: "x1", Size: 10}, {Path: "x2", Size: 10},
		{Path: "y1", Size: 20}, {Path: "y2", Size: 20}, {Path: "y3", Size: 20},
	})
}

// TestGroupDuplicatesLargestGroupFirst —— 大组排前面:用户最想删的就是它。
func TestGroupDuplicatesLargestGroupFirst(t *testing.T) {
	got := twoGroups()
	if len(got.Groups) != 2 {
		t.Fatalf("应两组,得到 %+v", got.Groups)
	}
	if len(got.Groups[0].Paths) != 3 {
		t.Errorf("最大组应排第一,得到 %+v", got.Groups[0])
	}
}

// manyGroups 造出 7 组重复 —— 每页 3 组,正好 3 页。
func manyGroups() dupScanResult {
	entries := make([]rclone.FileEntry, 0, 14)
	for g := 0; g < 7; g++ {
		entries = append(entries,
			rclone.FileEntry{Path: fmt.Sprintf("g%d-a.bin", g), Size: int64(g) + 1},
			rclone.FileEntry{Path: fmt.Sprintf("g%d-b.bin", g), Size: int64(g) + 1},
		)
	}
	return groupDuplicates(entries)
}

// TestRenderDupScanPageClamps —— 页码越界要夹回范围内,不能渲染出空白页。
func TestRenderDupScanPageClamps(t *testing.T) {
	res := manyGroups()
	if len(res.Groups) != 7 {
		t.Fatalf("夹具应造出 7 组,得到 %d 组", len(res.Groups))
	}

	_, buttons := renderDupScanPage("mega", res, 99)
	if !hasButton(buttons, "dupscan_page_1") {
		t.Errorf("越界后应夹回最后一页(第3页)并给出「上一页」,得到 %+v", buttons)
	}
	_, buttons = renderDupScanPage("mega", res, 0)
	if !hasButton(buttons, "dupscan_page_1") {
		t.Errorf("首页应有「下一页」,得到 %+v", buttons)
	}
	if !hasButton(buttons, "dupscan_scope_default") {
		t.Errorf("应始终有「重新扫描」,得到 %+v", buttons)
	}
}

// TestRenderDupScanPageFoldsLongGroups —— 一组几百个路径会把消息撑爆,
// 超过 6 条必须折叠成「另有 N 份」。
func TestRenderDupScanPageFoldsLongGroups(t *testing.T) {
	ent := make([]rclone.FileEntry, 0, 10)
	for i := 0; i < 10; i++ {
		ent = append(ent, rclone.FileEntry{Path: string(rune('a'+i)) + ".bin", Size: 10})
	}
	text, _ := renderDupScanPage("mega", groupDuplicates(ent), 0)

	if !strings.Contains(text, "另有 4 份") {
		t.Errorf("超出 6 条应折叠,得到:\n%s", text)
	}
	if strings.Contains(text, "j.bin") {
		t.Errorf("被折叠的路径不该再逐条列出,得到:\n%s", text)
	}
}

// TestRenderDupScanPageNoDuplicates —— 一组都没有时要说清扫了多少,
// 并带上判重依据那一行。
func TestRenderDupScanPageNoDuplicates(t *testing.T) {
	text, buttons := renderDupScanPage("mega", dupScanResult{Total: 42}, 0)
	if !strings.Contains(text, "42 个") {
		t.Errorf("应报扫描文件数,得到:\n%s", text)
	}
	if !strings.Contains(text, "判重依据") {
		t.Errorf("无重复时也必须说判重依据,否则「没找到」会被当成「网盘干净」:\n%s", text)
	}
	if len(buttons) != 0 {
		t.Errorf("没有重复就没有翻页按钮,得到 %+v", buttons)
	}
}

// TestFormatDupSize 验证去重扫描大小展示:包含精确字节数与千分位格式化。
func TestFormatDupSize(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{0, "0 字节"},
		{500, "500 字节"},
		{1023, "1023 字节"},
		{1024, "1.0 KB (1,024 字节)"},
		{1572864, "1.5 MB (1,572,864 字节)"},
		{1073741824, "1.0 GB (1,073,741,824 字节)"},
	}
	for _, tc := range cases {
		if got := formatDupSize(tc.in); got != tc.want {
			t.Errorf("formatDupSize(%d) = %q, want %q", tc.in, got, tc.want)
		}
	}

	// 验证在 renderDupScanPage 中渲染
	res := dupScanResult{
		Groups: []dupGroup{
			{Basis: "hash", Algo: "md5", Size: 1572864, Paths: []string{"a.mp4", "b.mp4"}},
		},
		Hashed:        2,
		Total:         2,
		HashAvailable: true,
	}
	text, _ := renderDupScanPage("mega", res, 0)
	if !strings.Contains(text, "1.5 MB (1,572,864 字节)") {
		t.Errorf("页面中应展示精确字节数,得到:\n%s", text)
	}
	if !strings.Contains(text, "📂 网盘: <code>mega</code>") {
		t.Errorf("页面中应展示网盘名称,得到:\n%s", text)
	}
}

// TestScanDriveScansDriveRoot —— 扫的是网盘根,不是用户那个子目录。
// 传错的话会漏掉用户挪到别处的文件,给出一份「没有重复」的假清单。
func TestScanDriveScansDriveRoot(t *testing.T) {
	rc := &fakeRclone{scan: []rclone.FileEntry{
		hashed("a.mp4", "md5", "aaa", 100),
		hashed("b.mp4", "md5", "aaa", 100),
	}}
	a := newFilesApp(rc, &fakeDrives{drive: megaDrive()})

	res, err := a.scanDrive(context.Background(), megaDrive())
	if err != nil {
		t.Fatalf("扫描不该失败: %v", err)
	}
	if len(rc.scanCalls) != 1 || rc.scanCalls[0] != "" {
		t.Errorf("应扫网盘根(空路径),实际扫了 %v", rc.scanCalls)
	}
	if len(res.Groups) != 1 {
		t.Errorf("应归出一组重复,得到 %+v", res.Groups)
	}
}

// TestResolveScanDrives 验证按网盘单独扫描与全盘扫描的范围解析。
func TestResolveScanDrives(t *testing.T) {
	d1 := drive.Drive{ID: "d1", UserID: "u1", Name: "Mega-1", IsDefault: 1}
	d2 := drive.Drive{ID: "d2", UserID: "u1", Name: "Mega-2", IsDefault: 0}
	fd := &fakeDrives{
		drive: &d1,
		all:   []drive.Drive{d1, d2},
	}
	a := newFilesApp(&fakeRclone{}, fd)

	// 1. scope: all
	allDrives, err := a.resolveScanDrives(context.Background(), "u1", "dupscan_scope_all")
	if err != nil || len(allDrives) != 2 {
		t.Errorf("dupscan_scope_all 应返回全部 2 个网盘, err=%v, drives=%+v", err, allDrives)
	}

	// 2. scope: specific drive d2
	singleDrive, err := a.resolveScanDrives(context.Background(), "u1", "dupscan_scope_drive_d2")
	if err != nil || len(singleDrive) != 1 || singleDrive[0].ID != "d2" {
		t.Errorf("dupscan_scope_drive_d2 应返回 d2, err=%v, drives=%+v", err, singleDrive)
	}

	// 3. scope: default
	defDrive, err := a.resolveScanDrives(context.Background(), "u1", "dupscan_scope_default")
	if err != nil || len(defDrive) != 1 || defDrive[0].ID != "d1" {
		t.Errorf("dupscan_scope_default 应返回默认网盘 d1, err=%v, drives=%+v", err, defDrive)
	}
}

// ============================================================================
// 跨网盘混查测试
// ============================================================================

func TestGroupCrossDuplicates_HashMatching(t *testing.T) {
	d1 := drive.Drive{ID: "mega", Name: "MEGA 主盘"}
	d2 := drive.Drive{ID: "oss", Name: "OSS 归档"}

	allDriveEntries := []DriveEntries{
		{
			Drive: d1,
			Entries: []rclone.FileEntry{
				hashed("/Movies/Avatar.mkv", "md5", "8f3a9876", 1200000000),
				hashed("/Other/test.txt", "md5", "1111", 50),
			},
		},
		{
			Drive: d2,
			Entries: []rclone.FileEntry{
				hashed("/Backups/2026/Avatar.mkv", "md5", "8f3a9876", 1200000000),
				hashed("/Other/diff.txt", "md5", "2222", 60),
			},
		},
	}

	res := groupCrossDuplicates(allDriveEntries)
	if !res.IsCrossDrive {
		t.Fatal("IsCrossDrive 应为 true")
	}
	if len(res.Groups) != 1 {
		t.Fatalf("应归出 1 组跨盘重复, 实际得到 %d 组: %+v", len(res.Groups), res.Groups)
	}

	g := res.Groups[0]
	if g.Basis != "hash" || g.Algo != "md5" || g.Size != 1200000000 {
		t.Errorf("分组元数据不对: %+v", g)
	}
	if len(g.Items) != 2 {
		t.Fatalf("组内应有 2 个条目, 实际得到 %d", len(g.Items))
	}
	if g.Items[0].DriveLabel != "MEGA 主盘" && g.Items[1].DriveLabel != "MEGA 主盘" {
		t.Errorf("应包含 MEGA 主盘项: %+v", g.Items)
	}
}

func TestGroupCrossDuplicates_MixedHashAndNameSize(t *testing.T) {
	d1 := drive.Drive{ID: "mega", Name: "MEGA 主盘"}
	d2 := drive.Drive{ID: "oss", Name: "OSS 归档"}
	d3 := drive.Drive{ID: "proton", Name: "ProtonDrive"}

	allDriveEntries := []DriveEntries{
		{
			Drive: d1,
			Entries: []rclone.FileEntry{
				hashed("/Movies/Avatar.mkv", "md5", "8f3a987654321", 1200000000),
			},
		},
		{
			Drive: d2,
			Entries: []rclone.FileEntry{
				hashed("/Backups/2026/Avatar.mkv", "md5", "8f3a987654321", 1200000000),
			},
		},
		{
			Drive: d3,
			Entries: []rclone.FileEntry{
				// ProtonDrive 无哈希
				{Path: "/Avatar.mkv", Size: 1200000000},
			},
		},
	}

	res := groupCrossDuplicates(allDriveEntries)
	if len(res.Groups) != 1 {
		t.Fatalf("应将有哈希与同名同大小无哈希的归出 1 组, 得到 %d 组", len(res.Groups))
	}
	g := res.Groups[0]
	if g.Basis != "cross_mixed" {
		t.Errorf("混合判重 basis 应为 cross_mixed, 得到 %q", g.Basis)
	}
	if len(g.Items) != 3 {
		t.Fatalf("应包含 3 份文件, 得到 %d", len(g.Items))
	}

	// 检查 ProtonDrive 项的标注
	var protonItem *dupFileItem
	for i := range g.Items {
		if g.Items[i].DriveLabel == "ProtonDrive" {
			protonItem = &g.Items[i]
			break
		}
	}
	if protonItem == nil {
		t.Fatal("未找到 ProtonDrive 条目")
	}
	if !strings.Contains(protonItem.Note, "无哈希") {
		t.Errorf("ProtonDrive 项 Note 应标注无哈希, 得到 %q", protonItem.Note)
	}

	// 验证页面渲染
	text, _ := renderDupScanPage("全网盘", res, 0)
	if !strings.Contains(text, "🔍 <b>全网盘重复文件扫描</b>") {
		t.Errorf("跨盘页面标题不正确:\n%s", text)
	}
	if !strings.Contains(text, "🔁 <b>3 份重复文件</b>") {
		t.Errorf("重复文件头信息不正确:\n%s", text)
	}
	if !strings.Contains(text, "🟢 <i>判重依据：内容哈希 (md5) + 同名同大小</i>") {
		t.Errorf("判重依据行不正确:\n%s", text)
	}
	if !strings.Contains(text, "• 📂 <b>[MEGA 主盘]</b> <code>/Movies/Avatar.mkv</code> (md5: 8f3a9876...)") {
		t.Errorf("MEGA 条目渲染不匹配:\n%s", text)
	}
	if !strings.Contains(text, "• 📂 <b>[ProtonDrive]</b> <code>/Avatar.mkv</code> (⚠️ 无哈希，依同名同大小关联)") {
		t.Errorf("ProtonDrive 条目渲染不匹配:\n%s", text)
	}
	if !strings.Contains(text, "📊 <i>第 1/1 页 | 共 1 组跨盘重复</i>") {
		t.Errorf("跨盘页脚统计不匹配:\n%s", text)
	}
}

func TestGroupCrossDuplicates_NameSizeFallback(t *testing.T) {
	d1 := drive.Drive{ID: "d1", Name: "网盘A"}
	d2 := drive.Drive{ID: "d2", Name: "网盘B"}

	allDriveEntries := []DriveEntries{
		{
			Drive: d1,
			Entries: []rclone.FileEntry{
				{Path: "/doc/report.pdf", Size: 50000},
			},
		},
		{
			Drive: d2,
			Entries: []rclone.FileEntry{
				{Path: "/archive/report.pdf", Size: 50000},
			},
		},
	}

	res := groupCrossDuplicates(allDriveEntries)
	if len(res.Groups) != 1 {
		t.Fatalf("应按同名同大小归出 1 组, 得到 %d 组", len(res.Groups))
	}
	if res.Groups[0].Basis != "cross_name_size" {
		t.Errorf("basis 应为 cross_name_size, 得到 %q", res.Groups[0].Basis)
	}
}

func TestGroupCrossDuplicates_ConflictingHashesNotMerged(t *testing.T) {
	d1 := drive.Drive{ID: "d1", Name: "网盘A"}
	d2 := drive.Drive{ID: "d2", Name: "网盘B"}

	allDriveEntries := []DriveEntries{
		{
			Drive: d1,
			Entries: []rclone.FileEntry{
				hashed("conflict.bin", "md5", "hash111", 5000),
			},
		},
		{
			Drive: d2,
			Entries: []rclone.FileEntry{
				hashed("conflict.bin", "md5", "hash222", 5000),
			},
		},
	}

	res := groupCrossDuplicates(allDriveEntries)
	if len(res.Groups) != 0 {
		t.Fatalf("哈希冲突的文件即使同名同大小也不应聚为重复, 得到 %d 组", len(res.Groups))
	}
}

func TestRenderDupScanPage_CrossDrive_NoDuplicates(t *testing.T) {
	res := dupScanResult{
		Total:        100,
		IsCrossDrive: true,
	}
	text, buttons := renderDupScanPage("全网盘", res, 0)
	if !strings.Contains(text, "全网盘重复文件扫描") {
		t.Errorf("应包含全网盘标题:\n%s", text)
	}
	if !strings.Contains(text, "未发现跨盘重复文件") {
		t.Errorf("应包含未发现提示:\n%s", text)
	}
	if len(buttons) != 0 {
		t.Errorf("无重复时不应有分页按钮")
	}
}

func TestRenderDupScanPage_HTMLValidity(t *testing.T) {
	d1 := drive.Drive{ID: "mega", Name: "MEGA <主盘> & \"Special\""}
	d2 := drive.Drive{ID: "oss", Name: "OSS 归档"}
	d3 := drive.Drive{ID: "proton", Name: "ProtonDrive"}

	allDriveEntries := []DriveEntries{
		{
			Drive: d1,
			Entries: []rclone.FileEntry{
				hashed("/Movies/<Avatar> & Co.mkv", "md5", "8f3a987654321", 1200000000),
			},
		},
		{
			Drive: d2,
			Entries: []rclone.FileEntry{
				hashed("/Backups/2026/<Avatar> & Co.mkv", "md5", "8f3a987654321", 1200000000),
			},
		},
		{
			Drive: d3,
			Entries: []rclone.FileEntry{
				{Path: "/<Avatar> & Co.mkv", Size: 1200000000},
			},
		},
	}

	res := groupCrossDuplicates(allDriveEntries)
	text, _ := renderDupScanPage("全网盘", res, 0)

	tb := entity.Builder{}
	err := styling.Perform(&tb, styling.Custom(func(eb *entity.Builder) error {
		return html.HTML(strings.NewReader(text), eb, html.Options{})
	}))
	if err != nil {
		t.Fatalf("HTML 解析失败: %v, text=\n%s", err, text)
	}
	plain, entities := tb.Complete()
	if len(plain) == 0 || len(entities) == 0 {
		t.Fatalf("解析得到的实体或文本为空: textLen=%d, entities=%d", len(plain), len(entities))
	}
}
