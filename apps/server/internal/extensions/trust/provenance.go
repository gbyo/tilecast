package trust

import (
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

var (
	// ErrAttestationInvalid answers a bundle that does not verify: a bad
	// signature, a digest the bundle does not cover, an identity outside
	// the expected repository, or a missing transparency log entry.
	ErrAttestationInvalid = errors.New("package attestation does not verify")
	// ErrTrustRootUnavailable answers verification without trust
	// material. The Sigstore production root comes over the network, so
	// an offline server fails closed here.
	ErrTrustRootUnavailable = errors.New("Sigstore trust root is unavailable")
)

// githubActionsIssuer is the OIDC issuer GitHub Actions workflows
// authenticate with. Author CI signs through it, so provenance binds to
// it.
const githubActionsIssuer = "https://token.actions.githubusercontent.com"

// AttestationVerifier checks Sigstore bundles against the Sigstore
// production trust root. A bundle verifies when its signature covers
// the artifact digest, its certificate chains to Fulcio, its
// transparency log entry checks out, and its workflow identity names
// the expected repository.
type AttestationVerifier struct {
	fetch func() (*root.TrustedRoot, error)
}

// AttestationOption configures an AttestationVerifier.
type AttestationOption func(*AttestationVerifier)

// WithTrustedRootFetcher substitutes trust-root retrieval. Production
// fetches the Sigstore production root over TUF; tests inject a static
// root so verification runs offline and deterministic.
func WithTrustedRootFetcher(fetch func() (*root.TrustedRoot, error)) AttestationOption {
	return func(v *AttestationVerifier) { v.fetch = fetch }
}

// NewAttestationVerifier verifies GitHub Actions provenance.
func NewAttestationVerifier(options ...AttestationOption) *AttestationVerifier {
	verifier := &AttestationVerifier{fetch: root.FetchTrustedRoot}
	for _, option := range options {
		option(verifier)
	}
	return verifier
}

// Verify checks that bundleJSON attests artifactDigest and was signed by
// a GitHub Actions workflow in owner/repo. The digest carries its
// algorithm as algo:hex. Success returns the signer identity: the
// certificate subject, which names the workflow and ref that signed.
func (v *AttestationVerifier) Verify(bundleJSON []byte, artifactDigest, owner, repo string) (string, error) {
	algorithm, encoded, found := strings.Cut(strings.TrimSpace(artifactDigest), ":")
	if !found || encoded == "" {
		return "", fmt.Errorf("%w: digest %q has no algorithm", ErrAttestationInvalid, artifactDigest)
	}
	digest, err := hex.DecodeString(encoded)
	if err != nil || len(digest) == 0 {
		return "", fmt.Errorf("%w: digest %q is not hex", ErrAttestationInvalid, artifactDigest)
	}
	if owner == "" || repo == "" {
		return "", fmt.Errorf("%w: expected repository must not be empty", ErrAttestationInvalid)
	}
	var entity bundle.Bundle
	// Cap the bundle before parsing: bundles are small JSON documents,
	// and anything larger is hostile.
	if len(bundleJSON) > 1<<20 {
		return "", fmt.Errorf("%w: bundle exceeds 1 MiB", ErrAttestationInvalid)
	}
	if err := entity.UnmarshalJSON(bundleJSON); err != nil {
		return "", fmt.Errorf("%w: bundle is not valid: %v", ErrAttestationInvalid, err)
	}
	trusted, err := v.fetch()
	if err != nil || trusted == nil {
		return "", fmt.Errorf("%w: %v", ErrTrustRootUnavailable, err)
	}
	verifier, err := verify.NewVerifier(trusted, verify.WithTransparencyLog(1), verify.WithObserverTimestamps(1))
	if err != nil {
		return "", fmt.Errorf("attestation verifier: %w", err)
	}
	identity, err := verify.NewShortCertificateIdentity(
		githubActionsIssuer, "",
		"", "^https://github\\.com/"+regexp.QuoteMeta(owner+"/"+repo)+"/",
	)
	if err != nil {
		return "", fmt.Errorf("attestation identity: %w", err)
	}
	policy := verify.NewPolicy(
		verify.WithArtifactDigest(algorithm, digest),
		verify.WithCertificateIdentity(identity),
	)
	result, err := verifier.Verify(&entity, policy)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrAttestationInvalid, err)
	}
	if result == nil || result.Signature == nil || result.Signature.Certificate == nil {
		return "", fmt.Errorf("%w: verification returned no signer", ErrAttestationInvalid)
	}
	signer := result.Signature.Certificate.SubjectAlternativeName
	if signer == "" {
		return "", fmt.Errorf("%w: signer has no identity", ErrAttestationInvalid)
	}
	return signer, nil
}
