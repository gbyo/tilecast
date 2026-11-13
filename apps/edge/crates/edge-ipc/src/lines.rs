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

/// Reads one line of at most `max` bytes, the newline included. The rest of
/// a longer line is consumed and dropped. A last line without a newline
/// counts as a line.
pub async fn read_line(reader: &mut (impl AsyncBufRead + Unpin), max: usize) -> Line {
    let mut line = Vec::new();
    let mut overflow = false;
    loop {
        let available = match reader.fill_buf().await {
            Ok(available) => available,
            Err(_) => return Line::End,
        };
        if available.is_empty() {
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
        if !overflow {
            if line.len() + chunk.len() > max {
                overflow = true;
                line.clear();
            } else {
                line.extend_from_slice(chunk);
            }
        }
        reader.consume(used);
        if done {
            if overflow {
                return Line::TooLong;
            }
            line.pop();
            return Line::Complete(line);
        }
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::BufReader;

    use super::*;

    async fn lines(input: &[u8], max: usize) -> Vec<Option<Vec<u8>>> {
        let mut reader = BufReader::with_capacity(4, input);
        let mut out = Vec::new();
        loop {
            match read_line(&mut reader, max).await {
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
}
