package app

import (
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
)

func TestResolveUploadConflict_NoConflict(t *testing.T) {
	remoteFiles := []rclone.FileEntry{
		{Name: "other.mp4", Size: 1024, IsDir: false},
	}
	res := resolveUploadConflict(remoteFiles, "video.mp4", 2048)
	if res.TargetFileName != "video.mp4" {
		t.Fatalf("expected TargetFileName 'video.mp4', got '%s'", res.TargetFileName)
	}
	if res.ShouldSkip {
		t.Fatalf("expected ShouldSkip false, got true")
	}
	if res.IsRenamed {
		t.Fatalf("expected IsRenamed false, got true")
	}
}

func TestResolveUploadConflict_SameNameSameSize_Dedupe(t *testing.T) {
	remoteFiles := []rclone.FileEntry{
		{Name: "2.mp4", Size: 1517641, IsDir: false},
	}
	res := resolveUploadConflict(remoteFiles, "2.mp4", 1517641)
	if res.TargetFileName != "2.mp4" {
		t.Fatalf("expected TargetFileName '2.mp4', got '%s'", res.TargetFileName)
	}
	if !res.ShouldSkip {
		t.Fatalf("expected ShouldSkip true (dedupe hit), got false")
	}
	if res.IsRenamed {
		t.Fatalf("expected IsRenamed false, got true")
	}
}

func TestResolveUploadConflict_SameNameDifferentSize_AutoRename(t *testing.T) {
	remoteFiles := []rclone.FileEntry{
		{Name: "2.mp4", Size: 1517641, IsDir: false},
	}
	// Different size: should not overwrite, should rename to 2 (1).mp4
	res := resolveUploadConflict(remoteFiles, "2.mp4", 2000000)
	if res.TargetFileName != "2 (1).mp4" {
		t.Fatalf("expected TargetFileName '2 (1).mp4', got '%s'", res.TargetFileName)
	}
	if res.ShouldSkip {
		t.Fatalf("expected ShouldSkip false, got true")
	}
	if !res.IsRenamed {
		t.Fatalf("expected IsRenamed true, got false")
	}
}

func TestResolveUploadConflict_MultipleConflicts(t *testing.T) {
	remoteFiles := []rclone.FileEntry{
		{Name: "2.mp4", Size: 1000, IsDir: false},
		{Name: "2 (1).mp4", Size: 2000, IsDir: false},
		{Name: "2 (2).mp4", Size: 3000, IsDir: false},
	}
	// Different size from all existing files: should pick 2 (3).mp4
	res := resolveUploadConflict(remoteFiles, "2.mp4", 4000)
	if res.TargetFileName != "2 (3).mp4" {
		t.Fatalf("expected TargetFileName '2 (3).mp4', got '%s'", res.TargetFileName)
	}
	if res.ShouldSkip {
		t.Fatalf("expected ShouldSkip false, got true")
	}
	if !res.IsRenamed {
		t.Fatalf("expected IsRenamed true, got false")
	}
}

func TestResolveUploadConflict_HitExistingIndexedCandidate(t *testing.T) {
	remoteFiles := []rclone.FileEntry{
		{Name: "2.mp4", Size: 1000, IsDir: false},
		{Name: "2 (1).mp4", Size: 2000, IsDir: false},
	}
	// Size matches 2 (1).mp4: should dedupe against 2 (1).mp4
	res := resolveUploadConflict(remoteFiles, "2.mp4", 2000)
	if res.TargetFileName != "2 (1).mp4" {
		t.Fatalf("expected TargetFileName '2 (1).mp4', got '%s'", res.TargetFileName)
	}
	if !res.ShouldSkip {
		t.Fatalf("expected ShouldSkip true, got false")
	}
	if !res.IsRenamed {
		t.Fatalf("expected IsRenamed true, got false")
	}
}

func TestResolveUploadConflict_InputAlreadyIndexed(t *testing.T) {
	remoteFiles := []rclone.FileEntry{
		{Name: "doc (1).pdf", Size: 1000, IsDir: false},
	}
	// Input name is already doc (1).pdf and differs in size -> should become doc (2).pdf
	res := resolveUploadConflict(remoteFiles, "doc (1).pdf", 2000)
	if res.TargetFileName != "doc (2).pdf" {
		t.Fatalf("expected TargetFileName 'doc (2).pdf', got '%s'", res.TargetFileName)
	}
	if res.ShouldSkip {
		t.Fatalf("expected ShouldSkip false, got true")
	}
	if !res.IsRenamed {
		t.Fatalf("expected IsRenamed true, got false")
	}
}

func TestResolveUploadConflict_NoExtension(t *testing.T) {
	remoteFiles := []rclone.FileEntry{
		{Name: "LICENSE", Size: 100, IsDir: false},
	}
	res := resolveUploadConflict(remoteFiles, "LICENSE", 200)
	if res.TargetFileName != "LICENSE (1)" {
		t.Fatalf("expected TargetFileName 'LICENSE (1)', got '%s'", res.TargetFileName)
	}
	if res.ShouldSkip || !res.IsRenamed {
		t.Fatalf("unexpected res state: %+v", res)
	}
}

func TestResolveUploadConflict_MultipleDots(t *testing.T) {
	remoteFiles := []rclone.FileEntry{
		{Name: "archive.tar.gz", Size: 100, IsDir: false},
	}
	res := resolveUploadConflict(remoteFiles, "archive.tar.gz", 200)
	if res.TargetFileName != "archive.tar (1).gz" {
		t.Fatalf("expected TargetFileName 'archive.tar (1).gz', got '%s'", res.TargetFileName)
	}
}

func TestResolveUploadConflict_CaseInsensitive(t *testing.T) {
	remoteFiles := []rclone.FileEntry{
		{Name: "PHOTO.JPG", Size: 100, IsDir: false},
	}
	// photo.jpg differs in case and size: should rename to prevent collision on case-insensitive remotes
	res := resolveUploadConflict(remoteFiles, "photo.jpg", 200)
	if res.TargetFileName != "photo (1).jpg" {
		t.Fatalf("expected TargetFileName 'photo (1).jpg', got '%s'", res.TargetFileName)
	}
	if res.ShouldSkip || !res.IsRenamed {
		t.Fatalf("unexpected res state: %+v", res)
	}
}

func TestResolveUploadConflict_IgnoreDirs(t *testing.T) {
	remoteFiles := []rclone.FileEntry{
		{Name: "folder", Size: 0, IsDir: true},
	}
	// Directory with same name should not conflict with incoming file
	res := resolveUploadConflict(remoteFiles, "folder", 500)
	if res.TargetFileName != "folder" {
		t.Fatalf("expected TargetFileName 'folder', got '%s'", res.TargetFileName)
	}
	if res.ShouldSkip || res.IsRenamed {
		t.Fatalf("unexpected res state: %+v", res)
	}
}

func TestResolveUploadConflict_UnknownSizeCannotDedupe(t *testing.T) {
	remoteFiles := []rclone.FileEntry{
		{Name: "video.mp4", Size: 1000, IsDir: false},
	}
	// Incoming size <= 0: cannot confirm duplicate, must safely rename
	res := resolveUploadConflict(remoteFiles, "video.mp4", 0)
	if res.TargetFileName != "video (1).mp4" {
		t.Fatalf("expected TargetFileName 'video (1).mp4', got '%s'", res.TargetFileName)
	}
	if res.ShouldSkip {
		t.Fatalf("expected ShouldSkip false for unknown size, got true")
	}
	if !res.IsRenamed {
		t.Fatalf("expected IsRenamed true, got false")
	}
}
