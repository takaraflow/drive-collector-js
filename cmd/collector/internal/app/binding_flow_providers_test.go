package app

import (
	"context"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/youngsx/drive-collector/cmd/collector/internal/bindingsession"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
)

func TestIsSensitiveStep(t *testing.T) {
	sensitive := []string{"WAIT_PASS", "WAIT_PASSWORD", "WAIT_2FA", "WAIT_SK", "WAIT_TOKEN"}
	for _, step := range sensitive {
		if !isSensitiveStep(step) {
			t.Errorf("isSensitiveStep(%q) should be true", step)
		}
	}

	nonSensitive := []string{"WAIT_EMAIL", "WAIT_USER", "WAIT_ENDPOINT", "WAIT_BUCKET", "UNKNOWN"}
	for _, step := range nonSensitive {
		if isSensitiveStep(step) {
			t.Errorf("isSensitiveStep(%q) should be false", step)
		}
	}
}

func TestBindStart_NewProviders(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	defer mr.Close()

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	cases := []struct {
		driveType drive.Type
		wantText  string
	}{
		{drive.TypePCloud, "pCloud 账号邮箱"},
	}

	for _, tc := range cases {
		t.Run(string(tc.driveType), func(t *testing.T) {
			tg := &mockFolderTG{}
			app := &App{
				tg:           tg,
				bindSessions: bindingsession.NewStore(rdb),
			}

			err := app.bindStart(context.Background(), 100, "user_1", string(tc.driveType))
			if err != nil {
				t.Fatalf("bindStart failed: %v", err)
			}

			if len(tg.sentTexts) != 1 {
				t.Fatalf("expected 1 prompt, got %d", len(tg.sentTexts))
			}
			if !strings.Contains(tg.sentTexts[0], tc.wantText) {
				t.Errorf("prompt missing %q, got: %s", tc.wantText, tg.sentTexts[0])
			}

			sess, err := app.bindSessions.Get(context.Background(), "user_1")
			if err != nil {
				t.Fatalf("get session failed: %v", err)
			}
			if sess == nil {
				t.Fatal("session is nil")
			}
			expectedPrefix := strings.ToUpper(string(tc.driveType)) + ":"
			if !strings.HasPrefix(sess.CurrentStep, expectedPrefix) {
				t.Errorf("expected session step prefix %s, got %s", expectedPrefix, sess.CurrentStep)
			}
		})
	}
}
