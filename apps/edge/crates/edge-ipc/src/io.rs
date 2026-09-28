//! Async frame I/O on top of `edge_protocol::ipc::frame`.

use edge_protocol::ipc::frame::{self, FrameError};
use edge_protocol::ipc::message::{Frame, MessageError};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Debug, thiserror::Error)]
pub enum IoError {
    #[error("connection closed")]
    Closed,
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("framing error: {0}")]
    Frame(#[from] FrameError),
    #[error("message error: {0}")]
    Message(#[from] MessageError),
}

impl IoError {
    /// Reason code sent in a goodbye or logged on close.
    pub fn reason_code(&self) -> &'static str {
        match self {
            IoError::Closed => "closed",
            IoError::Io(_) => "io_error",
            IoError::Frame(FrameError::TooLarge(_)) => "frame_too_large",
            IoError::Frame(FrameError::Empty) => "frame_empty",
            IoError::Message(_) => "malformed_frame",
        }
    }
}

/// Reads one frame payload. The length header is validated before the
/// payload is read, so an oversized frame never allocates its claimed size.
pub async fn read_payload<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, IoError> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Err(IoError::Closed),
        Err(error) => return Err(IoError::Io(error)),
    }
    let length = frame::check_length(header)?;
    let mut payload = vec![0u8; length];
    reader.read_exact(&mut payload).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::UnexpectedEof { IoError::Closed } else { IoError::Io(error) }
    })?;
    Ok(payload)
}

pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Frame, IoError> {
    let payload = read_payload(reader).await?;
    Ok(Frame::decode(&payload)?)
}

pub async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, message: &Frame) -> Result<(), IoError> {
    let bytes = frame::encode(&message.encode())?;
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}
