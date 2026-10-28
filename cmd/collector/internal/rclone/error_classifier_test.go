package rclone

import (
	"testing"
)

func TestClassifyError(t *testing.T) {
	tests := []struct {
		name          string
		errorText     string
		opt           *ClassifyOptions
		wantCode      ErrorCode
		wantRetryable bool
		wantUserRetry bool
	}{
		{
			name:          "Empty error",
			errorText:     "",
			wantCode:      CodeUnknown,
			wantRetryable: false,
			wantUserRetry: true,
		},
		{
			name:          "Quota Exceeded",
			errorText:     "Failed to copy: quota exceeded on remote target",
			wantCode:      CodeDriveQuotaExceeded,
			wantRetryable: false,
			wantUserRetry: true,
		},
		{
			name:          "Auth Invalid - Login Failed",
			errorText:     "Failed to create file system: couldn't login: invalid password",
			wantCode:      CodeDriveAuthInvalid,
			wantRetryable: false,
			wantUserRetry: false,
		},
		{
			name:          "Permission Denied - 403",
			errorText:     "HTTP 403 Forbidden: access denied",
			wantCode:      CodeDrivePermissionDenied,
			wantRetryable: false,
			wantUserRetry: false,
		},
		{
			name:          "Transient Timeout",
			errorText:     "rclone copy timed out after 60s",
			wantCode:      CodeRcloneTransient,
			wantRetryable: true,
			wantUserRetry: true,
		},
		{
			name:          "Remote Not Found",
			errorText:     "directory not found: /non-existent/folder",
			wantCode:      CodeDriveRemoteNotFound,
			wantRetryable: false,
			wantUserRetry: true,
		},
		{
			name:          "Mega Object Not Found (Scoped Remote Path)",
			errorText:     ":mega,user=a,pass=b:remote_path couldn't login: Object (typically, node or user) not found",
			wantCode:      CodeDriveRemoteNotFound,
			wantRetryable: false,
			wantUserRetry: true,
		},
		{
			name:          "Mega Object Not Found (Auth root)",
			errorText:     ":mega: couldn't login: Object (typically, node or user) not found",
			wantCode:      CodeDriveAuthInvalid,
			wantRetryable: false,
			wantUserRetry: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var res Classification
			if tt.opt != nil {
				res = ClassifyError(tt.errorText, *tt.opt)
			} else {
				res = ClassifyError(tt.errorText)
			}
			if res.Code != tt.wantCode {
				t.Errorf("Code = %v, want %v", res.Code, tt.wantCode)
			}
			if res.Retryable != tt.wantRetryable {
				t.Errorf("Retryable = %v, want %v", res.Retryable, tt.wantRetryable)
			}
			if res.UserRetryable != tt.wantUserRetry {
				t.Errorf("UserRetryable = %v, want %v", res.UserRetryable, tt.wantUserRetry)
			}
			if tt.wantCode != CodeUnknown && res.UserMessage == "" {
				t.Errorf("Expected UserMessage for code %v, got empty", tt.wantCode)
			}
		})
	}
}

func TestIsProtonRefreshTokenDead(t *testing.T) {
	if !IsProtonRefreshTokenDead("refresh token failed: Code=10013") {
		t.Errorf("Expected Code=10013 to be identified as dead token")
	}
	if !IsProtonRefreshTokenDead("error: invalid refresh token received") {
		t.Errorf("Expected invalid refresh token to be identified as dead token")
	}
	if IsProtonRefreshTokenDead("requires a 2FA code") {
		t.Errorf("2FA code prompt should not be identified as dead token")
	}
}
