package wasm

import (
	"strings"
	"testing"
)

// This file assembles test modules by hand: no wat2wasm, no toolchain.
// The builder below frames sections around caller-supplied parts so each
// test controls exactly one shape decision.

func uleb(value uint32) []byte {
	var out []byte
	for {
		part := byte(value & 0x7f)
		value >>= 7
		if value != 0 {
			part |= 0x80
		}
		out = append(out, part)
		if value == 0 {
			return out
		}
	}
}

func vecName(name string) []byte {
	raw := []byte(name)
	return append(uleb(uint32(len(raw))), raw...)
}

func section(id byte, body []byte) []byte {
	out := []byte{id}
	out = append(out, uleb(uint32(len(body)))...)
	return append(out, body...)
}

type testFuncType struct {
	params  []byte
	results []byte
}

type testImport struct {
	module  string
	name    string
	kind    byte
	typeIdx uint32
}

type testFunc struct {
	typeIdx uint32
	body    []byte
}

type testMemory struct {
	min    uint32
	max    uint32
	hasMax bool
	shared bool
}

type testExport struct {
	name  string
	kind  byte
	index uint32
}

type testData struct {
	offset uint32
	bytes  []byte
}

type testModule struct {
	types   []testFuncType
	imports []testImport
	funcs   []testFunc
	memory  *testMemory
	exports []testExport
	start   *uint32
	data    []testData
}

var (
	typeCall        = testFuncType{params: []byte{0x7f, 0x7f, 0x7f, 0x7f}, results: []byte{0x7f}}
	typeLog         = testFuncType{params: []byte{0x7f, 0x7f, 0x7f}}
	typeNow         = testFuncType{results: []byte{0x7e}}
	typeJob         = testFuncType{params: []byte{0x7f, 0x7f}, results: []byte{0x7f}}
	typeServiceCall = testFuncType{params: []byte{0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f}, results: []byte{0x7f}}
	i32Zero         = []byte{0x41, 0x00, 0x0b}
)

func assemble(spec testModule) []byte {
	out := []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}
	if spec.types != nil {
		body := uleb(uint32(len(spec.types)))
		for _, typ := range spec.types {
			body = append(body, 0x60)
			body = append(body, uleb(uint32(len(typ.params)))...)
			body = append(body, typ.params...)
			body = append(body, uleb(uint32(len(typ.results)))...)
			body = append(body, typ.results...)
		}
		out = append(out, section(1, body)...)
	}
	if spec.imports != nil {
		body := uleb(uint32(len(spec.imports)))
		for _, imp := range spec.imports {
			body = append(body, vecName(imp.module)...)
			body = append(body, vecName(imp.name)...)
			body = append(body, imp.kind)
			switch imp.kind {
			case 0:
				body = append(body, uleb(imp.typeIdx)...)
			case 1:
				body = append(body, 0x70, 0x00, 0x01)
			case 2:
				body = append(body, 0x00, 0x01)
			case 3:
				body = append(body, 0x7f, 0x00)
			}
		}
		out = append(out, section(2, body)...)
	}
	if spec.funcs != nil {
		body := uleb(uint32(len(spec.funcs)))
		for _, fn := range spec.funcs {
			body = append(body, uleb(fn.typeIdx)...)
		}
		out = append(out, section(3, body)...)
	}
	if spec.memory != nil {
		body := uleb(1)
		flags := uint32(0)
		if spec.memory.hasMax {
			flags |= 0x01
		}
		if spec.memory.shared {
			flags |= 0x02 | 0x01
		}
		body = append(body, uleb(flags)...)
		body = append(body, uleb(spec.memory.min)...)
		if flags&0x01 != 0 {
			body = append(body, uleb(spec.memory.max)...)
		}
		out = append(out, section(5, body)...)
	}
	if spec.exports != nil {
		body := uleb(uint32(len(spec.exports)))
		for _, exp := range spec.exports {
			body = append(body, vecName(exp.name)...)
			body = append(body, exp.kind)
			body = append(body, uleb(exp.index)...)
		}
		out = append(out, section(7, body)...)
	}
	if spec.start != nil {
		out = append(out, section(8, uleb(*spec.start))...)
	}
	if spec.funcs != nil {
		body := uleb(uint32(len(spec.funcs)))
		for _, fn := range spec.funcs {
			// No locals; the body carries its own end opcode.
			code := append([]byte{0x00}, fn.body...)
			body = append(body, uleb(uint32(len(code)))...)
			body = append(body, code...)
		}
		out = append(out, section(10, body)...)
	}
	if spec.data != nil {
		body := uleb(uint32(len(spec.data)))
		for _, segment := range spec.data {
			// Active segment: flags, offset expression, bytes. The
			// offset is a signed constant, like every i32.const.
			body = append(body, 0x00, 0x41)
			body = append(body, sleb(int32(segment.offset))...)
			body = append(body, 0x0b)
			body = append(body, uleb(uint32(len(segment.bytes)))...)
			body = append(body, segment.bytes...)
		}
		out = append(out, section(11, body)...)
	}
	return out
}

