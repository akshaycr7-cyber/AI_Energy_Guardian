"""
AI Energy Guardian - Final ML Training Pipeline

Models:
1. Occupancy Classifier
2. Fan Count Regressor
3. Light Count Regressor

Dataset:
    data/source_dataset.xlsx

Output:
    ml/models/energy_guardian_models_final.joblib
    ml/models/TRAINING_REPORT.json
    ml/models/training_state.json

Important:
- The current historical dataset does NOT contain genuine measured power/energy.
- Therefore this script does NOT train a fake power/energy model.
- Real power regression will be added after INA219 measurements are collected.
"""

from __future__ import annotations

import json
import math
import hashlib
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from sklearn.compose import ColumnTransformer
from sklearn.ensemble import (
    RandomForestClassifier,
    RandomForestRegressor,
)
from sklearn.impute import SimpleImputer
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    mean_absolute_error,
    mean_squared_error,
    r2_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

try:  # Supports both ``python ml/train_final.py`` and package imports.
    from .preprocessing import (
        CATEGORICAL_FEATURES,
        MODEL_FEATURES,
        NUMERICAL_FEATURES,
        extract_start_hour_minute,
    )
except ImportError:  # pragma: no cover - direct-script compatibility
    from preprocessing import (
        CATEGORICAL_FEATURES,
        MODEL_FEATURES,
        NUMERICAL_FEATURES,
        extract_start_hour_minute,
    )


# ============================================================
# 1. PROJECT PATHS
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parents[1]

DATA_PATH = PROJECT_ROOT / "data" / "source_dataset.xlsx"

MODEL_DIR = PROJECT_ROOT / "ml" / "models"

MODEL_PATH = MODEL_DIR / "energy_guardian_models_final.joblib"
REPORT_PATH = MODEL_DIR / "TRAINING_REPORT.json"
STATE_PATH = MODEL_DIR / "training_state.json"


# ============================================================
# 2. RANDOM FOREST SETTINGS
# ============================================================

RANDOM_STATE = 42

N_ESTIMATORS_CLASSIFIER = 400
N_ESTIMATORS_REGRESSOR = 400


# ============================================================
# 3. EXACT DATASET COLUMNS
# ============================================================

DATE_COL = "Date"
TIME_COL = "Time"

LECT_COL = "Lect"

FAN_TARGET = "No. of Fans ON"
LIGHT_TARGET = "No. of Lights ON"

SMART_BOARD_COL = "Smart Board ON/OFF"

OCCUPANCY_TARGET = "Occupancy"

WEATHER_COL = "Weather Condition"

TEMP_COL = "Temperature (C)"
HUMIDITY_COL = "Humidity (%)"
CLOUD_COL = "Cloud Cover (%)"
PRECIP_COL = "Precipitation (mm)"


# ============================================================
# 4. UTILITY FUNCTIONS
# ============================================================

def print_header(title: str) -> None:
    """Print a clean console section header."""
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)


def clean_string_series(series: pd.Series) -> pd.Series:
    """
    Clean categorical/string values without inventing new labels.
    Missing values become 'Unknown'.
    """
    return (
        series
        .astype("string")
        .str.strip()
        .replace({
            "": pd.NA,
            "nan": pd.NA,
            "None": pd.NA,
        })
        .fillna("Unknown")
        .astype(str)
    )


def parse_numeric(series: pd.Series) -> pd.Series:
    """Convert a series to numeric safely."""
    return pd.to_numeric(series, errors="coerce")


def calculate_rmse(y_true, y_pred) -> float:
    """Calculate RMSE."""
    return float(math.sqrt(mean_squared_error(y_true, y_pred)))


def normalise_occupancy(series: pd.Series) -> pd.Series:
    """Standardise known source labels without fabricating missing targets."""
    cleaned = series.astype("string").str.strip().str.lower()
    mapping = {
        "occupied": "Occupied",
        "partial": "Partial",
        "partial occupancy": "Partial",
        "empty": "Empty",
        # A recorded class activity means the classroom was in use.
        "observed class activity": "Occupied",
    }
    return cleaned.map(mapping).astype("string")


