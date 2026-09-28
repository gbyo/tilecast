package discovery

import "testing"

func TestAdvertisedPort(t *testing.T) {
	tests := []struct {
		name      string
		publicURL string
		want      int
		wantErr   bool
	}{
		{name: "http default", publicURL: "http://tilecast.local", want: 80},
		{name: "https default", publicURL: "https://signage.example.org", want: 443},
		{name: "http explicit", publicURL: "http://tilecast.local:8080", want: 8080},
		{name: "https explicit", publicURL: "https://signage.example.org:8443", want: 8443},
		{name: "unsupported scheme", publicURL: "ftp://signage.example.org", wantErr: true},
		{name: "missing host", publicURL: "https:///tilecast", wantErr: true},
		{name: "zero port", publicURL: "http://tilecast.local:0", wantErr: true},
		{name: "overflow port", publicURL: "http://tilecast.local:65536", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := advertisedPort(tt.publicURL)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("advertisedPort(%q) returned %d; expected an error", tt.publicURL, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("advertisedPort(%q): %v", tt.publicURL, err)
			}
			if got != tt.want {
				t.Fatalf("advertisedPort(%q) = %d; want %d", tt.publicURL, got, tt.want)
			}
		})
	}
}
