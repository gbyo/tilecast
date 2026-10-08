package wasm

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"

	"github.com/tilecast/tilecast/apps/server/internal/extensions/services"
	packagemanifest "github.com/tilecast/tilecast/packages/package-sdk/go/package"
)

// Guest ABI error codes. Host functions answer a negative i32 instead of
// trapping, so a denied capability is an ordinary error the guest sees.
const (
	// ErrNoGrant answers a capability call the activation never granted.
	ErrNoGrant = -1
	// ErrKV absent key or clipped buffer.
	ErrKVMissing = -2
	// ErrTooLarge answers an oversized key, value, buffer, or body.
	ErrTooLarge = -3
	// ErrHostFailure answers a backend or unexpected host error.
	ErrHostFailure = -4
	// ErrNotAllowlisted answers an off-allowlist or malformed URL.
	ErrNotAllowlisted = -5
	// ErrFetchFailed answers a network failure, timeout, or refusal.
	ErrFetchFailed = -6
	// ErrNoOperation answers a call_v1 operation token the service
	// registry does not know.
	ErrNoOperation = -7
)

// Call framing bounds. The host writes the call input at address 0 and
// offers the output window beside it; guests stay within their declared
// memory, which always spans at least one 64 KiB page.
const (
	callInputAddr  = 0
	callOutputAddr = 16 << 10
	callInputCap   = 16 << 10
	callOutputCap  = 16 << 10
	// MaxBridgeInputBytes caps one Studio UI bridge payload, decoded.
	// It matches the call-input window the host frames for the guest.
	MaxBridgeInputBytes = callInputCap
	// maxFetchBody caps one approved response body at 1 MiB.
	maxFetchBody = 1 << 20
	// fetchTimeout bounds one approved outbound request.
	fetchTimeout = 10 * time.Second
	// maxLogBytes caps one guest log line; longer lines truncate.
	maxLogBytes = 4 << 10
)

// Grants carries the evaluated capabilities for one package activation:
// the install review the operator approved, re-read from the manifest.
type Grants struct {
	// NetworkHosts are the approved outbound HTTPS origins.
	NetworkHosts []string
	// Storage grants plugin-owned key/value storage.
	Storage bool
	// Services are the versioned Tilecast service grants for call_v1.
	Services []packagemanifest.ServiceGrant
}

// ServiceCaller executes authorized service calls. The dispatcher lives
// behind it so the host never imports domain services itself.
type ServiceCaller interface {
	Call(ctx context.Context, call services.Call) (any, *services.Denial, *services.CallError)
}

// Call is one guest invocation.
type Call struct {
	// PackageID scopes storage, logs, and the compile cache entry.
	PackageID string
	// Digest keys the compiled module cache: the pinned artifact digest.
	Digest string
	// Module is the validated module image.
	Module []byte
	// Grants are the activation's evaluated capabilities.
	Grants Grants
	// Entry is run_job or handle_ui_request.
	Entry string
	// Input is framed at address 0: a job identity or a UI request.
	Input []byte
	// Timeout bounds the whole call, guest and host functions alike.
	Timeout time.Duration
	// Context is the invocation context for service calls: studio or
	// background.
	Context string
	// Actor is the authenticated Studio operator. Studio calls require
	// one; background calls must not carry one.
	Actor *services.Actor
	// Caller executes service calls. Nil denies every call_v1.
	Caller ServiceCaller
}

// Result is one completed call.
type Result struct {
	// Status is the guest's i32 answer.
	Status int32
	// Output holds handle_ui_request's framed reply; run_job answers
	// status only.
	Output []byte
}

// invocation carries per-call state to host functions through the
// context. One host module serves every package, so the grants ride the
// call, never shared host state.
type invocation struct {
	packageID string
	grants    Grants
	context   string
	actor     *services.Actor
	caller    ServiceCaller
	store     KVStore
	fetch     func(ctx context.Context, rawURL string, allow []string) ([]byte, error)
	logger    *slog.Logger
}

type invocationKey struct{}

func invocationOf(ctx context.Context) *invocation {
	call, _ := ctx.Value(invocationKey{}).(*invocation)
	return call
}

// Host executes validated plugin modules: one wazero runtime, a digest
// keyed compile cache, and the capability host functions. Every call
// instantiates fresh guest state, runs under a deadline, and closes its
// instance; nothing persists between calls except KV rows.
type Host struct {
	runtime  wazero.Runtime
	store    KVStore
	fetch    func(ctx context.Context, rawURL string, allow []string) ([]byte, error)
	logger   *slog.Logger
	mu       sync.Mutex
	compiled map[string]wazero.CompiledModule
}