def dataframe_hash(df: pd.DataFrame) -> str:
    """
    Create a reproducible hash of the training dataframe.
    Useful for tracking which dataset version produced a model.
    """
    hashed = pd.util.hash_pandas_object(
        df,
        index=True
    ).values

    return hashlib.sha256(
        hashed.tobytes()
    ).hexdigest()


def check_target_leakage() -> dict[str, object]:
    """Record the direct target-leakage check for this fixed feature schema.

    This verifies that no label column is passed to any estimator.  It cannot
    decide whether a legitimate scheduling field is highly correlated with a
    target; those correlations are retained because lecture schedule, board
    state, weather and time are approved inference-time inputs.
    """
    targets = [OCCUPANCY_TARGET, FAN_TARGET, LIGHT_TARGET]
    direct_overlap = sorted(set(MODEL_FEATURES).intersection(targets))
    return {
        "passed": not direct_overlap,
        "model_features": list(MODEL_FEATURES),
        "target_columns": targets,
        "direct_target_columns_in_features": direct_overlap,
        "note": (
            "No direct target columns are used as features. Legitimate "
            "schedule/context features may still be correlated with outcomes."
        ),
    }


# ============================================================
# 6. LOAD DATASET
# ============================================================

def load_dataset() -> pd.DataFrame:

    print_header("LOADING DATASET")

    if not DATA_PATH.exists():
        raise FileNotFoundError(
            f"Dataset not found:\n{DATA_PATH}\n\n"
            "Make sure source_dataset.xlsx is inside:\n"
            "AI_Energy_Guardian/data/"
        )

    print(f"Dataset path: {DATA_PATH}")

    df = pd.read_excel(DATA_PATH)

    print(f"Rows loaded: {len(df):,}")
    print(f"Columns loaded: {len(df.columns)}")

    return df


# ============================================================
# 7. VALIDATE DATASET
# ============================================================

def validate_dataset(df: pd.DataFrame) -> None:

    print_header("VALIDATING DATASET")

    required_columns = [
        DATE_COL,
        TIME_COL,
        LECT_COL,
        FAN_TARGET,
        LIGHT_TARGET,
        SMART_BOARD_COL,
        OCCUPANCY_TARGET,
        WEATHER_COL,
        TEMP_COL,
        HUMIDITY_COL,
        CLOUD_COL,
        PRECIP_COL,
    ]

    missing = [
        col
        for col in required_columns
        if col not in df.columns
    ]

    if missing:
        raise ValueError(
            "The following required columns are missing:\n"
            + "\n".join(f"- {col}" for col in missing)
        )

    print("Required columns: OK")

    print("\nDataset shape:")
    print(df.shape)

    print("\nOccupancy values:")
    print(
        df[OCCUPANCY_TARGET]
        .astype("string")
        .value_counts(dropna=False)
    )

    print("\nFan-count distribution:")
    print(
        df[FAN_TARGET]
        .value_counts(dropna=False)
        .sort_index()
    )

    print("\nLight-count distribution:")
    print(
        df[LIGHT_TARGET]
        .value_counts(dropna=False)
        .sort_index()
    )


# ============================================================
# 8. PREPROCESS DATA
# ============================================================

