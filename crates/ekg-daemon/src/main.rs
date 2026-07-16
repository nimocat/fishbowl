use std::env;
use std::io::{self, BufRead, Write};
use std::path::Path;

use ekg_daemon::http::RpcDispatcher;
use ekg_daemon::native::NativeDispatcher;
use ekg_daemon::protocol::ProtocolSession;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_path = env::args()
        .nth(1)
        .ok_or("usage: ekg-rust-core <database-path>")?;
    let dispatcher = NativeDispatcher::open(Path::new(&database_path))
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