// validSpec is the full-shape fixture: the whole host ABI imported with
// exact signatures, both guest entries exported, 1..16 memory pages.
func validSpec() testModule {
	return testModule{
		types: []testFuncType{typeCall, typeLog, typeNow, typeJob, typeServiceCall},
		imports: []testImport{
			{module: "tilecast", name: "kv_get", kind: 0, typeIdx: 0},
			{module: "tilecast", name: "kv_set", kind: 0, typeIdx: 0},
			{module: "tilecast", name: "http_fetch", kind: 0, typeIdx: 0},
			{module: "tilecast", name: "log", kind: 0, typeIdx: 1},
			{module: "tilecast", name: "now_ms", kind: 0, typeIdx: 2},
			{module: "tilecast", name: "call_v1", kind: 0, typeIdx: 4},
		},
		funcs: []testFunc{
			{typeIdx: 3, body: i32Zero},
			{typeIdx: 0, body: i32Zero},
		},
		memory:  &testMemory{min: 1, max: 16, hasMax: true},
		exports: []testExport{{name: "run_job", kind: 0, index: 6}, {name: "handle_ui_request", kind: 0, index: 7}},
	}
}

func TestParseValidModule(t *testing.T) {
	module, err := Parse(assemble(validSpec()))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if len(module.Imports) != 6 || module.Imports[0] != "kv_get" || module.Imports[5] != "call_v1" {
		t.Fatalf("imports = %v", module.Imports)
	}
	if !module.HasMemory || module.MemoryPages != 16 {
		t.Fatalf("memory = %v %d", module.HasMemory, module.MemoryPages)
	}
	if kind := module.Exports["run_job"]; kind != 0 {
		t.Fatalf("run_job export kind = %d", kind)
	}
}

// TestParseCustomSections proves repeated custom sections pass: real
// toolchains emit several (names, producers, metadata), and the format
// allows it. Every other section must still appear at most once.
func TestParseCustomSections(t *testing.T) {
	custom := func(name string) []byte {
		body := append([]byte{byte(len(name))}, name...)
		return section(0, body)
	}
	raw := append(assemble(validSpec()), custom("name")...)
	raw = append(raw, custom("producers")...)
	if _, err := Parse(raw); err != nil {
		t.Fatalf("Parse refused repeated custom sections: %v", err)
	}

	duplicate := append(assemble(validSpec()), section(1, []byte{0x00})...)
	if _, err := Parse(duplicate); err == nil || !strings.Contains(err.Error(), "duplicate section 1") {
		t.Fatalf("duplicate type section error = %v", err)
	}
}

func TestParseRejects(t *testing.T) {
	start := uint32(6)
	with := func(mutate func(*testModule)) []byte {
		spec := validSpec()
		mutate(&spec)
		return assemble(spec)
	}
	cases := []struct {
		name string
		raw  []byte
		want string
	}{
		{"empty", []byte{}, "empty module"},
		{"bad magic", append([]byte{0x01, 0x02, 0x03, 0x04}, assemble(validSpec())[4:]...), "bad magic"},
		{"truncated", assemble(validSpec())[:10], "truncated"},
		{"wasi import", with(func(spec *testModule) {
			spec.imports[0].module = "wasi_snapshot_preview1"
		}), "leaves the host namespace"},
		{"unknown host function", with(func(spec *testModule) {
			spec.imports[0].name = "exec"
		}), "not in the host ABI"},
		{"wrong import signature", with(func(spec *testModule) {
			spec.imports[0].typeIdx = 1
		}), "wrong signature"},
		{"missing import type", with(func(spec *testModule) {
			spec.imports[0].typeIdx = 9
		}), "missing type"},
		{"memory import", with(func(spec *testModule) {
			spec.imports[0].kind = 2
		}), "not a function"},
		{"oversized memory", with(func(spec *testModule) {
			spec.memory.max = 1024
		}), "exceeds 256 pages"},
		{"no memory", with(func(spec *testModule) {
			spec.memory = nil
		}), "at least one memory page"},
		{"shared memory", with(func(spec *testModule) {
			spec.memory.shared = true
		}), "shared memories are not allowed"},
		{"two memories", assemble(testModule{memory: &testMemory{min: 1}}), ""},
		{"start function", with(func(spec *testModule) {
			spec.start = &start
		}), "start functions are not allowed"},
		{"entry re-exports import", with(func(spec *testModule) {
			spec.exports[0].index = 0
		}), "re-exports a host import"},
		{"entry wrong signature", with(func(spec *testModule) {
			spec.funcs[0].typeIdx = 1
		}), "wrong signature"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := tc.raw
			if tc.name == "two memories" {
				// Two memories need a hand-built section the
				// builder never emits.
				raw = append([]byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}, section(5, []byte{0x02, 0x00, 0x01, 0x00, 0x01})...)
			}
			_, err := Parse(raw)
			if err == nil {
				t.Fatal("Parse accepted a malformed module")
			}
			want := tc.want
			if tc.name == "two memories" {
				want = "at most one memory"
			}
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("error %q does not mention %q", err, want)
			}
		})
	}
}
