package fonts

import (
	"encoding/binary"
	"errors"
	"testing"

	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goitalic"
	"golang.org/x/image/font/gofont/goregular"
)

func TestParseUploadReadsFamilyWeightAndStyle(t *testing.T) {
	for _, test := range []struct {
		name   string
		data   []byte
		weight int
		style  string
	}{
		{"regular", goregular.TTF, 400, "normal"},
		// Go Bold declares usWeightClass 600 in its own OS/2 table.
		{"bold", gobold.TTF, 600, "normal"},
		{"italic", goitalic.TTF, 400, "italic"},
	} {
		t.Run(test.name, func(t *testing.T) {
			face, err := parseUpload(test.data, "../../evil/path.ttf")
			if err != nil {
				t.Fatal(err)
			}
			if face.Family != "Go" || face.WeightMin != test.weight || face.WeightMax != test.weight || face.Style != test.style {
				t.Fatalf("unexpected face %+v", face)
			}
			if face.MIMEType != "font/ttf" || face.Extension != ".ttf" {
				t.Fatalf("unexpected type %s %s", face.MIMEType, face.Extension)
			}
		})
	}
}

func TestParseUploadRefusesOtherFormats(t *testing.T) {
	for name, data := range map[string][]byte{
		"empty":      {},
		"collection": append([]byte("ttcf"), make([]byte, 64)...),
		"woff":       append([]byte("wOFF"), make([]byte, 64)...),
		"woff2":      append([]byte("wOF2"), make([]byte, 64)...),
		"png":        append([]byte("\x89PNG"), make([]byte, 64)...),
		"truncated":  goregular.TTF[:200],
	} {
		if _, err := parseUpload(data, "x.ttf"); !errors.Is(err, ErrUnsupportedFile) {
			t.Fatalf("%s: want unsupported, got %v", name, err)
		}
	}
}

func TestVariableWeightReadsTheWeightAxis(t *testing.T) {
	fvar := make([]byte, 16+2*20)
	binary.BigEndian.PutUint16(fvar[4:6], 16)   // axes array offset
	binary.BigEndian.PutUint16(fvar[8:10], 2)   // axis count
	binary.BigEndian.PutUint16(fvar[10:12], 20) // axis size
	copy(fvar[16:20], "wdth")
	copy(fvar[36:40], "wght")
	binary.BigEndian.PutUint32(fvar[40:44], 100<<16)
	binary.BigEndian.PutUint32(fvar[48:52], 900<<16)
	data := append(make([]byte, 64), fvar...)
	low, high, ok := variableWeight(data, map[string]tableRecord{"fvar": {offset: 64, length: uint32(len(fvar))}})
	if !ok || low != 100 || high != 900 {
		t.Fatalf("got %d-%d %v", low, high, ok)
	}
}

func TestCleanFamilyName(t *testing.T) {
	for input, want := range map[string]string{
		"  Open   Sans ":       "Open Sans",
		"Evil\"</style>":       "Evil/style",
		"Tab\tSeparated\nName": "Tab Separated Name",
		"\u0000\u0007":         "",
	} {
		if got := cleanFamilyName(input); got != want {
			t.Fatalf("%q: got %q want %q", input, got, want)
		}
	}
	long := cleanFamilyName(string(make([]rune, 0)) + "ÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄÄ")
	if len(long) > MaxFamilyNameLength {
		t.Fatalf("name not bounded: %d bytes", len(long))
	}
}
