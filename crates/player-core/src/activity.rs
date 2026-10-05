//! Native Activity session semantics pinned by the Player parity contract.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod reason {
    pub const EXPECTED_ITEM_BOUNDARY: &str = "expected_item_boundary";
    pub const SCHEDULE_TRANSITION: &str = "schedule_transition";
    pub const MANIFEST_REPLACEMENT: &str = "manifest_replacement";
    pub const DIRECT_ASSIGNMENT_CHANGE: &str = "direct_assignment_change";
    pub const TAKEOVER: &str = "takeover";
    pub const PLAYER_RESTART: &str = "player_restart";
    pub const PROCESS_EXIT: &str = "process_exit";
    pub const RENDERER_FAILURE: &str = "renderer_failure";
    pub const EMPTY_CONTENT: &str = "empty_content";
    pub const RECOVERY_ACTION: &str = "recovery_action";
}

/// One Activity event, without the envelope the outbox adds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_activity_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlist_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout_placement_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub takeover_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

fn text(value: &str, limit: usize) -> String {
    value.chars().filter(|c| !c.is_control()).take(limit).collect()
}

impl Event {
    pub fn new(event_type: &str, category: &str) -> Self {
        Self { event_type: event_type.to_owned(), category: Some(category.to_owned()), ..Self::default() }
    }

    pub fn with(mut self, change: impl FnOnce(&mut Self)) -> Self {
        change(&mut self);
        self
    }

    /// Bounded to the server's limits (`activity_ingest.go`), so no event
    /// can be refused for its length.
    pub fn bounded(mut self) -> Self {
        let clip = |value: &mut Option<String>, limit: usize| {
            if let Some(v) = value.as_mut() {
                *v = text(v, limit);
            }
        };
        clip(&mut self.presentation_type, 48);
        clip(&mut self.presentation_id, 128);
        clip(&mut self.presentation_revision, 128);
        clip(&mut self.content_type, 48);
        clip(&mut self.content_id, 128);
        clip(&mut self.playlist_item_id, 128);
        clip(&mut self.layout_placement_id, 128);
        clip(&mut self.activity_session_id, 160);
        clip(&mut self.parent_activity_session_id, 160);
        clip(&mut self.failure_code, 96);
        clip(&mut self.failure_message, 240);
        clip(&mut self.trigger, 96);
        clip(&mut self.schedule_id, 128);
        clip(&mut self.takeover_id, 128);
        self
    }
}

/// What is on screen, for the root session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationContext {
    /// A change starts a new root session (`source:presentationId:version`).
    pub key: String,
    pub presentation_type: String,
    pub presentation_id: String,
    pub trigger: Option<String>,
    pub schedule_id: Option<String>,
    pub takeover_id: Option<String>,
    pub manifest_version: Option<i64>,
}

/// An item of the presentation, for its child session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInfo {
    pub id: String,
    pub kind: String,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentContext {
    content_id: String,
    content_type: String,
    playlist_item_id: Option<String>,
    expected_duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Open<C> {
    id: String,
    started_mono_ms: i64,
    started_wall_ms: i64,
    context: C,
}

/// A clock and identifier source, so the tracker is deterministic in tests.
pub trait Clocks: Send + Sync {
    fn mono_ms(&self) -> i64;
    fn wall_ms(&self) -> i64;
    fn uuid(&self) -> String;
}

/// The Electron player's `PlaybackSessionTracker`.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracker {
    root: Option<Open<PresentationContext>>,
    child: Option<Open<ContentContext>>,
    items: Vec<ItemInfo>,
}

impl Tracker {
    pub fn is_empty(&self) -> bool {
        self.root.is_none() && self.child.is_none()
    }

    fn start_presentation(
        &mut self,
        context: PresentationContext,
        replaced: &str,
        clocks: &dyn Clocks,
        out: &mut Vec<Event>,
    ) {
        if self.root.as_ref().is_some_and(|root| root.context.key == context.key) {
            return;
        }
        self.stop_presentation(replaced, "partial", clocks, out);
        let root =
            Open { id: clocks.uuid(), started_mono_ms: clocks.mono_ms(), started_wall_ms: clocks.wall_ms(), context };
        let c = &root.context;
        out.push(Event::new("presentation.started", "manifest").with(|e| {
            e.result = Some("playing".into());
            e.activity_session_id = Some(root.id.clone());
            e.session_type = Some("presentation".into());
            e.presentation_type = Some(c.presentation_type.clone());
            e.presentation_id = Some(c.presentation_id.clone());
            e.trigger = c.trigger.clone();
            e.schedule_id = c.schedule_id.clone();
            e.takeover_id = c.takeover_id.clone();
            e.manifest_version = c.manifest_version;
        }));
        self.root = Some(root);
    }

