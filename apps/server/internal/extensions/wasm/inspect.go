// Package wasm inspects and hosts external plugin WebAssembly modules.
// Validation is pure standard library: the installer refuses malformed,
// over-privileged, or over-sized modules without executing anything.
// Execution (the wazero host) lives behind Host and only ever runs a
// module this package already accepted.
package wasm

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

// Resource bounds for external plugin modules.
const (
	// MaxModuleBytes caps the compiled module file. Eight megabytes is
	// generous for a capability-scoped plugin and keeps compilation
	// pauses out of activation.
	MaxModuleBytes = 8 << 20
	// MaxMemoryPages caps linear memory at 16 MiB: enough for request
	// buffers and guest state, small enough to instantiate per call.
	MaxMemoryPages = 256
	// MaxStudioEntryBytes caps the Studio UI entry page. Assets served
	// beside it share the per-file cap at serve time.
	MaxStudioEntryBytes = 1 << 20
)

// HostModule is the only import namespace a plugin module may use. No
// WASI, no environment shims: every host capability arrives through
// these functions or not at all.
const HostModule = "tilecast"

// Value types in function signatures.
const (
	valI32 = 0x7F
	valI64 = 0x7E
)

// hostFunction describes one v1 ABI function: its parameter and result
// value types. The installer rejects any import whose signature differs.
type hostFunction struct {
	params  []byte
	results []byte
}

// HostABI is the version 1 plugin host interface. Modules import
// functions from the "tilecast" namespace only:
//
//   - kv_get(key_ptr, key_len, out_ptr, out_cap) -> i32: bytes written,
//     or a negative error (absent grant, missing key, clipped buffer).
//   - kv_set(key_ptr, key_len, val_ptr, val_len) -> i32: 0, or a
//     negative error (absent grant, oversized key or value, quota).
//   - http_fetch(url_ptr, url_len, out_ptr, out_cap) -> i32: bytes
//     written, or a negative error (absent grant, off-allowlist host,
//     timeout, oversized body).
//   - log(level, msg_ptr, msg_len): bounded host log line, always on.
//   - now_ms() -> i64: host wall clock, always on.
//
// Pointers address the module's own linear memory; the host verifies
// every range before reading or writing.
var HostABI = map[string]hostFunction{
	"kv_get":     {params: []byte{valI32, valI32, valI32, valI32}, results: []byte{valI32}},
	"kv_set":     {params: []byte{valI32, valI32, valI32, valI32}, results: []byte{valI32}},
	"http_fetch": {params: []byte{valI32, valI32, valI32, valI32}, results: []byte{valI32}},
	"log":        {params: []byte{valI32, valI32, valI32}, results: nil},
	"now_ms":     {results: []byte{valI64}},
}

// Guest entry points the host calls. run_job carries one background job
// identity; handle_ui_request answers one Studio UI bridge call. Both
// take framed pointers into guest memory and answer a status code.
var guestEntries = map[string]hostFunction{
	"run_job":           {params: []byte{valI32, valI32}, results: []byte{valI32}},
	"handle_ui_request": {params: []byte{valI32, valI32, valI32, valI32}, results: []byte{valI32}},
}

// Module describes the validated shape of a plugin module.
type Module struct {
	// Imports accepted from the host ABI, in declaration order.
	Imports []string
	// Exports declared by the module: name to kind (0 is a function).
	Exports map[string]byte
	// MemoryPages is the declared memory maximum, when present.
	MemoryPages uint32
	// MinMemoryPages is the declared memory minimum, when present.
	MinMemoryPages uint32
	// HasMemory reports whether the module defines linear memory.
	HasMemory bool
	// Size is the module file length in bytes.
	Size int64
}

// Inspect reads one module file and validates its shape: magic, version,
// host-only imports with exact ABI signatures, bounded non-shared
// memory, and no start function. It never executes the module.
func Inspect(path string) (Module, error) {
	raw, err := readCapped(path, MaxModuleBytes)
	if err != nil {
		return Module{}, err
	}
	return Parse(raw)
}