def prepare_dataframe(df: pd.DataFrame) -> pd.DataFrame:

    print_header("PREPARING DATA")

    data = df.copy()

    # --------------------------------------------------------
    # Parse date and time
    # --------------------------------------------------------

    data[DATE_COL] = pd.to_datetime(
        data[DATE_COL],
        errors="coerce"
    )

    # Parse the interval's start component.  Do not call pd.to_datetime on the
    # full value: "9.00-10.00 am" is an interval rather than a timestamp.
    parsed_times = data[TIME_COL].apply(extract_start_hour_minute)

    data["Hour"] = parsed_times.apply(
        lambda x: x[0]
    )

    data["Minute"] = parsed_times.apply(
        lambda x: x[1]
    )

    # Keep a compact, auditable sample before rows are removed for unrelated
    # missing targets.  This makes it clear that interval start-times, rather
    # than whole intervals, were parsed.
    parsed_time_samples = [
        {
            "source_time": str(row[TIME_COL]),
            "hour": int(row["Hour"]),
            "minute": int(row["Minute"]),
        }
        for _, row in data.loc[
            data["Hour"].notna() & data["Minute"].notna(),
            [TIME_COL, "Hour", "Minute"],
        ].head(10).iterrows()
    ]

    # --------------------------------------------------------
    # Additional time features
    # --------------------------------------------------------

    data["Weekday"] = data[DATE_COL].dt.weekday
    data["Month"] = data[DATE_COL].dt.month

    # --------------------------------------------------------
    # Clean categorical variables
    # --------------------------------------------------------

    for col in CATEGORICAL_FEATURES:
        data[col] = clean_string_series(data[col])

    # --------------------------------------------------------
    # Convert numerical columns
    # --------------------------------------------------------

    numerical_source_columns = [
        FAN_TARGET,
        LIGHT_TARGET,
        TEMP_COL,
        HUMIDITY_COL,
        CLOUD_COL,
        PRECIP_COL,
        "Hour",
        "Minute",
        "Weekday",
        "Month",
    ]

    for col in numerical_source_columns:
        data[col] = parse_numeric(data[col])

    # Occupancy is a target, so unknown/missing labels must not become a fake
    # class.  Only documented source labels are normalised.
    data[OCCUPANCY_TARGET] = normalise_occupancy(data[OCCUPANCY_TARGET])

    # --------------------------------------------------------
    # Remove rows that cannot be used
    # --------------------------------------------------------

    before = len(data)
    time_parse_success = data["Hour"].notna() & data["Minute"].notna()
    time_parse_failures = data.loc[~time_parse_success, TIME_COL]

    print(f"Total rows before cleaning: {before:,}")
    print(f"Rows with successfully parsed Time: {int(time_parse_success.sum()):,}")
    print(f"Rows with failed Time parsing: {int((~time_parse_success).sum()):,}")
    print("Sample parsed times:")
    if parsed_time_samples:
        print(pd.DataFrame(parsed_time_samples).to_string(index=False))
    else:
        print("No Time values were parsed successfully.")
    if not time_parse_failures.empty:
        print("Unparseable Time values (with counts):")
        print(time_parse_failures.astype("string").value_counts(dropna=False).to_string())

    data = data.dropna(
        subset=[
            DATE_COL,
            "Hour",
            "Minute",
            FAN_TARGET,
            LIGHT_TARGET,
            OCCUPANCY_TARGET,
        ]
    ).copy()

    removed = before - len(data)

    print(f"Rows removed during mandatory cleaning: {removed:,}")
    print(f"Final rows remaining: {len(data):,}")
    print("Hour distribution:")
    print(data["Hour"].value_counts(dropna=False).sort_index().to_string())
    print("Minute distribution:")
    print(data["Minute"].value_counts(dropna=False).sort_index().to_string())

    data.attrs["cleaning_summary"] = {
        "total_rows_before_cleaning": int(before),
        "time_parsing_successful_rows": int(time_parse_success.sum()),
        "time_parsing_failed_rows": int((~time_parse_success).sum()),
        "sample_parsed_times": parsed_time_samples,
        "unparseable_time_values": {
            str(key): int(value)
            for key, value in time_parse_failures.astype("string").value_counts(dropna=False).items()
        },
        "rows_removed": int(removed),
        "final_rows_remaining": int(len(data)),
        "hour_distribution": {str(key): int(value) for key, value in data["Hour"].value_counts().sort_index().items()},
        "minute_distribution": {str(key): int(value) for key, value in data["Minute"].value_counts().sort_index().items()},
    }

    # --------------------------------------------------------
    # Sort chronologically
    # --------------------------------------------------------

    data = data.sort_values(
        by=[
            DATE_COL,
            "Hour",
            "Minute",
        ]
    ).reset_index(drop=True)

    return data