    fn stop_presentation(&mut self, reason: &str, result: &str, clocks: &dyn Clocks, out: &mut Vec<Event>) {
        let Some(root) = self.root.clone() else { return };
        // A child cannot outlive its parent; it ends for the same reason.
        self.finish_content(if result == "failed" { "failed" } else { "partial" }, reason, None, clocks, out);
        self.root = None;
        let failed = result == "failed";
        let c = &root.context;
        out.push(Event::new(if failed { "presentation.failed" } else { "presentation.stopped" }, "manifest").with(
            |e| {
                e.severity = Some(if failed { "error" } else { "info" }.into());
                e.result = Some(result.into());
                e.activity_session_id = Some(root.id.clone());
                e.session_type = Some("presentation".into());
                e.terminal_reason = Some(reason.into());
                e.duration_ms = Some((clocks.mono_ms() - root.started_mono_ms).max(0));
                e.presentation_type = Some(c.presentation_type.clone());
                e.presentation_id = Some(c.presentation_id.clone());
                e.trigger = c.trigger.clone();
                e.schedule_id = c.schedule_id.clone();
                e.takeover_id = c.takeover_id.clone();
                e.manifest_version = c.manifest_version;
            },
        ));
    }

    fn start_content(&mut self, item_id: &str, clocks: &dyn Clocks, out: &mut Vec<Event>) {
        // A start for the item that is already open, with no boundary in
        // between, is the renderer remounting the same thing, not a second
        // play. A single-item playlist looping reports `item-transition`
        // first, which closes the session, so it is unaffected.
        if self.child.as_ref().is_some_and(|child| child.context.content_id == item_id) {
            return;
        }
        // An item the player is not presenting is not on screen. The renderer
        // can still report the start of a mount from a presentation that has
        // since been replaced; recording it would invent a play, with a
        // content type the player had to guess, for content nobody was shown.
        let Some(item) = self.items.iter().find(|item| item.id == item_id).cloned() else { return };
        self.finish_content("completed", reason::EXPECTED_ITEM_BOUNDARY, None, clocks, out);
        let context = ContentContext {
            content_id: item_id.to_owned(),
            content_type: item.kind.clone(),
            playlist_item_id: Some(item_id.to_owned()),
            // Zero is how stored data spells "no duration"; reporting it made
            // every indefinite item look like a play cut short at zero.
            expected_duration_ms: item.duration_ms.filter(|ms| *ms > 0),
        };
        let child =
            Open { id: clocks.uuid(), started_mono_ms: clocks.mono_ms(), started_wall_ms: clocks.wall_ms(), context };
        let root = self.root.as_ref().map(|root| &root.context);
        let c = &child.context;
        out.push(Event::new("content.started", "playback").with(|e| {
            e.result = Some("playing".into());
            e.activity_session_id = Some(child.id.clone());
            e.parent_activity_session_id = self.root.as_ref().map(|root| root.id.clone());
            e.session_type = Some(session_type(c).into());
            e.content_type = Some(c.content_type.clone());
            e.content_id = Some(c.content_id.clone());
            e.playlist_item_id = c.playlist_item_id.clone();
            e.expected_duration_ms = c.expected_duration_ms;
            e.presentation_type = root.map(|r| r.presentation_type.clone());
            e.presentation_id = root.map(|r| r.presentation_id.clone());
            e.trigger = root.and_then(|r| r.trigger.clone());
            e.schedule_id = root.and_then(|r| r.schedule_id.clone());
            e.takeover_id = root.and_then(|r| r.takeover_id.clone());
            e.manifest_version = root.and_then(|r| r.manifest_version);
        }));
        self.child = Some(child);
    }

