//! Cross-player Activity parity (M8): the scenarios in
//! `packages/api-schema/activity/player-parity.json`, whose `expected`
//! events the Electron Linux Player produces, must come out of Tilecast
//! Edge's tracker unchanged. The activation mapping ([`presented`]) runs
//! here too, from Edge's own activation sources and documents.

#![allow(clippy::unwrap_used)]

use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};

use edge_protocol::Sha256Digest;
use edge_protocol::bounded::{SafeText, ShortToken};
use edge_protocol::ipc::presentation::{ItemKind, PresentationDocument, PresentationItem, StatusSurface};
use serde::Deserialize;
use serde_json::{Map, Value};
use tilecastd::activity::{Clocks, RendererSignal, Signal, Tracker, presented};
use tilecastd::presentation::{ActivationSource, PlaybackIdentity};

const FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/api-schema/activity/player-parity.json");

const FIELDS: &[&str] = &[
    "eventType",
    "category",
    "severity",
    "result",
    "activitySessionId",
    "parentActivitySessionId",
    "sessionType",
    "terminalReason",
    "durationMs",
    "expectedDurationMs",
    "presentationType",
    "presentationId",
    "contentType",
    "contentId",
    "playlistItemId",
    "trigger",
    "scheduleId",
    "takeoverId",
    "manifestVersion",
    "failureCode",
    "failureMessage",
];

#[derive(Deserialize)]
struct Document {
    scenarios: Vec<Scenario>,
}

