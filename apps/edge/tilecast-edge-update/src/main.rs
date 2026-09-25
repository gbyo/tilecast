//! `tilecast-edge-update`: see the library documentation and
//! `apps/edge/packaging/README.md`.

use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "tilecast-edge-update", version, about = "The Tilecast Edge update helper")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve tilecastd's requests on the socket systemd passes
    /// (tilecast-edge-update.service).
    Serve,
    /// Finish or undo an interrupted operation, and roll back a candidate
    /// that did not confirm (tilecast-edge-update-guard.service).
    Guard,
    /// Print the installed releases and the update transaction.
    Status,
    /// Return to the previous release while an update is provisional.
    Rollback,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    tracing_subscriber::fmt().json().with_writer(std::io::stderr).with_target(false).init();
    #[cfg(target_os = "linux")]
    {
        if !rustix::process::geteuid().is_root() {
            eprintln!("tilecast-edge-update: run this as root");
            return ExitCode::from(2);
        }
        let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("tilecast-edge-update: {error}");
                return ExitCode::FAILURE;
            }
        };
        runtime.block_on(linux_main::run(cli))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = cli;
        eprintln!("tilecast-edge-update runs only on Linux");
        ExitCode::FAILURE
    }
}

#[cfg(target_os = "linux")]
mod linux_main {
    use std::path::{Path, PathBuf};
    use std::process::ExitCode;
    use std::time::Duration;

    use edge_release::install::Layout;
    use tilecast_edge_update::linux::LinuxHost;
    use tilecast_edge_update::server::{DaemonOnly, IDLE_EXIT, serve};
    use tilecast_edge_update::transaction::{STATE_DIR, TransactionStore, UpdateLock};
    use tilecast_edge_update::updater::{CrashPoint, HelperPaths, Updater, WORK_RESERVE_BYTES};

    use super::{Cli, Command};

    const CAS_ROOT: &str = "/var/lib/tilecast-edge/cas";
    const LOCK_WAIT: Duration = Duration::from_secs(300);

    fn tilecast_uid() -> Option<u32> {
        let bytes = edge_platform::fs::read_regular(Path::new("/etc/passwd"), 4 * 1024 * 1024).ok()??;
        String::from_utf8_lossy(&bytes).lines().find_map(|line| {
            let fields: Vec<&str> = line.split(':').collect();
            (fields.len() == 7 && fields[0] == "tilecast").then(|| fields[2].parse().ok())?
        })
    }

    fn crash_point() -> Option<CrashPoint> {
        #[cfg(feature = "integration-test")]
        {
            std::env::var("TILECAST_UPDATE_CRASH_AT").ok().and_then(|value| CrashPoint::parse(&value))
        }
        #[cfg(not(feature = "integration-test"))]
        None
    }

    fn print(value: &impl serde::Serialize) {
        println!("{}", serde_json::to_string_pretty(value).unwrap_or_default());
    }

    pub async fn run(cli: Cli) -> ExitCode {
        let layout = Layout::system();
        let key = match layout.key() {
            Ok(key) => key,
            Err(error) => {
                eprintln!("tilecast-edge-update: {error}");
                return ExitCode::FAILURE;
            }
        };
        let Some(uid) = tilecast_uid() else {
            eprintln!("tilecast-edge-update: the tilecast account does not exist");
            return ExitCode::FAILURE;
        };
        let host = match LinuxHost::connect(&layout.unit_dir, &layout.install_root).await {
            Ok(host) => host,
            Err(error) => {
                eprintln!("tilecast-edge-update: {error}");
                return ExitCode::FAILURE;
            }
        };
        let store = TransactionStore::new(STATE_DIR);
        let paths = HelperPaths {
            cas_root: PathBuf::from(CAS_ROOT),
            tilecast_uid: Some(uid),
            reserve_bytes: WORK_RESERVE_BYTES,
        };
        let updater = Updater::new(&host, layout, store.clone(), key, paths).crash_at(crash_point());
        match cli.command {
            Command::Status => {
                print(&updater.status());
                ExitCode::SUCCESS
            }
            Command::Serve => {
                let listener = match edge_platform::activation::take_listen_socket()
                    .map(std::os::unix::net::UnixListener::from)
                    .map_err(|e| e.to_string())
                    .and_then(|listener| {
                        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
                        tokio::net::UnixListener::from_std(listener).map_err(|e| e.to_string())
                    }) {
                    Ok(listener) => listener,
                    Err(error) => {
                        eprintln!("tilecast-edge-update: {error}");
                        return ExitCode::FAILURE;
                    }
                };
                // Whatever the previous helper process left unfinished is
                // settled before a new request is served.
                if let Ok(_lock) = UpdateLock::acquire(store.dir(), LOCK_WAIT).await
                    && let Err(error) = updater.guard().await
                {
                    tracing::error!(component = "update", event = "recovery_failed", error = %error);
                }
                serve(listener, &updater, &DaemonOnly { tilecast_uid: uid }, IDLE_EXIT).await;
                ExitCode::SUCCESS
            }
            Command::Guard => {
                let Ok(_lock) = UpdateLock::acquire(store.dir(), LOCK_WAIT).await else {
                    eprintln!("tilecast-edge-update: another update operation holds the lock");
                    return ExitCode::FAILURE;
                };
                match updater.guard().await {
                    Ok(transaction) => {
                        if let Some(transaction) = transaction {
                            print(&transaction);
                        }
                        ExitCode::SUCCESS
                    }
                    Err(error) => {
                        eprintln!("tilecast-edge-update: {error}");
                        ExitCode::FAILURE
                    }
                }
            }
            Command::Rollback => {
                let Ok(_lock) = UpdateLock::acquire(store.dir(), LOCK_WAIT).await else {
                    eprintln!("tilecast-edge-update: another update operation holds the lock");
                    return ExitCode::FAILURE;
                };
                match updater.rollback("operator_requested").await {
                    Ok(transaction) => {
                        print(&transaction);
                        ExitCode::SUCCESS
                    }
                    Err(error) => {
                        eprintln!("tilecast-edge-update: {error} ({})", error.reason_code());
                        ExitCode::FAILURE
                    }
                }
            }
        }
    }
}
