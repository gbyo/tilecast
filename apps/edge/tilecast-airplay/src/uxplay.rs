//! What the supervisor gives UxPlay and what it reads back. Nothing here
//! performs I/O.
//!
//! The options come from typed, validated values only (threat review §5):
//!
//! * The receiver name, the PIN and the device ID go into the `-rc` startup
//!   file ([`rc_file`]), never into a process argument.
//! * The argument vector ([`arguments`]) is a fixed list. The `-vrtp` and
//!   `-artp` pipeline strings come from a fixed template whose only values
//!   are the two fixed ports.
//!
//! UxPlay 1.73.7 facts that this module depends on (`uxplay.cpp`,
//! `renderers/video_renderer.c`, `renderers/audio_renderer.c`):
//!
//! * `-rc <file>` is read before the command line, and the command line is
//!   parsed after it. A missing `-rc` file makes UxPlay exit with status 0; a
//!   file it cannot open is ignored.
//! * `-pin` without a value turns on PIN pairing and keeps a PIN that the
//!   `-rc` file set. The argument vector carries a bare `-pin`, so if UxPlay
//!   did not read the file, it still requires a PIN (a random one that no
//!   one sees) and no sender can connect.
//! * `-vrtp` replaces the decoder and the sink with `rtph264pay <options>`,
//!   so UxPlay does not draw. `-vs 0` must not be used: it turns video off,
//!   and then the RTP pipeline is never built. `-vs fakesink` keeps a sink
//!   that cannot draw for any path that does not use RTP.
//! * `-artp` replaces the audio sink with `rtpL16pay <options>`.
//! * In `-pin` mode UxPlay answers a wrong PIN with RTSP 470 and lets the
//!   sender try again, with no limit (`MAX_PW_ATTEMPTS` applies only to
//!   `-pw`). The supervisor counts the failures ([`OutputEvent::
//!   AuthenticationFailed`]) and ends the session at a limit.
//! * UxPlay prints the PIN on its output when a sender starts pairing. The
//!   supervisor therefore never logs or forwards a line of UxPlay output; it
//!   only classifies lines ([`classify`]).

use edge_protocol::airplay::{
    AUDIO_RTP_PORT, AirplayDeviceId, AirplayPin, AudioMode, ReceiverName, UXPLAY_PORTS, VIDEO_RTP_PORT, VideoProfile,
};

/// The largest UxPlay output line that the supervisor classifies. The rest
/// of a longer line is read and dropped.
pub const MAX_OUTPUT_LINE: usize = 1024;

/// The session values that go into the `-rc` file.
#[derive(Debug, Clone)]
pub struct SessionOptions {
    pub receiver_name: ReceiverName,
    pub pin: AirplayPin,
    pub device_id: AirplayDeviceId,
    pub profile: VideoProfile,
    pub audio_mode: AudioMode,
}

/// The `-rc` file text. One option per line, without the leading `-`.
pub fn rc_file(options: &SessionOptions) -> String {
    let quote = options.receiver_name.rc_quote();
    format!(
        "n {quote}{name}{quote}\nnh\npin {pin}\nm {mac}\n",
        name = options.receiver_name.as_str(),
        pin = options.pin.expose(),
        mac = options.device_id.expose(),
    )
}

/// The UxPlay argument vector, without the program name.
pub fn arguments(options: &SessionOptions, rc_path: &str) -> Vec<String> {
    let (width, height, fps) = options.profile.dimensions();
    let mut args: Vec<String> = vec![
        "-rc".into(),
        rc_path.into(),
        // A bare -pin: see the module documentation. The next argument must
        // start with '-'.
        "-pin".into(),
        "-p".into(),
        UXPLAY_PORTS.map(|port| port.to_string()).join(","),
        "-s".into(),
        format!("{width}x{height}"),
        "-fps".into(),
        fps.to_string(),
        "-vs".into(),
        "fakesink".into(),
        "-vrtp".into(),
        format!("config-interval=1 ! udpsink host=127.0.0.1 port={VIDEO_RTP_PORT}"),
    ];
    match options.audio_mode {
        AudioMode::GatewayOnly => {
            args.push("-artp".into());
            args.push(format!("pt=96 ! udpsink host=127.0.0.1 port={AUDIO_RTP_PORT}"));
        }
        AudioMode::None => {
            args.push("-as".into());
            args.push("0".into());
        }
    }
    args
}

/// What a UxPlay output line means to the supervisor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputEvent {
    /// UxPlay's server sockets are open (`httpd.c`).
    Ready,
    /// A sender started mirroring (`raop_rtp_mirror.c`).
    Mirroring,
    /// The mirror stream stopped or the connection was lost.
    Disconnected,
    /// A sender's PIN proof failed (`raop_handlers.h`, pair-setup-pin).
    AuthenticationFailed,
}

/// Classifies one output line with a fixed grammar. Any other line means
/// nothing and is dropped.
pub fn classify(line: &[u8]) -> Option<OutputEvent> {
    let line = line.get(..MAX_OUTPUT_LINE).unwrap_or(line);
    let contains = |needle: &[u8]| line.windows(needle.len()).any(|window| window == needle);
    if contains(b"Initialized server socket(s)") {
        Some(OutputEvent::Ready)
    } else if contains(b"raop_rtp_mirror starting mirroring") {
        Some(OutputEvent::Mirroring)
    } else if contains(b"raop_rtp_mirror->running is no longer true") || contains(b"lost connection with client") {
        Some(OutputEvent::Disconnected)
    } else if contains(b"Client Authentication Failure (client proof not validated)")
        || contains(b"pair-pin-setup (step 3): client authentication failed")
    {
        Some(OutputEvent::AuthenticationFailed)
    } else {
        None
    }
}

