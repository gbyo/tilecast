package updates

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestDiscoverUnifiedReleaseFindsEveryFamily(t *testing.T) {
	f := newReleaseFixture(t)
	f.unified("0.26.0-beta.1")
	release := f.release(900, "v0.26.0-beta.1", true)

	candidates, problems := DiscoverRelease(context.Background(), f.provider(release), f.public, release)
	if len(problems) != 0 {
		t.Fatalf("unexpected problems: %v", problems)
	}
	found := map[string]Manifest{}
	for _, candidate := range candidates {
		found[candidate.Manifest.NormalizedFamily()+"/"+candidate.Manifest.Architecture()] = candidate.Manifest
		if err := CheckCandidate(release, candidate, 10<<20); err != nil {
			t.Errorf("%s: %v", candidate.Manifest.NormalizedFamily(), err)
		}
	}
	for _, key := range []string{"android/", "edge/x86_64", "edge/aarch64", "windows/x86_64", "windows/aarch64"} {
		manifest, ok := found[key]
		if !ok {
			t.Fatalf("%s was not discovered; found %d of 5", key, len(found))
		}
		if manifest.VersionName != "0.26.0-beta.1" || manifest.VersionCode != 2600001 || manifest.Channel != "beta" {
			t.Errorf("%s identity: %+v", key, manifest)
		}
	}
	if len(candidates) != 5 {
		t.Fatalf("found %d candidates, want 5", len(candidates))
	}
}

// A family that cannot be verified is reported, and never hides the families
// of the same release that can.
func TestDiscoverReleaseReportsEachBadFamilyAndKeepsTheRest(t *testing.T) {
	f := newReleaseFixture(t)
	f.unified("0.26.0")
	release := f.release(901, "v0.26.0", false)
	f.corruptSignature(release, windowsGitHubManifestHead+"aarch64.json")
	f.drop(&release, EdgeArtifactName("0.26.0", "x86_64"))

	candidates, problems := DiscoverRelease(context.Background(), f.provider(release), f.public, release)
	if len(candidates) != 3 {
		t.Fatalf("found %d candidates, want android, edge aarch64, and windows x86_64: %v", len(candidates), problems)
	}
	if len(problems) != 2 {
		t.Fatalf("problems = %v, want the Edge archive and the Windows signature", problems)
	}
	joined := problems[0].Error() + " | " + problems[1].Error()
	for _, want := range []string{"edge x86_64", "windows aarch64", "signature"} {
		if !strings.Contains(joined, want) {
			t.Errorf("problems %q do not mention %q", joined, want)
		}
	}
}

func TestDiscoverReleaseIgnoresReleasesWithoutPlayerAssets(t *testing.T) {
	assets := []Asset{{Name: "SHA256SUMS", URL: "a"}, {Name: "wpe-2.54.0-x86_64.tar", URL: "b"}, {Name: "tilecast-release.json", URL: "c"}}
	f := newReleaseFixture(t)
	release := ProviderRelease{ID: 5, Tag: "wpe-2.54.0-7560c6d0974d040b-x86_64", Assets: assets}
	candidates, problems := DiscoverRelease(context.Background(), f.provider(release), f.public, release)
	if len(candidates) != 0 || len(problems) != 0 {
		t.Fatalf("a non-player release produced %d candidates and %v", len(candidates), problems)
	}
	if specs := releaseSpecs(assets); len(specs) != 0 {
		t.Fatalf("a non-player release has player specs: %v", specs)
	}
}

func TestDiscoverReleaseKeepsHistoricalStandaloneLayouts(t *testing.T) {
	f := newReleaseFixture(t)
	f.android("0.25.0", 46, "stable")
	android := f.release(10, "player-v0.25.0", false)
	f.linux("0.17.0", 17000)
	linux := f.release(11, "player-linux-v0.17.0", false)
	f.edge("0.2.1-preview.1", "beta", "x86_64")
	f.edge("0.2.1-preview.1", "beta", "aarch64")
	edge := f.release(12, "edge-v0.2.1-preview.1", true)

	for release, want := range map[string][]string{"player-v0.25.0": {"android/"}, "player-linux-v0.17.0": {"electron-linux/"}, "edge-v0.2.1-preview.1": {"edge/aarch64", "edge/x86_64"}} {
		var source ProviderRelease
		for _, candidate := range []ProviderRelease{android, linux, edge} {
			if candidate.Tag == release {
				source = candidate
			}
		}
		candidates, problems := DiscoverRelease(context.Background(), f.provider(source), f.public, source)
		if len(problems) != 0 || len(candidates) != len(want) {
			t.Fatalf("%s: %d candidates, problems %v", release, len(candidates), problems)
		}
		for index, candidate := range candidates {
			if key := candidate.Manifest.NormalizedFamily() + "/" + candidate.Manifest.Architecture(); key != want[index] {
				t.Errorf("%s: candidate %d is %s, want %s", release, index, key, want[index])
			}
		}
	}
}

