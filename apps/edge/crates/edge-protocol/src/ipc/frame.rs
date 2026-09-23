//! Length-prefixed framing, independent of any async runtime.

use super::MAX_FRAME_BYTES;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FrameError {
    #[error("frame length is zero")]
    Empty,
    #[error("frame of {0} bytes exceeds the maximum")]
    TooLarge(usize),
}

/// Prepends the 4-byte big-endian length to `payload`.
pub fn encode(payload: &[u8]) -> Result<Vec<u8>, FrameError> {
    if payload.is_empty() {
        return Err(FrameError::Empty);
    }
    if payload.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(payload.len()));
    }
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// Validates a received length header before any payload is buffered.
pub fn check_length(header: [u8; 4]) -> Result<usize, FrameError> {
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 {
        return Err(FrameError::Empty);
    }
    if length > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(length));
    }
    Ok(length)
}

/// Incremental decoder for byte streams that arrive in arbitrary pieces.
/// Buffers at most one frame; an invalid header is reported immediately.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
    failed: bool,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    /// Returns the next complete payload, `Ok(None)` when more bytes are
    /// needed, or an error that must end the connection.
    pub fn next_frame(&mut self) -> Result<Option<Vec<u8>>, FrameError> {
        if self.failed {
            return Err(FrameError::Empty);
        }
        if self.buffer.len() < 4 {
            return Ok(None);
        }
        let header = [self.buffer[0], self.buffer[1], self.buffer[2], self.buffer[3]];
        let length = match check_length(header) {
            Ok(length) => length,
            Err(error) => {
                self.failed = true;
                self.buffer.clear();
                return Err(error);
            }
        };
        if self.buffer.len() < 4 + length {
            return Ok(None);
        }
        let payload = self.buffer[4..4 + length].to_vec();
        self.buffer.drain(..4 + length);
        Ok(Some(payload))
    }

    /// Bytes buffered for an incomplete frame.
    pub fn pending_bytes(&self) -> usize {
        self.buffer.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_in_fragments() {
        let first = encode(b"{\"type\":\"a\"}").expect("encode");
        let second = encode(b"{\"type\":\"b\"}").expect("encode");
        let mut stream = first.clone();
        stream.extend_from_slice(&second);
        let mut decoder = FrameDecoder::new();
        let mut out = Vec::new();
        for byte in stream {
            decoder.push(&[byte]);
            while let Some(frame) = decoder.next_frame().expect("valid") {
                out.push(frame);
            }
        }
        assert_eq!(out, vec![b"{\"type\":\"a\"}".to_vec(), b"{\"type\":\"b\"}".to_vec()]);
        assert_eq!(decoder.pending_bytes(), 0);
    }

    #[test]
    fn rejects_empty_and_oversized_before_buffering() {
        assert_eq!(encode(b""), Err(FrameError::Empty));
        assert_eq!(encode(&vec![b'x'; MAX_FRAME_BYTES + 1]), Err(FrameError::TooLarge(MAX_FRAME_BYTES + 1)));
        let mut decoder = FrameDecoder::new();
        decoder.push(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes());
        assert!(matches!(decoder.next_frame(), Err(FrameError::TooLarge(_))));
        assert!(decoder.next_frame().is_err(), "decoder stays failed");

        let mut decoder = FrameDecoder::new();
        decoder.push(&0u32.to_be_bytes());
        assert_eq!(decoder.next_frame(), Err(FrameError::Empty));
    }

    #[test]
    fn maximum_frame_is_accepted() {
        assert!(check_length((MAX_FRAME_BYTES as u32).to_be_bytes()).is_ok());
    }
}
