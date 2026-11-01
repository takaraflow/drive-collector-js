package app

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
)

func newStorageApp(rc *fakeRclone, drives *fakeDrives) *App {
	return &App{
		rclone:  rc,
		drives:  drives,
		locks:   drive.NewSessionLock(),
		pending: make(chan string, pendingQueueSize),
		cfg:     Config{RemoteBase: "/global"},
		log:     quietApp(),
	}
}

func testDrive(id, dType, account, folder string, isDefault int) drive.Drive {
	return drive.Drive{
		ID:        id,
		UserID:    "42",
		Type:      dType,
		IsDefault: isDefault,
		Config:    drive.DriveConfig{User: account, Pass: "p"},
		RemoteFolder: sql.NullString{
			String: folder,
			Valid:  folder != "",
		},
	}
}

func TestGetDriveStorageSuccessAndCaching(t *testing.T) {
	d := testDrive("d1", "mega", "user@mega.nz", "/Telegram", 1)
	total := int64(50 * 1024 * 1024 * 1024)  // 50 GB
	used := int64(10 * 1024 * 1024 * 1024)   // 10 GB
	free := int64(40 * 1024 * 1024 * 1024)   // 40 GB
	trashed := int64(1 * 1024 * 1024 * 1024) // 1 GB
	objects := int64(345)

	rc := &fakeRclone{
		about: &rclone.AboutInfo{
			Total:   &total,
			Used:    &used,
			Free:    &free,
			Trashed: &trashed,
			Objects: &objects,
		},
	}
	app := newStorageApp(rc, &fakeDrives{drive: &d, all: []drive.Drive{d}})

	// 第一次查询：命中 rclone
	info, unsupported, errStr, _, err := app.getDriveStorage(context.Background(), &d, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if unsupported {
		t.Fatal("expected supported")
	}
	if errStr != "" {
		t.Fatalf("unexpected errStr: %s", errStr)
	}
	if info == nil || *info.Total != total {
		t.Fatalf("got info: %+v, want total %d", info, total)
	}
	if rc.aboutCalls != 1 {
		t.Fatalf("expected 1 rclone call, got %d", rc.aboutCalls)
	}

	// 第二次非强制查询：应命中内存缓存，不应产生新的 rclone 进程
	infoCached, _, _, _, _ := app.getDriveStorage(context.Background(), &d, false)
	if infoCached == nil || *infoCached.Total != total {
		t.Fatalf("cached info mismatch: %+v", infoCached)
	}
	if rc.aboutCalls != 1 {
		t.Fatalf("expected cached call not to increase rclone calls, got %d", rc.aboutCalls)
	}

	// 第三次 force 强制查询：应绕过缓存
	_, _, _, _, _ = app.getDriveStorage(context.Background(), &d, true)
	if rc.aboutCalls != 2 {
		t.Fatalf("expected force call to increase rclone calls to 2, got %d", rc.aboutCalls)
	}

	// 校验文本渲染
	now := time.Now()
	text, buttons := renderStorageView(&d, info, false, "", []drive.Drive{d}, now)
	if !strings.Contains(text, "MEGA") {
		t.Errorf("expected MEGA in text: %s", text)
	}
	if !strings.Contains(text, "50.0 GB") {
		t.Errorf("expected 50.0 GB in text: %s", text)
	}
	if !strings.Contains(text, "10.0 GB") || !strings.Contains(text, "20.0%") {
		t.Errorf("expected 10.0 GB (20.0%%) in text: %s", text)
	}
	if !strings.Contains(text, "40.0 GB") || !strings.Contains(text, "80.0%") {
		t.Errorf("expected 40.0 GB (80.0%%) in text: %s", text)
	}
	if !strings.Contains(text, "345") {
		t.Errorf("expected objects count in text: %s", text)
	}
	if !strings.Contains(text, "🟢 <b>空间状态充裕 (健康)</b>") {
		t.Errorf("expected healthy status in text: %s", text)
	}
	if !strings.Contains(text, "统计时间:") {
		t.Errorf("expected timestamp in text: %s", text)
	}

	// 校验按钮
	if len(buttons) < 2 {
		t.Fatalf("expected at least 2 button rows, got %d", len(buttons))
	}
	if buttons[0][0].Data != "storage_refresh_d1" {
		t.Errorf("expected refresh button, got %s", buttons[0][0].Data)
	}
}

func TestGetDriveStorageUnsupported(t *testing.T) {
	d := testDrive("s3_1", "oss", "my-bucket", "/backups", 1)
	d.Config = drive.DriveConfig{
		Endpoint: "https://oss.example.com",
		Bucket:   "my-bucket",
		AK:       "ak",
		SK:       "sk",
	}
	rc := &fakeRclone{
		aboutErr: rclone.ErrAboutNotSupported,
	}
	app := newStorageApp(rc, &fakeDrives{drive: &d, all: []drive.Drive{d}})

	info, unsupported, errStr, _, err := app.getDriveStorage(context.Background(), &d, false)
	if err != nil {
		t.Fatalf("expected err == nil for unsupported, got: %v", err)
	}
	if !unsupported {
		t.Fatal("expected unsupported == true")
	}
	if info != nil {
		t.Fatalf("expected nil info, got: %+v", info)
	}
	if errStr != "" {
		t.Fatalf("expected empty errStr, got: %s", errStr)
	}

	text, _ := renderStorageView(&d, nil, true, "", []drive.Drive{d}, time.Time{})
	if !strings.Contains(text, "不支持查询剩余空间配额") {
		t.Errorf("expected unsupported notice in text: %s", text)
	}
}

func TestGetDriveStorageFailure(t *testing.T) {
	d := testDrive("d2", "mega", "broken@mega.nz", "", 1)
	rc := &fakeRclone{
		aboutErr: errors.New("invalid login credentials"),
	}
	app := newStorageApp(rc, &fakeDrives{drive: &d, all: []drive.Drive{d}})

	_, unsupported, errStr, _, err := app.getDriveStorage(context.Background(), &d, false)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if unsupported {
		t.Fatal("expected unsupported == false")
	}
	if !strings.Contains(errStr, "invalid login credentials") {
		t.Fatalf("expected error detail in errStr, got: %s", errStr)
	}

	text, _ := renderStorageView(&d, nil, false, errStr, []drive.Drive{d}, time.Time{})
	if !strings.Contains(text, "空间信息查询失败") {
		t.Errorf("expected failure header in text: %s", text)
	}
	if !strings.Contains(text, "invalid login credentials") {
		t.Errorf("expected failure detail in text: %s", text)
	}
}

func TestRenderStorageViewHealthAlerts(t *testing.T) {
	d := testDrive("d1", "mega", "u1@mega.nz", "", 1)
	total := int64(100 * 1024 * 1024 * 1024)

	// Case 1: 96% used -> Critical Alert
	usedCritical := int64(96 * 1024 * 1024 * 1024)
	trashed := int64(500 * 1024 * 1024) // 500MB
	infoCritical := &rclone.AboutInfo{
		Total:   &total,
		Used:    &usedCritical,
		Trashed: &trashed,
	}
	textCritical, _ := renderStorageView(&d, infoCritical, false, "", []drive.Drive{d}, time.Now())
	if !strings.Contains(textCritical, "🚨 <b>存储空间严重告急") {
		t.Errorf("expected critical alert in text: %s", textCritical)
	}
	if !strings.Contains(textCritical, "💡 <i>提示: 回收站占用较多空间") {
		t.Errorf("expected trash cleanup advisory: %s", textCritical)
	}

	// Case 2: 88% used -> Warning
	usedWarning := int64(88 * 1024 * 1024 * 1024)
	infoWarning := &rclone.AboutInfo{
		Total: &total,
		Used:  &usedWarning,
	}
	textWarning, _ := renderStorageView(&d, infoWarning, false, "", []drive.Drive{d}, time.Now())
	if !strings.Contains(textWarning, "⚠️ <b>存储空间偏紧") {
		t.Errorf("expected warning in text: %s", textWarning)
	}
}

func TestMultipleDrivesButtons(t *testing.T) {
	d1 := testDrive("d1", "mega", "u1@mega.nz", "", 1)
	d2 := testDrive("d2", "protondrive", "u2@proton.me", "", 0)
	d3 := testDrive("d3", "pikpak", "u3@pikpak.com", "", 0)
	drives := []drive.Drive{d1, d2, d3}

	_, buttons := renderStorageView(&d1, nil, true, "", drives, time.Now())
	// buttons[0] 是刷新
	// buttons[1] 是网盘选择行 1 (2个按钮: d1, d2)
	// buttons[2] 是网盘选择行 2 (1个按钮: d3)
	// buttons[3] 是导航行 (查看文件 / 网盘管理)
	if len(buttons) != 4 {
		t.Fatalf("expected 4 rows for 3 drives (2-column layout), got %d", len(buttons))
	}
	driveRow1 := buttons[1]
	if len(driveRow1) != 2 {
		t.Fatalf("expected 2 drive buttons in first drive row, got %d", len(driveRow1))
	}
	if !strings.Contains(driveRow1[0].Text, "👉 🟢 1. MEGA") {
		t.Errorf("active drive button should have pointer and icon: %s", driveRow1[0].Text)
	}
	if !strings.Contains(driveRow1[1].Text, "🛡️ 2. PROTONDRIVE") {
		t.Errorf("second drive button text mismatch: %s", driveRow1[1].Text)
	}
	driveRow2 := buttons[2]
	if len(driveRow2) != 1 {
		t.Fatalf("expected 1 drive button in second drive row, got %d", len(driveRow2))
	}
	if !strings.Contains(driveRow2[0].Text, "⚡ 3. PIKPAK") {
		t.Errorf("third drive button text mismatch: %s", driveRow2[0].Text)
	}
}
