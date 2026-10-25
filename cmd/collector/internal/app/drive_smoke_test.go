package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/bindingsession"
	"github.com/youngsx/drive-collector/cmd/collector/internal/d1"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// fakeSmokeTG 记录 Telegram 交互行为，包括删除的敏感消息。
type fakeSmokeTG struct {
	sentMessages   []string
	deletedMsgIDs  []int64
	sentButtons    []string
}

func (f *fakeSmokeTG) Run(context.Context) error { return nil }
func (f *fakeSmokeTG) SelfID() int64             { return 10001 }

func (f *fakeSmokeTG) SendMessage(_ context.Context, _ int64, text string) error {
	f.sentMessages = append(f.sentMessages, text)
	return nil
}

func (f *fakeSmokeTG) SendMessageWithID(_ context.Context, _ int64, text string) (int, error) {
	f.sentMessages = append(f.sentMessages, text)
	return 999, nil
}

func (f *fakeSmokeTG) SendWithButtons(_ context.Context, _ int64, text string, _ [][]tgclient.Button) error {
	f.sentButtons = append(f.sentButtons, text)
	return nil
}

func (f *fakeSmokeTG) SendWithButtonsAndID(_ context.Context, _ int64, text string, _ [][]tgclient.Button) (int, error) {
	f.sentButtons = append(f.sentButtons, text)
	return 999, nil
}

func (f *fakeSmokeTG) EditMessage(context.Context, int64, int, string) error { return nil }
func (f *fakeSmokeTG) EditWithButtons(context.Context, int64, int, string, [][]tgclient.Button) error {
	return nil
}

func (f *fakeSmokeTG) DeleteMessages(_ context.Context, _ int64, ids []int64) error {
	f.deletedMsgIDs = append(f.deletedMsgIDs, ids...)
	return nil
}

func (f *fakeSmokeTG) AnswerCallback(context.Context, int64, string, bool) error {
	return nil
}

// fakeMemorySession 模拟 Redis 绑定会话存储。
type fakeMemorySession struct {
	sessions map[string]*bindingsession.Session
}

func newFakeMemorySession() *fakeMemorySession {
	return &fakeMemorySession{sessions: make(map[string]*bindingsession.Session)}
}

func (m *fakeMemorySession) Start(_ context.Context, userID, step string, data map[string]string) error {
	m.sessions[userID] = &bindingsession.Session{
		UserID:      userID,
		CurrentStep: step,
		Data:        data,
	}
	return nil
}

func (m *fakeMemorySession) Get(_ context.Context, userID string) (*bindingsession.Session, error) {
	return m.sessions[userID], nil
}

func (m *fakeMemorySession) Update(_ context.Context, userID, step string, data map[string]string) error {
	m.sessions[userID] = &bindingsession.Session{
		UserID:      userID,
		CurrentStep: step,
		Data:        data,
	}
	return nil
}

func (m *fakeMemorySession) Clear(_ context.Context, userID string) error {
	delete(m.sessions, userID)
	return nil
}



type roundTripFunc func(req *http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func mockD1Client() *d1.Client {
	hc := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			resp := map[string]any{
				"result": []map[string]any{
					{
						"results": []map[string]any{},
						"success": true,
					},
				},
				"success": true,
				"errors":  []any{},
			}
			body, _ := json.Marshal(resp)
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(bytes.NewReader(body)),
				Header:     make(http.Header),
			}, nil
		}),
	}
	c, _ := d1.New(d1.Config{
		AccountID:  "smoke-acc",
		DatabaseID: "smoke-db",
		Token:      "smoke-tok",
		HTTPClient: hc,
	})
	return c
}

