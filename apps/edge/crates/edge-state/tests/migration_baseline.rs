//! Extraction must preserve the shipped migration text, order, and names.

use edge_protocol::Sha256Digest;
use edge_state::MIGRATIONS;

#[test]
fn shipped_migrations_remain_byte_for_byte_unchanged() {
    // Append migrations after this baseline. Never regenerate it to accommodate
    // a moved file or an edited historical migration.
    let baseline = [
        (1, "initial", "2aab634e22de6be21ccac311ddfdbf5ee6ac7d59b8a4ef9a5bd28346d40e0202"),
        (2, "manifests", "379e69cd8ebe5c81c16e424c7609499ba351748e847d82edfd0b8c3e405a8f42"),
        (3, "commands_and_config", "4c562f7ecf136122075977319c16f1bd71274f9e915aa2f487c4d8f7964324f3"),
        (4, "activity_outbox", "cc18122db2b4e396c9aa94df3e1ee0742ab3f869c2e261e54d974ed18cf25263"),
        (5, "hardware", "18fee0cf4735fc62e64c3e6431232d98e3567557d4390f75184fdba8a2569a43"),
        (6, "update_jobs", "a55fe6d78fabaaa769a5ed721bee72a3a615619a3237c1773957197b2bfbdde2"),
        (7, "drop_noise_history", "b4b340f89212e886b4c5f6e97050a4c99700f963e582a2e0424be9e1e83b2d00"),
    ];
    assert!(MIGRATIONS.len() >= baseline.len(), "shipped migrations must not be removed");
    for (migration, (version, name, digest)) in MIGRATIONS.iter().zip(baseline) {
        assert_eq!((migration.version, migration.name), (version, name), "shipped order and identity");
        assert_eq!(Sha256Digest::of(migration.sql.as_bytes()).to_hex(), digest, "migration {version} bytes");
    }
}
