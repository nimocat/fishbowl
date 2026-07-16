use std::env;
use std::io::{self, BufRead, Write};

use ekg_daemon::{QueryRequest, RetrievalEngine};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse<'a> {
    request_id: &'a str,
    error: &'a str,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_path = env::args()
        .nth(1)
        .ok_or("usage: ekg-rust-core <database-path>")?;
    let mut engine = RetrievalEngine::open(&database_path)?;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line?;
        let parsed = serde_json::from_str::<QueryRequest>(&line);
        match parsed {
            Ok(request) => match engine.query(request) {
                Ok(response) => serde_json::to_writer(&mut stdout, &response)?,
                Err(_) => serde_json::to_writer(
                    &mut stdout,
                    &ErrorResponse {
                        request_id: "unknown",
                        error: "query failed",
                    },
                )?,
            },
            Err(_) => serde_json::to_writer(
                &mut stdout,
                &ErrorResponse {
                    request_id: "unknown",
                    error: "invalid request",
                },
            )?,
        }
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}