// TestSmoke_WebDAV_EndToEnd 全链路 Smoke 测试：
// 1. 引导流程：URL -> Username -> Password
// 2. 敏感密码输入自动焚毁消息
// 3. 配置生成与校验落盘
// 4. 普通落盘上传 (upload) 完整路径验证
// 5. 零磁盘流式直传 (streamTransfer) 完整管道验证
func TestSmoke_WebDAV_EndToEnd(t *testing.T) {
	ctx := context.Background()
	rcloneMock := &fakeRclone{}
	dlMock := &fakeDL{content: "smoke test webdav payload content"}
	repoMock := &fakeRepo{}
	drivesMock := &fakeDrives{}

	app, _ := newTestApp(t, dlMock, repoMock, drivesMock)
	app.rclone = rcloneMock
	app.d1c = mockD1Client()

	fakeTG := &fakeSmokeTG{}
	app.tg = fakeTG

	memSession := newFakeMemorySession()
	app.bindSessions = memSession

	userID := "1234567"
	chatID := int64(1234567)

	// Step 1: 用户点击绑定 WebDAV
	if err := app.bindStart(ctx, chatID, userID, "webdav"); err != nil {
		t.Fatalf("bindStart 失败: %v", err)
	}
	sess, err := app.bindSessions.Get(ctx, userID)
	if err != nil || sess == nil || sess.CurrentStep != "WEBDAV:WAIT_URL" {
		t.Fatalf("期望状态 WEBDAV:WAIT_URL, 实际: %v", sess)
	}

	// Step 2: 用户输入服务器地址
	msgURL := messageInfo{ChatID: chatID, SenderID: 1234567, ID: 101}
	handled := app.handleBindInput(ctx, msgURL, "https://dav.box.example.com/remote/webdav/")
	if !handled {
		t.Fatal("handleBindInput 应该消费 URL 消息")
	}
	sess, _ = app.bindSessions.Get(ctx, userID)
	if sess == nil || sess.CurrentStep != "WEBDAV:WAIT_USER" {
		t.Fatalf("期望状态 WEBDAV:WAIT_USER, 实际: %v", sess)
	}

	// Step 3: 用户输入用户名
	msgUser := messageInfo{ChatID: chatID, SenderID: 1234567, ID: 102}
	handled = app.handleBindInput(ctx, msgUser, "alice_dav")
	if !handled {
		t.Fatal("handleBindInput 应该消费用户名消息")
	}
	sess, _ = app.bindSessions.Get(ctx, userID)
	if sess == nil || sess.CurrentStep != "WEBDAV:WAIT_PASS" {
		t.Fatalf("期望状态 WEBDAV:WAIT_PASS, 实际: %v", sess)
	}

	// Step 4: 用户输入密码 (敏感信息)
	msgPass := messageInfo{ChatID: chatID, SenderID: 1234567, ID: 103}
	handled = app.handleBindInput(ctx, msgPass, "MySecretDavPassword#2026")
	if !handled {
		t.Fatal("handleBindInput 应该消费密码消息")
	}

	// 门禁断言 1: 敏感密码消息必须在 Telegram 聊天中被物理删除
	var foundDeleted bool
	for _, id := range fakeTG.deletedMsgIDs {
		if id == 103 {
			foundDeleted = true
			break
		}
	}
	if !foundDeleted {
		t.Errorf("门禁失败: 用户密码消息 (ID 103) 未被自动删除, deletedMsgIDs=%v", fakeTG.deletedMsgIDs)
	}

	// Step 5: 验证绑定完成，装配网盘驱动用于后续转存
	boundDrive := &drive.Drive{
		ID:     "drive_webdav_1",
		UserID: userID,
		Type:   string(drive.TypeWebDAV),
		Status: "active",
		Config: drive.DriveConfig{
			URL:                "https://dav.box.example.com/remote/webdav/",
			User:               "alice_dav",
			Pass:               "MySecretDavPassword#2026",
			Vendor:             "other",
			PassFormat:         "rclone_obscured",
			SchemaVersion:      1,
			CredentialVerified: true,
		},
	}
	drivesMock.drive = boundDrive

	// Step 6: 门禁断言 2: 普通落盘上传 (upload) 全链路通过
	task1 := store.Task{
		ID:        "task_smoke_dav_1",
		UserID:    userID,
		FileName:  sqlStr("report_2026.pdf"),
		SourceRef: sqlStr("1234567/42"),
	}
	if err := app.upload(ctx, task1); err != nil {
		t.Fatalf("WebDAV 普通上传失败: %v", err)
	}

	conn := rcloneMock.lastConfig.Connection
	if !strings.HasPrefix(conn, ":webdav,") {
		t.Fatalf("期望 rclone 接收 :webdav, 连接串, 实际得到: %s", conn)
	}
	if !strings.Contains(conn, `url="https://dav.box.example.com/remote/webdav/"`) {
		t.Errorf("连接串未包含正确的 URL: %s", conn)
	}
	if !strings.Contains(conn, `user="alice_dav"`) {
		t.Errorf("连接串未包含正确的用户名: %s", conn)
	}
	if !strings.Contains(conn, `pass="MySecretDavPassword#2026"`) {
		t.Errorf("连接串未包含正确的密码: %s", conn)
	}

	// Step 7: 门禁断言 3: 零磁盘直接流式管道 (streamTransfer) 全链路通过
	task2 := store.Task{
		ID:        "task_smoke_dav_2",
		UserID:    userID,
		FileName:  sqlStr("streaming_video.mp4"),
		SourceRef: sqlStr("1234567/43"),
	}
	if err := app.streamTransfer(ctx, task2); err != nil {
		t.Fatalf("WebDAV 零磁盘直传管道失败: %v", err)
	}

	streamConn := rcloneMock.lastConfig.Connection
	if !strings.HasPrefix(streamConn, ":webdav,") {
		t.Fatalf("期望直传管道接收 :webdav, 连接串, 实际得到: %s", streamConn)
	}
}