// NewHost builds the execution host over the store. The host module
// registers immediately; guest modules compile on first call.
func NewHost(ctx context.Context, store KVStore, logger *slog.Logger) (*Host, error) {
	host := &Host{
		runtime: wazero.NewRuntimeWithConfig(ctx,
			wazero.NewRuntimeConfig().WithCloseOnContextDone(true)),
		store:    store,
		fetch:    restrictedFetch,
		logger:   logger,
		compiled: map[string]wazero.CompiledModule{},
	}
	builder := host.runtime.NewHostModuleBuilder(HostModule)
	builder.NewFunctionBuilder().
		WithFunc(host.kvGet).
		Export("kv_get")
	builder.NewFunctionBuilder().
		WithFunc(host.kvSet).
		Export("kv_set")
	builder.NewFunctionBuilder().
		WithFunc(host.httpFetch).
		Export("http_fetch")
	builder.NewFunctionBuilder().
		WithFunc(host.logLine).
		Export("log")
	builder.NewFunctionBuilder().
		WithFunc(host.nowMS).
		Export("now_ms")
	builder.NewFunctionBuilder().
		WithFunc(host.serviceCall).
		Export("call_v1")
	if _, err := builder.Instantiate(ctx); err != nil {
		host.runtime.Close(ctx) //nolint:errcheck
		return nil, fmt.Errorf("wasm: host module: %w", err)
	}
	return host, nil
}

// Close releases the runtime and every compiled module.
func (h *Host) Close(ctx context.Context) error {
	h.mu.Lock()
	compiled := h.compiled
	h.compiled = map[string]wazero.CompiledModule{}
	h.mu.Unlock()
	for _, module := range compiled {
		module.Close(ctx) //nolint:errcheck
	}
	return h.runtime.Close(ctx)
}

// Remove evicts one digest from the compile cache. Package removal and
// update call it after the activation row is gone.
func (h *Host) Remove(ctx context.Context, digest string) {
	h.mu.Lock()
	compiled, ok := h.compiled[digest]
	if ok {
		delete(h.compiled, digest)
	}
	h.mu.Unlock()
	if ok {
		compiled.Close(ctx) //nolint:errcheck
	}
}