    fn finish_content(
        &mut self,
        result: &str,
        reason: &str,
        failure: Option<(&str, &str)>,
        clocks: &dyn Clocks,
        out: &mut Vec<Event>,
    ) {
        let Some(child) = self.child.take() else { return };
        let event_type = match result {
            "failed" => "content.failed",
            "skipped" => "content.skipped",
            _ => "content.completed",
        };
        let root = self.root.as_ref().map(|root| &root.context);
        let c = &child.context;
        out.push(Event::new(event_type, "playback").with(|e| {
            e.severity = Some(if result == "failed" { "error" } else { "info" }.into());
            e.result = Some(result.into());
            e.activity_session_id = Some(child.id.clone());
            e.session_type = Some(session_type(c).into());
            e.terminal_reason = Some(reason.into());
            e.duration_ms = Some((clocks.mono_ms() - child.started_mono_ms).max(0));
            e.content_type = Some(c.content_type.clone());
            e.content_id = Some(c.content_id.clone());
            e.playlist_item_id = c.playlist_item_id.clone();
            e.expected_duration_ms = c.expected_duration_ms;
            e.presentation_type = root.map(|r| r.presentation_type.clone());
            e.presentation_id = root.map(|r| r.presentation_id.clone());
            e.manifest_version = root.and_then(|r| r.manifest_version);
            e.failure_code = failure.map(|(code, _)| code.to_owned());
            e.failure_message = failure.map(|(_, message)| message.to_owned());
        }));
    }

    /// Sessions a daemon left open when it stopped uncleanly, closed at the
    /// last time it was known alive.
    pub fn close_after_restart(&mut self, alive_at_wall_ms: i64) -> Vec<(i64, Event)> {
        let mut out = vec![];
        let root = self.root.take();
        if let Some(child) = self.child.take() {
            let c = &child.context;
            out.push((
                alive_at_wall_ms,
                Event::new("content.completed", "playback").with(|e| {
                    e.severity = Some("info".into());
                    e.result = Some("partial".into());
                    e.activity_session_id = Some(child.id.clone());
                    e.session_type = Some(session_type(c).into());
                    e.terminal_reason = Some(reason::PLAYER_RESTART.into());
                    e.duration_ms = Some((alive_at_wall_ms - child.started_wall_ms).max(0));
                    e.content_type = Some(c.content_type.clone());
                    e.content_id = Some(c.content_id.clone());
                    e.playlist_item_id = c.playlist_item_id.clone();
                    e.expected_duration_ms = c.expected_duration_ms;
                    e.presentation_type = root.as_ref().map(|r| r.context.presentation_type.clone());
                    e.presentation_id = root.as_ref().map(|r| r.context.presentation_id.clone());
                    e.manifest_version = root.as_ref().and_then(|r| r.context.manifest_version);
                }),
            ));
        }
        if let Some(root) = root {
            let c = &root.context;
            out.push((
                alive_at_wall_ms,
                Event::new("presentation.stopped", "manifest").with(|e| {
                    e.severity = Some("info".into());
                    e.result = Some("partial".into());
                    e.activity_session_id = Some(root.id.clone());
                    e.session_type = Some("presentation".into());
                    e.terminal_reason = Some(reason::PLAYER_RESTART.into());
                    e.duration_ms = Some((alive_at_wall_ms - root.started_wall_ms).max(0));
                    e.presentation_type = Some(c.presentation_type.clone());
                    e.presentation_id = Some(c.presentation_id.clone());
                    e.trigger = c.trigger.clone();
                    e.schedule_id = c.schedule_id.clone();
                    e.takeover_id = c.takeover_id.clone();
                    e.manifest_version = c.manifest_version;
                }),
            ));
        }
        out
    }

    /// Applies one daemon signal, returning the events it produces.
    pub fn apply(&mut self, signal: &Signal, clocks: &dyn Clocks) -> Vec<Event> {
        let mut out = vec![];
        match signal {
            Signal::Presented(Presented::Playing { context, replaced, items }) => {
                self.items = items.clone();
                self.start_presentation(context.clone(), replaced, clocks, &mut out);
            }
            Signal::Presented(Presented::Stopped { reason, failed }) => {
                self.items.clear();
                self.stop_presentation(reason, if *failed { "failed" } else { "partial" }, clocks, &mut out);
            }
            Signal::Renderer { kind: RendererSignal::ItemStarted, item_id } => {
                if let Some(item_id) = item_id {
                    self.start_content(item_id, clocks, &mut out);
                }
            }
            Signal::Renderer { kind: RendererSignal::WidgetEmpty, .. } => {
                self.finish_content("skipped", reason::EMPTY_CONTENT, None, clocks, &mut out);
            }
            Signal::Renderer { kind: RendererSignal::ItemTransition, .. } => {
                self.finish_content("completed", reason::EXPECTED_ITEM_BOUNDARY, None, clocks, &mut out);
            }
            Signal::PlaybackError { item_id, message } => {
                self.finish_content(
                    "failed",
                    reason::RENDERER_FAILURE,
                    Some(("renderer_failure", message)),
                    clocks,
                    &mut out,
                );
                let manifest_version = self.root.as_ref().and_then(|root| root.context.manifest_version);
                out.push(Event::new("renderer.failure", "playback").with(|e| {
                    e.severity = Some("error".into());
                    e.result = Some("failed".into());
                    e.content_id = item_id.clone();
                    e.failure_code = Some("renderer_failure".into());
                    e.failure_message = Some(message.clone());
                    e.manifest_version = manifest_version;
                }));
            }
            Signal::Event(event) => out.push((**event).clone()),
            Signal::Shutdown => self.stop_presentation(reason::PROCESS_EXIT, "partial", clocks, &mut out),
        }
        out
    }
}

