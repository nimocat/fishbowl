use fishbowl_core::{HierarchicalIndex, KnowledgeRecord};
use serde_json::Value;

#[test]
fn real_engineering_queries_reach_recall_at_five_gate() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/retrieval/engineering_query_golden.json"
    ))
    .unwrap();
    let records = fixture["records"].as_array().unwrap();
    assert!(records.len() >= 30);
    let mut index = HierarchicalIndex::default();
    for record in records {
        index.insert(&KnowledgeRecord {
            case_id: record["caseId"].as_str().unwrap().to_owned(),
            domain: record["domain"].as_str().unwrap().to_owned(),
            text: format!(
                "{} {}",
                record["title"].as_str().unwrap(),
                record["text"].as_str().unwrap()
            ),
        });
    }
    let mut query_count = 0;
    let mut recalled = 0;
    for record in records {
        for query in record["queries"].as_array().unwrap() {
            query_count += 1;
            let expected = record["caseId"].as_str().unwrap();
            if index
                .search(
                    query.as_str().unwrap(),
                    Some(record["domain"].as_str().unwrap()),
                    5,
                )
                .iter()
                .any(|case_id| case_id == expected)
            {
                recalled += 1;
            }
        }
    }
    assert!(query_count >= 120);
    let recall = recalled as f64 / query_count as f64;
    eprintln!(
        "EKG_ENGINEERING_GOLDEN records={} queries={} recalled={} recall_at_5={recall:.3}",
        records.len(),
        query_count,
        recalled
    );
    assert!(recall >= 0.95, "recall@5 was {recall:.3}");
}
