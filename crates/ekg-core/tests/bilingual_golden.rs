use ekg_core::{HierarchicalIndex, KnowledgeRecord};
use serde_json::Value;

#[test]
fn bilingual_golden_recall_at_five_is_at_least_ninety_five_percent() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/retrieval/bilingual_golden.json"
    ))
    .unwrap();
    let mut index = HierarchicalIndex::default();
    for record in fixture["records"].as_array().unwrap() {
        index.insert(&KnowledgeRecord {
            case_id: record["caseId"].as_str().unwrap().to_owned(),
            domain: record["domain"].as_str().unwrap().to_owned(),
            text: record["text"].as_str().unwrap().to_owned(),
        });
    }
    let queries = fixture["queries"].as_array().unwrap();
    let recalled = queries
        .iter()
        .filter(|query| {
            index
                .search(query["text"].as_str().unwrap(), None, 5)
                .iter()
                .any(|case_id| case_id == query["expectedCaseId"].as_str().unwrap())
        })
        .count();
    let recall = recalled as f64 / queries.len() as f64;
    eprintln!(
        "EKG_BILINGUAL_GOLDEN queries={} recalled={} recall_at_5={recall:.3}",
        queries.len(),
        recalled
    );
    assert!(recall >= 0.95);
}
