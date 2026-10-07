// Package ghrepo parses public GitHub repository addresses. The
// marketplace catalog and the package installer share this parser so
// catalog CI and installation accept exactly the same URL forms: a
// listing the catalog accepts always resolves at install time, and an
// address the installer rejects never enters the catalog.
package ghrepo

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// ErrRepositoryURL answers input that is not a public GitHub repository
// address.
var ErrRepositoryURL = errors.New("not a GitHub repository URL")

// Repository is the address every other call resolves within. Owner and
// Name are lowercase: GitHub treats them case-insensitively, and one
// canonical identity keeps the same repository from registering twice.
type Repository struct {
	Owner string
	Name  string
}

// URL reports the canonical public address of the repository.
func (r Repository) URL() string {
	return "https://github.com/" + r.Owner + "/" + r.Name
}

// ParseRepositoryURL accepts a public GitHub repository address in the
// shapes operators paste: with or without a trailing slash or a .git
// suffix. The path must be exactly owner and name: deeper paths such as
// issue or tree pages answer ErrRepositoryURL, as do credentials, plain
// HTTP, and any host but github.com. No request is made.
func ParseRepositoryURL(raw string) (Repository, error) {
	trimmed := strings.TrimSpace(raw)
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return Repository{}, fmt.Errorf("%w: %q", ErrRepositoryURL, raw)
	}
	if parsed.Scheme != "https" || !strings.EqualFold(parsed.Hostname(), "github.com") || parsed.User != nil {
		return Repository{}, fmt.Errorf("%w: %q", ErrRepositoryURL, raw)
	}
	path := strings.TrimSuffix(strings.Trim(parsed.Path, "/"), ".git")
	segments := strings.Split(path, "/")
	if len(segments) != 2 || segments[0] == "" || segments[1] == "" {
		return Repository{}, fmt.Errorf("%w: %q", ErrRepositoryURL, raw)
	}
	owner, name := strings.ToLower(segments[0]), strings.ToLower(segments[1])
	if !validOwner(owner) || !validName(name) {
		return Repository{}, fmt.Errorf("%w: %q", ErrRepositoryURL, raw)
	}
	return Repository{Owner: owner, Name: name}, nil
}

func validOwner(value string) bool {
	if len(value) < 1 || len(value) > 39 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' {
			continue
		}
		return false
	}
	return value[0] != '-' && value[len(value)-1] != '-'
}

func validName(value string) bool {
	if len(value) < 1 || len(value) > 100 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '-' || c == '_' {
			continue
		}
		return false
	}
	return true
}
