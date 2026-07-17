use std::fs;

use fishbowl_contracts::{
    CleanupDisposition, FinishDiskObservationInput, ListCleanupCandidatesInput,
    ListDiskObservationsInput, ProjectReference, RegisterProjectInput, StartDiskObservationInput,
};
use fishbowl_storage::{
    DatabaseManager, ReadRepository, WriteRepository, capture_project_disk,
    capture_project_disk_cached,
};

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
fn persistent_measurement_cache_hits_unchanged_roots_and_invalidates_only_changed_roots() {
    let root = temp_dir("cache");
    fs::create_dir_all(root.join("server/target/debug/deps")).unwrap();
    fs::write(root.join("server/target/debug/deps/api.o"), vec![1; 41]).unwrap();
    fs::create_dir_all(root.join("admin/node_modules/pkg/lib")).unwrap();
    fs::write(
        root.join("admin/node_modules/pkg/lib/index.js"),
        vec![2; 23],
    )
    .unwrap();

    let cold = capture_project_disk_cached(&root, &[]).unwrap();
    assert_eq!(cold.cache_hits, 0);
    assert_eq!(cold.cache_misses, 2);
    assert_eq!(cold.snapshot.tracked_bytes, 64);

    let warm = capture_project_disk_cached(&root, &cold.cache_entries).unwrap();
    assert_eq!(warm.cache_hits, 2);
    assert_eq!(warm.cache_misses, 0);
    assert_eq!(warm.snapshot.tracked_bytes, cold.snapshot.tracked_bytes);
    assert!(warm.snapshot.scanned_entries < cold.snapshot.scanned_entries);
    assert!(warm.snapshot.truncated);

    fs::write(root.join("server/target/debug/deps/new.o"), vec![3; 19]).unwrap();
    let partial = capture_project_disk_cached(&root, &warm.cache_entries).unwrap();
    assert_eq!(partial.cache_hits, 1);
    assert_eq!(partial.cache_misses, 1);
    assert_eq!(partial.snapshot.tracked_bytes, 83);

    fs::remove_dir_all(root.join("admin/node_modules")).unwrap();
    let removed = capture_project_disk_cached(&root, &partial.cache_entries).unwrap();
    assert!(removed.discovery_complete);
    assert_eq!(removed.cache_entries.len(), 1);
    assert_eq!(removed.cache_hits, 1);
    assert_eq!(removed.snapshot.tracked_bytes, 60);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn measurement_cache_persists_per_project_and_removes_disappeared_roots() {
    let first_root = temp_dir("cache-first-project");
    fs::create_dir_all(first_root.join("target/debug")).unwrap();
    fs::write(first_root.join("target/debug/app"), vec![1; 41]).unwrap();
    fs::create_dir_all(first_root.join("node_modules/pkg")).unwrap();
    fs::write(first_root.join("node_modules/pkg/index.js"), vec![2; 23]).unwrap();
    let second_root = temp_dir("cache-second-project");
    let database = temp_path("cache-persistence", "db");
    DatabaseManager::open(&database).unwrap();
    let mut writer = WriteRepository::open(database.to_str().unwrap()).unwrap();
    let first = writer
        .register_project(RegisterProjectInput {
            name: "cache-first".into(),
            root: first_root.to_string_lossy().into_owned(),
            description: None,
            operation_id: Some("register-cache-first".into()),
        })
        .unwrap();
    let second = writer
        .register_project(RegisterProjectInput {
            name: "cache-second".into(),
            root: second_root.to_string_lossy().into_owned(),
            description: None,
            operation_id: Some("register-cache-second".into()),
        })
        .unwrap();
    let first_reference = ProjectReference {
        project_id: Some(first.id),
        project_root: None,
    };
    let second_reference = ProjectReference {
        project_id: Some(second.id),
        project_root: None,
    };
    let cold = capture_project_disk_cached(&first_root, &[]).unwrap();
    let started = writer
        .start_disk_observation_capture(
            StartDiskObservationInput {
                project: first_reference.clone(),
                operation_id: "start-cache-persistence".into(),
                task: "verify persistent cache".into(),
            },
            cold,
        )
        .unwrap();
    drop(writer);

    let reader = ReadRepository::open(database.to_str().unwrap()).unwrap();
    let persisted = reader
        .load_disk_measurement_cache(&first_reference)
        .unwrap();
    assert_eq!(persisted.len(), 2);
    assert!(
        reader
            .load_disk_measurement_cache(&second_reference)
            .unwrap()
            .is_empty()
    );
    drop(reader);

    fs::remove_dir_all(first_root.join("node_modules")).unwrap();
    let updated = capture_project_disk_cached(&first_root, &persisted).unwrap();
    assert!(updated.discovery_complete);
    assert_eq!(updated.cache_hits, 1);
    let mut writer = WriteRepository::open(database.to_str().unwrap()).unwrap();
    writer
        .finish_disk_observation_capture(
            FinishDiskObservationInput {
                project: first_reference.clone(),
                operation_id: "finish-cache-persistence".into(),
                observation_id: started.observation_id,
            },
            updated,
        )
        .unwrap();
    drop(writer);

    let reader = ReadRepository::open(database.to_str().unwrap()).unwrap();
    let persisted = reader
        .load_disk_measurement_cache(&first_reference)
        .unwrap();
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].relative_path, "target");

    drop(reader);
    fs::remove_file(database).unwrap();
    fs::remove_dir_all(first_root).unwrap();
    fs::remove_dir_all(second_root).unwrap();
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
    assert_eq!(
        bounded_result.scanned_entries,
        bounded.scanned_entries + 250_000
    );
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
        "fishbowl-disk-{label}-{}-{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4(),
        extension
    ))
}
