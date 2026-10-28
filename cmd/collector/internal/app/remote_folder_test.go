package app

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

type mockFolderTG struct {
	sentTexts []string
}

func (m *mockFolderTG) Run(ctx context.Context) error                          { return nil }
func (m *mockFolderTG) SelfID() int64                                         { return 12345 }
func (m *mockFolderTG) SendMessage(ctx context.Context, chatID int64, text string) error {
	m.sentTexts = append(m.sentTexts, text)
	return nil
}
func (m *mockFolderTG) SendMessageWithID(ctx context.Context, chatID int64, text string) (int, error) {
	m.sentTexts = append(m.sentTexts, text)
	return len(m.sentTexts), nil
}
func (m *mockFolderTG) SendWithButtons(ctx context.Context, chatID int64, text string, buttons [][]tgclient.Button) error {
	m.sentTexts = append(m.sentTexts, text)
	return nil
}
func (m *mockFolderTG) SendWithButtonsAndID(ctx context.Context, chatID int64, text string, buttons [][]tgclient.Button) (int, error) {
	m.sentTexts = append(m.sentTexts, text)
	return len(m.sentTexts), nil
}
func (m *mockFolderTG) EditMessage(ctx context.Context, chatID int64, msgID int, text string) error {
	return nil
}
func (m *mockFolderTG) EditWithButtons(ctx context.Context, chatID int64, msgID int, text string, buttons [][]tgclient.Button) error {
	return nil
}
func (m *mockFolderTG) AnswerCallback(ctx context.Context, callbackID int64, text string, alert bool) error {
	return nil
}
func (m *mockFolderTG) DeleteMessages(ctx context.Context, chatID int64, ids []int64) error {
	return nil
}
func (m *mockFolderTG) WaitReady(ctx context.Context) error {
	return nil
}
func (m *mockFolderTG) RegisterBotCommands(ctx context.Context, ownerID int64) error {
	return nil
}

func TestHandleRemoteFolderCommand_NoArgs(t *testing.T) {
	t.Run("shows default when no custom folder set", func(t *testing.T) {
		tg := &mockFolderTG{}
		drives := &fakeDrives{drive: &drive.Drive{
			ID:           "d1",
			RemoteFolder: sql.NullString{Valid: false},
		}}
		app := &App{
			tg:     tg,
			drives: drives,
			cfg:    Config{RemoteBase: "/my_base"},
		}

		err := app.handleRemoteFolderCommand(context.Background(), messageInfo{
			ChatID:   100,
			SenderID: 200,
			Text:     "/remote_folder",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		if len(tg.sentTexts) != 1 {
			t.Fatalf("expected 1 message, got %d", len(tg.sentTexts))
		}
		got := tg.sentTexts[0]
		if !strings.Contains(got, "当前上传目录：<code>/my_base (默认)</code>") {
			t.Errorf("expected default folder display, got: %s", got)
		}
		if !strings.Contains(got, "保存目录设置") {
			t.Errorf("expected menu title, got: %s", got)
		}
	})

	t.Run("shows custom folder when set", func(t *testing.T) {
		tg := &mockFolderTG{}
		drives := &fakeDrives{drive: &drive.Drive{
			ID:           "d1",
			RemoteFolder: sql.NullString{String: "/custom/path", Valid: true},
		}}
		app := &App{
			tg:     tg,
			drives: drives,
		}

		err := app.handleRemoteFolderCommand(context.Background(), messageInfo{
			ChatID:   100,
			SenderID: 200,
			Text:     "/remote_folder",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		if len(tg.sentTexts) != 1 {
			t.Fatalf("expected 1 message, got %d", len(tg.sentTexts))
		}
		got := tg.sentTexts[0]
		if !strings.Contains(got, "当前上传目录：<code>/custom/path (自定义)</code>") {
			t.Errorf("expected custom folder display, got: %s", got)
		}
	})
}
