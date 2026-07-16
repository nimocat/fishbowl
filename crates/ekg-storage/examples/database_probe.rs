use ekg_contracts::{ExportProjectGraphInput, ProjectReference};
use ekg_storage::{DatabaseManager, WriteRepository};
use serde_json::json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().is_some_and(|value| value == "--restore") {
        let backup = args.get(1).ok_or("backup path is required")?;
        let destination = args.get(2).ok_or("destination path is required")?;
        DatabaseManager::restore_backup(
            std::path::Path::new(backup),
            std::path::Path::new(destination),
        )
        .map_err(|error| format!("restore failed: {error:?}"))?;
        println!("{}", json!({"restored":true,"destination":destination}));
        return Ok(());
    }
    let path = args.first().ok_or("database path is required")?;
    let managed = DatabaseManager::open(std::path::Path::new(path))
        .map_err(|error| format!("database open failed: {error:?}"))?;
    let version = managed
        .user_version()
        .map_err(|error| format!("version failed: {error:?}"))?;
    let quick_check = managed
        .quick_check()
        .map_err(|error| format!("quick check failed: {error:?}"))?;
    let project_id: Option<String> = managed
        .connection()
        .query_row(
            "SELECT id FROM projects ORDER BY created_at,id LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    drop(managed);
    let snapshot = if let Some(project_id) = project_id {
        let mut repository = WriteRepository::open(path)
            .map_err(|error| format!("repository open failed: {error:?}"))?;
        let archive = repository
            .export_project_graph(ExportProjectGraphInput {
                project: ProjectReference {
                    project_id: Some(project_id),
                    project_root: None,
                },
            })
            .map_err(|error| format!("snapshot failed: {error:?}"))?;
        json!({"cases":archive.cases.len(),"nodes":archive.nodes.len(),"edges":archive.edges.len(),"evidence":archive.evidence.len(),"artifacts":archive.artifacts.len()})
    } else {
        json!(null)
    };
    println!(
        "{}",
        json!({"userVersion":version,"quickCheck":quick_check,"snapshot":snapshot})
    );
    Ok(())
}

use rusqlite::OptionalExtension;
