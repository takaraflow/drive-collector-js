package secrets

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestInfisicalWithToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v3/secrets/raw" {
			auth := r.Header.Get("Authorization")
			if auth != "Bearer token-123" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(listSecretsResponse{
				Secrets: []infisicalSecretItem{
					{SecretKey: "DATABASE_URL", SecretValue: "postgres://..."},
					{SecretKey: "RCLONE_CONFIG", SecretValue: "[remote]\ntype=mega"},
				},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	provider := NewInfisicalProvider(InfisicalConfig{
		SiteURL:    server.URL,
		Token:      "token-123",
		ProjectID:  "proj-abc",
		EnvName:    "prod",
		HTTPClient: server.Client(),
	})

	secrets, err := provider.FetchSecrets(context.Background())
	if err != nil {
		t.Fatalf("FetchSecrets failed: %v", err)
	}

	if len(secrets) != 2 {
		t.Fatalf("expected 2 secrets, got %d", len(secrets))
	}
	if secrets["DATABASE_URL"] != "postgres://..." {
		t.Errorf("expected DATABASE_URL to match")
	}
	if secrets["RCLONE_CONFIG"] != "[remote]\ntype=mega" {
		t.Errorf("expected RCLONE_CONFIG to match")
	}
}

func TestInfisicalWithUniversalAuth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/auth/universal-auth/login" {
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["clientId"] == "client-1" && body["clientSecret"] == "secret-1" {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(universalAuthResponse{
					AccessToken: "exchanged-token-456",
					ExpiresIn:   7200,
				})
				return
			}
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		if r.URL.Path == "/api/v3/secrets/raw" {
			if r.Header.Get("Authorization") != "Bearer exchanged-token-456" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(listSecretsResponse{
				Secrets: []infisicalSecretItem{
					{SecretKey: "API_KEY", SecretValue: "val-999"},
				},
			})
			return
		}

		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	provider := NewInfisicalProvider(InfisicalConfig{
		SiteURL:      server.URL,
		ClientID:     "client-1",
		ClientSecret: "secret-1",
		ProjectID:    "proj-xyz",
		HTTPClient:   server.Client(),
	})

	secrets, err := provider.FetchSecrets(context.Background())
	if err != nil {
		t.Fatalf("FetchSecrets failed: %v", err)
	}
	if secrets["API_KEY"] != "val-999" {
		t.Errorf("expected API_KEY=val-999, got %q", secrets["API_KEY"])
	}
}
