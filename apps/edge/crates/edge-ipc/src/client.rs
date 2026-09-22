//! Rust IPC client (used by `tilecastctl` and by tests that play a renderer).

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use edge_protocol::bounded::{ShortText, ShortToken};
use edge_protocol::ipc::event::Event;
use edge_protocol::ipc::message::{
    ErrorBody, EventFrame, Frame, Goodbye, Hello, Rejected, Request, RequestId, Welcome,
};
use edge_protocol::ipc::method::Method;
use edge_protocol::ipc::{DAEMON_MAX_PROTOCOL_VERSION, DAEMON_MIN_PROTOCOL_VERSION, Role};
use serde_json::Value;
use tokio::net::UnixStream;
use tokio::net::unix::OwnedWriteHalf;
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};

use crate::io::{IoError, read_frame, write_frame};

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("could not connect: {0}")]
    Connect(std::io::Error),
    #[error("handshake rejected: {0:?}")]
    Rejected(Rejected),
    #[error("unexpected handshake reply")]
    UnexpectedReply,
    #[error("timed out")]
    Timeout,
    #[error("connection closed")]
    Closed,
    #[error(transparent)]
    Io(#[from] IoError),
}

#[derive(Debug, Clone)]
pub struct ClientOptions {
    pub role: Role,
    pub client: ShortToken,
    pub client_version: ShortText,
    pub features: Vec<ShortToken>,
    pub min_protocol_version: u32,
    pub max_protocol_version: u32,
}

impl ClientOptions {
    pub fn new(role: Role, client: &str, client_version: &str) -> Self {
        Self {
            role,
            client: ShortToken::new(client).unwrap_or_else(|_| ShortToken::new("client").expect("literal token")),
            client_version: ShortText::lossy(client_version),
            features: Vec::new(),
            min_protocol_version: DAEMON_MIN_PROTOCOL_VERSION,
            max_protocol_version: DAEMON_MAX_PROTOCOL_VERSION,
        }
    }
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, ErrorBody>>>>>;

/// Something the daemon sent that is not a response.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Event(u64, Event),
    Goodbye(String),
}

#[derive(Debug)]
pub struct IpcClient {
    welcome: Welcome,
    writer: AsyncMutex<OwnedWriteHalf>,
    pending: Pending,
    next_id: AtomicU64,
    next_event_seq: AtomicU64,
    incoming: AsyncMutex<mpsc::Receiver<Incoming>>,
}

impl IpcClient {
    pub async fn connect(path: impl AsRef<Path>, options: ClientOptions) -> Result<Self, ClientError> {
        let stream = UnixStream::connect(path.as_ref()).await.map_err(ClientError::Connect)?;
        let (mut reader, mut writer) = stream.into_split();
        let hello = Frame::Hello(Hello {
            min_protocol_version: options.min_protocol_version,
            max_protocol_version: options.max_protocol_version,
            role: options.role,
            client: options.client,
            client_version: options.client_version,
            features: options.features,
        });
        write_frame(&mut writer, &hello).await?;
        let reply = tokio::time::timeout(Duration::from_secs(10), read_frame(&mut reader))
            .await
            .map_err(|_| ClientError::Timeout)??;
        let welcome = match reply {
            Frame::Welcome(welcome) => welcome,
            Frame::Rejected(rejected) => return Err(ClientError::Rejected(rejected)),
            _ => return Err(ClientError::UnexpectedReply),
        };
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = mpsc::channel(512);
        let reader_pending = Arc::clone(&pending);
        tokio::spawn(async move {
            loop {
                match read_frame(&mut reader).await {
                    Ok(Frame::Response(response)) => {
                        let waiter =
                            reader_pending.lock().unwrap_or_else(|p| p.into_inner()).remove(response.id.as_str());
                        if let Some(waiter) = waiter {
                            let _ = waiter.send(response.outcome);
                        }
                    }
                    Ok(Frame::Event(EventFrame { seq, event })) => {
                        if sender.send(Incoming::Event(seq, event)).await.is_err() {
                            break;
                        }
                    }
                    Ok(Frame::Goodbye(Goodbye { reason })) => {
                        let _ = sender.send(Incoming::Goodbye(reason.into_string())).await;
                        break;
                    }
                    Ok(_) | Err(_) => break,
                }
            }
            reader_pending.lock().unwrap_or_else(|p| p.into_inner()).clear();
        });
        Ok(Self {
            welcome,
            writer: AsyncMutex::new(writer),
            pending,
            next_id: AtomicU64::new(1),
            next_event_seq: AtomicU64::new(1),
            incoming: AsyncMutex::new(receiver),
        })
    }

    pub fn welcome(&self) -> &Welcome {
        &self.welcome
    }

    /// Calls a method and waits for its response.
    pub async fn request(&self, method: Method) -> Result<Result<Value, ErrorBody>, ClientError> {
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), sender);
        let frame = Frame::Request(Request { id: RequestId::new(id).map_err(|_| ClientError::Closed)?, method });
        write_frame(&mut *self.writer.lock().await, &frame).await?;
        tokio::time::timeout(Duration::from_secs(30), receiver)
            .await
            .map_err(|_| ClientError::Timeout)?
            .map_err(|_| ClientError::Closed)
    }

    /// Sends a client → daemon event with the next sequence number.
    pub async fn send_event(&self, event: Event) -> Result<(), ClientError> {
        let mut writer = self.writer.lock().await;
        let seq = self.next_event_seq.fetch_add(1, Ordering::Relaxed);
        write_frame(&mut *writer, &Frame::Event(EventFrame { seq, event })).await?;
        Ok(())
    }

    /// Sends an arbitrary frame. Tests use this to exercise protocol errors.
    pub async fn send_raw(&self, frame: &Frame) -> Result<(), ClientError> {
        write_frame(&mut *self.writer.lock().await, frame).await?;
        Ok(())
    }

    /// Waits for the next event or goodbye.
    pub async fn next_incoming(&self, timeout: Duration) -> Result<Incoming, ClientError> {
        let mut incoming = self.incoming.lock().await;
        match tokio::time::timeout(timeout, incoming.recv()).await {
            Err(_) => Err(ClientError::Timeout),
            Ok(None) => Err(ClientError::Closed),
            Ok(Some(item)) => Ok(item),
        }
    }

    pub async fn goodbye(&self, reason: &str) -> Result<(), ClientError> {
        let reason = ShortToken::new(reason).map_err(|_| ClientError::Closed)?;
        self.send_raw(&Frame::Goodbye(Goodbye { reason })).await
    }
}
