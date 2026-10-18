package telegram

import (
	"testing"
)

func TestParseLink(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantOK   bool
		wantLink ParsedLink
	}{
		{
			name:   "public channel https",
			input:  "https://t.me/durov/123",
			wantOK: true,
			wantLink: ParsedLink{
				ChannelUsername: "durov",
				MessageID:       123,
				IsPrivate:       false,
			},
		},
		{
			name:   "public channel http",
			input:  "http://t.me/durov/123",
			wantOK: true,
			wantLink: ParsedLink{
				ChannelUsername: "durov",
				MessageID:       123,
				IsPrivate:       false,
			},
		},
		{
			name:   "public channel schemeless",
			input:  "t.me/durov/123",
			wantOK: true,
			wantLink: ParsedLink{
				ChannelUsername: "durov",
				MessageID:       123,
				IsPrivate:       false,
			},
		},
		{
			name:   "public channel telegram.me",
			input:  "https://telegram.me/durov/123",
			wantOK: true,
			wantLink: ParsedLink{
				ChannelUsername: "durov",
				MessageID:       123,
				IsPrivate:       false,
			},
		},
		{
			name:   "public channel web preview /s/",
			input:  "https://t.me/s/durov/123",
			wantOK: true,
			wantLink: ParsedLink{
				ChannelUsername: "durov",
				MessageID:       123,
				IsPrivate:       false,
			},
		},
		{
			name:   "public channel with query",
			input:  "https://t.me/telegram_channel/456?single",
			wantOK: true,
			wantLink: ParsedLink{
				ChannelUsername: "telegram_channel",
				MessageID:       456,
				IsPrivate:       false,
			},
		},
		{
			name:   "public channel topic link",
			input:  "https://t.me/telegram_channel/10/456",
			wantOK: true,
			wantLink: ParsedLink{
				ChannelUsername: "telegram_channel",
				MessageID:       456,
				IsPrivate:       false,
			},
		},
		{
			name:   "public channel trailing slash",
			input:  "https://t.me/durov/123/",
			wantOK: true,
			wantLink: ParsedLink{
				ChannelUsername: "durov",
				MessageID:       123,
				IsPrivate:       false,
			},
		},
		{
			name:   "private channel https",
			input:  "https://t.me/c/1234567890/456",
			wantOK: true,
			wantLink: ParsedLink{
				ChannelID: 1234567890,
				MessageID: 456,
				IsPrivate: true,
			},
		},
		{
			name:   "private channel topic link",
			input:  "https://t.me/c/1234567890/10/456",
			wantOK: true,
			wantLink: ParsedLink{
				ChannelID: 1234567890,
				MessageID: 456,
				IsPrivate: true,
			},
		},
		{
			name:   "private channel with query",
			input:  "https://t.me/c/1234567890/456?single",
			wantOK: true,
			wantLink: ParsedLink{
				ChannelID: 1234567890,
				MessageID: 456,
				IsPrivate: true,
			},
		},
		{
			name:   "embedded in conversation text",
			input:  "Hi, please check this message: https://t.me/my_channel/789 thanks!",
			wantOK: true,
			wantLink: ParsedLink{
				ChannelUsername: "my_channel",
				MessageID:       789,
				IsPrivate:       false,
			},
		},
		{
			name:   "embedded private topic in conversation text",
			input:  "转存这个: https://t.me/c/1987654321/5/999 谢谢",
			wantOK: true,
			wantLink: ParsedLink{
				ChannelID: 1987654321,
				MessageID: 999,
				IsPrivate: true,
			},
		},
		{
			name:   "invalid link no msg id",
			input:  "https://t.me/durov",
			wantOK: false,
		},
		{
			name:   "invalid link empty",
			input:  "",
			wantOK: false,
		},
		{
			name:   "regular text without link",
			input:  "hello this is a regular chat message",
			wantOK: false,
		},
		{
			name:   "non-telegram link",
			input:  "https://example.com/c/123/456",
			wantOK: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := ParseLink(tt.input)
			if ok != tt.wantOK {
				t.Fatalf("ParseLink(%q) ok = %v, want %v", tt.input, ok, tt.wantOK)
			}
			if ok && got != tt.wantLink {
				t.Errorf("ParseLink(%q) = %+v, want %+v", tt.input, got, tt.wantLink)
			}
		})
	}
}

func TestParseChannelID(t *testing.T) {
	tests := []struct {
		chatID    int64
		wantID    int64
		isChannel bool
	}{
		{-1001234567890, 1234567890, true},
		{-1002000000000, 2000000000, true},
		{-12345678, 0, false},
		{7428626313, 0, false},
		{0, 0, false},
	}

	for _, tt := range tests {
		got, ok := ParseChannelID(tt.chatID)
		if ok != tt.isChannel {
			t.Errorf("ParseChannelID(%d) isChannel = %v, want %v", tt.chatID, ok, tt.isChannel)
		}
		if got != tt.wantID {
			t.Errorf("ParseChannelID(%d) id = %d, want %d", tt.chatID, got, tt.wantID)
		}
	}
}