func TestCheckCandidateMapsPrereleaseToBetaAndStableToStable(t *testing.T) {
	f := newReleaseFixture(t)
	f.unified("0.26.0-beta.1")
	beta := f.release(1, "v0.26.0-beta.1", true)
	f.unified("0.26.0")
	stable := f.release(2, "v0.26.0", false)
	for _, test := range []struct {
		release    ProviderRelease
		prerelease bool
		wantErr    bool
	}{
		{beta, true, false},
		{stable, false, false},
		// The release kind and the signed channel must agree.
		{beta, false, true},
		{stable, true, true},
	} {
		release := test.release
		release.Prerelease = test.prerelease
		candidates, problems := DiscoverRelease(context.Background(), f.provider(release), f.public, release)
		if len(problems) != 0 {
			t.Fatal(problems)
		}
		for _, candidate := range candidates {
			if err := CheckCandidate(release, candidate, 10<<20); (err != nil) != test.wantErr {
				t.Errorf("%s prerelease=%v: err=%v, wantErr=%v", release.Tag, test.prerelease, err, test.wantErr)
			}
		}
	}
}

func TestAndroidManifestFollowsTheUnifiedOrdering(t *testing.T) {
	f := newReleaseFixture(t)
	for _, test := range []struct {
		name    string
		version string
		code    int64
		channel string
		wantErr bool
	}{
		{"legacy release keeps its own code", "0.25.0", 46, "stable", false},
		{"first Beta", "0.26.0-beta.1", 2600001, "beta", false},
		{"Stable after Beta", "0.26.0", 2600099, "stable", false},
		{"a Beta must not claim its Stable's code", "0.26.0-beta.1", 2600099, "beta", true},
		{"the old ordering is refused after the cutover", "0.26.0", 47, "stable", true},
		{"a Beta name cannot ship as Stable", "0.26.0-beta.1", 2600001, "stable", true},
		{"a Stable name cannot ship as Beta", "0.26.0", 2600099, "beta", true},
		{"unknown prerelease label", "0.26.0-rc.1", 2600001, "beta", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			f.reset()
			f.android(test.version, test.code, test.channel)
			release := f.release(7, "tag", test.channel == "beta")
			candidates, problems := DiscoverRelease(context.Background(), f.provider(release), f.public, release)
			if test.wantErr && (len(problems) != 1 || len(candidates) != 0) {
				t.Fatalf("accepted: candidates=%d problems=%v", len(candidates), problems)
			}
			if !test.wantErr && (len(problems) != 0 || len(candidates) != 1) {
				t.Fatalf("rejected: %v", problems)
			}
		})
	}
}

func TestEnvelopeChannelMustMatchTheVersionName(t *testing.T) {
	f := newReleaseFixture(t)
	for _, test := range []struct {
		version, channel string
		wantErr          bool
	}{
		{"0.26.0-beta.2", "beta", false},
		{"0.26.0", "stable", false},
		{"0.26.0-beta.2", "stable", true},
		{"0.26.0", "beta", true},
		// A preview shipped before the cutover has no implied channel.
		{"0.2.1-preview.1", "beta", false},
	} {
		f.reset()
		f.edge(test.version, test.channel, "x86_64")
		release := f.release(1, "tag", false)
		_, problems := DiscoverRelease(context.Background(), f.provider(release), f.public, release)
		if (len(problems) != 0) != test.wantErr {
			t.Errorf("edge %s on %s: problems=%v wantErr=%v", test.version, test.channel, problems, test.wantErr)
		}
	}
}