// Parse validates one in-memory module image.
func Parse(raw []byte) (Module, error) {
	var module Module
	module.Size = int64(len(raw))
	if len(raw) == 0 {
		return Module{}, errors.New("wasm: empty module")
	}
	reader := &cursor{data: raw}
	if magic := reader.bytes(4); string(magic) != "\x00asm" {
		return Module{}, errors.New("wasm: bad magic")
	}
	if version := reader.u32(); version != 1 {
		return Module{}, fmt.Errorf("wasm: unsupported version %d", version)
	}
	if reader.err != nil {
		return Module{}, reader.err
	}
	var types [][2][]byte
	var imports []wasmImport
	var funcTypes []uint32
	var exports []wasmExport
	seen := map[byte]bool{}
	for !reader.done() {
		id := reader.u8()
		size := reader.u32leb()
		body := reader.bytes(int(size))
		if reader.err != nil {
			return Module{}, reader.err
		}
		if seen[id] {
			return Module{}, fmt.Errorf("wasm: duplicate section %d", id)
		}
		seen[id] = true
		section := &cursor{data: body}
		switch id {
		case 1:
			types = readTypes(section)
		case 2:
			imports = readImports(section)
		case 3:
			funcTypes = readFuncTypes(section)
		case 5:
			module.HasMemory, module.MinMemoryPages, module.MemoryPages = readMemory(section)
		case 7:
			exports = readExports(section)
		case 8:
			return Module{}, errors.New("wasm: start functions are not allowed")
		}
		if section.err != nil {
			return Module{}, section.err
		}
		if reader.err != nil {
			return Module{}, reader.err
		}
	}
	if err := checkImports(imports, types); err != nil {
		return Module{}, err
	}
	module.Imports = make([]string, 0, len(imports))
	for _, entry := range imports {
		module.Imports = append(module.Imports, entry.name)
	}
	if err := checkExports(exports, imports, funcTypes, types); err != nil {
		return Module{}, err
	}
	if !module.HasMemory || module.MinMemoryPages < 1 {
		return Module{}, errors.New("wasm: the module must define at least one memory page")
	}
	module.Exports = make(map[string]byte, len(exports))
	for _, entry := range exports {
		module.Exports[entry.name] = entry.kind
	}
	return module, nil
}

// wasmImport is one function import: its namespace, name, and type index.
type wasmImport struct {
	module  string
	name    string
	kind    byte
	typeIdx uint32
}

// wasmExport is one export: its name, kind, and index.
type wasmExport struct {
	name  string
	kind  byte
	index uint32
}

func readCapped(path string, max int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("wasm: %v", err)
	}
	if info.Size() == 0 || info.Size() > max {
		return nil, fmt.Errorf("wasm: module must hold 1 to %d bytes", max)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("wasm: %v", err)
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, max+1))
	if err != nil {
		return nil, fmt.Errorf("wasm: %v", err)
	}
	if int64(len(raw)) != info.Size() {
		return nil, errors.New("wasm: module changed during read")
	}
	return raw, nil
}

// cursor reads a binary stream with sticky truncation errors.
type cursor struct {
	data []byte
	at   int
	err  error
}

func (c *cursor) done() bool { return c.err != nil || c.at >= len(c.data) }

func (c *cursor) fail(err error) {
	if c.err == nil {
		c.err = err
	}
}

func (c *cursor) u8() byte {
	if c.at >= len(c.data) {
		c.fail(errors.New("wasm: truncated section"))
		return 0
	}
	value := c.data[c.at]
	c.at++
	return value
}

func (c *cursor) u32() uint32 {
	raw := c.bytes(4)
	if c.err != nil {
		return 0
	}
	return binary.LittleEndian.Uint32(raw)
}

func (c *cursor) u32leb() uint32 {
	var value uint32
	var shift uint
	for {
		byte := c.u8()
		if c.err != nil {
			return 0
		}
		if shift >= 35 && byte&0x7f != 0 {
			c.fail(errors.New("wasm: leb128 overflow"))
			return 0
		}
		value |= uint32(byte&0x7f) << shift
		if byte&0x80 == 0 {
			return value
		}
		shift += 7
	}
}

func (c *cursor) bytes(length int) []byte {
	if length < 0 || c.at+length > len(c.data) {
		c.fail(errors.New("wasm: truncated section"))
		return nil
	}
	raw := c.data[c.at : c.at+length]
	c.at += length
	return raw
}

func (c *cursor) name() string {
	length := c.u32leb()
	if c.err != nil {
		return ""
	}
	return string(c.bytes(int(length)))
}

func readTypes(c *cursor) [][2][]byte {
	count := c.u32leb()
	types := make([][2][]byte, 0, min(count, 64))
	for i := uint32(0); i < count; i++ {
		if c.u8() != 0x60 || c.err != nil {
			c.fail(errors.New("wasm: bad function type"))
			return nil
		}
		params := c.u32leb()
		signature := [2][]byte{}
		for j := uint32(0); j < params; j++ {
			signature[0] = append(signature[0], c.u8())
		}
		results := c.u32leb()
		for j := uint32(0); j < results; j++ {
			signature[1] = append(signature[1], c.u8())
		}
		types = append(types, signature)
	}
	return types
}

func readImports(c *cursor) []wasmImport {
	count := c.u32leb()
	imports := make([]wasmImport, 0, min(count, 16))
	for i := uint32(0); i < count; i++ {
		entry := wasmImport{module: c.name(), name: c.name(), kind: c.u8()}
		if c.err != nil {
			return nil
		}
		if entry.kind != 0 {
			// Non-function imports fail in checkImports; consume the
			// descriptor so the cursor stays aligned.
			skipImportDescriptor(c, entry.kind)
			imports = append(imports, entry)
			continue
		}
		entry.typeIdx = c.u32leb()
		imports = append(imports, entry)
	}
	return imports
}

