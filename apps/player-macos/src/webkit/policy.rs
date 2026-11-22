//! The WKWebView renderer's decisions, kept apart from the WebKit glue so
//! they are testable without a WebKit process: which documents may use the
//! Runtime bridge, which navigations may happen, and how host messages
//! queue for the WebKit pull channel.

use std::collections::VecDeque;

use webview_host::bridge::MAX_HOST_MESSAGE_BYTES;
use webview_host::schemes::{RUNTIME_ENTRY_URL, RUNTIME_HOST, RUNTIME_SCHEME};

/// What WebKit reports about the frame that sent a script message.
#[derive(Debug, Clone, Copy)]
pub struct MessageSource<'a> {
    /// `WKFrameInfo.isMainFrame`.
    pub main_frame: bool,
    /// `WKSecurityOrigin` protocol, host, and port of the sending frame.
    pub origin_protocol: &'a str,
    pub origin_host: &'a str,
    pub origin_port: isize,
    /// The URL of the top-level document in the receiving web view.
    pub document_url: Option<&'a str>,
    /// Whether the message came from the renderer's current web view (and
    /// so its current generation), not a replaced one.
    pub current_view: bool,
}

/// Whether a script message may reach the Runtime bridge: only the top
/// frame of the current web view, from the trusted Runtime origin, while
/// that view shows the Runtime document. A Widget frame, an iframe, a
/// navigated page, or a replaced generation never qualifies.
pub fn is_trusted_bridge_source(source: &MessageSource<'_>) -> bool {
    source.current_view
        && source.main_frame
        && source.origin_protocol == RUNTIME_SCHEME
        && source.origin_host == RUNTIME_HOST
        && source.origin_port == 0
        && source.document_url == Some(RUNTIME_ENTRY_URL)
}

/// Whether the trusted web view may navigate. The top frame loads exactly
/// the Runtime document; this renderer serves no subframes (no Website
/// views, no external Widget or plugin frames), so every subframe
/// navigation is refused.
pub fn allows_navigation(main_frame: bool, url: &str) -> bool {
    main_frame && url == RUNTIME_ENTRY_URL
}

/// A pull's document id: 32 lowercase hex characters from the bootstrap.
pub fn valid_document_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The most host messages that may wait for the Runtime to pull them.
pub const MAX_QUEUED_MESSAGES: usize = 256;
/// The most encoded bytes that may wait for the Runtime to pull them.
pub const MAX_QUEUED_BYTES: usize = 4 * MAX_HOST_MESSAGE_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueError {
    /// One message is larger than the host message limit.
    TooLarge,
    /// The Runtime is not pulling; the queue is at its bound.
    Full,
}

/// Host→Runtime messages waiting for the Runtime's pull, in order.
#[derive(Debug, Default)]
pub struct HostQueue {
    messages: VecDeque<String>,
    bytes: usize,
}

impl HostQueue {
    /// Queues one message. A message over the host limit, or one that does
    /// not fit the bound, is refused rather than truncated or reordered.
    pub fn push(&mut self, message: &serde_json::Value) -> Result<(), QueueError> {
        let encoded = serde_json::to_string(message).map_err(|_| QueueError::TooLarge)?;
        if encoded.len() > MAX_HOST_MESSAGE_BYTES {
            return Err(QueueError::TooLarge);
        }
        if self.messages.len() >= MAX_QUEUED_MESSAGES || self.bytes + encoded.len() > MAX_QUEUED_BYTES {
            return Err(QueueError::Full);
        }
        self.bytes += encoded.len();
        self.messages.push_back(encoded);
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    pub fn len(&self) -> usize {
        self.messages.len()
    }

    pub fn clear(&mut self) {
        self.messages.clear();
        self.bytes = 0;
    }

    /// Takes the oldest messages, in order, as one JSON array: at least one
    /// message, and more while the batch stays within the host message
    /// limit. `None` when nothing waits.
    pub fn take_batch(&mut self) -> Option<String> {
        let first = self.messages.pop_front()?;
        self.bytes -= first.len();
        let mut batch = String::with_capacity(first.len() + 2);
        batch.push('[');
        batch.push_str(&first);
        while let Some(next) = self.messages.front() {
            if batch.len() + next.len() + 2 > MAX_HOST_MESSAGE_BYTES {
                break;
            }
            let next = self.messages.pop_front().expect("front exists");
            self.bytes -= next.len();
            batch.push(',');
            batch.push_str(&next);
        }
        batch.push(']');
        Some(batch)
    }
}

/// What to do with a pull from `document`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pull {
    /// The same document pulled again: release its older pull.
    Repeat,
    /// A new document: the old document is gone, release its pull.
    NewDocument,
}

/// The document currently pulling host messages.
#[derive(Debug, Default)]
pub struct PullDocument(Option<String>);

impl PullDocument {
    pub fn accept(&mut self, document: &str) -> Pull {
        if self.0.as_deref() == Some(document) {
            Pull::Repeat
        } else {
            self.0 = Some(document.to_owned());
            Pull::NewDocument
        }
    }

