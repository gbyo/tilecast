# Hello Services

A sample Package API v3 package. It carries one Data Source
contribution, one WebAssembly guest, and three service grants. Install
it to see the full external-runtime path work: manifest review,
sandboxed execution, and capability-scoped service calls.

## What it does

The `report` background job runs hourly. It reads the organization
name (`organization.read@1/get`), reads the screen list
(`screens.read@1/list`), and writes one namespaced audit event
(`audit.write@1/write`) recording both. Any failure answers -1 and the
scheduler retries on the next interval.

## Layout

- `tilecast.package.json`: the v3 manifest. Three service grants, one
  background job, one Data Source contribution.
- `guest/`: the Rust guest (`guest/src/lib.rs`), built on the
  reference guest SDK in `packages/package-guest-sdk`.
- `runtime/hello_services.wasm`: the built guest, committed so the
  sample installs without a toolchain.
- `data-sources/census/`: a real declarative Data Source contribution.
  Nested IDs stay short; the pipeline qualifies them with the package
  ID at install time.

## Rebuilding the guest

From the repository root:

```sh
cargo build -p hello-services --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/hello_services.wasm \
  packages/package-samples/hello-services/runtime/hello_services.wasm
```

The server suite runs the committed module through the real host
(`TestSampleHelloServicesReport` in
`apps/server/internal/extensions/wasm`): validation, instantiation,
the `run_job` entry, and all three `tilecast.call_v1` round trips.
Rebuild the module before changing guest behavior; the test fails if
the committed bytes drift from the source.
