package app

// /scan_dup 的最小可跑检查。命令入口要真连 Telegram,测不到;能测的
// 是判重(纯函数)、翻页渲染,以及「扫的是网盘根且走会话锁」——
// 后者错了就是把用户的整个网盘重扫一遍,或把 Proton 账号砖掉。

import (
	"context"
	"fmt"
	"strings"
	"testing"

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
// 且如实说「可能内容不同」,不能谎称网盘干净。
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
	entries := make([]rclone.FileEntry, 0, 10)
	for i := 0; i < 10; i++ {
		entries = append(entries, rclone.FileEntry{Path: string(rune('a'+i)) + ".bin", Size: 10})
	}
	text, _ := renderDupScanPage("mega", groupDuplicates(entries), 0)

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