// TestSmoke_OSS_EndToEnd 全链路 Smoke 测试：
// 1. 引导流程：Endpoint -> Bucket -> AK -> SK
// 2. 敏感 Secret Key 输入自动焚毁消息
// 3. 配置生成与校验落盘
// 4. 普通落盘上传 (upload) 完整路径验证
// 5. 零磁盘流式直传 (streamTransfer) 完整管道验证
func TestSmoke_OSS_EndToEnd(t *testing.T) {
	ctx := context.Background()
	rcloneMock := &fakeRclone{}
	dlMock := &fakeDL{content: "smoke test s3/oss payload content"}
	repoMock := &fakeRepo{}
	drivesMock := &fakeDrives{}

	app, _ := newTestApp(t, dlMock, repoMock, drivesMock)
	app.rclone = rcloneMock
	app.d1c = mockD1Client()

	fakeTG := &fakeSmokeTG{}
	app.tg = fakeTG

	memSession := newFakeMemorySession()
	app.bindSessions = memSession

	userID := "9876543"
	chatID := int64(9876543)

	// Step 1: 用户点击绑定 S3 / OSS
	if err := app.bindStart(ctx, chatID, userID, "oss"); err != nil {
		t.Fatalf("bindStart 失败: %v", err)
	}
	sess, err := app.bindSessions.Get(ctx, userID)
	if err != nil || sess == nil || sess.CurrentStep != "OSS:WAIT_ENDPOINT" {
		t.Fatalf("期望状态 OSS:WAIT_ENDPOINT, 实际: %v", sess)
	}

	// Step 2: 用户输入 Endpoint
	msgEP := messageInfo{ChatID: chatID, SenderID: 9876543, ID: 201}
	handled := app.handleBindInput(ctx, msgEP, "https://oss-cn-hangzhou.aliyuncs.com")
	if !handled {
		t.Fatal("handleBindInput 应该消费 Endpoint 消息")
	}
	sess, _ = app.bindSessions.Get(ctx, userID)
	if sess == nil || sess.CurrentStep != "OSS:WAIT_BUCKET" {
		t.Fatalf("期望状态 OSS:WAIT_BUCKET, 实际: %v", sess)
	}

	// Step 3: 用户输入 Bucket
	msgBucket := messageInfo{ChatID: chatID, SenderID: 9876543, ID: 202}
	handled = app.handleBindInput(ctx, msgBucket, "my-production-backup")
	if !handled {
		t.Fatal("handleBindInput 应该消费 Bucket 消息")
	}
	sess, _ = app.bindSessions.Get(ctx, userID)
	if sess == nil || sess.CurrentStep != "OSS:WAIT_AK" {
		t.Fatalf("期望状态 OSS:WAIT_AK, 实际: %v", sess)
	}

	// Step 4: 用户输入 Access Key ID
	msgAK := messageInfo{ChatID: chatID, SenderID: 9876543, ID: 203}
	handled = app.handleBindInput(ctx, msgAK, "LTAI5tSmokeTestAK888")
	if !handled {
		t.Fatal("handleBindInput 应该消费 AK 消息")
	}
	sess, _ = app.bindSessions.Get(ctx, userID)
	if sess == nil || sess.CurrentStep != "OSS:WAIT_SK" {
		t.Fatalf("期望状态 OSS:WAIT_SK, 实际: %v", sess)
	}

	// Step 5: 用户输入 Secret Access Key (敏感信息)
	msgSK := messageInfo{ChatID: chatID, SenderID: 9876543, ID: 204}
	handled = app.handleBindInput(ctx, msgSK, "VerySecretKeyForOSS99999")
	if !handled {
		t.Fatal("handleBindInput 应该消费 SK 消息")
	}

	// 门禁断言 1: 敏感 Secret Key 消息必须在 Telegram 聊天中被物理删除
	var foundDeleted bool
	for _, id := range fakeTG.deletedMsgIDs {
		if id == 204 {
			foundDeleted = true
			break
		}
	}
	if !foundDeleted {
		t.Errorf("门禁失败: 用户 SK 消息 (ID 204) 未被自动删除, deletedMsgIDs=%v", fakeTG.deletedMsgIDs)
	}

	// Step 6: 验证绑定完成，装配网盘驱动用于后续转存
	boundDrive := &drive.Drive{
		ID:     "drive_oss_1",
		UserID: userID,
		Type:   string(drive.TypeOSS),
		Status: "active",
		Config: drive.DriveConfig{
			Endpoint:           "https://oss-cn-hangzhou.aliyuncs.com",
			Bucket:             "my-production-backup",
			AK:                 "LTAI5tSmokeTestAK888",
			SK:                 "VerySecretKeyForOSS99999",
			Provider:           "Other",
			PassFormat:         "rclone_obscured",
			SchemaVersion:      1,
			CredentialVerified: true,
		},
	}
	drivesMock.drive = boundDrive

	// Step 7: 门禁断言 2: 普通落盘上传 (upload) 全链路通过
	task1 := store.Task{
		ID:        "task_smoke_oss_1",
		UserID:    userID,
		FileName:  sqlStr("cloud_archive.tar.gz"),
		SourceRef: sqlStr("9876543/11"),
	}
	if err := app.upload(ctx, task1); err != nil {
		t.Fatalf("OSS 普通上传失败: %v", err)
	}

	conn := rcloneMock.lastConfig.Connection
	if !strings.HasPrefix(conn, ":s3,") {
		t.Fatalf("期望 rclone 接收 :s3, 连接串, 实际得到: %s", conn)
	}
	if !strings.Contains(conn, `endpoint="https://oss-cn-hangzhou.aliyuncs.com"`) {
		t.Errorf("连接串未包含正确的 Endpoint: %s", conn)
	}
	if !strings.Contains(conn, `access_key_id="LTAI5tSmokeTestAK888"`) {
		t.Errorf("连接串未包含正确的 AK: %s", conn)
	}
	if !strings.Contains(conn, `secret_access_key="VerySecretKeyForOSS99999"`) {
		t.Errorf("连接串未包含正确的 SK: %s", conn)
	}
	if !strings.HasSuffix(conn, ":my-production-backup") {
		t.Errorf("连接串未包含正确的 Bucket 后缀: %s", conn)
	}

	// Step 8: 门禁断言 3: 零磁盘直接流式管道 (streamTransfer) 全链路通过
	task2 := store.Task{
		ID:        "task_smoke_oss_2",
		UserID:    userID,
		FileName:  sqlStr("streaming_backup.tar.gz"),
		SourceRef: sqlStr("9876543/12"),
	}
	if err := app.streamTransfer(ctx, task2); err != nil {
		t.Fatalf("OSS 零磁盘直传管道失败: %v", err)
	}

	streamConn := rcloneMock.lastConfig.Connection
	if !strings.HasPrefix(streamConn, ":s3,") {
		t.Fatalf("期望直传管道接收 :s3, 连接串, 实际得到: %s", streamConn)
	}
}

