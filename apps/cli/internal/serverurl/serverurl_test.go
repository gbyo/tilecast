package serverurl

import "testing"

func TestNormalize(t *testing.T) {
	cases := []struct {
		raw  string
		want string
		fail bool
	}{
		{"https://example.com", "https://example.com", false},
		{"https://example.com/", "https://example.com", false},
		{"  https://example.com/base/  ", "https://example.com/base", false},
		{"example.com", "https://example.com", false},
		{"example.com:8443", "https://example.com:8443", false},
		{"http://127.0.0.1:8080/", "http://127.0.0.1:8080", false},
		{"http://localhost:8080", "http://localhost:8080", false},
		{"http://printer.local", "http://printer.local", false},
		{"http://192.168.1.10", "http://192.168.1.10", false},
		{"http://10.0.0.5:8080/path/", "http://10.0.0.5:8080/path", false},
		{"http://[fd00::1]:8080", "http://[fd00::1]:8080", false},
		{"http://example.com", "", true},
		{"http://93.184.216.34", "", true},
		{"ftp://example.com", "", true},
		{"", "", true},
		{"   ", "", true},
		{"https://", "", true},
	}
	for _, tc := range cases {
		got, err := Normalize(tc.raw)
		if tc.fail {
			if err == nil {
				t.Errorf("Normalize(%q) succeeded, want an error", tc.raw)
			}
			continue
		}
		if err != nil {
			t.Errorf("Normalize(%q): %v", tc.raw, err)
			continue
		}
		if got != tc.want {
			t.Errorf("Normalize(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}