# ============================================================
# 9. CHRONOLOGICAL TRAIN/TEST SPLIT
# ============================================================

def chronological_split(
    df: pd.DataFrame,
    train_ratio: float = 0.80,
):
    """
    Time-aware split.

    Earlier records -> training
    Later records   -> test

    This is preferred over a random split for time-dependent
    classroom data because it reduces temporal leakage.
    """

    split_index = int(len(df) * train_ratio)

    if split_index <= 0 or split_index >= len(df):
        raise ValueError("Invalid train/test split.")

    train_df = df.iloc[:split_index].copy()
    test_df = df.iloc[split_index:].copy()

    return train_df, test_df


# ============================================================
# 10. BUILD PREPROCESSOR
# ============================================================

def build_preprocessor() -> ColumnTransformer:

    categorical_pipeline = Pipeline(
        steps=[
            (
                "imputer",
                SimpleImputer(
                    strategy="most_frequent"
                ),
            ),
            (
                "onehot",
                OneHotEncoder(
                    handle_unknown="ignore",
                    sparse_output=False,
                ),
            ),
        ]
    )

    numerical_pipeline = Pipeline(
        steps=[
            (
                "imputer",
                SimpleImputer(
                    strategy="median"
                ),
            ),
        ]
    )

    preprocessor = ColumnTransformer(
        transformers=[
            (
                "categorical",
                categorical_pipeline,
                CATEGORICAL_FEATURES,
            ),
            (
                "numerical",
                numerical_pipeline,
                NUMERICAL_FEATURES,
            ),
        ],
        remainder="drop",
        verbose_feature_names_out=False,
    )

    return preprocessor


# ============================================================
# 11. BUILD MODELS
# ============================================================

def build_occupancy_model() -> Pipeline:

    preprocessor = build_preprocessor()

    classifier = RandomForestClassifier(
        n_estimators=N_ESTIMATORS_CLASSIFIER,
        random_state=RANDOM_STATE,
        n_jobs=-1,
        class_weight="balanced",
        min_samples_leaf=2,
    )

    return Pipeline(
        steps=[
            (
                "preprocessor",
                preprocessor,
            ),
            (
                "model",
                classifier,
            ),
        ]
    )


def build_fan_model() -> Pipeline:

    preprocessor = build_preprocessor()

    regressor = RandomForestRegressor(
        n_estimators=N_ESTIMATORS_REGRESSOR,
        random_state=RANDOM_STATE,
        n_jobs=-1,
        min_samples_leaf=2,
    )

    return Pipeline(
        steps=[
            (
                "preprocessor",
                preprocessor,
            ),
            (
                "model",
                regressor,
            ),
        ]
    )


def build_light_model() -> Pipeline:

    preprocessor = build_preprocessor()

    regressor = RandomForestRegressor(
        n_estimators=N_ESTIMATORS_REGRESSOR,
        random_state=RANDOM_STATE,
        n_jobs=-1,
        min_samples_leaf=2,
    )

    return Pipeline(
        steps=[
            (
                "preprocessor",
                preprocessor,
            ),
            (
                "model",
                regressor,
            ),
        ]
    )


# ============================================================
# 12. FEATURE IMPORTANCE
# ============================================================

def extract_feature_importance(
    pipeline: Pipeline,
) -> list[dict]:

    preprocessor = pipeline.named_steps["preprocessor"]
    model = pipeline.named_steps["model"]

    try:
        feature_names = (
            preprocessor
            .get_feature_names_out()
        )

        importances = model.feature_importances_

        results = []

        for name, importance in zip(
            feature_names,
            importances,
        ):
            results.append(
                {
                    "feature": str(name),
                    "importance": float(importance),
                }
            )

        results.sort(
            key=lambda x: x["importance"],
            reverse=True,
        )

        return results

    except Exception as exc:

        return [
            {
                "error": (
                    "Feature importance could not be extracted: "
                    + str(exc)
                )
            }
        ]


