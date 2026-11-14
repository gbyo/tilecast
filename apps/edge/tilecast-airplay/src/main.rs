//! `tilecast-airplay`: see the library documentation.

use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "tilecast-airplay", version = edge_platform::RELEASE_VERSION, about = "The Tilecast Edge AirPlay supervisor")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve tilecastd on the socket that systemd passes
    /// (tilecast-airplay.service).
    Serve,
}

fn main() -> ExitCode {
    let Cli { command: Command::Serve } = Cli::parse();
    tracing_subscriber::fmt().json().with_writer(std::io::stderr).with_target(false).init();
    #[cfg(target_os = "linux")]
    {
        let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("tilecast-airplay: {error}");
                return ExitCode::FAILURE;
            }
        };
        runtime.block_on(linux_main::serve())
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("tilecast-airplay runs only on Linux");
        ExitCode::FAILURE
    }
}

#[cfg(target_os = "linux")]
mod linux_main {
    use std::path::PathBuf;
    use std::process::ExitCode;

    use tilecast_airplay::supervisor::{Config, DaemonOnly, IDLE_EXIT, Supervisor, SystemAvahi};

    fn fail(message: &str) -> ExitCode {
        eprintln!("tilecast-airplay: {message}");
        ExitCode::FAILURE
    }

    pub async fn serve() -> ExitCode {
        if rustix::process::geteuid().is_root() {
            return fail("refusing to run as root");
        }
        // The release's own UxPlay, next to this program.
        let uxplay = match std::env::current_exe() {
            Ok(exe) => match exe.parent() {
                Some(bin) => bin.join("uxplay"),
                None => return fail("cannot locate the release's bin directory"),
            },
            Err(error) => return fail(&error.to_string()),
        };
        // systemd sets RUNTIME_DIRECTORY from RuntimeDirectory=. Only the
        // first directory is the session directory.
        let Some(session_dir) = std::env::var_os("RUNTIME_DIRECTORY")
            .and_then(|value| value.to_str().and_then(|v| v.split(':').next()).map(PathBuf::from))
            .filter(|dir| dir.is_absolute())
        else {
            return fail("RUNTIME_DIRECTORY is not set; run this from tilecast-airplay.service");
        };
        let Some(tilecast_uid) = edge_platform::peer::account_uid("tilecast") else {
            return fail("the tilecast account does not exist");
        };
        let listener = match edge_platform::activation::take_listen_socket()
            .map(std::os::unix::net::UnixListener::from)
            .map_err(|e| e.to_string())
            .and_then(|listener| {
                listener.set_nonblocking(true).map_err(|e| e.to_string())?;
                tokio::net::UnixListener::from_std(listener).map_err(|e| e.to_string())
            }) {
            Ok(listener) => listener,
            Err(error) => return fail(&error),
        };
        let supervisor = Supervisor::new(Config::new(uxplay, session_dir), Box::new(SystemAvahi));
        supervisor.serve(listener, &DaemonOnly { tilecast_uid }, IDLE_EXIT).await;
        ExitCode::SUCCESS
    }
}
