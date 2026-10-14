package packages

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

// ReadVerifiedContentFile reads executable bytes from the authenticated OCI
// layer itself. A changed extracted cache can never become signed code after
// a catalog rebuild. The same open stream supplies both bytes and digest.
func ReadVerifiedContentFile(ctx context.Context, layout string, verified VerifiedPackage, name string, max int64) ([]byte, error) {
	if max < 1 || max > MaxExtractedFileBytes {
		return nil, fmt.Errorf("package file byte bound is invalid")
	}
	wanted, err := cleanEntry("/tilecast-content", name)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	files := 0
	var total int64
	var selected []byte
	for _, digest := range verified.ContentDigests {
		encoded := strings.TrimPrefix(digest, "sha256:")
		decoded, err := hex.DecodeString(encoded)
		if !strings.HasPrefix(digest, "sha256:") || err != nil || len(decoded) != 32 {
			return nil, fmt.Errorf("package content digest is invalid")
		}
		file, err := os.Open(filepath.Join(layout, "blobs", "sha256", strings.TrimPrefix(digest, "sha256:")))
		if err != nil {
			return nil, err
		}
		body, readErr := func() ([]byte, error) {
			hash := sha256.New()
			compressed := &io.LimitedReader{R: contextReader{ctx: ctx, reader: file}, N: MaxContentBytes + 1}
			tee := io.TeeReader(compressed, hash)
			zip, err := gzip.NewReader(tee)
			if err != nil {
				return nil, err
			}
			defer zip.Close()
			expanded := &io.LimitedReader{R: zip, N: MaxExtractedBytes + (16 << 20) + 1}
			archive := tar.NewReader(expanded)
			var found []byte
			for {
				header, err := archive.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					return nil, err
				}
				path, err := cleanEntry("/tilecast-content", header.Name)
				if err != nil {
					return nil, err
				}
				if files >= MaxExtractedFiles {
					return nil, fmt.Errorf("package content exceeds entry count")
				}
				files++
				if header.Typeflag == tar.TypeDir {
					if header.Size != 0 {
						return nil, fmt.Errorf("package directory has a body")
					}
					continue
				}
				if header.Typeflag != tar.TypeReg || seen[path] || header.Size < 0 || header.Size > MaxExtractedFileBytes || total+header.Size > MaxExtractedBytes {
					return nil, fmt.Errorf("package content exceeds extraction bounds")
				}
				seen[path] = true
				total += header.Size
				if path == wanted {
					if header.Size < 1 || header.Size > max {
						return nil, fmt.Errorf("package file exceeds its bound")
					}
					found, err = io.ReadAll(io.LimitReader(archive, max+1))
					if err != nil || int64(len(found)) != header.Size {
						return nil, fmt.Errorf("package file is incomplete")
					}
				}
			}
			if _, err := io.Copy(io.Discard, expanded); err != nil {
				return nil, err
			}
			if expanded.N <= 0 {
				return nil, fmt.Errorf("package content exceeds expansion bound")
			}
			if _, err := io.Copy(io.Discard, tee); err != nil {
				return nil, err
			}
			if compressed.N <= 0 || "sha256:"+hex.EncodeToString(hash.Sum(nil)) != digest {
				return nil, fmt.Errorf("package content digest changed")
			}
			return found, nil
		}()
		_ = file.Close()
		if readErr != nil {
			return nil, readErr
		}
		if body != nil {
			selected = body
		}
	}
	if selected == nil {
		return nil, fmt.Errorf("package content file is missing")
	}
	return selected, nil
}
