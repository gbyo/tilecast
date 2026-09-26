use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use edge_platform::paths::DEFAULT_CONFIG_FILE;
use edge_platform::systemd::Notifier;
use edge_server::legacy::{ImportMode, ImportOutcome};
use tilecastd::config::EdgeConfig;
use tilecastd::daemon::{Daemon, cancel_on_signal};

#[derive(Debug, Parser)]
#[command(name = "tilecastd", version, about = "Tilecast Edge daemon")]
struct Cli {
    /// Operator configuration file.
    #[arg(long, value_name = "PATH")]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the daemon (default).
    Run,
    /// Validate the configuration file and exit.
    CheckConfig,
    /// Import the legacy Electron Linux Player's state (migration step 8).
    ImportLegacy {
        /// Legacy data directory (default: `legacy.data_dir`, then
        /// `$XDG_DATA_HOME/tilecast-player` or `~/.local/share/tilecast-player`).
        #[arg(long, value_name = "DIR")]
        from: Option<PathBuf>,
        /// Import again even if an import completed (a migration after a
        /// rollback). Executed command keys are only ever added.
        #[arg(long)]
        refresh: bool,
    },
    /// Check the legacy player's cached presentation against this build's
    /// capability profile, offline (migration step 4).
    CheckLegacyCompat {
        #[arg(long, value_name = "DIR")]
        from: PathBuf,
    },
    /// Run the release self-test host until the built-in fixture is proven
    /// on a renderer (migration step 3).
    SelfTest {
        /// The release's self-test fixture.
        #[arg(long, value_name = "PATH")]
        fixture: PathBuf,
        /// Private runtime directory (default: `$RUNTIME_DIRECTORY`).
        #[arg(long, value_name = "DIR")]
        runtime_dir: Option<PathBuf>,
        #[arg(long, value_name = "SECONDS", default_value_t = tilecastd::self_test::DEFAULT_TIMEOUT.as_secs())]
        timeout_seconds: u64,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let explicit = cli.config.is_some();
    let path = cli.config.unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_FILE));
    let config = match EdgeConfig::load(&path, explicit) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("tilecastd: {error}");
            return ExitCode::from(2);
        }
    };
    match cli.command.unwrap_or(Command::Run) {
        Command::CheckConfig => {
            println!("configuration is valid");
            ExitCode::SUCCESS
        }
        Command::Run => run(config),
        Command::ImportLegacy { from, refresh } => import_legacy(config, from, refresh),
        Command::CheckLegacyCompat { from } => check_legacy_compat(&from),
        Command::SelfTest { fixture, runtime_dir, timeout_seconds } => {
            self_test(&config, fixture, runtime_dir, timeout_seconds)
        }
    }
}

fn print_json(value: &impl serde::Serialize) {
    println!("{}", serde_json::to_string(value).unwrap_or_else(|_| "{}".into()));
}

/// Exit codes: 0 the cutover may continue, 3 the presentation is
/// incompatible or invalid, 1 the check could not run.
fn check_legacy_compat(from: &std::path::Path) -> ExitCode {
    if !from.is_absolute() {
        eprintln!("tilecastd: --from must be an absolute path");
        return ExitCode::FAILURE;
    }
    match tilecastd::legacy_compat::check(from) {
        Ok(report) => {
            print_json(&report);
            if report.allows_cutover() { ExitCode::SUCCESS } else { ExitCode::from(3) }
        }
        Err(error) => {
            eprintln!("tilecastd: could not read the legacy state: {error}");
            ExitCode::FAILURE
        }
    }
}

/// Exit codes: 0 passed, 1 failed. The report is printed either way.
fn self_test(config: &EdgeConfig, fixture: PathBuf, runtime_dir: Option<PathBuf>, timeout_seconds: u64) -> ExitCode {
    tilecastd::logging::init(&config.log);
    let runtime_dir = runtime_dir.or_else(|| {
        std::env::var_os("RUNTIME_DIRECTORY")
            .and_then(|value| value.to_str().and_then(|v| v.split(':').next()).map(PathBuf::from))
    });
    let Some(runtime_dir) = runtime_dir.filter(|path| path.is_absolute()) else {
        eprintln!("tilecastd: the self-test needs an absolute --runtime-dir or RUNTIME_DIRECTORY");
        return ExitCode::FAILURE;
    };
    if !fixture.is_absolute() || !tilecastd::self_test::TIMEOUT_RANGE_SECONDS.contains(&timeout_seconds) {
        eprintln!("tilecastd: --fixture must be absolute and --timeout-seconds between 10 and 600");
        return ExitCode::FAILURE;
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("tilecastd: could not start async runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    let timeout = std::time::Duration::from_secs(timeout_seconds);
    let report = runtime.block_on(tilecastd::self_test::run(fixture, runtime_dir, timeout));
    print_json(&report);
    if report.passed() { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

/// Exit codes: 0 imported or already complete, 1 failed (legacy state is
/// untouched; the migrator keeps or restores the legacy player). One JSON
/// line on standard output reports the outcome; it never holds the
/// credential.
fn import_legacy(config: EdgeConfig, from: Option<PathBuf>, refresh: bool) -> ExitCode {
    tilecastd::logging::init(&config.log);
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("tilecastd: could not start async runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    let mode = if refresh { ImportMode::Refresh } else { ImportMode::Once };
    match runtime.block_on(tilecastd::legacy_import::run(&config, from, mode)) {
        Ok(ImportOutcome::Imported(summary)) => {
            print_json(&serde_json::json!({"outcome": "imported", "summary": summary}));
            ExitCode::SUCCESS
        }
        Ok(ImportOutcome::AlreadyComplete) => {
            print_json(&serde_json::json!({"outcome": "already_complete"}));
            ExitCode::SUCCESS
        }
        Err(error) => {
            let reason = tilecastd::legacy_import::failure_reason(&error);
            print_json(&serde_json::json!({"outcome": "failed", "reason": reason}));
            eprintln!("tilecastd: legacy import failed: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(config: EdgeConfig) -> ExitCode {
    tilecastd::logging::init(&config.log);
    let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("tilecastd: could not start async runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    let result = runtime.block_on(async {
        let daemon = Daemon::start(config, Notifier::from_environment()).await?;
        tokio::spawn(cancel_on_signal(daemon.context().shutdown.clone()));
        daemon.run().await
    });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(component = "daemon", event = "fatal", error = format!("{error:#}"));
            eprintln!("tilecastd: {error:#}");
            ExitCode::FAILURE
        }
    }
}
