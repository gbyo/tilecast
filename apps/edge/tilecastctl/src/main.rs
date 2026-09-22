//! `tilecastctl`: local administration over the Edge Unix socket (RFC §37).
//!
//! Every command maps to one fixed daemon method. The CLI never reads the
//! device credential, node keys or the state database directly, and no
//! command executes anything on the host.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use edge_ipc::client::{ClientOptions, IpcClient};
use edge_platform::paths::{DEFAULT_RUNTIME_DIR, SOCKET_NAME};
use edge_protocol::ipc::Role;
use edge_protocol::ipc::method::{Empty, Method};
use edge_protocol::ipc::status::DaemonStatus;
use serde_json::Value;

#[derive(Debug, Parser)]
#[command(name = "tilecastctl", version, about = "Inspect and test the local Tilecast Edge daemon")]
struct Cli {
    /// Edge socket path.
    #[arg(long, value_name = "PATH")]
    socket: Option<PathBuf>,
    /// Print the daemon's JSON result instead of a summary.
    #[arg(long)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Daemon, identity, content, mesh and renderer status.
    Status,
    /// The current capability snapshot.
    Capabilities,
    /// Peers observed on the mesh.
    Peers,
    /// Content store usage.
    Cache,
    /// Show the status surface on screen (renderer self-test).
    SelfTest,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("tilecastctl: {error}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(run(cli))
}

async fn run(cli: Cli) -> ExitCode {
    let socket = cli.socket.unwrap_or_else(|| PathBuf::from(DEFAULT_RUNTIME_DIR).join(SOCKET_NAME));
    let options = ClientOptions::new(Role::Tilecastctl, "tilecastctl", env!("CARGO_PKG_VERSION"));
    let client = match IpcClient::connect(&socket, options).await {
        Ok(client) => client,
        Err(error) => {
            eprintln!("tilecastctl: cannot reach tilecastd at {}: {error}", socket.display());
            return ExitCode::from(3);
        }
    };
    let method = match cli.command {
        Command::Status => Method::StatusGet(Empty {}),
        Command::Capabilities => Method::CapabilitiesGet(Empty {}),
        Command::Peers => Method::PeersList(Empty {}),
        Command::Cache => Method::CasStatus(Empty {}),
        Command::SelfTest => Method::DiagnosticsShowStatus(Empty {}),
    };
    let is_status = matches!(method, Method::StatusGet(_));
    let result = match client.request(method).await {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            eprintln!("tilecastctl: {} ({})", error.message, error.code);
            return ExitCode::from(4);
        }
        Err(error) => {
            eprintln!("tilecastctl: {error}");
            return ExitCode::FAILURE;
        }
    };
    if cli.json || !is_status {
        println!("{}", serde_json::to_string_pretty(&result).unwrap_or_default());
    } else {
        print_status(&result);
    }
    ExitCode::SUCCESS
}

fn print_status(value: &Value) {
    let Ok(status) = serde_json::from_value::<DaemonStatus>(value.clone()) else {
        println!("{}", serde_json::to_string_pretty(value).unwrap_or_default());
        return;
    };
    println!("tilecastd {} · {:?}", status.daemon_version, status.mode);
    if let Some(reason) = &status.recovery_reason {
        println!("  recovery reason: {reason}");
    }
    match &status.node_id {
        Some(node) => println!("  node: {node}"),
        None => println!("  node: not initialized"),
    }
    match &status.server {
        Some(server) => println!(
            "  server: {} (installation {}, credential {})",
            server.server_url,
            server.installation_id,
            if server.has_device_credential { "stored" } else { "absent" }
        ),
        None => println!("  server: not configured"),
    }
    println!("  edge identity: {}", status.identity.state);
    if let Some(certificate) = &status.identity.certificate {
        println!("    certificate …{} valid until {}", certificate.fingerprint_suffix, certificate.not_after);
    }
    if let Some(cas) = &status.cas {
        println!(
            "  content: {} objects, {} of {} bytes ({} pinned)",
            cas.object_count, cas.used_bytes, cas.limit_bytes, cas.pinned_bytes
        );
    }
    println!("  mesh: {} ({} peers)", status.mesh.state, status.mesh.peer_count);
    let renderer = &status.renderer;
    println!(
        "  renderer: {}{}",
        renderer.state,
        renderer.platform.as_ref().map(|p| format!(" · {p}")).unwrap_or_default()
    );
    if let Some(reason) = &renderer.incompatible_reason {
        println!("    {reason}");
    }
    println!("  capability revision: {}", status.capability_revision);
    println!("  systemd watchdog: {}", if status.systemd_watchdog { "active" } else { "not configured" });
}
