use ekg_contracts::NodeStatus;
use ekg_core::{GuardrailContext, GuardrailCriteria, GuardrailEnforcement, evaluate_guardrail};
use serde_json::Value;

#[test]
fn blocking_recall_is_complete_without_false_positives() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/retrieval/guardrail_golden.json"
    ))
    .unwrap();
    let mut expected_blocks = 0;
    let mut recalled_blocks = 0;
    let mut false_positives = 0;
    for item in fixture.as_array().unwrap() {
        let criteria = criteria(&item["criteria"]);
        let status = match item["status"].as_str().unwrap() {
            "verified" => NodeStatus::Verified,
            "candidate" => NodeStatus::Candidate,
            other => panic!("unexpected status {other}"),
        };
        let enforcement = match item["enforcement"].as_str().unwrap() {
            "advise" => GuardrailEnforcement::Advise,
            "warn" => GuardrailEnforcement::Warn,
            "block" => GuardrailEnforcement::Block,
            other => panic!("unexpected enforcement {other}"),
        };
        let result = evaluate_guardrail(
            &criteria,
            status,
            enforcement,
            GuardrailContext {
                task: item["task"].as_str().unwrap(),
                command: item["command"].as_str().unwrap(),
                files: item["files"].as_str().unwrap(),
            },
        );
        assert_eq!(result.matches, item["matches"].as_bool().unwrap());
        let expected = item["blocks"].as_bool().unwrap();
        if expected {
            expected_blocks += 1;
        }
        if result.blocks && expected {
            recalled_blocks += 1;
        }
        if result.blocks && !expected {
            false_positives += 1;
        }
    }
    assert_eq!(recalled_blocks, expected_blocks);
    assert_eq!(false_positives, 0);
}

fn criteria(value: &Value) -> GuardrailCriteria {
    GuardrailCriteria {
        task_includes_all: strings(value, "taskIncludes"),
        task_includes_any: strings(value, "taskIncludesAny"),
        command_includes_all: strings(value, "commandIncludes"),
        command_includes_any: strings(value, "commandIncludesAny"),
        file_includes_all: strings(value, "fileIncludes"),
        file_includes_any: strings(value, "fileIncludesAny"),
    }
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
