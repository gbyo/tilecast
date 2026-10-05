//! `tilecast-windows`: the Tilecast Player for Windows.
//!
//! `run` starts the player with its window: pairing, the server link,
//! verified content preparation, and the WebView2 Runtime renderer.
//! `--headless` runs without a window (pairing stays on stdout), and
//! `status` inspects the local state.

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use tilecast_windows::config::WindowsConfig;
use tilecast_windows::paths::WindowsPaths;

#[derive(Debug, Parser)]
#[command(name = "tilecast-windows", version = tilecast_windows::RELEASE_VERSION)]
#[command(about = "Tilecast Player for Windows")]
struct Cli {
    /// Overrides the state directory (default `%LOCALAPPDATA%\\Tilecast\\Tilecast Player`).
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    /// Overrides the runtime directory (default `%TEMP%\\Tilecast\\Tilecast Player`).
    #[arg(long, global = true)]
    runtime_dir: Option<PathBuf>,
    /// Reads this configuration file instead of the default beside the state.
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Runs the player until interrupted.
    Run {
        /// Begins pairing with this server address when the player is not
        /// already paired, printing the visible code.
        #[arg(long)]
        pair: Option<String>,
        /// Runs without a window: no renderer, pairing on stdout only.
        #[arg(long)]
        headless: bool,
    },
    /// Inspects the local binding, credential, and pairing state.
    Status,
    /// Abandons a pairing session in progress.
    ResetPairing,
}

fn paths(cli: &Cli) -> anyhow::Result<(WindowsPaths, WindowsConfig)> {
    let initial = WindowsPaths::from_environment(cli.state_dir.as_deref(), cli.runtime_dir.as_deref())
        .ok_or_else(|| anyhow::anyhow!("cannot resolve the state directory; pass --state-dir and --runtime-dir"))?;
    let config_path =
        cli.config.clone().unwrap_or_else(|| initial.state_dir.join(tilecast_windows::config::CONFIG_FILE_NAME));
    let config: WindowsConfig = WindowsConfig::load(&config_path, cli.config.is_some()).map_err(anyhow::Error::from)?;
    // Explicit flags win; the file overrides the derived defaults.
    let state_dir = cli.state_dir.clone().or(config.paths.state_dir.clone());
    let runtime_dir = cli.runtime_dir.clone().or(config.paths.runtime_dir.clone());
    let paths = WindowsPaths::from_environment(state_dir.as_deref(), runtime_dir.as_deref())
        .ok_or_else(|| anyhow::anyhow!("cannot resolve the state directory; pass --state-dir and --runtime-dir"))?;
    Ok((paths, config))
}

fn init_logging(level: Option<&str>) {
    let level = level.unwrap_or("info");
    let filter = tracing_subscriber::EnvFilter::try_new(format!("tilecast_windows={level},tilecast-windows={level}"))
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).with_target(false).compact().init();
}

async fn run(cli: &Cli, pair: Option<String>, headless: bool) -> anyhow::Result<()> {
    // The single-instance guard is claimed before any state is touched so a
    // second copy can never interleave writes with the running player.
    let instance = match tilecast_windows::win32::claim_single_instance() {
        Some(guard) => guard,
        None => {
            eprintln!("Tilecast Player is already running; refusing to start a second copy.");
            std::process::exit(1);
        }
    };
    let (paths, config) = paths(cli)?;
    init_logging(config.log.level.as_deref());
    if tilecast_windows::win32::register_restart() {
        tracing::debug!(component = "daemon", event = "restart_registered");
    }
    tracing::info!(
        component = "daemon",
        event = "starting",
        version = tilecast_windows::RELEASE_VERSION,
        state_dir = %paths.state_dir.display()
    );
    let (context, activity_signals) = tilecast_windows::daemon::build(config, paths).await?;
    context.headless.store(headless, std::sync::atomic::Ordering::Release);
    if let Some(url) = pair {
        match tilecast_windows::pairing::begin(&context, &url).await {
            Ok(()) => {
                // The pairing loop shows the code; wait for it briefly so the
                // operator sees it even when stdout is the only surface.
                for _ in 0..100 {
                    let view = tilecast_windows::pairing::view(&context);
                    if view.code.is_some() || view.state == "paired" {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                let view = tilecast_windows::pairing::view(&context);
                if let Some(code) = view.code {
                    println!("Pairing code: {code}");
                    println!("Approve this screen in Studio, then leave the player running.");
                } else {
                    println!("Pairing state: {}", view.state);
                }
            }
            Err(message) => {
                eprintln!("Pairing failed: {message}");
                std::process::exit(1);
            }
        }
    }
    let shutdown = context.shutdown.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown.cancel();
    });
    let restarted = std::sync::Arc::clone(&context);
    tilecast_windows::daemon::run(context, activity_signals).await;
    if restarted.restart_requested.load(std::sync::atomic::Ordering::Acquire) {
        relaunch(instance);
    }
    Ok(())
}