func TestReleaseRecordIDsAreDistinctPerFamilyAndArchitecture(t *testing.T) {
	seen := map[string]string{}
	for _, key := range [][2]string{{FamilyAndroid, ""}, {FamilyElectronLinux, ""}, {FamilyEdge, "x86_64"}, {FamilyEdge, "aarch64"}, {FamilyWindows, "x86_64"}, {FamilyWindows, "aarch64"}} {
		id := recordID(900, key[0], key[1]).String()
		if previous, ok := seen[id]; ok {
			t.Fatalf("%v collides with %s", key, previous)
		}
		seen[id] = key[0] + "/" + key[1]
	}
	first, again := recordID(900, FamilyEdge, "x86_64"), recordID(900, FamilyEdge, "x86_64")
	if first != again || first == recordID(901, FamilyEdge, "x86_64") {
		t.Fatal("record ids must be deterministic and distinct across releases")
	}
	// Android keeps the id it had before the unified release.
	if got, want := recordID(900, FamilyAndroid, ""), uuid.NewSHA1(uuid.NameSpaceURL, []byte("github:900")); got != want {
		t.Fatalf("android id = %s, want the pre-unified id %s", got, want)
	}
}

func TestGitHubProviderPagesThroughALargeReleaseHistory(t *testing.T) {
	release := func(page, index int, drafted bool) ProviderRelease {
		return ProviderRelease{ID: int64(page*1000 + index), Tag: "release", Draft: drafted}
	}
	var requests []string
	var conditional []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.RawQuery)
		conditional = append(conditional, r.Header.Get("If-None-Match"))
		if r.URL.Query().Get("per_page") != "100" {
			t.Errorf("per_page = %q", r.URL.Query().Get("per_page"))
		}
		w.Header().Set("ETag", `"first"`)
		var page []ProviderRelease
		switch r.URL.Query().Get("page") {
		case "1", "2":
			n := 1
			if r.URL.Query().Get("page") == "2" {
				n = 2
			}
			for i := 0; i < 100; i++ {
				page = append(page, release(n, i, i == 0))
			}
		case "3":
			page = append(page, release(3, 1, false), release(3, 2, false))
		default:
			t.Errorf("unexpected page %q", r.URL.Query().Get("page"))
		}
		_ = json.NewEncoder(w).Encode(page)
	}))
	defer server.Close()
	provider := NewGitHubProvider("")
	provider.client = server.Client()
	provider.apiBase = server.URL

	result, err := provider.Releases(t.Context(), `"previous"`)
	if err != nil {
		t.Fatal(err)
	}
	// Two full pages and a short one, drafts removed from the full pages.
	if len(requests) != 3 || len(result.Releases) != 99+99+2 {
		t.Fatalf("requests=%v releases=%d", requests, len(result.Releases))
	}
	if conditional[0] != `"previous"` || conditional[1] != "" || conditional[2] != "" {
		t.Fatalf("only the first page may be conditional: %v", conditional)
	}
	if result.ETag != `"first"` {
		t.Fatalf("etag = %q", result.ETag)
	}
}

func TestGitHubProviderStopsAtTheReleasePageLimit(t *testing.T) {
	pages := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		pages++
		page := make([]ProviderRelease, 100)
		for i := range page {
			page[i] = ProviderRelease{ID: int64(pages*1000 + i), Tag: "release"}
		}
		_ = json.NewEncoder(w).Encode(page)
	}))
	defer server.Close()
	provider := NewGitHubProvider("")
	provider.client = server.Client()
	provider.apiBase = server.URL
	if _, err := provider.Releases(t.Context(), ""); err != nil {
		t.Fatal(err)
	}
	if pages != maxReleasePages {
		t.Fatalf("requested %d pages, want the %d page limit", pages, maxReleasePages)
	}
}

func TestGitHubProviderTreatsANotModifiedFirstPageAsNoChange(t *testing.T) {
	pages := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		pages++
		w.WriteHeader(http.StatusNotModified)
	}))
	defer server.Close()
	provider := NewGitHubProvider("")
	provider.client = server.Client()
	provider.apiBase = server.URL
	result, err := provider.Releases(t.Context(), `"etag"`)
	if err != nil || !result.NotModified || pages != 1 {
		t.Fatalf("result=%+v err=%v pages=%d", result, err, pages)
	}
}
