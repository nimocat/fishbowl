use std::fs;

use ekg_contracts::{
    CleanupDisposition, FinishDiskObservationInput, ListCleanupCandidatesInput,
    ListDiskObservationsInput, ProjectReference, RegisterProjectInput, StartDiskObservationInput,
};
use ekg_storage::{DatabaseManager, ReadRepository, WriteRepository, capture_project_disk};

#[test]
fn scanner_tracks_only_regenerable_roots_and_never_follows_symlinks() {
    let root = temp_dir("scan");
    fs::create_dir_all(root.join("Sources")).unwrap();
    fs::write(root.join("Sources/owned.swift"), vec![1; 17]).unwrap();
    fs::create_dir_all(root.join("server/target/release")).unwrap();
    fs::write(root.join("server/target/release/api"), vec![2; 41]).unwrap();
    fs::create_dir_all(root.join("admin/node_modules/pkg")).unwrap();
    fs::write(root.join("admin/node_modules/pkg/index.js"), vec![3; 23]).unwrap();

    let outside = temp_dir("outside");
    fs::write(outside.join("secret.bin"), vec![4; 101]).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("tmp-link")).unwrap();

    let snapshot = capture_project_disk(&root).unwrap();
    let paths = snapshot
        .entries
        .iter()
        .map(|entry| entry.relative_path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(paths, vec!["admin/node_modules", "server/target"]);
    assert_eq!(snapshot.tracked_bytes, 64);
    assert!(!snapshot.truncated);

    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn observations_are_idempotent_project_scoped_and_explain_cleanup_confidence() {
    let root = temp_dir("ledger-project");
    fs::create_dir_all(root.join("server/target")).unwrap();
    fs::write(root.join("server/target/old.o"), vec![1; 10]).unwrap();
    let database = temp_path("ledger", "db");
    DatabaseManager::open(&database).unwrap();
    let mut writer = WriteRepository::open(database.to_str().unwrap()).unwrap();
    let project = writer
        .register_project(RegisterProjectInput {
            name: "disk-ledger".into(),
            root: root.to_string_lossy().into_owned(),
            description: None,
            operation_id: Some("register-ledger".into()),
        })
        .unwrap();
    let reference = ProjectReference {
        project_id: Some(project.id.clone()),
        project_root: None,
    };

    let first = writer
        .start_disk_observation(
            StartDiskObservationInput {
                project: reference.clone(),
                operation_id: "disk-start-1".into(),
                task: "build backend".into(),
            },
            capture_project_disk(&root).unwrap(),
        )
        .unwrap();
    let replay = writer
        .start_disk_observation(
            StartDiskObservationInput {
                project: reference.clone(),
                operation_id: "disk-start-1".into(),
                task: "build backend".into(),
            },
            capture_project_disk(&root).unwrap(),
        )
        .unwrap();
    assert_eq!(first.observation_id, replay.observation_id);
    assert!(first.created);
    assert!(!replay.created);

    let overlap = writer
        .start_disk_observation(
            StartDiskObservationInput {
                project: reference.clone(),
                operation_id: "disk-start-2".into(),
                task: "parallel task".into(),
            },
            capture_project_disk(&root).unwrap(),
        )
        .unwrap();

    fs::write(root.join("server/target/new.o"), vec![2; 20]).unwrap();
    fs::create_dir_all(root.join("tmp/generated")).unwrap();
    fs::write(root.join("tmp/generated/output.bin"), vec![3; 30]).unwrap();
    let finished = writer
        .finish_disk_observation(
            FinishDiskObservationInput {
                project: reference.clone(),
                operation_id: "disk-finish-1".into(),
                observation_id: first.observation_id.clone(),
            },
            capture_project_disk(&root).unwrap(),
        )
        .unwrap();
    assert_eq!(finished.positive_growth_bytes, 50);
    assert_eq!(finished.overlapping_observations, 1);
    assert!(
        finished
            .entries
            .iter()
            .all(|entry| { entry.cleanup_disposition == CleanupDisposition::Shared })
    );

    let finished_replay = writer
        .finish_disk_observation(
            FinishDiskObservationInput {
                project: reference.clone(),
                operation_id: "disk-finish-1".into(),
                observation_id: first.observation_id,
            },
            capture_project_disk(&root).unwrap(),
        )
        .unwrap();
    assert_eq!(finished, finished_replay);

    let overlap_finished = writer
        .finish_disk_observation(
            FinishDiskObservationInput {
                project: reference.clone(),
                operation_id: "disk-finish-2".into(),
                observation_id: overlap.observation_id,
            },
            capture_project_disk(&root).unwrap(),
        )
        .unwrap();
    assert_eq!(overlap_finished.positive_growth_bytes, 50);

    drop(writer);
    let reader = ReadRepository::open(database.to_str().unwrap()).unwrap();
    let history = reader
        .list_disk_observations(&ListDiskObservationsInput {
            project: reference.clone(),
            limit: Some(10),
        })
        .unwrap();
    assert_eq!(history.observations.len(), 2);
    let candidates = reader
        .list_cleanup_candidates(&ListCleanupCandidatesInput {
            project: reference.clone(),
            limit: Some(10),
        })
        .unwrap();
    assert!(candidates.candidates.iter().all(|candidate| {
        candidate.cleanup_disposition == CleanupDisposition::Shared
            || candidate.cleanup_disposition == CleanupDisposition::Review
    }));
    assert!(candidates.candidates.iter().all(|candidate| {
        !candidate.relative_path.starts_with('/') && !candidate.relative_path.contains("..")
    }));

    drop(reader);
    let mut writer = WriteRepository::open(database.to_str().unwrap()).unwrap();
    let cleanup = writer
        .start_disk_observation(
            StartDiskObservationInput {
                project: reference.clone(),
                operation_id: "disk-start-cleanup".into(),
                task: "remove generated output".into(),
            },
            capture_project_disk(&root).unwrap(),
        )
        .unwrap();
    fs::remove_dir_all(root.join("server/target")).unwrap();
    fs::remove_dir_all(root.join("tmp")).unwrap();
    writer
        .finish_disk_observation(
            FinishDiskObservationInput {
                project: reference.clone(),
                operation_id: "disk-finish-cleanup".into(),
                observation_id: cleanup.observation_id,
            },
            capture_project_disk(&root).unwrap(),
        )
        .unwrap();
    let bounded = writer
        .start_disk_observation(
            StartDiskObservationInput {
                project: reference.clone(),
                operation_id: "disk-start-bounded".into(),
                task: "bounded scan".into(),
            },
            capture_project_disk(&root).unwrap(),
        )
        .unwrap();
    fs::create_dir_all(root.join("build")).unwrap();
    fs::write(root.join("build/output.bin"), vec![4; 5]).unwrap();
    let mut truncated_snapshot = capture_project_disk(&root).unwrap();
    truncated_snapshot.scanned_entries = 250_000;
    truncated_snapshot.truncated = true;
    let bounded_result = writer
        .finish_disk_observation(
            FinishDiskObservationInput {
                project: reference.clone(),
                operation_id: "disk-finish-bounded".into(),
                observation_id: bounded.observation_id,
            },
            truncated_snapshot,
        )
        .unwrap();
    assert_eq!(bounded_result.scanned_entries, 250_001);
    assert!(bounded_result.scan_truncated);
    assert_ne!(
        bounded_result.entries[0].cleanup_disposition,
        CleanupDisposition::Eligible
    );
    drop(writer);
    let reader = ReadRepository::open(database.to_str().unwrap()).unwrap();
    let latest = reader
        .list_cleanup_candidates(&ListCleanupCandidatesInput {
            project: reference,
            limit: Some(10),
        })
        .unwrap();
    assert_eq!(latest.candidates.len(), 1);
    assert_eq!(latest.candidates[0].relative_path, "build");
    assert_ne!(
        latest.candidates[0].cleanup_disposition,
        CleanupDisposition::Eligible
    );

    fs::remove_file(database).unwrap();
    fs::remove_dir_all(root).unwrap();
}

fn temp_dir(label: &str) -> std::path::PathBuf {
    let path = temp_path(label, "dir");
    fs::create_dir_all(&path).unwrap();
    path
}

fn temp_path(label: &str, extension: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "ekg-disk-{label}-{}-{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4(),
        extension
    ))
}
