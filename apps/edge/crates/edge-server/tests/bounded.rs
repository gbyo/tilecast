//! Response bodies are bounded whether or not the server declares a length
//! (docs/tilecast-edge.md §17.5). A raw socket stands in for a misbehaving
//! server: it streams chunked bodies without `Content-Length`.
#![allow(clippy::unwrap_used)]

use edge_protocol::InstallationId;
use edge_server::ServerError;
use edge_server::client::{MAX_ERROR_BYTES, MAX_SMALL_JSON_BYTES, ServerClient};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

/// Answers every request with `status` and `body`, streamed as 4 KiB chunks.
async fn chunked_server(status: &'static str, body: String) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            let body = body.clone();
            tokio::spawn(async move {
                let mut request = vec![0u8; 8192];
                let _ = stream.read(&mut request).await;
                let head = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n"
                );
                if stream.write_all(head.as_bytes()).await.is_err() {
                    return;
                }
                for chunk in body.as_bytes().chunks(4096) {
                    let frame = format!("{:x}\r\n", chunk.len());
                    if stream.write_all(frame.as_bytes()).await.is_err()
                        || stream.write_all(chunk).await.is_err()
                        || stream.write_all(b"\r\n").await.is_err()
                    {
                        return;
                    }
                }
                let _ = stream.write_all(b"0\r\n\r\n").await;
            });
        }
    });
    format!("http://127.0.0.1:{port}")
}

#[tokio::test]
async fn an_oversized_success_body_without_a_length_is_refused() {
    let padding = "x".repeat(MAX_SMALL_JSON_BYTES);
    let body = format!(
        r#"{{"data":{{"product":"Tilecast","installationId":"{}","organizationName":"{padding}","apiVersion":"v1","pairingEnabled":true}}}}"#,
        InstallationId::new_random()
    );
    let url = chunked_server("200 OK", body).await;
    assert_eq!(ServerClient::new(&url).unwrap().identity().await, Err(ServerError::ResponseTooLarge));
}

#[tokio::test]
async fn an_oversized_error_body_keeps_only_its_status_and_never_rejects_the_credential() {
    // A revocation code hidden behind an unbounded body must not be believed:
    // the credential is deleted only on a readable error envelope.
    let padding = "x".repeat(MAX_ERROR_BYTES);
    let body = format!(r#"{{"error":{{"code":"device_credential_revoked","message":"{padding}"}}}}"#);
    let url = chunked_server("401 Unauthorized", body).await;
    let error = ServerClient::new(&url).unwrap().identity().await.unwrap_err();
    assert_eq!(error, ServerError::Api { status: 401, code: "http_401".to_owned(), message: String::new() });
}

#[tokio::test]
async fn a_readable_small_error_still_reports_its_code() {
    let body = r#"{"error":{"code":"screen_disabled","message":"The screen is disabled."}}"#.to_owned();
    let url = chunked_server("403 Forbidden", body).await;
    let error = ServerClient::new(&url).unwrap().identity().await.unwrap_err();
    assert_eq!(
        error,
        ServerError::Api {
            status: 403,
            code: "screen_disabled".to_owned(),
            message: "The screen is disabled.".to_owned()
        }
    );
    assert!(!error.is_transient());
}