/// Starts a fresh copy of this process after a commanded restart. The
/// caller has shut down cleanly; the guard is dropped first so the new
/// copy can claim the instance, and `--pair` is not forwarded: a relaunch
/// resumes running, it never re-pairs.
fn relaunch(instance: tilecast_windows::win32::InstanceGuard) -> ! {
    // The guard releases the session mutex here on Windows, before the
    // fresh copy claims it.
    {
        let _held = instance;
    }
    let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("tilecast-windows"));
    let spawned = std::process::Command::new(&exe)
        .args(relaunch_args(std::env::args_os().skip(1)))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match spawned {
        Ok(_) => {
            tracing::info!(component = "daemon", event = "restart_relaunched");
            std::process::exit(0);
        }
        Err(error) => {
            tracing::error!(component = "daemon", event = "restart_relaunch_failed", error = %error);
            std::process::exit(1);
        }
    }
}

/// Forwards the command line to a relaunched copy, minus `--pair` (both
/// spellings): pairing already happened, and re-pairing a bound screen
/// would kill the fresh copy at startup.
fn relaunch_args(args: impl Iterator<Item = std::ffi::OsString>) -> Vec<std::ffi::OsString> {
    let mut out = Vec::new();
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--pair" {
            skip_next = true;
            continue;
        }
        if arg.to_str().is_some_and(|text| text.starts_with("--pair=")) {
            continue;
        }
        out.push(arg);
    }
    out
}

async fn status(cli: &Cli) -> anyhow::Result<()> {
    let (paths, _) = paths(cli)?;
    let status = tilecast_windows::daemon::status(&paths).await?;
    println!("Tilecast Player for Windows {}", tilecast_windows::RELEASE_VERSION);
    match &status.bound {
        Some(bound) => {
            println!("server: {}", bound.server_url);
            if let Some(name) = &bound.screen_name {
                println!("screen: {name}");
            }
            if let Some(id) = &bound.screen_id {
                println!("screen id: {id}");
            }
        }
        None => println!("server: not paired"),
    }
    println!("credential: {}", if status.has_credential { "stored" } else { "absent" });
    println!("playback: {}", if status.playback_disabled { "disabled" } else { "enabled" });
    match &status.pairing {
        Some(pairing) => println!(
            "pairing: {} ({}; {})",
            pairing.code,
            pairing.server_url,
            if pairing.expired { "expired" } else { "awaiting approval" }
        ),
        None => println!("pairing: none"),
    }
    Ok(())
}

async fn reset_pairing(cli: &Cli) -> anyhow::Result<()> {
    use tilecast_windows::pairing_store::SealedPairingStore;
    let (paths, _) = paths(cli)?;
    SealedPairingStore::remove_at(&paths.identity_dir()).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("Pairing session abandoned.");
    Ok(())
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match &cli.command {
        Command::Run { pair, headless } => run(&cli, pair.clone(), *headless).await,
        Command::Status => status(&cli).await,
        Command::ResetPairing => reset_pairing(&cli).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<std::ffi::OsString> {
        words.iter().map(std::ffi::OsString::from).collect()
    }

    #[test]
    fn relaunch_never_re_pairs() {
        assert_eq!(
            relaunch_args(args(&["run", "--pair", "http://x/", "--headless"]).into_iter()),
            args(&["run", "--headless"])
        );
        assert_eq!(relaunch_args(args(&["run", "--pair=http://x/"]).into_iter()), args(&["run"]));
        assert_eq!(relaunch_args(args(&["run", "--headless"]).into_iter()), args(&["run", "--headless"]));
        // A trailing `--pair` without a value still drops cleanly.
        assert_eq!(relaunch_args(args(&["run", "--pair"]).into_iter()), args(&["run"]));
    }
}
