use fishbowl_core::{
    ApplicabilityBoundary, GuardrailContext, GuardrailCriteria, PromotionEvidence,
    RegressionOutcome, evaluate_promotion, evaluate_regression,
};

#[test]
fn promotion_and_regression_preserve_current_trust_policy() {
    let incomplete = evaluate_promotion(&PromotionEvidence::default());
    assert!(!incomplete.eligible);
    assert_eq!(incomplete.missing_requirements.len(), 7);

    let complete = evaluate_promotion(&PromotionEvidence {
        root_cause_evidence_count: 1,
        root_cause_verified: true,
        successful_automated_verification_count: 1,
        human_confirmed: true,
        applicability: vec!["iOS".into()],
        limitations: vec!["physical device".into()],
        decisive_difference: "bounded executor".into(),
        ..PromotionEvidence::default()
    });
    assert!(complete.eligible);

    let mut boundary = ApplicabilityBoundary::new();
    boundary.insert("architecture".into(), vec!["arm64".into()]);
    assert_eq!(
        evaluate_regression(true, &boundary, &[("architecture", "arm64")]),
        RegressionOutcome::Regressed
    );
    assert_eq!(
        evaluate_regression(true, &boundary, &[("architecture", "x86_64")]),
        RegressionOutcome::OutsideApplicability
    );
    assert_eq!(
        evaluate_regression(false, &boundary, &[("architecture", "arm64")]),
        RegressionOutcome::DifferentFingerprint
    );
}

#[test]
fn guardrails_preserve_all_of_and_support_explicit_any_of() {
    let criteria = GuardrailCriteria {
        task_includes_all: vec!["CoreML".into()],
        task_includes_any: vec!["真机".into(), "physical device".into()],
        command_includes_all: vec!["xcodebuild".into()],
        file_includes_any: vec!["ModelRunner.swift".into(), "Inference.swift".into()],
        ..GuardrailCriteria::default()
    };
    assert!(criteria.matches(GuardrailContext {
        task: "CoreML 真机验证",
        command: "xcodebuild test",
        files: "Sources/Inference.swift",
    }));
    assert!(!criteria.matches(GuardrailContext {
        task: "CoreML 模拟器验证",
        command: "xcodebuild test",
        files: "Sources/Inference.swift",
    }));
}
