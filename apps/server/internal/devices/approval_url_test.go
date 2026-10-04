package devices

import (
	"strings"
	"testing"
)

func TestApprovalURLForPairing(t *testing.T) {
	url := approvalURLForPairing("https://signage.example.org", "K7Q2XD", "8c7d4a52-6a1e-4c1a-9f2b-2f6f0e6d7a10")
	want := "https://signage.example.org/screens/pair/K7Q2XD?installation=8c7d4a52-6a1e-4c1a-9f2b-2f6f0e6d7a10"
	if url != want {
		t.Fatalf("approval URL=%q want %q", url, want)
	}
}

func TestApprovalURLForPairingTrimsPublicURLSlash(t *testing.T) {
	url := approvalURLForPairing("https://signage.example.org/", "K7Q2XD", "8c7d4a52-6a1e-4c1a-9f2b-2f6f0e6d7a10")
	if !strings.HasPrefix(url, "https://signage.example.org/screens/pair/K7Q2XD?installation=") {
		t.Fatalf("approval URL did not honor the public URL: %q", url)
	}
	if strings.Contains(url, ".org//screens") {
		t.Fatalf("approval URL has a doubled slash: %q", url)
	}
}