fn session_type(context: &ContentContext) -> &'static str {
    if context.playlist_item_id.is_some() { "playlist_item" } else { "content" }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RendererSignal {
    ItemStarted,
    ItemTransition,
    WidgetEmpty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Presented {
    Playing { context: PresentationContext, replaced: &'static str, items: Vec<ItemInfo> },
    Stopped { reason: &'static str, failed: bool },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Signal {
    Presented(Presented),
    Renderer { kind: RendererSignal, item_id: Option<String> },
    PlaybackError { item_id: Option<String>, message: String },
    Event(Box<Event>),
    Shutdown,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Persisted {
    pub tracker: Tracker,
    pub alive_at_wall_ms: i64,
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::{AtomicI64, AtomicU32};

    use super::*;
    use std::sync::atomic::Ordering;

    pub(crate) struct FakeClocks {
        pub mono: AtomicI64,
        next: AtomicU32,
    }

    impl FakeClocks {
        pub(crate) fn new() -> Self {
            Self { mono: AtomicI64::new(0), next: AtomicU32::new(0) }
        }
    }

    impl Clocks for FakeClocks {
        fn mono_ms(&self) -> i64 {
            self.mono.load(Ordering::SeqCst)
        }

        fn wall_ms(&self) -> i64 {
            1_800_000_000_000 + self.mono_ms()
        }

        fn uuid(&self) -> String {
            format!("session-{}", self.next.fetch_add(1, Ordering::SeqCst) + 1)
        }
    }

    #[test]
    fn a_crash_leaves_sessions_the_next_start_closes_at_the_last_alive_time() {
        let clocks = FakeClocks::new();
        let mut tracker = Tracker::default();
        let context = PresentationContext {
            key: "direct:p:1".into(),
            presentation_type: "playlist".into(),
            presentation_id: "p".into(),
            trigger: Some("direct".into()),
            schedule_id: None,
            takeover_id: None,
            manifest_version: Some(1),
        };
        let items = vec![ItemInfo { id: "a".into(), kind: "image".into(), duration_ms: Some(4_000) }];
        tracker.apply(
            &Signal::Presented(Presented::Playing { context, replaced: "manifest_replacement", items }),
            &clocks,
        );
        tracker.apply(&Signal::Renderer { kind: RendererSignal::ItemStarted, item_id: Some("a".into()) }, &clocks);
        let stored =
            serde_json::to_string(&Persisted { tracker: tracker.clone(), alive_at_wall_ms: 1_800_000_009_000 })
                .unwrap();
        let Persisted { mut tracker, alive_at_wall_ms } = serde_json::from_str(&stored).unwrap();
        let closed = tracker.close_after_restart(alive_at_wall_ms);
        let reasons: Vec<_> = closed.iter().map(|(_, e)| (e.event_type.as_str(), e.duration_ms)).collect();
        assert_eq!(reasons, vec![("content.completed", Some(9_000)), ("presentation.stopped", Some(9_000))]);
        assert!(closed.iter().all(|(_, e)| e.terminal_reason.as_deref() == Some("player_restart")));
        assert!(tracker.is_empty());
    }

    #[test]
    fn events_are_bounded_to_the_server_limits() {
        let event = Event::new("content.failed", "playback")
            .with(|e| e.failure_message = Some(format!("{}\u{7}", "x".repeat(400))))
            .bounded();
        assert_eq!(event.failure_message.map(|m| m.len()), Some(240));
    }
}