# ============================================================
# 13. TRAIN OCCUPANCY CLASSIFIER
# ============================================================

def train_occupancy_model(
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
):

    print_header("TRAINING OCCUPANCY CLASSIFIER")

    X_train = train_df[MODEL_FEATURES]
    y_train = train_df[OCCUPANCY_TARGET]

    X_test = test_df[MODEL_FEATURES]
    y_test = test_df[OCCUPANCY_TARGET]

    model = build_occupancy_model()

    print("Training Random Forest occupancy classifier...")

    model.fit(
        X_train,
        y_train,
    )

    predictions = model.predict(X_test)

    accuracy = accuracy_score(
        y_test,
        predictions,
    )

    macro_f1 = f1_score(
        y_test,
        predictions,
        average="macro",
        zero_division=0,
    )

    precision = precision_score(y_test, predictions, average="weighted", zero_division=0)
    recall = recall_score(y_test, predictions, average="weighted", zero_division=0)
    weighted_f1 = f1_score(y_test, predictions, average="weighted", zero_division=0)

    labels = sorted(
        set(y_test.astype(str))
        | set(predictions.astype(str))
    )

    cm = confusion_matrix(
        y_test,
        predictions,
        labels=labels,
    )

    report = classification_report(
        y_test,
        predictions,
        labels=labels,
        output_dict=True,
        zero_division=0,
    )

    print(f"Accuracy : {accuracy:.4f}")
    print(f"Precision: {precision:.4f} (weighted)")
    print(f"Recall   : {recall:.4f} (weighted)")
    print(f"F1       : {weighted_f1:.4f} (weighted)")
    print(f"Macro-F1 : {macro_f1:.4f}")

    print("\nConfusion Matrix:")

    print(
        pd.DataFrame(
            cm,
            index=[
                f"Actual: {x}"
                for x in labels
            ],
            columns=[
                f"Predicted: {x}"
                for x in labels
            ],
        )
    )

    feature_importance = extract_feature_importance(
        model
    )

    return model, {
        "accuracy": float(accuracy),
        "precision_weighted": float(precision),
        "recall_weighted": float(recall),
        "f1_weighted": float(weighted_f1),
        "macro_f1": float(macro_f1),
        "labels": labels,
        "confusion_matrix": cm.tolist(),
        "classification_report": report,
        "class_distribution_train": {str(key): int(value) for key, value in y_train.value_counts().items()},
        "class_distribution_test": {str(key): int(value) for key, value in y_test.value_counts().items()},
        "feature_importance": feature_importance,
    }


# ============================================================
# 14. TRAIN REGRESSION MODEL
# ============================================================

def train_count_model(
    model_name: str,
    target_column: str,
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
):

    print_header(
        f"TRAINING {model_name.upper()} REGRESSOR"
    )

    X_train = train_df[MODEL_FEATURES]
    y_train = train_df[target_column]

    X_test = test_df[MODEL_FEATURES]
    y_test = test_df[target_column]

    if model_name.lower() == "fan":
        model = build_fan_model()
    elif model_name.lower() == "light":
        model = build_light_model()
    else:
        raise ValueError(
            f"Unknown model name: {model_name}"
        )

    print(
        f"Training Random Forest {model_name} "
        "count regressor..."
    )

    model.fit(
        X_train,
        y_train,
    )

    predictions = model.predict(X_test)

    mae = mean_absolute_error(
        y_test,
        predictions,
    )

    rmse = calculate_rmse(
        y_test,
        predictions,
    )

    r2 = r2_score(
        y_test,
        predictions,
    )

    # Convert predictions to physically meaningful
    # non-negative appliance counts.
    clipped_predictions = np.clip(
        predictions,
        0,
        None,
    )

    rounded_predictions = np.rint(
        clipped_predictions
    ).astype(int)

    exact_count_accuracy = float(
        np.mean(
            rounded_predictions
            == y_test.to_numpy().astype(int)
        )
    )

    print(f"MAE                  : {mae:.4f}")
    print(f"RMSE                 : {rmse:.4f}")
    print(f"R2                   : {r2:.4f}")
    print(
        "Exact count accuracy : "
        f"{exact_count_accuracy:.4f}"
    )

    feature_importance = extract_feature_importance(
        model
    )

    return model, {
        "mae": float(mae),
        "rmse": float(rmse),
        "r2": float(r2),
        "exact_count_accuracy": exact_count_accuracy,
        "feature_importance": feature_importance,
    }


