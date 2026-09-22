//! Tilecast Edge content-addressed store (RFC §14).
//!
//! # Identity and layout
//!
//! An object's identity is the SHA-256 of its bytes. Paths derive only from
//! a validated [`Sha256Digest`]:
//!
//! ```text
//! <state>/cas/sha256/<first two hex>/<64 hex>     verified objects
//! <state>/partial/<64 hex>.part                   resumable downloads
//! ```
//!
//! No filename, URL, MIME type or peer input ever becomes part of a path.
//!
//! # Invariants (do not change without an RFC amendment)
//!
//! 1. **Only verified bytes are promoted.** An object appears under `cas/`
//!    only after its full size and SHA-256 match, computed over the final
//!    partial file after `fsync`, never over a stream in flight.
//! 2. **Commit order** is: fsync partial → verify → `rename` into `cas/` →
//!    fsync the directory → insert the metadata row. Restart reconciliation
//!    ([`ContentStore::open`]) covers every crash point: an orphan partial
//!    without a row is deleted, a row without a file is dropped, and an
//!    object file without a row is re-hashed and adopted (it can only be
//!    there because it was verified).
//! 3. **Objects are immutable.** Nothing is ever written in place under
//!    `cas/`. Readers can hold files open safely while eviction unlinks.
//! 4. **Pins win.** Eviction never removes a pinned object and never touches
//!    a partial owned by an active write.
//! 5. **One writer per digest.** Concurrent fetches of the same object are
//!    serialized; the second waiter finds the object present.
//! 6. **After an unclean shutdown every object is suspect** until re-hashed
//!    on first use ([`ContentStore::open_verified`]).
//!
//! # Extension points
//!
//! * [`source::BlobSource`] — where bytes come from (origin server, peer,
//!   release artifact store). [`fetch::Fetcher`] tries sources in the order
//!   given and handles resume, restart-on-200, integrity failure and
//!   fallback. Ordering (peer ranking) is the caller's decision.
//! * [`policy::EvictionPolicy`] — which unpinned objects to evict.
//! * [`fetch::FetchObserver`] — per-attempt outcomes for peer scoring and
//!   byte counters.

pub mod fetch;
pub mod policy;
pub mod source;
pub mod store;

pub use edge_protocol::Sha256Digest;
pub use fetch::{FetchError, FetchObserver, FetchRequest, Fetcher};
pub use policy::{EvictionPolicy, LruByDomain};
pub use source::{BlobSource, SourceError, SourceKind, SourceStream};
pub use store::{CasError, CasEvent, ContentStore, IngestMeta, StorePolicy, WriteSession};
