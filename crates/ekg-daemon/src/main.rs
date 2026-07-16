use std::env;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{SecondsFormat, Utc};
use ekg_contracts::PROTOCOL_VERSION;
use ekg_daemon::http::{DaemonHttpConfig, RpcDispatcher, serve_loopback};
use ekg_daemon::native::NativeDispatcher;
use ekg_daemon::protocol::ProtocolSession;
use ekg_storage::DatabaseManager;
use serde_json::json;
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if arguments.first().map(String::as_str) == Some("daemon") {
        run_daemon(&arguments[1..]).await
    } else if arguments.first().map(String::as_str) == Some("integrity") {
        match run_integrity(&arguments[1..]) {
            Ok(()) => Ok(()),
            Err(message) => {
                eprintln!(
                    "{}",
                    json!({
                        "error": "INTEGRITY_FAILED",
                        "message": message,
                        "recovery": "Open in read-only recovery mode. Back up knowledge.db, use sqlite3 .recover into a separate database, verify it, then export from the recovered copy."
                    })
                );
                std::process::exit(1)
            }
        }
    } else {
        run_stdio(&arguments)
    }
}

fn run_integrity(arguments: &[String]) -> Result<(), String> {
    if arguments.len() != 2 || arguments[0] != "--database" {
        return Err("usage: ekg-rust-core integrity --database <path>".into());
    }
    let database = DatabaseManager::open(Path::new(&arguments[1])).map_err(|_| {
        "Database failed read-only preflight; original bytes were preserved".to_owned()
    })?;
    let results = database
        .quick_check()
        .map_err(|_| "Database quick_check failed; original bytes were preserved".to_owned())?;
    if results.iter().any(|value| value != "ok") {
        return Err("Database quick_check did not return ok; original bytes were preserved".into());
    }
    println!(
        "{}",
        json!({"ok": true, "check": "quick_check", "results": results})
    );
    Ok(())
}

fn run_stdio(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let database_path = arguments
        .first()
        .ok_or("usage: ekg-rust-core <database-path>")?;
    let dispatcher = NativeDispatcher::open(Path::new(database_path))
        .map_err(|_| "failed to open Rust native repository")?;
    let mut protocol = ProtocolSession::new(1024);
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let response = protocol.handle_line(&line?, |operation| dispatcher.dispatch(operation));
        stdout.write_all(response.as_bytes())?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

async fn run_daemon(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let options = DaemonOptions::parse(arguments)?;
    let token = fs::read_to_string(&options.token_file)?.trim().to_owned();
    if token.is_empty() || token.len() > 256 {
        return Err("daemon token must contain between 1 and 256 bytes".into());
    }
    let dispatcher = Arc::new(
        NativeDispatcher::open(&options.database)
            .map_err(|_| "failed to open Rust native repository")?,
    );
    let running = serve_loopback(
        options.port,
        DaemonHttpConfig {
            token,
            daemon_version: env!("CARGO_PKG_VERSION").into(),
            replay_capacity: 1000,
            static_directory: options
                .static_directory
                .clone()
                .or_else(default_static_directory),
        },
        dispatcher,
    )
    .await?;
    let instance_id = Uuid::new_v4().to_string();
    let descriptor = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "daemonVersion": env!("CARGO_PKG_VERSION"),
        "host": "127.0.0.1",
        "port": running.address.port(),
        "browserPort": running.address.port(),
        "instanceId": instance_id,
        "pid": std::process::id(),
        "startedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    });
    write_private_atomic(&options.descriptor, &format!("{descriptor}\n"))?;
    write_private_atomic(&options.pid_file, &format!("{}\n", std::process::id()))?;
    shutdown_signal().await?;
    running.close().await?;
    remove_if_exists(&options.descriptor)?;
    remove_if_exists(&options.pid_file)?;
    Ok(())
}

fn default_static_directory() -> Option<PathBuf> {
    let executable = env::current_exe().ok()?;
    let directory = executable.parent()?.parent()?.join("web");
    directory.is_dir().then_some(directory)
}

struct DaemonOptions {
    database: PathBuf,
    token_file: PathBuf,
    descriptor: PathBuf,
    pid_file: PathBuf,
    port: u16,
    static_directory: Option<PathBuf>,
}

impl DaemonOptions {
    fn parse(arguments: &[String]) -> Result<Self, Box<dyn std::error::Error>> {
        let mut database = None;
        let mut token_file = None;
        let mut descriptor = None;
        let mut pid_file = None;
        let mut port = 0u16;
        let mut static_directory = None;
        let mut index = 0;
        while index < arguments.len() {
            let name = arguments[index].as_str();
            let value = arguments
                .get(index + 1)
                .ok_or("daemon options require a value")?;
            match name {
                "--database" => database = Some(PathBuf::from(value)),
                "--token-file" => token_file = Some(PathBuf::from(value)),
                "--descriptor" => descriptor = Some(PathBuf::from(value)),
                "--pid-file" => pid_file = Some(PathBuf::from(value)),
                "--port" => port = value.parse()?,
                "--static-directory" => static_directory = Some(PathBuf::from(value)),
                _ => return Err(format!("unknown daemon option: {name}").into()),
            }
            index += 2;
        }
        Ok(Self {
            database: database.ok_or("--database is required")?,
            token_file: token_file.ok_or("--token-file is required")?,
            descriptor: descriptor.ok_or("--descriptor is required")?,
            pid_file: pid_file.ok_or("--pid-file is required")?,
            port,
            static_directory,
        })
    }
}

fn write_private_atomic(path: &Path, content: &str) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(parent)?;
    set_private_directory(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|v| v.to_str()).unwrap_or("ekg"),
        Uuid::new_v4()
    ));
    fs::write(&temporary, content)?;
    set_private_file(&temporary)?;
    fs::rename(&temporary, path)?;
    set_private_file(path)
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn set_private_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory(_: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file(_: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
async fn shutdown_signal() -> io::Result<()> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate())?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => result,
        _ = terminate.recv() => Ok(()),
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() -> io::Result<()> {
    tokio::signal::ctrl_c().await
}
