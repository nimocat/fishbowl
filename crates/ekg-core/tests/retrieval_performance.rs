use std::time::Instant;

use ekg_core::{HierarchicalIndex, KnowledgeRecord};

#[test]
fn ten_thousand_case_tree_has_bounded_warm_lookup() {
    let mut index = HierarchicalIndex::default();
    let build_started = Instant::now();
    for number in 0..10_000 {
        index.insert(&KnowledgeRecord {
            case_id: format!("case-{number:05}"),
            domain: if number % 2 == 0 { "workflow" } else { "media" }.into(),
            text: if number == 4_242 {
                "轻量代码修复采用三级风险验证门禁".into()
            } else {
                format!("工程知识节点 构建测试 记录编号 {number:05}")
            },
        });
    }
    let build_ms = build_started.elapsed().as_secs_f64() * 1_000.0;

    let mut durations_us = Vec::with_capacity(1_000);
    for _ in 0..1_000 {
        let started = Instant::now();
        let result = index.search("轻量修复 三级验证门禁", Some("workflow"), 5);
        durations_us.push(started.elapsed().as_secs_f64() * 1_000_000.0);
        assert_eq!(result.first().map(String::as_str), Some("case-04242"));
    }
    durations_us.sort_by(f64::total_cmp);
    let p50_us = durations_us[499];
    let p95_us = durations_us[949];
    eprintln!(
        "EKG_RUST_TREE_BENCH build_ms={build_ms:.3} query_p50_us={p50_us:.3} query_p95_us={p95_us:.3}",
    );

    // Debug runs may share a host with TypeScript gates. Release is the strict
    // deployment-performance signal; debug only catches order-of-magnitude
    // regressions without becoming a scheduler-contention test.
    let build_budget_ms = if cfg!(debug_assertions) {
        5_000.0
    } else {
        1_000.0
    };
    let query_budget_us = if cfg!(debug_assertions) {
        10_000.0
    } else {
        1_000.0
    };
    assert!(build_ms < build_budget_ms);
    assert!(p95_us < query_budget_us);
}
