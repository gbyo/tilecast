package fonts

import (
	"encoding/binary"
	"fmt"
	"math"
	"path/filepath"
	"strings"
	"unicode"

	"golang.org/x/image/font/sfnt"
)

// uploadedFace is what an uploaded file declares about itself. Uploads are
// read from the file's own tables; the uploaded filename is only a
// fallback display name and never becomes a path.
type uploadedFace struct {
	Family              string
	Style               string
	WeightMin           int
	WeightMax           int
	MIMEType            string
	Extension           string
	EmbeddingRestricted bool
}

type tableRecord struct {
	offset uint32
	length uint32
}

// parseUpload accepts one TrueType or OpenType (CFF) font. Collections,
// WOFF, and WOFF2 are refused: a collection holds several faces, and the
// web formats need decompression this server does not carry.
func parseUpload(data []byte, filename string) (uploadedFace, error) {
	if len(data) < 12 {
		return uploadedFace{}, ErrUnsupportedFile
	}
	face := uploadedFace{}
	switch string(data[:4]) {
	case "\x00\x01\x00\x00", "true":
		face.MIMEType, face.Extension = "font/ttf", ".ttf"
	case "OTTO":
		face.MIMEType, face.Extension = "font/otf", ".otf"
	case "ttcf":
		return uploadedFace{}, fmt.Errorf("%w: font collections are not supported; upload each face as its own TTF or OTF file", ErrUnsupportedFile)
	case "wOFF", "wOF2":
		return uploadedFace{}, fmt.Errorf("%w: upload the TTF or OTF file instead of the web font", ErrUnsupportedFile)
	default:
		return uploadedFace{}, ErrUnsupportedFile
	}
	parsed, err := sfnt.Parse(data)
	if err != nil {
		return uploadedFace{}, fmt.Errorf("%w: the file is not a readable font", ErrUnsupportedFile)
	}
	tables, err := readTableDirectory(data)
	if err != nil {
		return uploadedFace{}, err
	}
	var buffer sfnt.Buffer
	for _, id := range []sfnt.NameID{sfnt.NameIDTypographicFamily, sfnt.NameIDFamily} {
		if name, nameErr := parsed.Name(&buffer, id); nameErr == nil {
			if clean := cleanFamilyName(name); clean != "" {
				face.Family = clean
				break
			}
		}
	}
	if face.Family == "" {
		face.Family = cleanFamilyName(strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename)))
	}
	if face.Family == "" {
		return uploadedFace{}, fmt.Errorf("%w: the font has no family name", ErrUnsupportedFile)
	}
	face.Style = "normal"
	face.WeightMin, face.WeightMax = 400, 400
	if os2, ok := table(data, tables, "OS/2", 64); ok {
		if weight := int(binary.BigEndian.Uint16(os2[4:6])); weight >= 1 && weight <= 1000 {
			face.WeightMin, face.WeightMax = weight, weight
		}
		// fsType bit 1 is "restricted license embedding": the vendor did not
		// grant embedding. Studio shows this before the upload completes.
		face.EmbeddingRestricted = binary.BigEndian.Uint16(os2[8:10])&0x000F == 0x0002
		if binary.BigEndian.Uint16(os2[62:64])&0x0001 != 0 {
			face.Style = "italic"
		}
	} else if head, ok := table(data, tables, "head", 54); ok && binary.BigEndian.Uint16(head[44:46])&0x0002 != 0 {
		face.Style = "italic"
	}
	if low, high, ok := variableWeight(data, tables); ok {
		face.WeightMin, face.WeightMax = low, high
	}
	return face, nil
}

func readTableDirectory(data []byte) (map[string]tableRecord, error) {
	count := int(binary.BigEndian.Uint16(data[4:6]))
	if count == 0 || count > 512 || 12+count*16 > len(data) {
		return nil, fmt.Errorf("%w: the font table directory is invalid", ErrUnsupportedFile)
	}
	tables := make(map[string]tableRecord, count)
	for index := 0; index < count; index++ {
		record := data[12+index*16 : 28+index*16]
		offset := binary.BigEndian.Uint32(record[8:12])
		length := binary.BigEndian.Uint32(record[12:16])
		if uint64(offset)+uint64(length) > uint64(len(data)) {
			return nil, fmt.Errorf("%w: a font table is out of bounds", ErrUnsupportedFile)
		}
		tables[string(record[:4])] = tableRecord{offset: offset, length: length}
	}
	return tables, nil
}

func table(data []byte, tables map[string]tableRecord, tag string, minimum uint32) ([]byte, bool) {
	record, ok := tables[tag]
	if !ok || record.length < minimum {
		return nil, false
	}
	return data[record.offset : record.offset+record.length], true
}

// variableWeight reads the wght axis from the fvar table.
func variableWeight(data []byte, tables map[string]tableRecord) (int, int, bool) {
	fvar, ok := table(data, tables, "fvar", 16)
	if !ok {
		return 0, 0, false
	}
	axesOffset := int(binary.BigEndian.Uint16(fvar[4:6]))
	axisCount := int(binary.BigEndian.Uint16(fvar[8:10]))
	axisSize := int(binary.BigEndian.Uint16(fvar[10:12]))
	if axisSize < 20 || axisCount > 64 {
		return 0, 0, false
	}
	for index := 0; index < axisCount; index++ {
		start := axesOffset + index*axisSize
		if start+20 > len(fvar) {
			return 0, 0, false
		}
		axis := fvar[start : start+20]
		if string(axis[:4]) != "wght" {
			continue
		}
		low := fixedToInt(binary.BigEndian.Uint32(axis[4:8]))
		high := fixedToInt(binary.BigEndian.Uint32(axis[12:16]))
		if low >= 1 && high <= 1000 && low <= high {
			return low, high, true
		}
		return 0, 0, false
	}
	return 0, 0, false
}

func fixedToInt(value uint32) int {
	return int(math.Round(float64(int32(value)) / 65536))
}

// cleanFamilyName keeps printable text only. The name is shown in Studio
// and never used as a CSS identifier or a path.
func cleanFamilyName(name string) string {
	var builder strings.Builder
	space := false
	for _, r := range name {
		switch {
		case unicode.IsSpace(r):
			space = builder.Len() > 0
		case unicode.IsPrint(r) && r != '"' && r != '\\' && r != '<' && r != '>':
			if space {
				builder.WriteRune(' ')
				space = false
			}
			builder.WriteRune(r)
		}
	}
	clean := builder.String()
	if len(clean) > MaxFamilyNameLength {
		clean = strings.TrimSpace(truncateUTF8(clean, MaxFamilyNameLength))
	}
	return clean
}

func truncateUTF8(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	cut := limit
	for cut > 0 && !utf8Start(value[cut]) {
		cut--
	}
	return value[:cut]
}

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }
