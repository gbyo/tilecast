//! The relay client against an in-process WebSocket server that behaves as
//! the setup relay does (apps/setup-relay).
// tungstenite fixes the handshake callback's large error type.
#![allow(clippy::result_large_err)]
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use player_client::phone_setup::{Envelope, PhoneSetupError, RelayAddress, RelayOutcome, wait_with_ping_interval};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Message, http};

const CODE: &str = "Z5ySczQ0pPyM7NbIDHKMmA";

fn envelope_text() -> String {
    serde_json::json!({"v": 1, "epk": format!("BA{}", "A".repeat(85)), "iv": "A".repeat(16), "ct": "C".repeat(40)})
        .to_string()
}

enum Relay {
    Send(String),
    Close(u16),
    Refuse(u16),
    CountPings(tokio::sync::oneshot::Sender<usize>),
}

async fn serve(behavior: Relay) -> RelayAddress {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = RelayAddress::new(&format!("http://{}", listener.local_addr().expect("addr"))).expect("relay");
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.expect("accept");
        let refuse = match &behavior {
            Relay::Refuse(status) => Some(*status),
            _ => None,
        };
        let callback = move |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
            assert_eq!(request.uri().path(), "/v1/rendezvous");
            assert_eq!(request.headers()["authorization"], format!("Rendezvous {CODE}"));
            match refuse {
                Some(status) => {
                    Err(http::Response::builder().status(status).body(Some("{}".to_owned())).expect("response"))
                }
                None => Ok(response),
            }
        };
        let Ok(mut socket) = tokio_tungstenite::accept_hdr_async(tcp, callback).await else { return };
        match behavior {
            Relay::Send(text) => {
                socket.send(Message::Text(text.into())).await.expect("send");
                let _ = socket.close(None).await;
            }
            Relay::Close(code) => {
                let frame = CloseFrame { code: CloseCode::from(code), reason: "".into() };
                let _ = socket.close(Some(frame)).await;
            }
            Relay::CountPings(done) => {
                let mut pings = 0;
                while pings < 2 {
                    match socket.next().await {
                        Some(Ok(Message::Ping(_))) => pings += 1,
                        Some(Ok(Message::Text(_))) => panic!("the Player sent a data message"),
                        Some(Ok(_)) => {}
                        _ => break,
                    }
                }
                let _ = done.send(pings);
                socket.send(Message::Text(envelope_text().into())).await.expect("send");
            }
            Relay::Refuse(_) => {}
        }
    });
    address
}

async fn wait(relay: &RelayAddress) -> Result<RelayOutcome, PhoneSetupError> {
    wait_with_ping_interval(relay, CODE, "tilecast-test", Duration::from_millis(50)).await
}

#[tokio::test]
async fn receives_the_envelope() {
    let relay = serve(Relay::Send(envelope_text())).await;
    let expected = Envelope::parse(&envelope_text()).expect("envelope");
    assert_eq!(wait(&relay).await, Ok(RelayOutcome::Envelope(expected)));
}

#[tokio::test]
async fn rejects_a_malformed_envelope() {
    let relay = serve(Relay::Send("{\"v\":1}".to_owned())).await;
    assert_eq!(wait(&relay).await, Err(PhoneSetupError::Envelope));
}

#[tokio::test]
async fn reports_expiry_and_replacement() {
    let relay = serve(Relay::Close(4408)).await;
    assert_eq!(wait(&relay).await, Ok(RelayOutcome::Expired));
    let relay = serve(Relay::Close(4409)).await;
    assert_eq!(wait(&relay).await, Ok(RelayOutcome::Replaced));
}

#[tokio::test]
async fn maps_refused_handshakes() {
    let relay = serve(Relay::Refuse(410)).await;
    assert_eq!(wait(&relay).await, Ok(RelayOutcome::Closed));
    let relay = serve(Relay::Refuse(429)).await;
    assert_eq!(wait(&relay).await, Err(PhoneSetupError::RateLimited));
}

#[tokio::test]
async fn keeps_the_socket_open_with_ping_frames_only() {
    let (done, pings) = tokio::sync::oneshot::channel();
    let relay = serve(Relay::CountPings(done)).await;
    let outcome = wait(&relay).await;
    assert_eq!(pings.await.expect("pings"), 2);
    assert!(matches!(outcome, Ok(RelayOutcome::Envelope(_))));
}

#[tokio::test]
async fn an_unreachable_relay_is_a_network_error() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let relay = RelayAddress::new(&format!("http://{}", listener.local_addr().expect("addr"))).expect("relay");
    drop(listener);
    assert_eq!(wait(&relay).await, Err(PhoneSetupError::Network));
}
