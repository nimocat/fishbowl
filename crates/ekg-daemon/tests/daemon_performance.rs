use std::time::Instant;

use ekg_daemon::{QueryRequest, RetrievalEngine};
use rusqlite::{Connection, params};

#[test]
fn sqlite_to_tree_warm_query_is_bounded_for_ten_thousand_cases() {
    let path = std::env::temp_dir().join(format!(
        "ekg-rust-performance-{}-{}.db",
        std::process::id(),
        std::thread::current().name().unwrap_or("test"),
    ));
    let mut connection = Connection::open(&path).unwrap();
    connection.execute_batch(
        "CREATE TABLE cases (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, created_at TEXT);
         CREATE TABLE nodes (id TEXT PRIMARY KEY, case_id TEXT, type TEXT, status TEXT, data TEXT, created_at TEXT);
         CREATE TABLE events (sequence INTEGER PRIMARY KEY, project_id TEXT, case_id TEXT);",
    ).unwrap();
    let transaction = connection.transaction().unwrap();
    {
        let mut insert_case = transaction
            .prepare(
                "INSERT INTO cases VALUES (?, 'project-a', ?, 'candidate', '2026-07-16T00:00:00Z')",
            )
            .unwrap();
        let mut insert_node = transaction
            .prepare(
                "INSERT INTO nodes VALUES (?, ?, 'Problem', 'open', ?, '2026-07-16T00:00:00Z')",
            )
            .unwrap();
        for number in 0..10_000 {
            let case_id = format!("case-{number:05}");
            let text = if number == 4_242 {
                "{\"summary\":\"轻量代码修复采用三级风险验证门禁\",\"domain\":\"workflow\"}"
                    .to_owned()
            } else {
                format!(
                    "{{\"summary\":\"工程知识节点 构建测试 记录编号 {number:05}\",\"domain\":\"workflow\"}}"
                )
            };
            insert_case
                .execute(params![case_id, format!("Case {number}")])
                .unwrap();
            insert_node
                .execute(params![format!("node-{number:05}"), case_id, text])
                .unwrap();
        }
    }
    transaction
        .execute(
            "INSERT INTO events VALUES (1, 'project-a', 'case-04242')",
            [],
        )
        .unwrap();
    transaction.commit().unwrap();
    drop(connection);

    let mut engine = RetrievalEngine::open(path.to_str().unwrap()).unwrap();
    let cold_started = Instant::now();
    let cold = engine.query(request("cold")).unwrap();
    let cold_ms = cold_started.elapsed().as_secs_f64() * 1_000.0;
    assert_eq!(
        cold.case_ids.first().map(String::as_str),
        Some("case-04242")
    );

    let mut durations_us = Vec::with_capacity(1_000);
    for number in 0..1_000 {
        let started = Instant::now();
        let result = engine.query(request(&format!("warm-{number}"))).unwrap();
        durations_us.push(started.elapsed().as_secs_f64() * 1_000_000.0);
        assert!(result.cache_hit);
    }
    durations_us.sort_by(f64::total_cmp);
    let p50_us = durations_us[499];
    let p95_us = durations_us[949];
    eprintln!(
        "EKG_RUST_SQLITE_TREE_BENCH cold_ms={cold_ms:.3} warm_p50_us={p50_us:.3} warm_p95_us={p95_us:.3}",
    );
    let cold_budget_ms = if cfg!(debug_assertions) {
        5_000.0
    } else {
        1_000.0
    };
    let query_budget_us = if cfg!(debug_assertions) {
        10_000.0
    } else {
        1_000.0
    };
    assert!(cold_ms < cold_budget_ms);
    assert!(p95_us < query_budget_us);
    std::fs::remove_file(path).unwrap();
}

fn request(request_id: &str) -> QueryRequest {
    QueryRequest {
        request_id: request_id.to_owned(),
        project_id: "project-a".into(),
        text: "轻量修复 三级验证门禁".into(),
        domain: Some("workflow".into()),
        limit: 5,
    }
}
