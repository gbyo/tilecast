#![allow(clippy::unwrap_used)]

use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};

use player_core::{
    ActivityClocks as Clocks, ActivityItem as ItemInfo, ActivityPresentationContext as PresentationContext,
    ActivityPresented as Presented, ActivityRendererSignal as RendererSignal, ActivitySignal as Signal,
    ActivityTracker as Tracker,
};
use serde::Deserialize;
use serde_json::{Map, Value};

const FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/api-schema/activity/player-parity.json");

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

fn presented(present: &Present) -> Presented {
    if present.state != "playing" {
        return Presented::Stopped {
            reason: if present.state == "safe-mode" { "recovery_action" } else { "schedule_transition" },
            failed: present.state == "safe-mode",
        };
    }
    let selection = &present.selection;
    let source = source(selection.source.as_deref().unwrap_or("none"));
    let id = selection
        .layout_id
        .or(selection.playlist_id)
        .map(|id| id.to_string())
        .unwrap_or_else(|| present.items[0].id.clone());
    let version = present.manifest_version.unwrap_or_default();
    Presented::Playing {
        context: PresentationContext {
            key: format!("{source}:{id}:{version}"),
            presentation_type: if selection.layout_id.is_some() { "layout" } else { "playlist" }.into(),
            presentation_id: id,
            trigger: Some(source.into()),
            schedule_id: selection.schedule_id.map(|id| id.to_string()),
            takeover_id: selection.takeover_id.map(|id| id.to_string()),
            manifest_version: Some(version),
        },
        replaced: if selection.takeover_id.is_some() {
            "takeover"
        } else if selection.schedule_id.is_some() {
            "schedule_transition"
        } else if source == "direct" {
            "direct_assignment_change"
        } else {
            "manifest_replacement"
        },
        items: present
            .items
            .iter()
            .map(|item| ItemInfo { id: item.id.clone(), kind: item.kind.clone(), duration_ms: item.duration_ms })
            .collect(),
    }
}

fn normalize(events: Vec<player_core::ActivityEvent>) -> Vec<Value> {
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
            events.extend(tracker.apply(&Signal::Presented(presented(present)), &clocks));
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
fn core_produces_the_existing_events_for_every_parity_scenario() {
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
