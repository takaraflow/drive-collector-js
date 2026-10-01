package drive

import (
	"context"
	"sync"
)

// SessionLock 串行化「读 session → rclone 旋转一次性 refresh_token → 收割回 DB」。
//
// 背景(记忆里的 proton-refresh-token-race):
//
//	Proton 的 refresh_token 是【一次性】的。rclone 用掉 R1 后会
//	换成 R2,R1 立即失效。同一账号的两个并发任务都用 R1:
//	  A 把 R1 转成 R2 并存回
//	  B 手里的 R1 已死 → Code=10013 → 账号永久砖化,必须重新绑定
//
// 单实例下这个竞态【依然存在】—— 不是两个实例,是同一实例里的
// 两个并发任务(用户连发两条消息)。
//
// 锁的粒度是 (网盘类型, 用户):不同用户互不阻塞,同一用户的
// 串行化即可。
type SessionLock struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

// NewSessionLock 构造锁表。
func NewSessionLock() *SessionLock {
	return &SessionLock{locks: map[string]*sync.Mutex{}}
}

// Key 生成锁键。
func Key(driveType Type, userID string) string {
	return string(driveType) + ":" + userID
}

// Lock 取得锁并返回释放函数。
//
// 用法:
//
//	unlock := locks.Lock(drive.Key(TypeProton, userID))
//	defer unlock()
//
// 释放函数必须 defer —— session 操作一旦漏掉释放,该用户的
// 后续所有任务都卡死。
func (l *SessionLock) Lock(key string) func() {
	l.mu.Lock()
	if l.locks == nil {
		l.locks = map[string]*sync.Mutex{}
	}
	m, ok := l.locks[key]
	if !ok {
		m = &sync.Mutex{}
		l.locks[key] = m
	}
	l.mu.Unlock()

	m.Lock()
	return func() { m.Unlock() }
}

// WithSession 在锁内执行 session 相关操作。
//
// 显式提供这个包装,而不是到处写 Lock/defer Unlock —— 后者漏一次
// 就是一次永久卡死,而这种 bug 表现为「某个用户的任务全停了」,
// 极难定位。
func (l *SessionLock) WithSession(ctx context.Context, key string, fn func() error) error {
	unlock := l.Lock(key)
	defer unlock()
	return fn()
}