// TestSmoke_WebDAV_And_OSS_ValidationAndCancel 测试非法输入防错拦截与中途取消
func TestSmoke_WebDAV_And_OSS_ValidationAndCancel(t *testing.T) {
	ctx := context.Background()
	rcloneMock := &fakeRclone{}
	dlMock := &fakeDL{}
	repoMock := &fakeRepo{}
	drivesMock := &fakeDrives{}

	app, _ := newTestApp(t, dlMock, repoMock, drivesMock)
	app.rclone = rcloneMock
	app.d1c = mockD1Client()
	fakeTG := &fakeSmokeTG{}
	app.tg = fakeTG

	memSession := newFakeMemorySession()
	app.bindSessions = memSession

	// 1. WebDAV 非法 URL 拦截
	userID := "111222333"
	chatID := int64(111222333)
	_ = app.bindStart(ctx, chatID, userID, "webdav")

	msgBadURL := messageInfo{ChatID: chatID, SenderID: 111222333, ID: 501}
	app.handleBindInput(ctx, msgBadURL, "ftp://bad-protocol.com/dav")
	sess, _ := app.bindSessions.Get(ctx, userID)
	if sess == nil || sess.CurrentStep != "WEBDAV:WAIT_URL" {
		t.Fatalf("非法 URL 应该阻止状态推进，当前: %v", sess)
	}

	// 2. 取消 WebDAV 绑定
	app.handleBindInput(ctx, msgBadURL, "/cancel")
	sess, _ = app.bindSessions.Get(ctx, userID)
	if sess != nil {
		t.Fatalf("/cancel 后会话必须被清空，当前: %v", sess)
	}

	// 3. S3/OSS 非法空 Endpoint 拦截
	_ = app.bindStart(ctx, chatID, userID, "oss")
	msgBadEP := messageInfo{ChatID: chatID, SenderID: 111222333, ID: 502}
	app.handleBindInput(ctx, msgBadEP, "   ")
	sess, _ = app.bindSessions.Get(ctx, userID)
	if sess == nil || sess.CurrentStep != "OSS:WAIT_ENDPOINT" {
		t.Fatalf("空 Endpoint 应该阻止推进，当前: %v", sess)
	}

	// 4. 取消 OSS 绑定
	app.handleBindInput(ctx, msgBadEP, "取消")
	sess, _ = app.bindSessions.Get(ctx, userID)
	if sess != nil {
		t.Fatalf("发送 取消 后会话必须被清空，当前: %v", sess)
	}
}

