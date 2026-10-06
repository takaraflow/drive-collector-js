package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
)

// ============================================================================
// 运行中任务账本:取消按钮与封禁都靠它找到「现在该掐谁」。
//
// 断言的是账本本身(登记/注销/按 user 筛/ctx 真的被取消),而不是
// 端到端的 rclone 杀进程 —— 那要真的 rclone 二进制,测不出账本的错。
// ============================================================================

// TestCancelRunningTerminatesTheTask 取消要真的把任务掐死。
//
// 这是整套改动的根因:以前取消只改数据库状态,进程照跑到底,文件
// 照样传上网盘,而 EventComplete 被状态机拒掉 —— 用户看到「已取消」,
// 文件其实已经在网盘里,还白占了 quota。
func TestCancelRunningTerminatesTheTask(t *testing.T) {
	cases := []struct {
		name    string
		run     func(a *App) bool
		wantHit bool // cancelRunning 是否命中账本
		wantCtx bool // 任务的 ctx 是否真的被取消
	}{
		{
			name:    "取消正在跑的任务",
			run:     func(a *App) bool { return a.cancelRunning("t1") },
			wantHit: true,
			wantCtx: true,
		},
		{
			name:    "取消没在跑的任务不算命中",
			run:     func(a *App) bool { return a.cancelRunning("nope") },
			wantHit: false,
		},
		{
			name: "注销之后再取消不算命中",
			run: func(a *App) bool {
				a.unregisterRunning("t1")
				return a.cancelRunning("t1")
			},
			wantHit: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			a := &App{}
			a.registerRunning("t1", "u1", cancel)

			if got := tc.run(a); got != tc.wantHit {
				t.Errorf("命中账本 = %v,期望 %v", got, tc.wantHit)
			}
			if (ctx.Err() != nil) != tc.wantCtx {
				t.Errorf("任务 ctx 已取消 = %v,期望 %v", ctx.Err() != nil, tc.wantCtx)
			}
		})
	}
}

// TestCancelUserTasksOnlyTouchesOwnUser 封禁只能掐自己人的任务。
//
// 掐错人就是「封 A 把 B 的转存杀了」—— B 没做错任何事,文件却传不上去了。
func TestCancelUserTasksOnlyTouchesOwnUser(t *testing.T) {
	a := &App{}
	type entry struct {
		ctx    context.Context
		cancel context.CancelFunc
	}
	var got []entry
	for _, e := range []struct{ id, user string }{
		{"t1", "u1"}, {"t2", "u1"}, {"t3", "u2"},
	} {
		ctx, cancel := context.WithCancel(context.Background())
		got = append(got, entry{ctx, cancel})
		a.registerRunning(e.id, e.user, cancel)
	}
	defer func() {
		for _, e := range got {
			e.cancel()
		}
	}()

	if n := a.CancelUserTasks(context.Background(), "u1"); n != 2 {
		t.Errorf("掐死条数 = %d,期望 2", n)
	}
	if got[0].ctx.Err() == nil || got[1].ctx.Err() == nil {
		t.Error("u1 的任务没被取消")
	}
	if got[2].ctx.Err() != nil {
		t.Error("u2 的任务被误杀了 —— 封禁只能掐自己人的")
	}
	// 掐完不注销:注销归 processTask 的 defer 管。提前注销会让紧接着的
	// 取消按钮找不到这条任务,取消又退化成「只改库、进程照跑」。
	a.runningMu.Lock()
	n := len(a.running)
	a.runningMu.Unlock()
	if n != 3 {
		t.Errorf("账本剩 %d 条,期望 3(注销归 processTask 的 defer 管)", n)
	}
}

// TestCancelUserTasksOnEmptyLedger 没人跑时不该 panic。
func TestCancelUserTasksOnEmptyLedger(t *testing.T) {
	a := &App{}
	if n := a.CancelUserTasks(context.Background(), "u1"); n != 0 {
		t.Errorf("空账本应返回 0,得到 %d", n)
	}
}

// cancelTestTask 造一条待处理任务 —— 与 queue_test 里的写法一致:
// fakeRepo.FindById 对任何 id 都返回 byID,所以只需要设一次。
func cancelTestTask() *store.Task {
	return &store.Task{
		ID:        "t1",
		UserID:    "555",
		FileName:  sqlStr("photo.jpg"),
		SourceRef: sqlStr("555/42"),
	}
}

// TestProcessTaskLeavesNoResidue 任务跑完后账本里不能有残留。
//
// 残留会一直长到进程结束,封禁时把早就结束的任务也「杀」一遍,而且
// map 无界增长。这条守住 processTask 里的 defer 注销。
func TestProcessTaskLeavesNoResidue(t *testing.T) {
	repo := &fakeRepo{byID: cancelTestTask()}
	a, dir := newTestApp(t, &fakeDL{content: "data"}, repo, &fakeDrives{
		drive: &drive.Drive{Type: "mega"},
	})
	a.wireManagerForTest()

	a.processTask(context.Background(), "t1")

	a.runningMu.Lock()
	n := len(a.running)
	a.runningMu.Unlock()
	if n != 0 {
		t.Errorf("任务跑完后账本还剩 %d 条 —— 注销没执行", n)
	}
	// 本地文件也要没:成功路径原本就删,这次只是别把它删回去。
	if _, err := os.Stat(filepath.Join(dir, "photo.jpg")); err == nil {
		t.Error("本地文件还在盘上")
	}
}