    pub fn forget(&mut self) {
        self.0 = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_source() -> MessageSource<'static> {
        MessageSource {
            main_frame: true,
            origin_protocol: "tilecast",
            origin_host: "runtime",
            origin_port: 0,
            document_url: Some("tilecast://runtime/index.html"),
            current_view: true,
        }
    }

    #[test]
    fn only_the_top_level_runtime_document_reaches_the_bridge() {
        assert!(is_trusted_bridge_source(&runtime_source()));
        let refused = [
            // A subframe, even one claiming the Runtime origin.
            MessageSource { main_frame: false, ..runtime_source() },
            // A Widget or CAS-backed frame origin.
            MessageSource { origin_protocol: "tcwidget", origin_host: "cap", ..runtime_source() },
            MessageSource { origin_protocol: "tcmedia", origin_host: "cap", ..runtime_source() },
            // Another origin in the top frame, or a lookalike host or port.
            MessageSource { origin_protocol: "https", origin_host: "signs.example.org", ..runtime_source() },
            MessageSource { origin_host: "runtime2", ..runtime_source() },
            MessageSource { origin_port: 8080, ..runtime_source() },
            // The top frame navigated away from the Runtime document.
            MessageSource { document_url: Some("tilecast://runtime/other.html"), ..runtime_source() },
            MessageSource { document_url: Some("about:blank"), ..runtime_source() },
            MessageSource { document_url: None, ..runtime_source() },
            // A replaced web view generation.
            MessageSource { current_view: false, ..runtime_source() },
        ];
        for source in refused {
            assert!(!is_trusted_bridge_source(&source), "{source:?}");
        }
    }

    #[test]
    fn the_trusted_view_navigates_only_to_the_runtime() {
        assert!(allows_navigation(true, "tilecast://runtime/index.html"));
        for (main, url) in [
            (true, "tilecast://runtime/runtime.js"),
            (true, "https://signs.example.org/"),
            (true, "file:///etc/passwd"),
            (true, "http://localhost:8080/index.html"),
            (true, "about:blank"),
            (false, "tilecast://runtime/index.html"),
            (false, "tcwidget://cap/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            (false, "https://www.youtube.com/embed/x"),
            (false, "about:blank"),
        ] {
            assert!(!allows_navigation(main, url), "{main} {url}");
        }
    }

    #[test]
    fn document_ids_are_fixed_shape() {
        assert!(valid_document_id(&"0a".repeat(16)));
        assert!(!valid_document_id(&"0A".repeat(16)));
        assert!(!valid_document_id("short"));
        assert!(!valid_document_id(&"g".repeat(32)));
    }

    #[test]
    fn host_messages_batch_in_order_within_the_limit() {
        let mut queue = HostQueue::default();
        assert_eq!(queue.take_batch(), None);
        for n in 0..3 {
            queue.push(&serde_json::json!({"type": "presentation", "n": n})).expect("queued");
        }
        let batch: Vec<serde_json::Value> =
            serde_json::from_str(&queue.take_batch().expect("batch")).expect("JSON array");
        assert_eq!(batch.iter().map(|m| m["n"].as_u64().expect("n")).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert!(queue.is_empty());

        // Large messages travel one per batch, still in order.
        let big = "x".repeat(MAX_HOST_MESSAGE_BYTES - 64);
        queue.push(&serde_json::json!({"n": 0, "body": big})).expect("queued");
        queue.push(&serde_json::json!({"n": 1, "body": big})).expect("queued");
        queue.push(&serde_json::json!({"n": 2})).expect("queued");
        for expected in [vec![0], vec![1, 2]] {
            let batch: Vec<serde_json::Value> =
                serde_json::from_str(&queue.take_batch().expect("batch")).expect("JSON array");
            assert!(
                batch.len() == 1 || serde_json::to_string(&batch).expect("encodes").len() <= MAX_HOST_MESSAGE_BYTES
            );
            assert_eq!(batch.iter().map(|m| m["n"].as_u64().expect("n")).collect::<Vec<_>>(), expected);
        }
    }

    #[test]
    fn oversized_and_unpulled_messages_are_refused() {
        let mut queue = HostQueue::default();
        let too_big = serde_json::json!({"body": "x".repeat(MAX_HOST_MESSAGE_BYTES)});
        assert_eq!(queue.push(&too_big), Err(QueueError::TooLarge));
        for _ in 0..MAX_QUEUED_MESSAGES {
            queue.push(&serde_json::json!({})).expect("queued");
        }
        assert_eq!(queue.push(&serde_json::json!({})), Err(QueueError::Full));
        queue.clear();
        assert!(queue.is_empty());
        queue.push(&serde_json::json!({})).expect("room again");
    }

    #[test]
    fn a_new_document_replaces_the_old_pull() {
        let mut document = PullDocument::default();
        assert_eq!(document.accept("a"), Pull::NewDocument);
        assert_eq!(document.accept("a"), Pull::Repeat);
        assert_eq!(document.accept("b"), Pull::NewDocument);
        document.forget();
        assert_eq!(document.accept("b"), Pull::NewDocument);
    }
}
