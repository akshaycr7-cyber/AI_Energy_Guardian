"""Guardrails for a future, evaluated periodic retraining workflow.

No sensor reading triggers training here and this module never treats model
predictions as ground truth.  It deliberately does not replace production.
"""
from __future__ import annotations

from typing import Any


MINIMUM_NEW_VALID_OBSERVATIONS = 100
REQUIRED_OBSERVED_LABELS = {"Occupancy", "No. of Fans ON", "No. of Lights ON"}


def assess_retraining_eligibility(new_observations: list[dict[str, Any]], minimum_rows: int = MINIMUM_NEW_VALID_OBSERVATIONS) -> dict[str, Any]:
    """Report whether enough genuinely labelled observations are available."""
    valid = [row for row in new_observations if REQUIRED_OBSERVED_LABELS <= row.keys() and row.get("data_source") != "model_prediction"]
    return {
        "eligible": len(valid) >= minimum_rows,
        "valid_observations": len(valid),
        "minimum_required": minimum_rows,
        "action": "train_evaluated_candidate" if len(valid) >= minimum_rows else "accumulate_more_real_observations",
        "deployment_policy": "Merge historical data with valid new observations, evaluate chronologically, and replace production only if candidate metrics meet or exceed the current model.",
    }


def retraining_readiness() -> dict[str, Any]:
    """Expose the policy for a scheduler/service to call later."""
    return assess_retraining_eligibility([])