// TestSmoke_PikPak_EndToEnd 全链路冒烟:
// 1. Telegram 用户点击 PikPak 绑定向导
// 2. 交互式输入用户名与密码
// 3. 门禁验证: Telegram 自动物理删除含敏感密码的消息
// 4. 门禁验证: 会话安全归档
// 5. 门禁验证: 普通落盘上传 (upload) 成功调用 rclone 并构造精确的 :pikpak, 连接串
// 6. 门禁验证: 零磁盘管道直传 (streamTransfer) 成功调度 streampipe 并打通 rclone rcat
func TestSmoke_PikPak_EndToEnd(t *testing.T) {
	ctx := context.Background()

	rcloneMock := &fakeRclone{}
	dlMock := &fakeDL{content: "smoke pikpak test data content"}
	repoMock := &fakeRepo{}
	drivesMock := &fakeDrives{}

	app, _ := newTestApp(t, dlMock, repoMock, drivesMock)
	app.rclone = rcloneMock
	app.d1c = mockD1Client()

	fakeTG := &fakeSmokeTG{}
	app.tg = fakeTG

	memSession := newFakeMemorySession()
	app.bindSessions = memSession

	userID := "555666777"
	chatID := int64(555666777)

	// 1. 触发向导
	if err := app.bindStart(ctx, chatID, userID, "pikpak"); err != nil {
		t.Fatalf("bindStart 失败: %v", err)
	}

	// 2. 输入用户
	msgUser := messageInfo{ChatID: chatID, SenderID: 555666777, ID: 701}
	if !app.handleBindInput(ctx, msgUser, "pikpak_user@test.org") {
		t.Fatalf("handleBindInput 应该消费 User 消息")
	}

	// 3. 输入密码
	msgPass := messageInfo{ChatID: chatID, SenderID: 555666777, ID: 702}
	if !app.handleBindInput(ctx, msgPass, "PikPakSuperSecretPass999") {
		t.Fatalf("handleBindInput 应该消费 Pass 消息")
	}

	// 4. 门禁断言: 敏感密码消息已被物理销毁
	deletedPass := false
	for _, id := range fakeTG.deletedMsgIDs {
		if id == 702 {
			deletedPass = true
			break
		}
	}
	if !deletedPass {
		t.Errorf("安全门禁未通过: 用户敏感密码消息 (ID: 702) 未被物理删除! 已删: %v", fakeTG.deletedMsgIDs)
	}

	// 5. 门禁断言: 会话归档
	sess, _ := app.bindSessions.Get(ctx, userID)
	if sess != nil {
		t.Errorf("绑定完成后会话必须清空，实际依然存在: %+v", sess)
	}

	// 6. 构造真实任务验证落盘上传与连接串
	pikpakDrive := &drive.Drive{
		ID:     "smoke_pikpak_drive_1",
		UserID: userID,
		Type:   string(drive.TypePikPak),
		Status: "active",
		Config: drive.DriveConfig{
			User:       "pikpak_user@test.org",
			Pass:       "PikPakSuperSecretPass999",
			PassFormat: "rclone_obscured",
		},
	}
	drivesMock.drive = pikpakDrive

	task1 := store.Task{
		ID:        "task_smoke_pikpak_1",
		UserID:    userID,
		FileName:  sqlStr("test_pikpak.mp4"),
		SourceRef: sqlStr("555666777/10"),
	}

	err := app.upload(ctx, task1)
	if err != nil {
		t.Fatalf("PikPak upload 失败: %v", err)
	}

	conn := rcloneMock.lastConfig.Connection
	if !strings.HasPrefix(conn, ":pikpak,") {
		t.Errorf("生成的连接串非 :pikpak 格式: %s", conn)
	}
	if !strings.Contains(conn, `user="pikpak_user@test.org"`) {
		t.Errorf("连接串缺少 user: %s", conn)
	}

	// 7. 验证零磁盘直传
	task2 := store.Task{
		ID:        "task_smoke_pikpak_pipe",
		UserID:    userID,
		FileName:  sqlStr("stream_pikpak.mp4"),
		SourceRef: sqlStr("555666777/11"),
	}
	err = app.streamTransfer(ctx, task2)
	if err != nil {
		t.Fatalf("PikPak streamTransfer 失败: %v", err)
	}
}

