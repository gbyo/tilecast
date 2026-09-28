//! `tilecast-edge-migrate`: see the library documentation and
//! `apps/edge/packaging/README.md`.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(
    name = "tilecast-edge-migrate",
    version,
    about = "Install Tilecast Edge and migrate from the Electron player"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum BackendArg {
    Drm,
    /// The systemd integration test only.
    #[cfg(feature = "integration-test")]
    Headless,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Verify a signed, unpacked release and install it under
    /// /opt/tilecast-edge/<version>/, with its units, without enabling them.
    Install {
        /// The unpacked release (holds tilecast-edge-release.json and .sig).
        #[arg(long, value_name = "DIR")]
        from: PathBuf,
    },
    /// Migrate this screen from the Electron player (runs as a service and
    /// prints its progress).
    Migrate {
        /// The legacy player's kiosk login account.
        #[arg(long, value_name = "USER")]
        kiosk: String,
        #[arg(long, value_enum, default_value = "drm")]
        backend: BackendArg,
        /// Settlement deadline (120 to 3600).
        #[arg(long, default_value_t = tilecast_edge_migrate::migrate::DEFAULT_SETTLE_SECONDS)]
        settle_seconds: u64,
    },
    /// Start Edge on a machine that has no legacy player.
    CleanInstall {
        #[arg(long, value_enum, default_value = "drm")]
        backend: BackendArg,
        #[arg(long, default_value_t = tilecast_edge_migrate::migrate::DEFAULT_SETTLE_SECONDS)]
        settle_seconds: u64,
    },
    /// The service entry point: runs the requested attempt.
    Run,
    /// Finish or undo an interrupted attempt (boot, and after the service).
    Recover,
    /// Roll back during the rollback window.
    Rollback,
    /// Print the current attempt.
    Status,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    tracing_subscriber::fmt().with_writer(std::io::stderr).with_target(false).init();
    #[cfg(target_os = "linux")]
    {
        if !rustix::process::geteuid().is_root() && !matches!(cli.command, Command::Status) {
            eprintln!("tilecast-edge-migrate: run this as root");
            return ExitCode::from(2);
        }
        let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("tilecast-edge-migrate: {error}");
                return ExitCode::FAILURE;
            }
        };
        runtime.block_on(linux_main::run(cli))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = cli;
        eprintln!("tilecast-edge-migrate runs only on Linux");
        ExitCode::FAILURE
    }
}

#[cfg(target_os = "linux")]
mod linux_main {
    use std::path::Path;
    use std::process::ExitCode;
    use std::time::Duration;

    use serde::{Deserialize, Serialize};
    use tilecast_edge_migrate::host::{Host, MIGRATE_UNIT};
    use tilecast_edge_migrate::linux::LinuxHost;
    use tilecast_edge_migrate::migrate::{MigrateError, Migrator, Options};
    use tilecast_edge_migrate::release::{InstallOutcome, Layout, install};
    use tilecast_edge_migrate::state::{
        Attempt, Backend, Kind, MigrationLock, Phase, RUN_DIR, STATE_DIR, StateStore, write_atomic,
    };

    use super::{BackendArg, Cli, Command};

    const REQUEST: &str = "request.json";

