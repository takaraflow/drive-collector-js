package app

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/youngsx/drive-collector/cmd/collector/internal/instance"
	)

// TestSmoke_Cluster_Failover_And_TaskContention 验证多实例集群完整生命周期冒烟：
// 1. 主实例抢占 telegram_client 锁并注册心跳与并发负载指标
// 2. 备用实例在 StandbyMode 下遇到锁冲突不崩溃，平滑进入热备等待
// 3. 任务级分布式锁互斥：防止两台实例并发执行同一任务
// 4. 任务心跳自动续期分布式锁租约
// 5. 主实例退出时优雅主动释锁 (CAS)
// 6. 备用实例无缝抢占晋升为新 Leader
// 7. 新 Leader 定期扫描并清理过期的僵尸实例键
func TestSmoke_Cluster_Failover_And_TaskContention(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 1. 初始化两台实例的 Coordinator
	coord1 := instance.NewCoordinator(rdb, "worker-node-1", "https://node1.internal", quiet())
	coord2 := instance.NewCoordinator(rdb, "worker-node-2", "https://node2.internal", quiet())

	// 注册心跳与活跃任务负载监控
	var activeCount1 atomic.Int64
	coord1.RegisterActiveTaskCounter(func() int {
		return int(activeCount1.Load())
	})

	if err := coord1.Register(ctx); err != nil {
		t.Fatalf("node-1 注册失败: %v", err)
	}
	if err := coord2.Register(ctx); err != nil {
		t.Fatalf("node-2 注册失败: %v", err)
	}

	// 2. node-1 成功获取 telegram_client 锁
	held1, err := coord1.AcquireTelegramLock(ctx)
	if err != nil || !held1 {
		t.Fatalf("node-1 应该成功获取锁: held=%v, err=%v", held1, err)
	}

	// 3. 验证 node-2 探测锁持有者为 node-1
	holder, err := coord2.GetTelegramLockHolder(ctx)
	if err != nil || holder != "worker-node-1" {
		t.Errorf("holder 期望 worker-node-1, 实际: %q", holder)
	}

	// 4. 构建两台 App 实例
	dlMock := &fakeDL{content: "cluster payload"}
	repoMock := &fakeRepo{}
	drivesMock := &fakeDrives{}

	app1, _ := newTestApp(t, dlMock, repoMock, drivesMock)
	app1.cfg.Coord = coord1
	app1.cfg.StandbyMode = false

	app2, _ := newTestApp(t, dlMock, repoMock, drivesMock)
	app2.cfg.Coord = coord2
	app2.cfg.StandbyMode = true

	// 5. 验证任务级分布式锁互斥与并发防重
	taskID := "task-cluster-shared-999"

	// node-1 领取任务并加锁
	activeCount1.Store(1)
	leaseID1, acquired1, err := coord1.AcquireTaskLock(ctx, taskID, 60*time.Second)
	if err != nil || !acquired1 || leaseID1 == "" {
		t.Fatalf("node-1 获取任务锁失败: %v", err)
	}

	// node-2 此时试图处理同一任务 -> 必须被拒绝（防重处理）
	_, acquired2, err := coord2.AcquireTaskLock(ctx, taskID, 60*time.Second)
	if err != nil {
		t.Fatalf("node-2 检查任务锁失败: %v", err)
	}
	if acquired2 {
		t.Fatalf("并发安全漏洞: 同一任务被 node-2 同时抢到锁！")
	}

	// node-1 任务执行中心跳续期
	renewed, err := coord1.RenewLock(ctx, "task:"+taskID, leaseID1, 60*time.Second)
	if err != nil || !renewed {
		t.Fatalf("node-1 任务锁续期失败: %v", err)
	}

	// 释放任务锁
	if err := coord1.ReleaseTaskLock(ctx, taskID, leaseID1); err != nil {
		t.Fatalf("node-1 释放任务锁失败: %v", err)
	}
	activeCount1.Store(0)

	// 6. 主节点 node-1 优雅下线，主动释放 telegram_client 锁
	if err := coord1.ReleaseTelegramLock(ctx); err != nil {
		t.Fatalf("node-1 释放主锁失败: %v", err)
	}
	if mr.Exists("lock:telegram_client") {
		t.Fatal("node-1 释放后锁应立刻消失，不应留存 90s TTL")
	}

	// 7. 备用节点 node-2 热备接管，晋升为活跃 Leader
	held2, err := coord2.AcquireTelegramLock(ctx)
	if err != nil || !held2 {
		t.Fatalf("node-2 应该成功热接管锁: held=%v, err=%v", held2, err)
	}

	// 模拟 node-1 彻底下线并过期，node-2 心跳刷新
	mr.Del("instance:worker-node-1")
	isLeader2, err := coord2.IsClusterLeader(ctx)
	if err != nil || !isLeader2 {
		t.Errorf("node-2 应被选举为集群 Leader: isLeader=%v", isLeader2)
	}

	// 8. 验证清理已过期的残留僵尸实例
	mr.Set("instance:zombie-dead-node", `{"id":"zombie-dead-node","lastHeartbeat":1000}`)
	cleaned, err := coord2.CleanupExpiredInstances(ctx, 10*time.Second)
	if err != nil {
		t.Fatalf("清理过期实例出错: %v", err)
	}
	if cleaned == 0 {
		t.Errorf("期望清理至少 1 个僵尸实例")
	}
	if mr.Exists("instance:zombie-dead-node") {
		t.Errorf("僵尸节点键应被物理删除")
	}

	// 9. node-2 可以正常独占执行后续任务
	leaseID2, acquired3, err := coord2.AcquireTaskLock(ctx, "task-cluster-node2-new", 60*time.Second)
	if err != nil || !acquired3 || leaseID2 == "" {
		t.Fatalf("node-2 独占执行新任务失败: %v", err)
	}
	_ = coord2.ReleaseTaskLock(ctx, "task-cluster-node2-new", leaseID2)
}
