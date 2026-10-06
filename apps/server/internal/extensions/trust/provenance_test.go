package trust

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/sigstore/sigstore-go/pkg/root"
)

// The testdata fixtures are recorded Sigstore material: a real npm
// provenance bundle and the production trusted root, copied from
// sigstore-go's test data (Apache-2.0). Verification anchors to the
// transparency log's integrated time, so the fixtures verify offline and
// do not rot.
const (
	provenanceBundle = "sigstore.js@2.0.0-provenance.sigstore.json"
	provenanceRoot   = "public-good.json"
	// The npm tarball digest the recorded bundle covers.
	provenanceDigest = "sha512:46d4e2f74c4877316640000a6fdf8a8b59f1e0847667973e9859f774dd31b8f1e0937813b777fb66a2ac67d50540fe34640966eee9fc2ccca387082b4c85cd3c"
	provenanceSigner = "https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main"
)

func provenanceVerifier(t *testing.T) (*AttestationVerifier, []byte) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", provenanceBundle))
	if err != nil {
		t.Fatal(err)
	}
	rootJSON, err := os.ReadFile(filepath.Join("testdata", provenanceRoot))
	if err != nil {
		t.Fatal(err)
	}
	trusted, err := root.NewTrustedRootFromJSON(rootJSON)
	if err != nil {
		t.Fatal(err)
	}
	return NewAttestationVerifier(WithTrustedRootFetcher(func() (*root.TrustedRoot, error) {
		return trusted, nil
	})), raw
}

func TestAttestationVerifies(t *testing.T) {
	verifier, raw := provenanceVerifier(t)
	signer, err := verifier.Verify(raw, provenanceDigest, "sigstore", "sigstore-js")
	if err != nil {
		t.Fatal(err)
	}
	if signer != provenanceSigner {
		t.Fatalf("signer = %s, want %s", signer, provenanceSigner)
	}
}

func TestAttestationRejects(t *testing.T) {
	verifier, raw := provenanceVerifier(t)
	for name, mutate := range map[string]func() ([]byte, string, string, string){
		"wrong repository": func() ([]byte, string, string, string) {
			return raw, provenanceDigest, "sigstore", "other-repo"
		},
		"wrong owner": func() ([]byte, string, string, string) {
			return raw, provenanceDigest, "other-owner", "sigstore-js"
		},
		"wrong digest": func() ([]byte, string, string, string) {
			return raw, "sha512:" + provenanceDigest[len("sha512:")+1:] + "00", "sigstore", "sigstore-js"
		},
		"wrong algorithm": func() ([]byte, string, string, string) {
			return raw, "sha256:46d4e2f74c4877316640000a6fdf8a8b59f1e0847667973e9859f774", "sigstore", "sigstore-js"
		},
		"corrupt bundle": func() ([]byte, string, string, string) {
			return []byte(`{"not":"a bundle"}`), provenanceDigest, "sigstore", "sigstore-js"
		},
		"tampered bundle": func() ([]byte, string, string, string) {
			tampered := append([]byte(nil), raw...)
			tampered[len(tampered)-20] ^= 0xff
			return tampered, provenanceDigest, "sigstore", "sigstore-js"
		},
	} {
		t.Run(name, func(t *testing.T) {
			bundleJSON, digest, owner, repo := mutate()
			if _, err := verifier.Verify(bundleJSON, digest, owner, repo); !errors.Is(err, ErrAttestationInvalid) {
				t.Fatalf("err = %v, want ErrAttestationInvalid", err)
			}
		})
	}
}

func TestAttestationInputValidation(t *testing.T) {
	verifier, raw := provenanceVerifier(t)
	for name, parts := range map[string][3]string{
		"no algorithm":     {provenanceDigest[len("sha512:"):], "sigstore", "sigstore-js"},
		"not hex":          {"sha512:zzzz", "sigstore", "sigstore-js"},
		"empty repository": {provenanceDigest, "", ""},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := verifier.Verify(raw, parts[0], parts[1], parts[2]); !errors.Is(err, ErrAttestationInvalid) {
				t.Fatalf("err = %v, want ErrAttestationInvalid", err)
			}
		})
	}
	if _, err := verifier.Verify(make([]byte, (1<<20)+1), provenanceDigest, "sigstore", "sigstore-js"); !errors.Is(err, ErrAttestationInvalid) {
		t.Fatalf("oversize err = %v, want ErrAttestationInvalid", err)
	}
}

func TestAttestationWithoutTrustRoot(t *testing.T) {
	_, raw := provenanceVerifier(t)
	offline := NewAttestationVerifier(WithTrustedRootFetcher(func() (*root.TrustedRoot, error) {
		return nil, errors.New("network is down")
	}))
	if _, err := offline.Verify(raw, provenanceDigest, "sigstore", "sigstore-js"); !errors.Is(err, ErrTrustRootUnavailable) {
		t.Fatalf("err = %v, want ErrTrustRootUnavailable", err)
	}
}
