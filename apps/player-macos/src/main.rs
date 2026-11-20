//! `tilecast-macos`: the Tilecast Player for macOS.
//!
//! `run` (also what no subcommand means) starts the player: pairing, the
//! server link, verified content preparation, commands, Activity, and
//! telemetry through Player Core. The WKWebView renderer is not in this
//! build yet (gbyo/tilecast#1926), so the player runs renderer-less and
//! pairing stays on stdout. `status` inspects the local state.

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use tilecast_macos::config::HostConfig;
use tilecast_macos::paths::MacosPaths;

#[derive(Debug, Parser)]
#[command(name = "tilecast-macos", version = tilecast_macos::RELEASE_VERSION)]
#[command(about = "Tilecast Player for macOS")]
struct Cli {
    /// Overrides the state directory (default `~/Library/Application Support/Tilecast/Tilecast Player`).
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    /// Overrides the runtime directory (default `~/Library/Caches/Tilecast/Tilecast Player`).
    #[arg(long, global = true)]
    runtime_dir: Option<PathBuf>,
    /// Reads this configuration file instead of the default beside the state.
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    /// Without a subcommand the player runs, so an app launch needs no
    /// arguments.
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Runs the player until interrupted.
    Run {
        /// Begins pairing with this server address when the player is not
        /// already paired, printing the visible code.
        #[arg(long)]
        pair: Option<String>,
        /// Runs without a renderer, pairing on stdout only.
        #[arg(long)]
        headless: bool,
    },
    /// Inspects the local binding, credential, and pairing state.
    Status,
    /// Abandons a pairing session in progress.
    ResetPairing,
}

fn paths(cli: &Cli) -> anyhow::Result<(MacosPaths, HostConfig)> {
    let unresolved = || anyhow::anyhow!("cannot resolve the state directory; pass --state-dir and --runtime-dir");
    let initial = tilecast_macos::paths::from_environment(cli.state_dir.as_deref(), cli.runtime_dir.as_deref())
        .ok_or_else(unresolved)?;
    let config_path = cli.config.clone().unwrap_or_else(|| initial.config_file(tilecast_macos::host::CONFIG_FILE_NAME));
    let config = HostConfig::load(&config_path, cli.config.is_some()).map_err(anyhow::Error::from)?;
    // Explicit flags win; the file overrides the derived defaults.
    let state_dir = cli.state_dir.clone().or(config.paths.state_dir.clone());
    let runtime_dir = cli.runtime_dir.clone().or(config.paths.runtime_dir.clone());
    let paths =
        tilecast_macos::paths::from_environment(state_dir.as_deref(), runtime_dir.as_deref()).ok_or_else(unresolved)?;
    Ok((paths, config))
}

fn init_logging(level: Option<&str>) {
    let level = level.unwrap_or("info");
    let filter = tracing_subscriber::EnvFilter::try_new(format!("tilecast_macos={level},webview_host={level}"))
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).with_target(false).compact().init();
}

/// Holds an exclusive lock on the state directory for the process
/// lifetime, so a second copy can never interleave writes with the running
/// player. The lock is released by the kernel when the process ends,
/// cleanly or not.
fn claim_single_instance(paths: &MacosPaths) -> anyhow::Result<Option<std::fs::File>> {
    std::fs::create_dir_all(&paths.state_dir)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.state_dir.join(".instance.lock"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
    }
}

fn announce_pairing_code(code: &str) {
    println!("Pairing code: {code}");
    println!("Approve this screen in Studio, then leave the player running.");
}

/// Core replaces an expired or rejected pairing session with a new code, and a
/// resumed session shows its code without `--pair`. The renderer-less player
/// has no other surface, so every code that becomes visible is printed once.
async fn announce_new_pairing_codes(
    context: std::sync::Arc<tilecast_macos::daemon::DaemonContext>,
    mut shown: Option<String>,
) {
    loop {
        tokio::select! {
            () = context.shutdown.cancelled() => return,
            () = tokio::time::sleep(std::time::Duration::from_millis(500)) => {}
        }
        if let Some(code) = tilecast_macos::pairing::view(&context).code
            && shown.as_deref() != Some(code.as_str())
        {
            announce_pairing_code(&code);
            shown = Some(code);
        }
    }
}