#[derive(Deserialize)]
struct Scenario {
    name: String,
    steps: Vec<Step>,
    expected: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    present: Option<Present>,
    renderer: Option<Renderer>,
    error: Option<ErrorStep>,
    advance_ms: Option<i64>,
    #[serde(default)]
    shutdown: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Present {
    state: String,
    #[serde(default)]
    selection: Selection,
    manifest_version: Option<i64>,
    #[serde(default)]
    items: Vec<Item>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Selection {
    source: Option<String>,
    playlist_id: Option<uuid::Uuid>,
    layout_id: Option<uuid::Uuid>,
    schedule_id: Option<uuid::Uuid>,
    takeover_id: Option<uuid::Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    id: String,
    kind: String,
    duration_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Renderer {
    kind: String,
    item_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorStep {
    item_id: Option<String>,
    message: String,
}

struct FakeClocks {
    mono: AtomicI64,
    next: AtomicU32,
}

impl Clocks for FakeClocks {
    fn mono_ms(&self) -> i64 {
        self.mono.load(Ordering::SeqCst)
    }

    fn wall_ms(&self) -> i64 {
        1_800_000_000_000 + self.mono_ms()
    }

    fn uuid(&self) -> String {
        format!("uuid-{}", self.next.fetch_add(1, Ordering::SeqCst) + 1)
    }
}

fn source(name: &str) -> &'static str {
    match name {
        "direct" => "direct",
        "schedule" => "schedule",
        "takeover" => "takeover",
        "quick_present" => "quick_present",
        _ => "none",
    }
}

fn item(item: &Item) -> PresentationItem {
    let kind = match item.kind.as_str() {
        "image" => ItemKind::Image,
        "video" => ItemKind::Video,
        "widget" => ItemKind::Widget,
        "layout" => ItemKind::Layout,
        "website" => ItemKind::Website,
        other => panic!("unknown item kind {other}"),
    };
    PresentationItem {
        id: SafeText::new(item.id.clone()).unwrap(),
        kind,
        src: SafeText::new(String::new()).unwrap(),
        duration_ms: item.duration_ms,
        fit_mode: ShortToken::new("contain").unwrap(),
        transition: None,
        audio_enabled: false,
        volume: 1.0,
        video_start_offset_ms: None,
        video_end_offset_ms: None,
        viewport: None,
        website: None,
        widget: None,
        layout: None,
    }
}

/// An Edge activation for one presented state.
fn activation(present: &Present) -> (ActivationSource, Option<PlaybackIdentity>, PresentationDocument) {
    let surface = || StatusSurface {
        title: SafeText::new("Tilecast".to_owned()).unwrap(),
        message: SafeText::new(String::new()).unwrap(),
        background_color: None,
        text_color: None,
        logo_src: None,
        footer_text: None,
        status: None,
    };
    match present.state.as_str() {
        "playing" => {
            let selection = &present.selection;
            let identity = PlaybackIdentity {
                manifest: Sha256Digest::of(b"manifest"),
                manifest_version: present.manifest_version.unwrap_or_default(),
                selection_source: source(selection.source.as_deref().unwrap_or("none")),
                playlist_id: selection.playlist_id,
                layout_id: selection.layout_id,
                schedule_id: selection.schedule_id,
                takeover_id: selection.takeover_id,
                next_transition_ms: None,
            };
            let document = PresentationDocument::Playing {
                items: present.items.iter().map(item).collect(),
                takeover: selection.takeover_id.is_some(),
                generation: 1,
                synchronized: false,
            };
            (ActivationSource::ServerManifest, Some(identity), document)
        }
        "rest" => (
            ActivationSource::Policy,
            None,
            PresentationDocument::Sleep { display: None, text: None, text_color: None },
        ),
        "disabled" => (ActivationSource::Policy, None, PresentationDocument::Disabled(surface())),
        "idle" => (ActivationSource::StatusSurface, None, PresentationDocument::Idle(surface())),
        "safe-mode" => (
            ActivationSource::SafeMode,
            None,
            PresentationDocument::SafeMode { reason: SafeText::new("recovery".to_owned()).unwrap() },
        ),
        other => panic!("unknown state {other}"),
    }
}

fn normalize(events: Vec<tilecastd::activity::Event>) -> Vec<Value> {
    let mut sessions: Vec<String> = vec![];
    let mut session = |id: &str| {
        let index = sessions.iter().position(|s| s == id).unwrap_or_else(|| {
            sessions.push(id.to_owned());
            sessions.len() - 1
        });
        Value::String(format!("S{}", index + 1))
    };
    events
        .into_iter()
        .map(|event| {
            let value = serde_json::to_value(event).unwrap();
            let mut out = Map::new();
            for field in FIELDS {
                let Some(v) = value.get(*field).filter(|v| !v.is_null()) else { continue };
                let v = if matches!(*field, "activitySessionId" | "parentActivitySessionId") {
                    session(v.as_str().unwrap())
                } else {
                    v.clone()
                };
                out.insert((*field).to_owned(), v);
            }
            // The reporter's defaults on every recorded event.
            out.entry("category").or_insert_with(|| "playback".into());
            out.entry("severity").or_insert_with(|| "info".into());
            Value::Object(out)
        })
        .collect()
}

fn run(scenario: &Scenario) -> Vec<Value> {
    let clocks = FakeClocks { mono: AtomicI64::new(0), next: AtomicU32::new(0) };
    let mut tracker = Tracker::default();
    let mut events = vec![];
    for step in &scenario.steps {
        if let Some(present) = &step.present {
            let (source, identity, document) = activation(present);
            if let Some(presented) = presented(source, identity.as_ref(), &document) {
                events.extend(tracker.apply(&Signal::Presented(presented), &clocks));
            }
        }
        if let Some(renderer) = &step.renderer {
            let kind = match renderer.kind.as_str() {
                "item-started" => RendererSignal::ItemStarted,
                "item-transition" => RendererSignal::ItemTransition,
                "widget-empty" => RendererSignal::WidgetEmpty,
                other => panic!("unknown renderer signal {other}"),
            };
            events.extend(tracker.apply(&Signal::Renderer { kind, item_id: renderer.item_id.clone() }, &clocks));
        }
        if let Some(error) = &step.error {
            let signal = Signal::PlaybackError { item_id: error.item_id.clone(), message: error.message.clone() };
            events.extend(tracker.apply(&signal, &clocks));
        }
        if let Some(ms) = step.advance_ms {
            clocks.mono.fetch_add(ms, Ordering::SeqCst);
        }
        if step.shutdown {
            events.extend(tracker.apply(&Signal::Shutdown, &clocks));
        }
    }
    normalize(events)
}

#[test]
fn edge_produces_the_electron_players_events_for_every_parity_scenario() {
    let document: Document = serde_json::from_str(&std::fs::read_to_string(FILE).unwrap()).unwrap();
    assert!(document.scenarios.len() >= 3);
    for scenario in &document.scenarios {
        assert!(!scenario.expected.is_empty(), "{}", scenario.name);
        let actual = run(scenario);
        for (index, (actual, expected)) in actual.iter().zip(&scenario.expected).enumerate() {
            assert_eq!(actual, expected, "{}: event {index}", scenario.name);
        }
        assert_eq!(actual.len(), scenario.expected.len(), "{}", scenario.name);
    }
}
