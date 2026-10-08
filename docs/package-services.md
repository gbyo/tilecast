# External package service capabilities

Version 3 external packages call versioned Tilecast services through
one host function, `tilecast.call_v1`. This document is the service
contract: the inventory, the operation shapes, the transport, the
contexts, and the guest SDK. The manifest side lives in [Extension
packages](packages.md).

## Inventory

The service registry (`internal/extensions/services`) owns ten
services at version 1. No other version exists: a grant for any other
version fails closed. The install review resolves every grant against
the registry and shows the operations it unlocks. An unknown service
fails the review, the install, and the activation.

Read services answer domain facts. `organization.read@1/get` takes no
arguments and answers the installation organization. `instance.read@1`
answers installation facts. `screens.read@1/list` takes paging input
and answers non-secret screen facts with reported player
capabilities; `screens.read@1/get` takes an ID. `targets.resolve@1`
validates display targets and resolves them to screen IDs.
`content.read@1` lists and gets playlists, layouts, data sources,
schedules, and screen groups as JSON documents.
`users.read-basic@1` answers the basic user directory: identifiers,
names, roles, and activity only.

Manage services mutate through canonical domain services.
`managed-presentations.manage@1` owns one data source, one widget, and
one playlist per package: `ensure` creates or updates the set,
`update-data` refreshes the payload, `get` reads the IDs. The guest
never names another package's rows. `takeovers.manage@1` activates and
cancels emergency takeovers under canonical takeover validation; it
refuses paths a package cannot confirm, such as re-authentication.
The audit service writes bounded package audit events.
`audit.write@1/write` accepts only actions under the `package.`
namespace with bounded metadata, attributed to the package.

## Transport

`tilecast.call_v1(op_ptr, op_len, in_ptr, in_len, out_ptr, out_cap)`
carries one operation token, one JSON input, and one JSON answer. An
operation token joins service and method: `capability@version/method`,
for example `screens.read@1/list`. Tokens cap at 128 bytes. Inputs cap
at 32 KiB; answers cap at 64 KiB.

An executed call answers an envelope: `{ok: true, data}` or `{ok:
false, error}` with a typed domain failure: `invalid_input`,
`not_found`, `forbidden`, `conflict`, `too_large`, or `unavailable`.
A transport refusal never reaches the envelope: the import answers a
stable negative code for an unknown operation (-7), a missing grant
(-5), an oversized call (-3), or a host failure (-2). A clipped buffer
writes nothing.

## Contexts

Two contexts bound every call. Background jobs run as the system with
no user actor; writes attribute NULL like every other system write.
Studio interface calls run as the signed-in account with the
dashboard role and scope policy of the operation. A missing grant, a
forbidden context, or an invalid actor denies the call before any
domain code runs.

Reads reuse the domain and shared-host services with Studio scoping.
Mutations run through the canonical domain services with
same-transaction audit and after-commit fan-out, so package writes
obey the same rules as dashboard writes. No operation runs its own SQL
against domain tables except dispatcher-owned package rows.

## Guest SDK and sample

The reference guest SDK (`packages/package-guest-sdk`) owns the
unsafe boundary, the host-code mapping, the envelope parsing, and the
typed shapes for the small stable responses. Large domain documents
cross as JSON values: guests read the fields they need without the SDK
shadowing every domain type. The SDK builds for
`wasm32-unknown-unknown` and runs its pure logic under host unit
tests.

The Hello Services sample (`packages/package-samples/hello-services`)
shows the full path: a v3 manifest with three service grants, a Rust
guest on the SDK, a real Data Source contribution, and a scheduled job
that reads screens and writes one audit event. The server suite runs
its committed module through the real host: validation,
instantiation, the `run_job` entry, and all three `tilecast.call_v1`
round trips.
