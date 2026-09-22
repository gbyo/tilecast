use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use edge_platform::paths::DEFAULT_CONFIG_FILE;
use edge_platform::systemd::Notifier;
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
