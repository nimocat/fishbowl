use std::env;
use std::io::{self, BufRead, Write};

use ekg_contracts::{ErrorCode, ReadOperation};
use ekg_daemon::protocol::{ProtocolError, ProtocolSession};
use ekg_daemon::{QueryRequest, RetrievalEngine};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_path = env::args()
        .nth(1)
        .ok_or("usage: ekg-rust-core <database-path>")?;
    let mut engine = RetrievalEngine::open(&database_path)?;
    let mut protocol = ProtocolSession::new(1024);
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let response = protocol.handle_line(&line?, |operation| match operation {
            ReadOperation::QueryKnowledge(input) => {
                let project_id = input.project.project_id.clone().ok_or_else(|| {
                    ProtocolError::new(
                        ErrorCode::InvalidArgument,
                        "Rust query migration slice requires a project ID",
                    )
                })?;
                let result = engine
                    .query(QueryRequest {
                        request_id: "protocol-query".to_owned(),
                        project_id,
                        text: input.text.clone().unwrap_or_default(),
                        domain: input.domain.clone(),
                        limit: input.limit.unwrap_or(20),
                    })
                    .map_err(|_| {
                        ProtocolError::new(ErrorCode::InternalError, "Unexpected service failure")
                    })?;
                serde_json::to_value(result).map_err(|_| {
                    ProtocolError::new(ErrorCode::InternalError, "Unexpected service failure")
                })
            }
            ReadOperation::Preflight(_) | ReadOperation::GetCase(_) => Err(ProtocolError::new(
                ErrorCode::ValidationFailed,
                "Read operation is not enabled in this migration stage",
            )),
        });
        stdout.write_all(response.as_bytes())?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}