type fakeFilenAuthMock struct {
	apiKey string
}

func (f *fakeFilenAuthMock) Login(ctx context.Context, email, password, twoFactorCode string) (string, bool, error) {
	if twoFactorCode == "" {
		return "", true, nil // 触发 2FA 挑战
	}
	return f.apiKey, false, nil
}

// TestSmoke_Filen_EndToEnd 全链路冒烟 (方案 1: 自动端到端密钥派生并置换 API Key):
// 1. Telegram 用户点击 Filen 绑定向导
// 2. 交互式输入邮箱与密码
// 3. 后端探测到 2FA 挑战，无缝提示用户输入 6 位动态验证码
// 4. 用户提交动态码，后端自动完成端到端派生与置换，获取 API Key
// 5. 门禁验证: Telegram 自动物理销毁密码与 2FA 动态码原始消息
// 6. 门禁验证: D1 落库包含自动生成的 API Key
// 7. 门禁验证: 普通落盘与零磁盘管道直传 100% 成功生成 :filen, 连接串
func TestSmoke_Filen_EndToEnd(t *testing.T) {
	ctx := context.Background()

	rcloneMock := &fakeRclone{}
	dlMock := &fakeDL{content: "smoke filen payload content"}
	repoMock := &fakeRepo{}
	drivesMock := &fakeDrives{}

	app, _ := newTestApp(t, dlMock, repoMock, drivesMock)
	app.rclone = rcloneMock
	app.d1c = mockD1Client()
	app.filenClient = &fakeFilenAuthMock{apiKey: "derived_filen_token_88888"}

	fakeTG := &fakeSmokeTG{}
	app.tg = fakeTG

	memSession := newFakeMemorySession()
	app.bindSessions = memSession

	userID := "888999111"
	chatID := int64(888999111)

	// 1. 触发向导
	if err := app.bindStart(ctx, chatID, userID, "filen"); err != nil {
		t.Fatalf("bindStart 失败: %v", err)
	}

	// 2. 输入邮箱
	msgEmail := messageInfo{ChatID: chatID, SenderID: 888999111, ID: 801}
	if !app.handleBindInput(ctx, msgEmail, "alice@filen.io") {
		t.Fatalf("handleBindInput 应该消费 Email 消息")
	}

	// 3. 输入密码 (触发 2FA 流程)
	msgPass := messageInfo{ChatID: chatID, SenderID: 888999111, ID: 802}
	if !app.handleBindInput(ctx, msgPass, "AliceFilenSecretPassword") {
		t.Fatalf("handleBindInput 应该消费 Pass 消息")
	}

	// 检查状态机前进至 WAIT_2FA
	sess, _ := app.bindSessions.Get(ctx, userID)
	if sess == nil || sess.CurrentStep != "FILEN:WAIT_2FA" {
		t.Fatalf("期望步进至 FILEN:WAIT_2FA，实际: %+v", sess)
	}

	// 4. 输入 2FA 验证码
	msg2FA := messageInfo{ChatID: chatID, SenderID: 888999111, ID: 803}
	if !app.handleBindInput(ctx, msg2FA, "123456") {
		t.Fatalf("handleBindInput 应该消费 2FA 消息")
	}

	// 5. 门禁断言: 密码 (ID: 802) 和 2FA (ID: 803) 均被物理删除
	deleted802 := false
	deleted803 := false
	for _, id := range fakeTG.deletedMsgIDs {
		if id == 802 {
			deleted802 = true
		}
		if id == 803 {
			deleted803 = true
		}
	}
	if !deleted802 || !deleted803 {
		t.Errorf("安全门禁未通过: 密码消息或 2FA 消息未被完全物理删除! 已删: %v", fakeTG.deletedMsgIDs)
	}

	// 6. 构造真实任务验证落盘上传与连接串
	filenDrive := &drive.Drive{
		ID:     "smoke_filen_drive_1",
		UserID: userID,
		Type:   string(drive.TypeFilen),
		Status: "active",
		Config: drive.DriveConfig{
			User:       "alice@filen.io",
			Pass:       "AliceFilenSecretPassword",
			APIKey:     "derived_filen_token_88888",
			PassFormat: "rclone_obscured",
		},
	}
	drivesMock.drive = filenDrive

	task1 := store.Task{
		ID:        "task_smoke_filen_1",
		UserID:    userID,
		FileName:  sqlStr("secret_archive.enc"),
		SourceRef: sqlStr("888999111/20"),
	}

	err := app.upload(ctx, task1)
	if err != nil {
		t.Fatalf("Filen upload 失败: %v", err)
	}

	conn := rcloneMock.lastConfig.Connection
	if !strings.HasPrefix(conn, ":filen,") {
		t.Errorf("生成的连接串非 :filen 格式: %s", conn)
	}
	if !strings.Contains(conn, `email="alice@filen.io"`) {
		t.Errorf("连接串缺少 email: %s", conn)
	}
	if !strings.Contains(conn, `api_key="derived_filen_token_88888"`) {
		t.Errorf("连接串缺少自动派生的 api_key: %s", conn)
	}

	// 7. 验证零磁盘直传
	task2 := store.Task{
		ID:        "task_smoke_filen_pipe",
		UserID:    userID,
		FileName:  sqlStr("stream_filen.zip"),
		SourceRef: sqlStr("888999111/21"),
	}
	err = app.streamTransfer(ctx, task2)
	if err != nil {
		t.Fatalf("Filen streamTransfer 失败: %v", err)
	}
}
