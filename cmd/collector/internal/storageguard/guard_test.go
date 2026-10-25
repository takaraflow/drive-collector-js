package storageguard

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStorageGuard_Calculation(t *testing.T) {
	guard := New(Config{
		RequiredHeadroomRatio: 0.10,              // 10%
		RequiredHeadroomBytes: 256 * 1024 * 1024, // 256MB
	})

	// 0 预期大小时，仅需 256MB
	if req := guard.GetRequiredStorageBytes(0); req != 256*1024*1024 {
		t.Fatalf("expected 256MB, got %d", req)
	}

	// 100MB 预期大小时: math.Ceil(100MB * 1.1) + 256MB
	var hundredMB int64 = 100 * 1024 * 1024
	expected := uint64(math.Ceil(float64(hundredMB)*1.1)) + 256*1024*1024
	if req := guard.GetRequiredStorageBytes(hundredMB); req != expected {
		t.Fatalf("expected %d, got %d", expected, req)
	}
}

func TestStorageGuard_AssertCapacity_Mock(t *testing.T) {
	tmpDir := t.TempDir()

	guard := New(Config{
		RequiredHeadroomRatio: 0.10,
		RequiredHeadroomBytes: 100 * 1024 * 1024, // 100MB
	})

	var mockAvailable uint64 = 500 * 1024 * 1024 // 500MB
	guard.SetStatfsFn(func(path string) (uint64, error) {
		return mockAvailable, nil
	})

	// 1. 充足空间测试: 预计 100MB -> 需要 110MB + 100MB = 210MB <= 500MB
	err := guard.AssertCapacity(tmpDir, 100*1024*1024, "test_ok")
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}

	// 2. 空间不足测试: 预计 400MB -> 需要 440MB + 100MB = 540MB > 500MB
	err = guard.AssertCapacity(tmpDir, 400*1024*1024, "test_insufficient")
	if err == nil {
		t.Fatal("expected InsufficientStorageError, got nil")
	}
	var storageErr *InsufficientStorageError
	if !errors.As(err, &storageErr) {
		t.Fatalf("expected InsufficientStorageError, got %T: %v", err, err)
	}
	if storageErr.AvailableBytes != mockAvailable {
		t.Errorf("expected available %d, got %d", mockAvailable, storageErr.AvailableBytes)
	}
	if !strings.Contains(err.Error(), "存储空间不足") {
		t.Errorf("error string mismatch: %s", err.Error())
	}

	// 3. 模拟 statfs 返回错误
	guard.SetStatfsFn(func(path string) (uint64, error) {
		return 0, errors.New("disk I/O error")
	})
	if err := guard.AssertCapacity(tmpDir, 10, "test_io_err"); err == nil {
		t.Fatal("expected statfs failure error")
	}
}

func TestStorageGuard_RealFilesystem(t *testing.T) {
	tmpDir := filepath.Join(os.TempDir(), "storageguard_real_test")
	defer os.RemoveAll(tmpDir)

	guard := New(Config{})
	// 在真实挂载点上，预计 1 字节通常能通过（假设宿主机有 >256MB 磁盘）
	avail, err := guard.AvailableBytes(os.TempDir())
	if err != nil {
		t.Fatalf("real AvailableBytes failed: %v", err)
	}
	if avail == 0 {
		t.Logf("warning: avail bytes is 0 on tempdir")
	}

	err = guard.AssertCapacity(tmpDir, 1024, "real_test")
	if err != nil {
		// 如果宿主机磁盘极小可能会报错，检查是否为 InsufficientStorageError
		var sErr *InsufficientStorageError
		if !errors.As(err, &sErr) {
			t.Fatalf("unexpected error type on real fs: %v", err)
		}
	}
}

func TestFormatBytes(t *testing.T) {
	tests := []struct {
		bytes uint64
		want  string
	}{
		{500, "500 B"},
		{1024, "1.00 KB"},
		{1536, "1.50 KB"},
		{1024 * 1024, "1.00 MB"},
		{1024 * 1024 * 1024 * 2, "2.00 GB"},
	}
	for _, tt := range tests {
		got := FormatBytes(tt.bytes)
		if got != tt.want {
			t.Errorf("FormatBytes(%d) = %q, want %q", tt.bytes, got, tt.want)
		}
	}
}