// Invoke runs one guest entry with fresh state under the call deadline.
// The module image revalidates before compile: install validation
// accepted these bytes, and anything else fails closed here.
func (h *Host) Invoke(ctx context.Context, call Call) (Result, error) {
	if call.Entry != "run_job" && call.Entry != "handle_ui_request" {
		return Result{}, fmt.Errorf("wasm: unknown entry %q", call.Entry)
	}
	if len(call.Input) > callInputCap {
		return Result{}, fmt.Errorf("wasm: call input exceeds %d bytes", callInputCap)
	}
	if _, err := Parse(call.Module); err != nil {
		return Result{}, err
	}
	compiled, err := h.compile(ctx, call.Digest, call.Module)
	if err != nil {
		return Result{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, call.Timeout)
	defer cancel()
	ctx = context.WithValue(ctx, invocationKey{}, &invocation{
		packageID: call.PackageID,
		grants:    call.Grants,
		context:   call.Context,
		actor:     call.Actor,
		caller:    call.Caller,
		store:     h.store,
		fetch:     h.fetch,
		logger:    h.logger,
	})
	instance, err := h.runtime.InstantiateModule(ctx, compiled, wazero.NewModuleConfig())
	if err != nil {
		return Result{}, fmt.Errorf("wasm: instantiate: %w", err)
	}
	defer instance.Close(ctx) //nolint:errcheck
	memory := instance.Memory()
	if memory == nil || memory.Size() < callOutputAddr+callOutputCap {
		return Result{}, errors.New("wasm: guest memory too small for the call frame")
	}
	if !memory.Write(callInputAddr, call.Input) {
		return Result{}, errors.New("wasm: cannot frame the call input")
	}
	fn := instance.ExportedFunction(call.Entry)
	if fn == nil {
		return Result{}, fmt.Errorf("wasm: missing export %q", call.Entry)
	}
	var results []uint64
	if call.Entry == "run_job" {
		results, err = fn.Call(ctx, callInputAddr, uint64(len(call.Input)))
	} else {
		results, err = fn.Call(ctx, callInputAddr, uint64(len(call.Input)), callOutputAddr, callOutputCap)
	}
	if err != nil {
		return Result{}, fmt.Errorf("wasm: call %s: %w", call.Entry, err)
	}
	result := Result{Status: api.DecodeI32(results[0])}
	if call.Entry == "handle_ui_request" && result.Status >= 0 {
		output, ok := memory.Read(callOutputAddr, uint32(result.Status))
		if !ok {
			return Result{}, errors.New("wasm: guest answered outside its output window")
		}
		result.Output = output
	}
	return result, nil
}

func (h *Host) compile(ctx context.Context, digest string, module []byte) (wazero.CompiledModule, error) {
	h.mu.Lock()
	compiled, ok := h.compiled[digest]
	h.mu.Unlock()
	if ok {
		return compiled, nil
	}
	fresh, err := h.runtime.CompileModule(ctx, module)
	if err != nil {
		return nil, fmt.Errorf("wasm: compile: %w", err)
	}
	h.mu.Lock()
	if cached, ok := h.compiled[digest]; ok {
		h.mu.Unlock()
		fresh.Close(ctx) //nolint:errcheck
		return cached, nil
	}
	h.compiled[digest] = fresh
	h.mu.Unlock()
	return fresh, nil
}

func readGuestString(mod api.Module, ptr, length uint32, cap int) (string, bool) {
	if uint64(length) > uint64(cap) {
		return "", false
	}
	raw, ok := mod.Memory().Read(ptr, length)
	if !ok {
		return "", false
	}
	return string(raw), true
}

func (h *Host) kvGet(ctx context.Context, mod api.Module, keyPtr, keyLen, outPtr, outCap uint32) int32 {
	call := invocationOf(ctx)
	if call == nil || !call.grants.Storage {
		return ErrNoGrant
	}
	key, ok := readGuestString(mod, keyPtr, keyLen, MaxKVKeyBytes)
	if !ok {
		return ErrTooLarge
	}
	value, err := call.store.Get(ctx, call.packageID, key)
	if errors.Is(err, ErrKVNotFound) {
		return ErrKVMissing
	}
	if err != nil {
		return ErrHostFailure
	}
	if uint64(len(value)) > uint64(outCap) {
		return ErrTooLarge
	}
	if !mod.Memory().Write(outPtr, value) {
		return ErrTooLarge
	}
	return int32(len(value))
}

func (h *Host) kvSet(ctx context.Context, mod api.Module, keyPtr, keyLen, valPtr, valLen uint32) int32 {
	call := invocationOf(ctx)
	if call == nil || !call.grants.Storage {
		return ErrNoGrant
	}
	key, ok := readGuestString(mod, keyPtr, keyLen, MaxKVKeyBytes)
	if !ok {
		return ErrTooLarge
	}
	if uint64(valLen) > uint64(MaxKVValueBytes) {
		return ErrTooLarge
	}
	value, ok := mod.Memory().Read(valPtr, valLen)
	if !ok {
		return ErrTooLarge
	}
	if err := call.store.Set(ctx, call.packageID, key, value); err != nil {
		return ErrHostFailure
	}
	return 0
}

func (h *Host) httpFetch(ctx context.Context, mod api.Module, urlPtr, urlLen, outPtr, outCap uint32) int32 {
	call := invocationOf(ctx)
	if call == nil || len(call.grants.NetworkHosts) == 0 {
		return ErrNoGrant
	}
	rawURL, ok := readGuestString(mod, urlPtr, urlLen, 2048)
	if !ok {
		return ErrTooLarge
	}
	body, err := call.fetch(ctx, rawURL, call.grants.NetworkHosts)
	if errors.Is(err, errNotAllowlisted) {
		return ErrNotAllowlisted
	}
	if err != nil {
		return ErrFetchFailed
	}
	if uint64(len(body)) > uint64(outCap) {
		return ErrTooLarge
	}
	if !mod.Memory().Write(outPtr, body) {
		return ErrTooLarge
	}
	return int32(len(body))
}

func (h *Host) logLine(ctx context.Context, mod api.Module, level, msgPtr, msgLen uint32) {
	call := invocationOf(ctx)
	if call == nil {
		return
	}
	if msgLen > maxLogBytes {
		msgLen = maxLogBytes
	}
	raw, ok := mod.Memory().Read(msgPtr, msgLen)
	if !ok {
		return
	}
	message := strings.ToValidUTF8(string(raw), "\uFFFD")
	logger := call.logger.With("package_id", call.packageID)
	switch level {
	case 2:
		logger.Error(message)
	case 1:
		logger.Warn(message)
	default:
		logger.Info(message)
	}
}

func (h *Host) nowMS(context.Context) uint64 {
	return uint64(time.Now().UnixMilli())
}

// serviceCall executes one tilecast.call_v1 operation: the dispatcher
// authorizes the operation token against the activation's service grants
// and the invocation context, then runs it. Denials answer stable
// negative codes; executed calls answer a JSON envelope, success or
// typed domain failure, or a negative code when the envelope cannot be
// written whole.
func (h *Host) serviceCall(ctx context.Context, mod api.Module, opPtr, opLen, inPtr, inLen, outPtr, outCap uint32) int32 {
	call := invocationOf(ctx)
	if call == nil || call.caller == nil {
		return ErrNoGrant
	}
	operation, ok := readGuestString(mod, opPtr, opLen, services.MaxOperationBytes)
	if !ok {
		return ErrTooLarge
	}
	if uint64(inLen) > uint64(services.MaxInputBytes) {
		return ErrTooLarge
	}
	input, ok := mod.Memory().Read(inPtr, inLen)
	if !ok {
		return ErrTooLarge
	}
	data, denial, failure := call.caller.Call(ctx, services.Call{
		PackageID: call.packageID,
		Context:   call.context,
		Actor:     call.actor,
		Grants:    call.grants.Services,
		Operation: operation,
		Input:     input,
	})
	if denial != nil {
		if denial.Kind == services.DenialUnknownOperation {
			return ErrNoOperation
		}
		return ErrNoGrant
	}
	var envelope []byte
	var err error
	if failure != nil {
		envelope, err = services.MarshalFailure(failure)
	} else {
		envelope, err = services.MarshalSuccess(data)
	}
	if err != nil {
		return ErrHostFailure
	}
	if len(envelope) > services.MaxOutputBytes || uint64(len(envelope)) > uint64(outCap) {
		return ErrTooLarge
	}
	if !mod.Memory().Write(outPtr, envelope) {
		return ErrTooLarge
	}
	return int32(len(envelope))
}

var errNotAllowlisted = errors.New("wasm: URL is not allowlisted")

// restrictedFetch performs one approved outbound GET: HTTPS only, an
// exact allowlisted hostname, the default port, no redirects, a bounded
// body, and no private, loopback, or link-local address at dial time.
// DNS rebinding past resolution is the known residual: the dialer
// re-resolves and re-checks every connection, which closes the naive
// gap but cannot make a hostile resolver honest.
func restrictedFetch(ctx context.Context, rawURL string, allow []string) ([]byte, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" {
		return nil, errNotAllowlisted
	}
	host := strings.ToLower(parsed.Hostname())
	approved := false
	for _, entry := range allow {
		if host == entry {
			approved = true
			break
		}
	}
	if !approved || (parsed.Port() != "" && parsed.Port() != "443") {
		return nil, errNotAllowlisted
	}
	dialer := &net.Dialer{Timeout: fetchTimeout}
	transport := &http.Transport{
		DialContext: func(dialCtx context.Context, network, address string) (net.Conn, error) {
			name, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			resolved, err := net.DefaultResolver.LookupIP(dialCtx, "ip", name)
			if err != nil || len(resolved) == 0 {
				return nil, errors.New("wasm: DNS resolution failed")
			}
			for _, ip := range resolved {
				if !isPublicIP(ip) {
					return nil, errors.New("wasm: private address blocked")
				}
			}
			return dialer.DialContext(dialCtx, network, net.JoinHostPort(resolved[0].String(), port))
		},
		TLSClientConfig:   &tls.Config{MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2: true,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   fetchTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("wasm: redirects are not followed")
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("wasm: upstream status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxFetchBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxFetchBody {
		return nil, errors.New("wasm: response body too large")
	}
	return body, nil
}

// isPublicIP reports whether an address is safe to dial on a plugin's
// behalf: globally reachable, never local, private, or special.
func isPublicIP(ip net.IP) bool {
	if ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalMulticast() || ip.IsLinkLocalUnicast() || ip.IsMulticast() {
		return false
	}
	for _, blocked := range blockedRanges {
		if blocked.Contains(ip) {
			return false
		}
	}
	return true
}

// blockedRanges are special-use ranges IsPrivate does not cover: carrier
// NAT, IETF protocol assignments, benchmarking, and reserved space.
var blockedRanges = mustParseCIDRs(
	"100.64.0.0/10",
	"192.0.0.0/24",
	"198.18.0.0/15",
	"240.0.0.0/4",
)

func mustParseCIDRs(raw ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(raw))
	for _, entry := range raw {
		_, block, err := net.ParseCIDR(entry)
		if err != nil {
			panic("wasm: bad blocked range " + entry)
		}
		out = append(out, block)
	}
	return out
}
