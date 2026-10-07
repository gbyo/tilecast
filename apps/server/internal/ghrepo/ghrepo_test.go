package ghrepo

import (
	"errors"
	"strings"
	"testing"
)

func TestParseRepositoryURL(t *testing.T) {
	for raw, want := range map[string]Repository{
		"https://github.com/example/tilecast-scoreboard":      {Owner: "example", Name: "tilecast-scoreboard"},
		"https://github.com/example/tilecast-scoreboard/":     {Owner: "example", Name: "tilecast-scoreboard"},
		"https://github.com/example/tilecast-scoreboard.git":  {Owner: "example", Name: "tilecast-scoreboard"},
		"https://github.com/example/tilecast-scoreboard.git/": {Owner: "example", Name: "tilecast-scoreboard"},
		"https://github.com/Example/Tilecast-Scoreboard":      {Owner: "example", Name: "tilecast-scoreboard"},
		"  https://github.com/example/tilecast-scoreboard  ":  {Owner: "example", Name: "tilecast-scoreboard"},
		"https://github.com/example/name.with_dots-and_9":     {Owner: "example", Name: "name.with_dots-and_9"},
		"https://github.com/example/tilecast-scoreboard//":    {Owner: "example", Name: "tilecast-scoreboard"},
	} {
		repo, err := ParseRepositoryURL(raw)
		if err != nil {
			t.Fatalf("%q: %v", raw, err)
		}
		if repo != want {
			t.Fatalf("%q: repo = %+v, want %+v", raw, repo, want)
		}
	}
	repo, err := ParseRepositoryURL("https://github.com/Example/Tilecast-Scoreboard")
	if err != nil {
		t.Fatal(err)
	}
	if repo.URL() != "https://github.com/example/tilecast-scoreboard" {
		t.Fatalf("URL = %s", repo.URL())
	}
}

func TestParseRepositoryURLRejects(t *testing.T) {
	for _, raw := range []string{
		"",
		"not a url",
		// Scheme and credentials.
		"http://github.com/example/tilecast-scoreboard",
		"git://github.com/example/tilecast-scoreboard",
		"https://user:pass@github.com/example/tilecast-scoreboard",
		"https://user@github.com/example/tilecast-scoreboard",
		// Hosts.
		"https://gitlab.com/example/tilecast-scoreboard",
		"https://gist.github.com/example/tilecast-scoreboard",
		"https://www.github.com/example/tilecast-scoreboard",
		"https://github.com.evil.example/example/tilecast-scoreboard",
		// Paths that are not the repository itself.
		"https://github.com/example",
		"https://github.com/",
		"https://github.com/example/tilecast-scoreboard/issues",
		"https://github.com/example/tilecast-scoreboard/issues/12",
		"https://github.com/example/tilecast-scoreboard/tree/main/docs",
		// Identities GitHub does not allow.
		"https://github.com/-/tilecast-scoreboard",
		"https://github.com/-example/tilecast-scoreboard",
		"https://github.com/example-/tilecast-scoreboard",
		"https://github.com/" + strings.Repeat("o", 40) + "/tilecast-scoreboard",
		"https://github.com/example/" + strings.Repeat("n", 101),
		"https://github.com/exa$mple/tilecast-scoreboard",
		"https://github.com/example/white space",
	} {
		if _, err := ParseRepositoryURL(raw); !errors.Is(err, ErrRepositoryURL) {
			t.Fatalf("%q: err = %v, want ErrRepositoryURL", raw, err)
		}
	}
}