// skipImportDescriptor consumes a table, memory, or global descriptor.
func skipImportDescriptor(c *cursor, kind byte) {
	switch kind {
	case 1:
		c.u8()
		skipLimits(c)
	case 2:
		skipLimits(c)
	case 3:
		c.u8()
		c.u8()
	default:
		c.fail(fmt.Errorf("wasm: bad import kind %d", kind))
	}
}

func skipLimits(c *cursor) {
	flags := c.u32leb()
	c.u32leb()
	if flags&0x01 != 0 {
		c.u32leb()
	}
}

func readFuncTypes(c *cursor) []uint32 {
	count := c.u32leb()
	indexes := make([]uint32, 0, min(count, 256))
	for i := uint32(0); i < count; i++ {
		indexes = append(indexes, c.u32leb())
	}
	return indexes
}

func readMemory(c *cursor) (bool, uint32, uint32) {
	count := c.u32leb()
	if count == 0 || c.err != nil {
		return false, 0, 0
	}
	if count > 1 {
		c.fail(errors.New("wasm: at most one memory"))
		return false, 0, 0
	}
	flags := c.u32leb()
	initial := c.u32leb()
	var maximum uint32
	hasMaximum := flags&0x01 != 0
	if hasMaximum {
		maximum = c.u32leb()
	}
	if c.err != nil {
		return false, 0, 0
	}
	if flags&0x02 != 0 {
		c.fail(errors.New("wasm: shared memories are not allowed"))
		return false, 0, 0
	}
	if flags&0x04 != 0 {
		c.fail(errors.New("wasm: 64-bit memories are not allowed"))
		return false, 0, 0
	}
	if initial > MaxMemoryPages || (hasMaximum && maximum > MaxMemoryPages) {
		c.fail(fmt.Errorf("wasm: memory exceeds %d pages", MaxMemoryPages))
		return false, 0, 0
	}
	if !hasMaximum {
		maximum = initial
	}
	return true, initial, maximum
}

func readExports(c *cursor) []wasmExport {
	count := c.u32leb()
	exports := make([]wasmExport, 0, min(count, 16))
	for i := uint32(0); i < count; i++ {
		entry := wasmExport{name: c.name(), kind: c.u8()}
		entry.index = c.u32leb()
		if c.err != nil {
			return nil
		}
		exports = append(exports, entry)
	}
	return exports
}

// checkImports replays the import list against the host ABI: namespace,
// name, and exact function signature. A module whose imports disagree
// with the host would trap at instantiation; the installer refuses it
// before anything is retained.
func checkImports(imports []wasmImport, types [][2][]byte) error {
	for _, entry := range imports {
		if entry.kind != 0 {
			return fmt.Errorf("wasm: import %s.%s is not a function", entry.module, entry.name)
		}
		if entry.module != HostModule {
			return fmt.Errorf("wasm: import %s.%s leaves the host namespace", entry.module, entry.name)
		}
		want, ok := HostABI[entry.name]
		if !ok {
			return fmt.Errorf("wasm: import %s.%s is not in the host ABI", entry.module, entry.name)
		}
		if int(entry.typeIdx) >= len(types) {
			return fmt.Errorf("wasm: import %s.%s names a missing type", entry.module, entry.name)
		}
		if !signatureEqual(types[entry.typeIdx], want) {
			return fmt.Errorf("wasm: import %s.%s has the wrong signature", entry.module, entry.name)
		}
	}
	return nil
}

// checkExports verifies the guest entry points a module declares. Extra
// exports are harmless and ignored; a declared entry with the wrong
// kind or signature fails the install instead of trapping at runtime.
func checkExports(exports []wasmExport, imports []wasmImport, funcTypes []uint32, types [][2][]byte) error {
	importedFuncs := uint32(0)
	for _, entry := range imports {
		if entry.kind == 0 {
			importedFuncs++
		}
	}
	for _, entry := range exports {
		want, watched := guestEntries[entry.name]
		if !watched {
			continue
		}
		if entry.kind != 0 {
			return fmt.Errorf("wasm: export %s is not a function", entry.name)
		}
		if entry.index < importedFuncs {
			return fmt.Errorf("wasm: export %s re-exports a host import", entry.name)
		}
		local := entry.index - importedFuncs
		if int(local) >= len(funcTypes) || int(funcTypes[local]) >= len(types) {
			return fmt.Errorf("wasm: export %s names a missing function", entry.name)
		}
		if !signatureEqual(types[funcTypes[local]], want) {
			return fmt.Errorf("wasm: export %s has the wrong signature", entry.name)
		}
	}
	return nil
}

func signatureEqual(got [2][]byte, want hostFunction) bool {
	return string(got[0]) == string(want.params) && string(got[1]) == string(want.results)
}
