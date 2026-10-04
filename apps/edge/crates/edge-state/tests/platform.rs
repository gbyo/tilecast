//! Edge-only recovery repository in the unchanged physical schema.

use edge_state::{OpenOptions, open_connection};

#[test]
fn the_presentation_network_state_has_no_place_for_a_credential() {
    use edge_state::platform::presentation_network::{self, NetworkState};
    let dir = tempfile::tempdir().expect("tempdir");
    let connection = open_connection(&dir.path().join("state.db"), OpenOptions::default()).expect("open");
    let now = edge_protocol::Timestamp::parse("2026-09-25T12:00:00Z").expect("time");
    assert_eq!(presentation_network::get(&connection).expect("get"), NetworkState::default());
    assert!(NetworkState::default().radio_was_enabled, "the safe default never turns a radio off");
    let state = NetworkState {
        active_network_id: Some("6f0c2b1e-9d2a-4b7e-8f3a-2c1d0e9f8a7b".into()),
        radio_was_enabled: false,
    };
    presentation_network::put(&connection, &state, now).expect("put");
    assert_eq!(presentation_network::get(&connection).expect("get"), state);
    let columns: Vec<String> = connection
        .prepare("SELECT name FROM pragma_table_info('presentation_network_state')")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("columns");
    assert_eq!(columns, ["singleton", "active_network_id", "radio_was_enabled", "updated_at_ms"]);
}