    #[derive(Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        kind: Kind,
        kiosk_user: Option<String>,
        backend: Backend,
        settle_seconds: u64,
    }

    fn backend(arg: BackendArg) -> Backend {
        match arg {
            BackendArg::Drm => Backend::Drm,
            #[cfg(feature = "integration-test")]
            BackendArg::Headless => Backend::Headless,
        }
    }

    fn print_attempt(attempt: &Attempt) {
        println!("{}", serde_json::to_string_pretty(attempt).unwrap_or_default());
    }

    fn outcome_code(attempt: &Attempt) -> ExitCode {
        if attempt.phase == Phase::Accepted { ExitCode::SUCCESS } else { ExitCode::FAILURE }
    }

    fn crash_point() -> Option<tilecast_edge_migrate::migrate::CrashPoint> {
        #[cfg(feature = "integration-test")]
        {
            std::env::var("TILECAST_MIGRATE_CRASH_AT")
                .ok()
                .and_then(|value| tilecast_edge_migrate::migrate::CrashPoint::parse(&value))
        }
        #[cfg(not(feature = "integration-test"))]
        None
    }

    pub async fn run(cli: Cli) -> ExitCode {
        let store = StateStore::new(STATE_DIR);
        match cli.command {
            Command::Status => match store.load() {
                Ok(Some(attempt)) => {
                    print_attempt(&attempt);
                    ExitCode::SUCCESS
                }
                Ok(None) => {
                    println!("no migration attempt");
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("tilecast-edge-migrate: {error}");
                    ExitCode::FAILURE
                }
            },
            Command::Install { from } => match install(&from, &Layout::system()) {
                Ok((outcome, release)) => {
                    let host = match LinuxHost::connect(Layout::system()).await {
                        Ok(host) => host,
                        Err(error) => {
                            eprintln!("tilecast-edge-migrate: {error}");
                            return ExitCode::FAILURE;
                        }
                    };
                    match host.install_system_configuration().await {
                        Ok(warnings) => {
                            for warning in warnings {
                                eprintln!("tilecast-edge-migrate: warning: {warning}");
                            }
                        }
                        Err(error) => {
                            eprintln!("tilecast-edge-migrate: {error}");
                            return ExitCode::FAILURE;
                        }
                    }
                    let version = match outcome {
                        InstallOutcome::Installed { version, .. } => format!("installed {version}"),
                        InstallOutcome::AlreadyInstalled { version } => format!("{version} was already installed"),
                    };
                    println!(
                        "{version} (manifest sha256 {}); units are installed and not enabled",
                        release.manifest_sha256
                    );
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("tilecast-edge-migrate: {error} ({})", error.reason_code());
                    ExitCode::FAILURE
                }
            },
            Command::Migrate { kiosk, backend: arg, settle_seconds } => {
                let request =
                    Request { kind: Kind::Migration, kiosk_user: Some(kiosk), backend: backend(arg), settle_seconds };
                start_service(&store, &request).await
            }
            Command::CleanInstall { backend: arg, settle_seconds } => {
                let request =
                    Request { kind: Kind::CleanInstall, kiosk_user: None, backend: backend(arg), settle_seconds };
                start_service(&store, &request).await
            }
            Command::Run => {
                let Ok(_lock) = MigrationLock::acquire(Path::new(RUN_DIR)) else {
                    eprintln!("tilecast-edge-migrate: another migration is running");
                    return ExitCode::FAILURE;
                };
                let request = match edge_platform::fs::read_regular(&store.dir().join(REQUEST), 64 * 1024) {
                    Ok(Some(bytes)) => serde_json::from_slice::<Request>(&bytes).ok(),
                    _ => None,
                };
                let _ = std::fs::remove_file(store.dir().join(REQUEST));
                let Some(request) = request else {
                    eprintln!("tilecast-edge-migrate: no valid request; use `migrate` or `clean-install`");
                    return ExitCode::FAILURE;
                };
                let host = match LinuxHost::connect(Layout::system()).await {
                    Ok(host) => host,
                    Err(error) => {
                        eprintln!("tilecast-edge-migrate: {error}");
                        return ExitCode::FAILURE;
                    }
                };
                let options = Options {
                    kind: request.kind,
                    kiosk_user: request.kiosk_user,
                    backend: request.backend,
                    settle_seconds: request.settle_seconds,
                };
                let migrator = Migrator::new(&host, store.clone()).crash_at(crash_point());
                report(migrator.run(&options).await)
            }
            Command::Recover => {
                let Ok(_lock) = MigrationLock::acquire(Path::new(RUN_DIR)) else {
                    eprintln!("tilecast-edge-migrate: a migration is running; it recovers on its own");
                    return ExitCode::SUCCESS;
                };
                let host = match LinuxHost::connect(Layout::system()).await {
                    Ok(host) => host,
                    Err(error) => {
                        eprintln!("tilecast-edge-migrate: {error}");
                        return ExitCode::FAILURE;
                    }
                };
                match Migrator::new(&host, store).recover().await {
                    Ok(Some(attempt)) => {
                        print_attempt(&attempt);
                        ExitCode::SUCCESS
                    }
                    Ok(None) => ExitCode::SUCCESS,
                    Err(error) => {
                        eprintln!("tilecast-edge-migrate: {error}");
                        ExitCode::FAILURE
                    }
                }
            }
            Command::Rollback => {
                let host = match LinuxHost::connect(Layout::system()).await {
                    Ok(host) => host,
                    Err(error) => {
                        eprintln!("tilecast-edge-migrate: {error}");
                        return ExitCode::FAILURE;
                    }
                };
                // A running attempt is stopped; its service's ExecStopPost
                // runs the recovery, which rolls back.
                if MigrationLock::acquire(Path::new(RUN_DIR)).is_err() {
                    let _ = host.stop(MIGRATE_UNIT).await;
                }
                let Ok(_lock) = MigrationLock::acquire(Path::new(RUN_DIR)) else {
                    eprintln!("tilecast-edge-migrate: the migration service did not stop");
                    return ExitCode::FAILURE;
                };
                report(Migrator::new(&host, store).operator_rollback().await.map(|a| a.unwrap_or_else(no_attempt)))
            }
        }
    }

    fn no_attempt() -> Attempt {
        eprintln!("tilecast-edge-migrate: no migration attempt");
        std::process::exit(1);
    }

    fn report(result: Result<Attempt, MigrateError>) -> ExitCode {
        match result {
            Ok(attempt) => {
                print_attempt(&attempt);
                outcome_code(&attempt)
            }
            Err(error) => {
                eprintln!("tilecast-edge-migrate: {error}");
                ExitCode::FAILURE
            }
        }
    }

    /// Writes the request, starts the migration service and follows the
    /// attempt until it ends. An SSH disconnect stops only this follower.
    async fn start_service(store: &StateStore, request: &Request) -> ExitCode {
        if let Ok(Some(attempt)) = store.load()
            && !attempt.phase.is_terminal()
        {
            eprintln!("tilecast-edge-migrate: an unfinished attempt exists; run `tilecast-edge-migrate recover`");
            return ExitCode::FAILURE;
        }
        let host = match LinuxHost::connect(Layout::system()).await {
            Ok(host) => host,
            Err(error) => {
                eprintln!("tilecast-edge-migrate: {error}");
                return ExitCode::FAILURE;
            }
        };
        let previous = store.load().ok().flatten().map(|a| a.attempt_id);
        if let Err(error) = store
            .ensure()
            .map_err(|e| e.to_string())
            .and_then(|()| serde_json::to_vec(request).map_err(|e| e.to_string()))
            .and_then(|bytes| write_atomic(store.dir(), REQUEST, &bytes).map_err(|e| e.to_string()))
        {
            eprintln!("tilecast-edge-migrate: {error}");
            return ExitCode::FAILURE;
        }
        if let Err(error) = host.start_detached(MIGRATE_UNIT).await {
            eprintln!("tilecast-edge-migrate: {error}");
            return ExitCode::FAILURE;
        }
        let mut last = None;
        let mut waited = 0u32;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            waited += 1;
            let current = store.load().ok().flatten().filter(|a| Some(&a.attempt_id) != previous.as_ref());
            let Some(attempt) = current else {
                // The service ended without starting an attempt.
                if waited > 15 && !host.unit(MIGRATE_UNIT).await.is_ok_and(|u| u.active) {
                    eprintln!("tilecast-edge-migrate: the migration service stopped; see journalctl -u {MIGRATE_UNIT}");
                    return ExitCode::FAILURE;
                }
                continue;
            };
            let line = attempt.events.last().map(|e| format!("{:?}: {}", attempt.phase, e.detail));
            if line != last {
                if let Some(line) = &line {
                    println!("{line}");
                }
                last = line;
            }
            if attempt.phase.is_terminal() {
                print_attempt(&attempt);
                return outcome_code(&attempt);
            }
        }
    }
}
