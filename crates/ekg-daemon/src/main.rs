use std::env;
use std::io::{self, BufRead, Write};

use ekg_contracts::{ErrorCode, ReadOperation};
use ekg_daemon::protocol::{ProtocolError, ProtocolSession};
use ekg_storage::{ReadRepository, StorageError};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_path = env::args()
        .nth(1)
        .ok_or("usage: ekg-rust-core <database-path>")?;
    let repository =
        ReadRepository::open(&database_path).map_err(|_| "failed to open Rust read repository")?;
    let mut protocol = ProtocolSession::new(1024);
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let response = protocol.handle_line(&line?, |operation| match operation {
            ReadOperation::QueryKnowledge(input) => {
                let result = repository
                    .query_knowledge(input)
                    .map_err(map_storage_error)?;
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

fn map_storage_error(error: StorageError) -> ProtocolError {
    match error {
        StorageError::Contract(code) => ProtocolError::new(code, "Request argument is invalid"),
        StorageError::ProjectNotFound => {
            ProtocolError::new(ErrorCode::NotFound, "Project was not found")
        }
        StorageError::Sqlite(_) | StorageError::InvalidStoredData(_) => {
            ProtocolError::new(ErrorCode::InternalError, "Unexpected service failure")
        }
    }
}
