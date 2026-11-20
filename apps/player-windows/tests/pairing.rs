//! Pairing a fresh headless installation against an in-process fake
//! Tilecast Server: the shared scenarios in `webview_host::testing`, run over
//! this platform's composition.
//!
//! Needs `--features test-util` for the reversible test sealer.
#![cfg(feature = "test-util")]

use std::sync::Arc;
use webview_host::host::HostServices;
use webview_host::seal::TestSealer;
use webview_host::testing::pairing as scenarios;

fn services() -> HostServices {
    tilecast_windows::host::services_with_sealer(Arc::new(TestSealer))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_clean_machine_pairs_is_approved_and_connects() {
    scenarios::a_clean_machine_pairs_is_approved_and_connects(services).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_session_survives_a_restart_and_a_saved_token_enrolls_after_a_crash() {
    scenarios::a_session_survives_a_restart_and_a_saved_token_enrolls_after_a_crash(services).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn expiry_and_rejection_start_a_fresh_session_and_reset_clears_it() {
    scenarios::expiry_and_rejection_start_a_fresh_session_and_reset_clears_it(services).await;
}