// TestProcessTaskCleansUpAfterFailure 失败路径也必须清干净。
//
// 最容易漏的就是这条:任务走不到成功分支,于是本地文件留在
// /tmp/downloads 里,一次次把容器 1GB 盘撑满 —— 而盘满的表现是
// 【所有】任务一起失败,排查时却会往网盘方向找。
func TestProcessTaskCleansUpAfterFailure(t *testing.T) {
	repo := &fakeRepo{byID: cancelTestTask()}
	a, dir := newTestApp(t, &fakeDL{err: errors.New("boom")}, repo, &fakeDrives{})
	a.wireManagerForTest()

	a.processTask(context.Background(), "t1")

	if _, err := os.Stat(filepath.Join(dir, "photo.jpg")); err == nil {
		t.Error("下载失败后半截文件还在盘上 —— 会把容器磁盘撑爆")
	}
	a.runningMu.Lock()
	n := len(a.running)
	a.runningMu.Unlock()
	if n != 0 {
		t.Errorf("失败后账本还剩 %d 条", n)
	}
}

// TestCancelTaskButtonKillsTheProcess 取消按钮要真的触发终止。
//
// 断言 cancelTask 走到账本上 —— 以前它只改库,进程照跑到底,文件
// 照样传上去,而 EventComplete 被状态机拒掉。
func TestCancelTaskButtonKillsTheProcess(t *testing.T) {
	tsk := cancelTestTask()
	repo := &fakeRepo{byID: tsk}
	a, _ := newTestApp(t, &fakeDL{content: "data"}, repo, &fakeDrives{})
	a.wireManagerForTest()

	// 模拟「任务正在跑」:登记一条真实的可取消 ctx。
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a.registerRunning("t1", tsk.UserID, cancel)

	a.cancelTask(context.Background(), tsk.UserID, "t1")

	if ctx.Err() == nil {
		t.Error("点了取消,任务却没被终止 —— 文件会继续传上云盘")
	}
	var sawCancel bool
	for _, ev := range repo.trans {
		if ev == contract.EventCancel {
			sawCancel = true
		}
	}
	if !sawCancel {
		t.Errorf("状态机没收到 cancel 事件,trans = %v", repo.trans)
	}
}

// rotatingRclone 上传时把 conf 里的 refresh_token 换掉 —— 模拟 rclone
// 的真实行为(服务端那边旧 token 已随即作废)。
type rotatingRclone struct {
	fakeRclone
}

func (r *rotatingRclone) Upload(_ context.Context, cfg rclone.Config, _, _ string, _ rclone.ProgressFunc) error {
	body := "[" + cfg.Runtime.RemoteName + "]\n" +
		"type = protondrive\n" +
		"client_uid = uid\n" +
		"client_access_token = at-NEW\n" +
		"client_refresh_token = rt-NEW\n" +
		"client_salted_key_pass = skp\n"
	if err := os.WriteFile(cfg.Runtime.ConfigPath, []byte(body), 0o600); err != nil {
		return err
	}
	return r.uploadErr
}

// TestUploadHarvestsRotatedTokenEvenWhenKilled 上传失败/被取消也必须收割
// 已旋转的 session。
//
// rclone 被 kill 之前很可能已经把 refresh_token 换掉了,而服务端那侧的
// 旧 token 随即作废。不写回的话库里那份就是死的,下次认证 Code=10013,
// 账号永久砖化(记忆里的 proton-refresh-token-race)。
//
// 以前 harvest 只在成功路径跑 —— 那时取消【不会真的杀进程】,rclone 总
// 能跑完。现在会杀了,不补这一刀就是拿「能取消」换「能砖账号」。
func TestUploadHarvestsRotatedTokenEvenWhenKilled(t *testing.T) {
	d := &drive.Drive{
		ID: "d1", UserID: "u1", Type: "protondrive",
		Config: drive.DriveConfig{
			ClientUID: "uid", ClientAccessToken: "at-OLD",
			ClientRefreshToken: "rt-OLD", ClientSaltedKeyPass: "skp",
		},
	}
	drives := &fakeDrives{drive: d}
	a, _ := newTestApp(t, &fakeDL{}, &fakeRepo{}, drives)

	rot := &rotatingRclone{}
	rot.uploadErr = errors.New("rclone killed")
	a.rclone = rot

	// 上传失败,模拟被取消后 ctx 已死的那条路径。
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_ = a.upload(ctx, store.Task{ID: "t1", UserID: "u1", FileName: sqlStr("a.txt")})

	if drives.saveCalls == 0 || drives.saved == nil {
		t.Fatal("上传失败后没有收割 —— 库里那份 refresh_token 已作废,下次认证必 10013")
	}
	if drives.saved.ClientRefreshToken != "rt-NEW" {
		t.Errorf("写回的 refresh_token = %q,期望 rt-NEW", drives.saved.ClientRefreshToken)
	}
}

// TestConcurrentCancelAndRegister 账本本身不能有竞态。
func TestConcurrentCancelAndRegister(t *testing.T) {
	a := &App{}
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			_, cancel := context.WithCancel(context.Background())
			defer cancel()
			a.registerRunning("t", "u", cancel)
		}()
		go func() {
			defer wg.Done()
			a.cancelRunning("t")
		}()
		go func() {
			defer wg.Done()
			a.CancelUserTasks(context.Background(), "u")
		}()
	}
	wg.Wait()
}
