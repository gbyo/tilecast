//! Newline-delimited messages with a bound on each line, for the line
//! protocols of the Edge helpers (`edge_protocol::airplay`) and for reading
//! the output of a supervised program.

use tokio::io::{AsyncBufRead, AsyncBufReadExt as _};

/// One read line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    /// A line without its newline.
    Complete(Vec<u8>),
    /// A line longer than the bound. Its rest has been read and dropped.
    TooLong,
    End,
}

/// Reads lines of at most `max` bytes, the newline included. The rest of a
/// longer line is consumed and dropped. A last line without a newline counts
/// as a line.
///
/// [`Self::next`] is cancel-safe: a `select!` may drop it at any time. The
/// partial line and the overflow state belong to the reader, not to the
/// call, so no byte that the reader consumed is lost.
#[derive(Debug)]
pub struct LineReader<R> {
    reader: R,
    max: usize,
    line: Vec<u8>,
    overflow: bool,
}

impl<R: AsyncBufRead + Unpin> LineReader<R> {
    pub fn new(reader: R, max: usize) -> Self {
        Self { reader, max, line: Vec::new(), overflow: false }
    }

    pub async fn next(&mut self) -> Line {
        loop {
            // The only await point. Everything after it runs without a
            // yield, so a dropped call never leaves a half-applied step.
            let available = match self.reader.fill_buf().await {
                Ok(available) => available,
                Err(_) => {
                    self.line.clear();
                    self.overflow = false;
                    return Line::End;
                }
            };
            if available.is_empty() {
                let overflow = std::mem::take(&mut self.overflow);
                let line = std::mem::take(&mut self.line);
                return match (line.is_empty(), overflow) {
                    (_, true) => Line::TooLong,
                    (true, false) => Line::End,
                    (false, false) => Line::Complete(line),
                };
            }
            let (chunk, done) = match available.iter().position(|b| *b == b'\n') {
                Some(index) => (&available[..=index], true),
                None => (available, false),
            };
            let used = chunk.len();
            if !self.overflow {
                if self.line.len() + chunk.len() > self.max {
                    self.overflow = true;
                    self.line.clear();
                } else {
                    self.line.extend_from_slice(chunk);
                }
            }
            self.reader.consume(used);
            if done {
                if std::mem::take(&mut self.overflow) {
                    return Line::TooLong;
                }
                let mut line = std::mem::take(&mut self.line);
                line.pop();
                return Line::Complete(line);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncWriteExt as _, BufReader};

    use super::*;

    async fn lines(input: &[u8], max: usize) -> Vec<Option<Vec<u8>>> {
        let mut reader = LineReader::new(BufReader::with_capacity(4, input), max);
        let mut out = Vec::new();
        loop {
            match reader.next().await {
                Line::End => return out,
                Line::TooLong => out.push(None),
                Line::Complete(line) => out.push(Some(line)),
            }
        }
    }

    #[tokio::test]
    async fn lines_are_bounded_and_the_rest_of_a_long_line_is_dropped() {
        let got = lines(b"one\nmuch-too-long-line\ntwo\nlast", 8).await;
        assert_eq!(got, vec![Some(b"one".to_vec()), None, Some(b"two".to_vec()), Some(b"last".to_vec())], "{got:?}");
        assert_eq!(lines(b"", 8).await, Vec::<Option<Vec<u8>>>::new());
        assert_eq!(lines(b"1234567\n", 8).await, vec![Some(b"1234567".to_vec())]);
        assert_eq!(lines(b"12345678\n", 8).await, vec![None]);
    }

    /// A `select!` arm that loses the race drops the read. The next read must
    /// still return the whole line.
    #[tokio::test]
    async fn a_cancelled_read_loses_no_bytes() {
        let (mut client, server) = tokio::io::duplex(64);
        let mut reader = LineReader::new(BufReader::new(server), 4096);
        client.write_all(b"{\"type\":\"adv").await.unwrap();
        let cancelled = tokio::time::timeout(std::time::Duration::from_millis(50), reader.next()).await;
        assert!(cancelled.is_err(), "the read waits for the rest of the line");
        client.write_all(b"ertising\"}\n").await.unwrap();
        assert_eq!(reader.next().await, Line::Complete(b"{\"type\":\"advertising\"}".to_vec()));
    }

    #[tokio::test]
    async fn a_cancelled_read_keeps_the_overflow_state() {
        let (mut client, server) = tokio::io::duplex(64);
        let mut reader = LineReader::new(BufReader::new(server), 8);
        client.write_all(b"much-too-long").await.unwrap();
        let cancelled = tokio::time::timeout(std::time::Duration::from_millis(50), reader.next()).await;
        assert!(cancelled.is_err());
        client.write_all(b"-line\nok\n").await.unwrap();
        assert_eq!(reader.next().await, Line::TooLong, "the rest of the long line is still dropped");
        assert_eq!(reader.next().await, Line::Complete(b"ok".to_vec()));
    }
}