async fn run(cli: &Cli, pair: Option<String>, headless: bool) -> anyhow::Result<()> {
    let (paths, config) = paths(cli)?;
    // Claimed before any state is touched.
    let Some(instance) = claim_single_instance(&paths)? else {
        eprintln!("Tilecast Player is already running; refusing to start a second copy.");
        std::process::exit(1);
    };
    init_logging(config.log.level.as_deref());
    tracing::info!(
        component = "daemon",
        event = "starting",
        version = tilecast_macos::RELEASE_VERSION,
        state_dir = %paths.state_dir.display()
    );
    let (context, activity_signals) =
        tilecast_macos::daemon::build(config, paths, tilecast_macos::host::services()).await?;
    context.headless.store(headless, std::sync::atomic::Ordering::Release);
    let mut shown_code = None;
    if let Some(url) = pair {
        match tilecast_macos::pairing::begin(&context, &url).await {
            Ok(()) => {
                // The pairing loop shows the code; wait for it briefly so the
                // operator sees it on stdout.
                for _ in 0..100 {
                    let view = tilecast_macos::pairing::view(&context);
                    if view.code.is_some() || view.state == "paired" {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                let view = tilecast_macos::pairing::view(&context);
                if let Some(code) = view.code {
                    announce_pairing_code(&code);
                    shown_code = Some(code);
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
    tokio::spawn(announce_new_pairing_codes(std::sync::Arc::clone(&context), shown_code));
    let shutdown = context.shutdown.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown.cancel();
    });
    let restarted = std::sync::Arc::clone(&context);
    tilecast_macos::daemon::run(context, activity_signals).await;
    if restarted.restart_requested.load(std::sync::atomic::Ordering::Acquire) {
        relaunch(instance);
    }
    Ok(())
}

/// Starts a fresh copy of this process after a commanded restart. The
/// caller has shut down cleanly; the lock is released first so the new copy
/// can claim the instance, and `--pair` is not forwarded.
fn relaunch(instance: std::fs::File) -> ! {
    drop(instance);
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("tilecast-macos"));
    let spawned = std::process::Command::new(&exe)
        .args(tilecast_macos::daemon::relaunch_args(std::env::args_os().skip(1)))
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

async fn status(cli: &Cli) -> anyhow::Result<()> {
    let (paths, _) = paths(cli)?;
    let status = tilecast_macos::daemon::status(&paths, tilecast_macos::keychain::production_sealer()).await?;
    println!("Tilecast Player for macOS {}", tilecast_macos::RELEASE_VERSION);
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
    use tilecast_macos::pairing_store::SealedPairingStore;
    let (paths, _) = paths(cli)?;
    // A running Player could save an approval after the removal, so it must
    // not be running.
    let Some(_instance) = claim_single_instance(&paths)? else {
        anyhow::bail!("stop the running Player before resetting pairing");
    };
    SealedPairingStore::remove_at(&paths.identity_dir()).map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("Pairing session abandoned.");
    Ok(())
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match &cli.command {
        None => run(&cli, None, false).await,
        Some(Command::Run { pair, headless }) => run(&cli, pair.clone(), *headless).await,
        Some(Command::Status) => status(&cli).await,
        Some(Command::ResetPairing) => reset_pairing(&cli).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_arguments_means_run() {
        let cli = Cli::try_parse_from(["tilecast-macos"]).expect("parses without a subcommand");
        assert!(cli.command.is_none());
        let cli = Cli::try_parse_from(["tilecast-macos", "status"]).expect("parses");
        assert!(matches!(cli.command, Some(Command::Status)));
    }

    #[test]
    fn a_second_copy_cannot_claim_the_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = MacosPaths::new(dir.path().join("state"), dir.path().join("run"));
        let first = claim_single_instance(&paths).expect("lock").expect("first copy claims");
        assert!(claim_single_instance(&paths).expect("lock").is_none(), "a second copy is refused");
        drop(first);
        assert!(claim_single_instance(&paths).expect("lock").is_some(), "released on exit");
    }
}
