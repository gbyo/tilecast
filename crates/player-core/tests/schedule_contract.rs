#![allow(clippy::unwrap_used)]
use player_core::{Dependencies, PlayerCore, Source};
use player_state::{OpenOptions, StateDb};
use player_types::time::{ManualClock, Timestamp};
use serde_json::{Value, json};

#[test]
fn native_selection_preserves_the_shared_schedule_corpus() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../packages/manifest-schema/schedule-fixtures.json")).unwrap();
    let fallback = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let dir = tempfile::tempdir().unwrap();
    let db = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
    let clock = ManualClock::new(Timestamp::from_unix_seconds(0).unwrap());
    let core = PlayerCore::new(Dependencies { state: db, clock: clock.clone() });
    for case in cases {
        clock.set(Timestamp::parse(case["now"].as_str().unwrap()).unwrap());
        let document = json!({"directFallbackPlaylist": {"id": fallback}, "schedules": case["schedules"]});
        let selected = core.select(&document).unwrap();
        let expected = case["expectedPlaylistId"].as_str().unwrap();
        assert_eq!(
            selected.playlist_id.unwrap().to_string(),
            if expected == "fallback" { fallback } else { expected },
            "{}",
            case["name"]
        );
        assert_eq!(
            selected.schedule_id.map(|id| id.to_string()),
            case.get("expectedScheduleId").and_then(Value::as_str).map(str::to_owned),
            "{}",
            case["name"]
        );
        assert_eq!(
            selected.source,
            if case["expectedSource"] == "schedule" { Source::Schedule } else { Source::Direct },
            "{}",
            case["name"]
        );
    }
}