# ============================================================
# 15. MAIN TRAINING FUNCTION
# ============================================================

def main():

    start_time = datetime.now(
        timezone.utc
    )

    print_header(
        "AI ENERGY GUARDIAN - FINAL ML TRAINING"
    )

    print("Python/scikit-learn environment:")
    print("Python:", __import__("sys").version)

    try:
        import sklearn

        print(
            "scikit-learn:",
            sklearn.__version__,
        )

    except Exception:
        print(
            "scikit-learn version could not be read."
        )

    # --------------------------------------------------------
    # Load
    # --------------------------------------------------------

    raw_df = load_dataset()

    # --------------------------------------------------------
    # Validate
    # --------------------------------------------------------

    validate_dataset(raw_df)

    # --------------------------------------------------------
    # Prepare
    # --------------------------------------------------------

    df = prepare_dataframe(
        raw_df
    )
    cleaning_summary = dict(df.attrs.get("cleaning_summary", {}))

    occupancy_distribution = {
        str(key): int(value)
        for key, value in df[OCCUPANCY_TARGET].value_counts().items()
    }
    empty_occupancy_present = "Empty" in occupancy_distribution
    leakage_check = check_target_leakage()
    print_header("TARGET AND LEAKAGE CHECK")
    print(f"Occupancy class distribution: {occupancy_distribution}")
    print(
        "Empty occupancy observations: "
        + ("present" if empty_occupancy_present else "absent")
    )
    print(
        "Direct target leakage check: "
        + ("PASS" if leakage_check["passed"] else "FAIL")
    )

    # --------------------------------------------------------
    # Dataset hash
    # --------------------------------------------------------

    dataset_hash = dataframe_hash(
        df
    )

    # --------------------------------------------------------
    # Chronological split
    # --------------------------------------------------------

    print_header(
        "CHRONOLOGICAL TRAIN / TEST SPLIT"
    )

    train_df, test_df = chronological_split(
        df,
        train_ratio=0.80,
    )

    print(
        f"Training rows : {len(train_df):,}"
    )

    print(
        f"Testing rows  : {len(test_df):,}"
    )

    print(
        "\nTraining period:"
    )

    print(
        train_df[DATE_COL].min(),
        "to",
        train_df[DATE_COL].max(),
    )

    print(
        "\nTesting period:"
    )

    print(
        test_df[DATE_COL].min(),
        "to",
        test_df[DATE_COL].max(),
    )

    # --------------------------------------------------------
    # Train occupancy
    # --------------------------------------------------------

    occupancy_model, occupancy_metrics = (
        train_occupancy_model(
            train_df,
            test_df,
        )
    )

    # --------------------------------------------------------
    # Train fan count
    # --------------------------------------------------------

    fan_model, fan_metrics = (
        train_count_model(
            "fan",
            FAN_TARGET,
            train_df,
            test_df,
        )
    )

    # --------------------------------------------------------
    # Train light count
    # --------------------------------------------------------

    light_model, light_metrics = (
        train_count_model(
            "light",
            LIGHT_TARGET,
            train_df,
            test_df,
        )
    )

    # ========================================================
    # FINAL MODEL PACKAGE
    # ========================================================

    trained_at = datetime.now(
        timezone.utc
    ).isoformat()

    model_package = {

        "model_version": "1.0.0",

        "trained_at_utc": trained_at,

        "training_environment": {
            "python": __import__(
                "sys"
            ).version,
            "sklearn": __import__(
                "sklearn"
            ).__version__,
        },

        "models": {

            "occupancy_classifier":
                occupancy_model,

            "fan_count_regressor":
                fan_model,

            "light_count_regressor":
                light_model,
        },

        # Direct names are the stable public inference API.  The nested
        # ``models`` mapping is retained for easy inspection/backwards use.
        "occupancy_model": occupancy_model,
        "fan_count_model": fan_model,
        "light_count_model": light_model,

        "features": MODEL_FEATURES,

        "feature_metadata": {
            "all_features": MODEL_FEATURES,
            "categorical_features": CATEGORICAL_FEATURES,
            "numerical_features": NUMERICAL_FEATURES,
            "time_features": ["Hour", "Minute", "Weekday", "Month"],
        },

        "preprocessing_metadata": {
            "categorical": {
                "features": CATEGORICAL_FEATURES,
                "missing_value_strategy": "most_frequent",
                "encoding": "one-hot",
                "unknown_category_handling": "ignore",
            },
            "numerical": {
                "features": NUMERICAL_FEATURES,
                "missing_value_strategy": "median",
            },
            "time_parsing": "Parse the interval start only; 1-4 without AM are classroom afternoon periods.",
        },

        "training_information": {
            "split": "chronological 80/20",
            "random_state": RANDOM_STATE,
            "classifier_estimators": N_ESTIMATORS_CLASSIFIER,
            "regressor_estimators": N_ESTIMATORS_REGRESSOR,
            "target_leakage_check": leakage_check,
            "occupancy_class_distribution": occupancy_distribution,
            "empty_occupancy_present": empty_occupancy_present,
            "empty_occupancy_note": (
                "Empty is absent from the current dataset; no Empty labels were invented. "
                "The classifier can learn it when real Empty observations are added."
                if not empty_occupancy_present else
                "Empty observations are present in the current dataset."
            ),
        },

        "categorical_features":
            CATEGORICAL_FEATURES,

        "numerical_features":
            NUMERICAL_FEATURES,

        "targets": {
            "occupancy":
                OCCUPANCY_TARGET,

            "fan_count":
                FAN_TARGET,

            "light_count":
                LIGHT_TARGET,
        },

        "metrics": {

            "occupancy":
                occupancy_metrics,

            "fan_count":
                fan_metrics,

            "light_count":
                light_metrics,
        },

        "dataset": {

            "rows_raw":
                int(len(raw_df)),

            "rows_after_cleaning":
                int(len(df)),

            "training_rows":
                int(len(train_df)),

            "testing_rows":
                int(len(test_df)),

            "dataset_hash":
                dataset_hash,

            "source":
                str(DATA_PATH.name),

            "split":
                "Chronological 80/20",

            "cleaning_summary": cleaning_summary,
        },

        "power_model": {

            "trained":
                False,

            "reason":
                (
                    "The current dataset does not contain "
                    "genuine measured power or energy. "
                    "Power regression will be trained after "
                    "INA219-based real measurements are collected."
                ),
        },

        "notes": [

            (
                "Fan and light ON/OFF classification was not "
                "used because the current dataset has extremely "
                "few OFF observations."
            ),

            (
                "Fan and light are currently modeled as "
                "count regressors."
            ),

            (
                "Final appliance ON/OFF decisions will be "
                "handled by the decision engine using occupancy, "
                "environment, model outputs, and explicit rules."
            ),

            (
                "The dataset contains historical, generated, "
                "and forecast/weather-calibrated records. "
                "It should not be described as entirely measured "
                "sensor data."
            ),

            (
                "Real power/energy learning requires actual "
                "measured electrical data."
            ),
        ],
    }

    # ========================================================
    # SAVE MODEL
    # ========================================================

    print_header(
        "SAVING FINAL MODEL"
    )

    MODEL_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    joblib.dump(
        model_package,
        MODEL_PATH,
        compress=3,
    )

    print(
        f"Model saved to:\n{MODEL_PATH}"
    )

    # ========================================================
    # TRAINING REPORT
    # ========================================================

    finished_at = datetime.now(
        timezone.utc
    )

    duration_seconds = (
        finished_at - start_time
    ).total_seconds()

    report = {

        "project":
            "AI Energy Guardian",

        "model_version":
            model_package["model_version"],

        "trained_at_utc":
            trained_at,

        "finished_at_utc":
            finished_at.isoformat(),

        "training_duration_seconds":
            float(duration_seconds),

        "dataset": model_package["dataset"],

        "data_cleaning": cleaning_summary,

        "training_information": model_package["training_information"],

        "features": {
            "all":
                MODEL_FEATURES,

            "categorical":
                CATEGORICAL_FEATURES,

            "numerical":
                NUMERICAL_FEATURES,
        },

        "models": {

            "occupancy_classifier":
                occupancy_metrics,

            "fan_count_regressor":
                fan_metrics,

            "light_count_regressor":
                light_metrics,
        },

        "power_model":
            model_package["power_model"],

        "notes":
            model_package["notes"],
    }

    with open(
        REPORT_PATH,
        "w",
        encoding="utf-8",
    ) as file:

        json.dump(
            report,
            file,
            indent=4,
            ensure_ascii=False,
        )

    print(
        f"Training report saved to:\n{REPORT_PATH}"
    )

    # ========================================================
    # TRAINING STATE
    # ========================================================

    state = {

        "model_version":
            model_package["model_version"],

        "last_training_time_utc":
            trained_at,

        "last_training_rows":
            int(len(df)),

        "dataset_path": str(DATA_PATH),

        "training_rows": int(len(train_df)),

        "testing_rows": int(len(test_df)),

        "sklearn_version": __import__("sklearn").__version__,

        "metrics": model_package["metrics"],

        "feature_names": MODEL_FEATURES,

        "dataset_hash":
            dataset_hash,

        "model_path":
            str(MODEL_PATH),

        "automatic_retraining_enabled":
            False,

        "automatic_retraining_note":
            (
                "This file records the initial final training. "
                "The production retraining service will update "
                "this state after each accepted candidate model."
            ),
    }

    with open(
        STATE_PATH,
        "w",
        encoding="utf-8",
    ) as file:

        json.dump(
            state,
            file,
            indent=4,
        )

    print(
        f"Training state saved to:\n{STATE_PATH}"
    )

    # ========================================================
    # FINAL SUMMARY
    # ========================================================

    print_header(
        "TRAINING COMPLETE"
    )

    print(
        "FINAL MODEL STATUS: SUCCESS"
    )

    print(
        f"\nModel file:\n{MODEL_PATH}"
    )

    print(
        f"\nReport file:\n{REPORT_PATH}"
    )

    print(
        f"\nTraining rows: {len(train_df):,}"
    )

    print(
        f"Testing rows : {len(test_df):,}"
    )

    print(
        "\nOccupancy Accuracy:"
        f" {occupancy_metrics['accuracy']:.4f}"
    )

    print(
        "Occupancy Macro-F1:"
        f" {occupancy_metrics['macro_f1']:.4f}"
    )

    print(
        "\nFan Count:"
        f" MAE={fan_metrics['mae']:.4f},"
        f" RMSE={fan_metrics['rmse']:.4f},"
        f" R2={fan_metrics['r2']:.4f}"
    )

    print(
        "\nLight Count:"
        f" MAE={light_metrics['mae']:.4f},"
        f" RMSE={light_metrics['rmse']:.4f},"
        f" R2={light_metrics['r2']:.4f}"
    )

    print(
        "\nPower model:"
        " NOT TRAINED - waiting for real INA219 measurements."
    )

    print(
        "\nNext phase:"
        " connect this model package to prediction.py,"
        " then build the decision engine and simulator."
    )


# ============================================================
# 16. SCRIPT ENTRY POINT
# ============================================================

if __name__ == "__main__":
    main()
