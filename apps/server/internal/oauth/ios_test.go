package oauth

import (
	"context"
	"testing"
)

func TestIOSCallbackIsFixed(t *testing.T) {
	service := &Service{}
	for _, tc := range []struct {
		client, redirect string
		valid            bool
	}{
		{ClientIOS, IOSRedirectURI, true},
		{ClientIOS, "tilecast-ios://oauth/other", false},
		{ClientIOS, "http://127.0.0.1:8471/callback", false},
		{ClientCLI, IOSRedirectURI, false},
		{ClientCLI, "http://127.0.0.1:8471/callback", true},
	} {
		_, err := service.ValidateAuthorize(context.Background(), tc.client, tc.redirect, "read", "state", "challenge", "S256")
		if (err == nil) != tc.valid {
			t.Errorf("client %s redirect %s: error %v, want valid %t", tc.client, tc.redirect, err, tc.valid)
		}
	}
}