/// The version in `uxplay -v` output (`UxPlay version 1.73.7; ...`).
pub fn parse_version(output: &str) -> Option<String> {
    let lower = output.to_ascii_lowercase();
    let start = lower.find("uxplay")? + "uxplay".len();
    let rest = &output[start..];
    let digits = rest.find(|c: char| c.is_ascii_digit())?;
    if rest[..digits].contains('\n') {
        return None;
    }
    let version: String = rest[digits..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').take(32).collect();
    let version = version.trim_end_matches('.');
    let parts: Vec<&str> = version.split('.').collect();
    let valid = (2..=3).contains(&parts.len()) && parts.iter().all(|p| !p.is_empty() && p.len() <= 5);
    valid.then(|| version.to_owned())
}

/// Whether `version` is at least `baseline`, by numeric parts.
pub fn version_at_least(version: &str, baseline: &str) -> bool {
    let parse = |value: &str| value.split('.').map(|part| part.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>();
    let (actual, expected) = (parse(version), parse(baseline));
    for index in 0..actual.len().max(expected.len()) {
        let (left, right) = (actual.get(index).copied().unwrap_or(0), expected.get(index).copied().unwrap_or(0));
        if left != right {
            return left > right;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(name: &str, audio_mode: AudioMode) -> SessionOptions {
        SessionOptions {
            receiver_name: ReceiverName::new(name).unwrap(),
            pin: AirplayPin::new("4096").unwrap(),
            device_id: AirplayDeviceId::new("02:11:22:33:44:55").unwrap(),
            profile: VideoProfile::P720p30,
            audio_mode,
        }
    }

    #[test]
    fn secrets_go_only_into_the_rc_file() {
        let options = options("Lobby North", AudioMode::GatewayOnly);
        let args = arguments(&options, "/run/tilecast-airplay-session/session.rc");
        let joined = args.join(" ");
        assert!(!joined.contains("4096") && !joined.contains("02:11:22") && !joined.contains("Lobby"), "{joined}");
        assert_eq!(rc_file(&options), "n \"Lobby North\"\nnh\npin 4096\nm 02:11:22:33:44:55\n");
    }

    #[test]
    fn a_name_with_a_double_quote_is_enclosed_in_single_quotes() {
        let rc = rc_file(&options("Room \"A\" East", AudioMode::None));
        assert!(rc.starts_with("n 'Room \"A\" East'\n"), "{rc}");
    }

    #[test]
    fn the_argument_vector_is_fixed() {
        let args = arguments(&options("Lobby", AudioMode::GatewayOnly), "/run/x/session.rc");
        assert_eq!(
            args,
            [
                "-rc",
                "/run/x/session.rc",
                "-pin",
                "-p",
                "37000,37001,37002",
                "-s",
                "1280x720",
                "-fps",
                "30",
                "-vs",
                "fakesink",
                "-vrtp",
                "config-interval=1 ! udpsink host=127.0.0.1 port=42000",
                "-artp",
                "pt=96 ! udpsink host=127.0.0.1 port=42002",
            ]
        );
        // The bare -pin must be followed by an option, or UxPlay would read
        // the next argument as the PIN.
        let pin = args.iter().position(|arg| arg == "-pin").unwrap();
        assert!(args[pin + 1].starts_with('-'));
        let silent = arguments(&options("Lobby", AudioMode::None), "/run/x/session.rc");
        assert_eq!(&silent[silent.len() - 2..], ["-as", "0"]);
        assert!(!silent.iter().any(|arg| arg == "-artp"));
        // -vs 0 would turn video off and with it the RTP forward.
        for pair in [&args, &silent] {
            assert!(!pair.windows(2).any(|w| w[0] == "-vs" && w[1] == "0"));
        }
    }

    #[test]
    fn output_lines_are_classified_by_a_fixed_grammar() {
        assert_eq!(classify(b"Initialized server socket(s)"), Some(OutputEvent::Ready));
        assert_eq!(classify(b"raop_rtp_mirror starting mirroring"), Some(OutputEvent::Mirroring));
        assert_eq!(classify(b"raop_rtp_mirror->running is no longer true"), Some(OutputEvent::Disconnected));
        assert_eq!(
            classify(b"*** ERROR lost connection with client (network problem?)"),
            Some(OutputEvent::Disconnected)
        );
        assert_eq!(
            classify(b"Client Authentication Failure (client proof not validated)"),
            Some(OutputEvent::AuthenticationFailed)
        );
        assert_eq!(classify(b"*** CLIENT MUST NOW ENTER PIN = \"4096\" AS AIRPLAY PASSWORD"), None);
        assert_eq!(classify(b""), None);
        let mut long = vec![b'x'; MAX_OUTPUT_LINE];
        long.extend_from_slice(b"raop_rtp_mirror starting mirroring");
        assert_eq!(classify(&long), None);
    }

    #[test]
    fn versions_are_parsed_and_compared() {
        assert_eq!(parse_version("UxPlay version 1.73.7; for help, use option \"-h\"\n").as_deref(), Some("1.73.7"));
        assert_eq!(parse_version("uxplay 1.73").as_deref(), Some("1.73"));
        assert_eq!(parse_version("UxPlay\n1.73.7"), None);
        assert_eq!(parse_version("no version here"), None);
        assert!(version_at_least("1.73.7", "1.73.7"));
        assert!(version_at_least("1.74", "1.73.7"));
        assert!(!version_at_least("1.73.6", "1.73.7"));
    }
}
