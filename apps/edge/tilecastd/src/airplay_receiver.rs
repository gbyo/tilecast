//! The typed client for the AirPlay supervisor `tilecast-airplay`
//! (docs/tilecast-edge-airplay.md §4.2). The wire types and bounds are
//! `edge_protocol::airplay`; `tilecastd` starts no process and reaches
//! UxPlay only through this socket.
//!
//! One connection holds a session. When `tilecastd` drops the connection,
//! the supervisor stops UxPlay and exits.

use std::path::Path;
use std::time::Duration;

use edge_ipc::lines::{Line, LineReader};
pub use edge_protocol::airplay::DEFAULT_SOCKET;
use edge_protocol::airplay::{ControlEvent, ControlRequest, MAX_LINE_BYTES, encode_line};
use tokio::io::{AsyncWriteExt as _, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReceiverError {
    /// No socket, or nothing listening: the unit is not installed.
    #[error("the Tilecast AirPlay supervisor is not installed or not running")]
    Missing,
    /// The supervisor closed the connection.
    #[error("the AirPlay supervisor closed the connection")]
    Closed,
    /// A line that is too long or does not decode.
    #[error("the AirPlay supervisor sent a malformed message")]
    Protocol,
    #[error("the AirPlay supervisor did not answer in time")]
    Timeout,
    /// The supervisor refused the connection or the last request.
    #[error("the AirPlay supervisor refused the request ({0})")]
    Rejected(String),
}

impl ReceiverError {
    /// A stable code for a failed session or a limitation.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Missing => "airplay_unit_missing",
            Self::Closed => "airplay_unit_closed",
            Self::Protocol => "airplay_unit_protocol",
            Self::Timeout => "airplay_unit_timeout",
            Self::Rejected(_) => "airplay_unit_rejected",
        }
    }
}

/// One control connection to the supervisor.
#[derive(Debug)]
pub struct ReceiverConnection {
    /// Cancel-safe: the session loop drops a pending read whenever another
    /// event of its `select!` wins, and no partial line is lost.
    reader: LineReader<BufReader<OwnedReadHalf>>,
    writer: OwnedWriteHalf,
}

impl ReceiverConnection {
    pub async fn connect(socket: &Path) -> Result<Self, ReceiverError> {
        let stream = match tokio::time::timeout(CONNECT_TIMEOUT, UnixStream::connect(socket)).await {
            Ok(Ok(stream)) => stream,
            Ok(Err(_)) => return Err(ReceiverError::Missing),
            Err(_) => return Err(ReceiverError::Timeout),
        };
        let (read, writer) = stream.into_split();
        Ok(Self { reader: LineReader::new(BufReader::new(read), MAX_LINE_BYTES), writer })
    }

    pub async fn send(&mut self, request: &ControlRequest) -> Result<(), ReceiverError> {
        let bytes = encode_line(request).ok_or(ReceiverError::Protocol)?;
        match tokio::time::timeout(WRITE_TIMEOUT, self.writer.write_all(&bytes)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => Err(ReceiverError::Closed),
            Err(_) => Err(ReceiverError::Timeout),
        }
    }

    /// The next event. A `rejected` event is returned as an error, because
    /// the supervisor closes the connection after it.
    pub async fn next_event(&mut self) -> Result<ControlEvent, ReceiverError> {
        match self.reader.next().await {
            Line::End => Err(ReceiverError::Closed),
            Line::TooLong => Err(ReceiverError::Protocol),
            Line::Complete(bytes) => match ControlEvent::decode(&bytes) {
                Ok(ControlEvent::Rejected { code }) => Err(ReceiverError::Rejected(code.into_string())),
                Ok(event) => Ok(event),
                Err(_) => Err(ReceiverError::Protocol),
            },
        }
    }

    /// [`Self::next_event`] with a deadline.
    pub async fn next_event_within(&mut self, timeout: Duration) -> Result<ControlEvent, ReceiverError> {
        tokio::time::timeout(timeout, self.next_event()).await.unwrap_or(Err(ReceiverError::Timeout))
    }
}
