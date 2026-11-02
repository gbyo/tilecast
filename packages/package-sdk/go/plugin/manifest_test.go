package externalplugin

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestSharedDescriptorFixtures(t *testing.T) {
	for _, group := range []string{"valid", "invalid"} {
		dir := filepath.Join("..", "..", "testdata", "external-plugins", group)
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if filepath.Ext(entry.Name()) != ".json" {
				continue
			}
			t.Run(group+"/"+entry.Name(), func(t *testing.T) {
				raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
				if err != nil {
					t.Fatal(err)
				}
				_, err = Parse(raw)
				if (err == nil) != (group == "valid") {
					t.Fatalf("Parse error: %v", err)
				}
			})
		}
	}
}

func TestStrictDocumentAndJSONIntegerSemantics(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "external-plugins", "valid", "corners.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(append(raw, []byte(" {}")...)); err == nil {
		t.Fatal("trailing JSON accepted")
	}
	decimal := bytes.Replace(raw, []byte(`"apiVersion": 2`), []byte(`"apiVersion": 2.0`), 1)
	decimal = bytes.Replace(decimal, []byte(`"definitionVersion": 1`), []byte(`"definitionVersion": 1.0`), 1)
	if _, err := Parse(decimal); err != nil {
		t.Fatalf("integer values rejected: %v", err)
	}
}
