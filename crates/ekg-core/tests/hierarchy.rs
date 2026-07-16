use ekg_contracts::NodeStatus;
use ekg_core::{HierarchyEdge, HierarchyRecord, KnowledgeHierarchy};

#[test]
fn hierarchy_is_byte_deterministic_and_rebuilds_only_affected_branches() {
    let records = records();
    let edges = vec![HierarchyEdge::new("case-camera", "case-session")];
    let first = KnowledgeHierarchy::build(7, records.clone(), edges.clone());
    let second = KnowledgeHierarchy::build(7, records.into_iter().rev().collect(), edges);
    assert_eq!(
        first.snapshot_json().unwrap(),
        second.snapshot_json().unwrap()
    );

    let before_media = first.branch_json("project-a", "media").unwrap();
    let mut updated = first;
    updated.upsert(
        8,
        HierarchyRecord {
            text: "camera preview session binding updated".into(),
            ..record(
                "project-a",
                "ios",
                "case-camera",
                NodeStatus::Verified,
                "camera preview",
            )
        },
    );
    assert_eq!(
        updated.last_rebuilt_branches(),
        &[("project-a".into(), "ios".into())]
    );
    assert_eq!(
        updated.branch_json("project-a", "media").unwrap(),
        before_media
    );
    assert_eq!(updated.branch_source_revision("project-a", "ios"), Some(8));
}

#[test]
fn global_and_local_queries_preserve_supporting_cases() {
    let hierarchy = KnowledgeHierarchy::build(
        7,
        records(),
        vec![HierarchyEdge::new("case-camera", "case-session")],
    );
    let global = hierarchy.query_global("project-a", "camera session", 5);
    assert!(!global.is_empty());
    assert!(
        global[0]
            .supporting_case_ids
            .contains(&"case-camera".into())
    );
    assert!(
        global[0]
            .supporting_case_ids
            .contains(&"case-session".into())
    );

    let local = hierarchy.query_local("project-a", "ios", "preview binding", 5);
    assert_eq!(local[0].case_id, "case-camera");
    assert!(!local.iter().any(|item| item.case_id == "case-audio"));
}

#[test]
fn generated_summaries_never_confer_verified_status() {
    let mut hierarchy = KnowledgeHierarchy::build(7, records(), vec![]);
    let summary = hierarchy
        .attach_generated_summary(
            "project-a",
            "ios",
            "model-generated overview",
            "generator-v1",
        )
        .unwrap();
    assert_eq!(summary.status, NodeStatus::Candidate);
    assert_eq!(summary.source_revision, 7);
    assert!(summary.supporting_case_ids.is_empty());
}

#[test]
fn deterministic_k_core_metadata_distinguishes_dense_communities() {
    let dense = ["a", "b", "c", "tail"]
        .into_iter()
        .map(|case_id| {
            record(
                "project-a",
                "graph",
                case_id,
                NodeStatus::Candidate,
                case_id,
            )
        })
        .collect();
    let hierarchy = KnowledgeHierarchy::build(
        1,
        dense,
        vec![
            HierarchyEdge::new("a", "b"),
            HierarchyEdge::new("b", "c"),
            HierarchyEdge::new("c", "a"),
            HierarchyEdge::new("c", "tail"),
        ],
    );
    let branch = String::from_utf8(hierarchy.branch_json("project-a", "graph").unwrap()).unwrap();
    assert!(branch.contains("\"coreLevel\":2"));
}

fn records() -> Vec<HierarchyRecord> {
    vec![
        record(
            "project-a",
            "ios",
            "case-camera",
            NodeStatus::Verified,
            "camera preview binding",
        ),
        record(
            "project-a",
            "ios",
            "case-session",
            NodeStatus::Candidate,
            "camera session lifecycle",
        ),
        record(
            "project-a",
            "media",
            "case-audio",
            NodeStatus::Verified,
            "audio streaming decode",
        ),
        record(
            "project-b",
            "ios",
            "case-other",
            NodeStatus::Verified,
            "camera preview binding",
        ),
    ]
}

fn record(
    project: &str,
    domain: &str,
    case_id: &str,
    status: NodeStatus,
    text: &str,
) -> HierarchyRecord {
    HierarchyRecord {
        project_id: project.into(),
        domain: domain.into(),
        case_id: case_id.into(),
        status,
        text: text.into(),
        fingerprints: vec![],
        files: vec![format!("{case_id}.swift")],
        commands: vec![],
        verified_conclusion: (status == NodeStatus::Verified).then(|| format!("verified {text}")),
    }
}
