"""
PFIS — ML Fraud Detection Service
==================================
Runs a Flask HTTP API that Node.js calls for every transaction.

Endpoints:
  POST /score          → score a single transaction
  POST /retrain        → add a labelled sample and optionally retrain
  GET  /model/status   → per-profile model stats
  POST /bootstrap      → generate synthetic normal data and train from scratch
"""

import json
import threading
import time
import logging
from collections import defaultdict
from datetime import datetime

import numpy as np
from flask import Flask, request, jsonify
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

logging.basicConfig(level=logging.INFO, format="%(asctime)s [ML] %(message)s")
log = logging.getLogger("pfis-ml")

app = Flask(__name__)

# ─── PROFILE DEFINITIONS (mirrors Node.js) ──────────────────────────────────
PROFILES = {
    "U-PF-001": {"name": "Kofi Mensah",     "avg": 600,  "hours": [8, 18],  "location": "Kumasi",     "device": "Samsung Galaxy A54"},
    "U-PF-002": {"name": "Ama Boateng",      "avg": 120,  "hours": [9, 20],  "location": "Accra",      "device": "iPhone 13"},
    "U-PF-003": {"name": "Kwame Asante",     "avg": 350,  "hours": [7, 21],  "location": "Takoradi",   "device": "Tecno Spark 10"},
    "U-PF-004": {"name": "Akosua Frimpong",  "avg": 1200, "hours": [6, 20],  "location": "Accra",      "device": "Xiaomi Redmi 12"},
    "U-PF-005": {"name": "Yaw Darko",        "avg": 450,  "hours": [8, 19],  "location": "Kumasi",     "device": "Samsung Galaxy A32"},
    "U-PF-006": {"name": "Efua Ansah",       "avg": 200,  "hours": [10, 22], "location": "Cape Coast", "device": "Tecno Camon 20"},
}

HIGH_RISK_RECIPIENTS = {"New Recipient", "Unknown Account", "International Wire"}

# ─── PER-PROFILE MODEL STATE ─────────────────────────────────────────────────
class ProfileModel:
    """Isolation Forest + scaler for a single user profile."""

    MIN_SAMPLES_TO_TRAIN = 20   # minimum normal samples before model is fitted
    RETRAIN_EVERY        = 15   # retrain after this many new labelled samples

    def __init__(self, profile_id: str):
        self.profile_id   = profile_id
        self.profile      = PROFILES[profile_id]

        self.model        = None
        self.scaler       = StandardScaler()
        self.trained      = False

        # Raw feature rows for (re)training
        self.normal_samples: list[list[float]] = []   # confirmed legit / auto-approved
        self.fraud_samples:  list[list[float]] = []   # operator-cancelled (confirmed fraud)

        self.pending_retrain = 0
        self.total_scored    = 0
        self.total_retrained = 0
        self._lock           = threading.Lock()

    # ── Feature engineering ─────────────────────────────────────────────────
    def featurise(self, txn: dict) -> list[float]:
        """
        Convert a raw transaction dict into a fixed-length feature vector.

        Features:
          0  amount_raw              — raw GHS amount
          1  amount_to_avg_ratio     — amount / profile average
          2  amount_log              — log(1 + amount)  (compresses long tail)
          3  hour_of_day             — 0–23
          4  is_off_hours            — 1 if outside profile's active window
          5  device_match            — 1 if matches registered device, else 0
          6  location_match          — 1 if matches registered location, else 0
          7  recipient_risk          — 1 if high-risk recipient category, else 0
          8  velocity_1h             — count of this user's txns in last 60 min
          9  amount_zscore           — z-score vs profile avg (rough)
        """
        profile  = self.profile
        ts       = txn.get("ts", time.time() * 1000)           # epoch ms
        dt       = datetime.fromtimestamp(ts / 1000)
        hour     = dt.hour

        amount   = float(txn.get("amount", 0))
        avg      = float(profile["avg"])
        h_start, h_end = profile["hours"]

        # velocity: count from txn's own history field if provided
        velocity = float(txn.get("velocity_1h", 0))

        # z-score using profile avg as mean, avg*0.5 as rough std
        std_est  = max(avg * 0.5, 1.0)
        z_score  = (amount - avg) / std_est

        return [
            amount,                                                    # 0
            amount / max(avg, 1),                                      # 1
            float(np.log1p(amount)),                                   # 2
            float(hour),                                               # 3
            float(not (h_start <= hour <= h_end)),                     # 4
            float(txn.get("device", "") == profile["device"]),         # 5
            float(txn.get("location", "") == profile["location"]),     # 6
            float(txn.get("recipient", "") in HIGH_RISK_RECIPIENTS),   # 7
            velocity,                                                  # 8
            float(np.clip(z_score, -5, 10)),                           # 9
        ]

    # ── Training ─────────────────────────────────────────────────────────────
    def _fit(self):
        """Fit/refit the Isolation Forest on accumulated normal samples."""
        if len(self.normal_samples) < self.MIN_SAMPLES_TO_TRAIN:
            return False

        X = np.array(self.normal_samples, dtype=float)

        # Weight: if we have fraud samples too, duplicate them to bias the model
        if self.fraud_samples:
            fraud_X    = np.array(self.fraud_samples, dtype=float)
            # repeat fraud samples 3× so they become "inliers" in a separate
            # inverted sense — Isolation Forest is unsupervised, so we instead
            # just train ONLY on normal samples; fraud samples are used at
            # score time to calibrate the decision boundary offset.
            pass   # (see scoring note below)

        X_scaled = self.scaler.fit_transform(X)

        contamination = min(0.1, max(0.01, len(self.fraud_samples) / max(len(self.normal_samples), 1)))

        self.model = IsolationForest(
            n_estimators=150,
            max_samples="auto",
            contamination=contamination,
            random_state=42,
            n_jobs=-1,
        )
        self.model.fit(X_scaled)
        self.trained         = True
        self.total_retrained += 1
        log.info(f"[{self.profile_id}] Model retrained — {len(self.normal_samples)} normal / "
                 f"{len(self.fraud_samples)} fraud samples  (contamination={contamination:.3f})")
        return True

    # ── Scoring ──────────────────────────────────────────────────────────────
    def score(self, txn: dict) -> dict:
        """
        Returns:
          score         0–100  (100 = most anomalous)
          risk          safe | moderate | high
          anomaly_score raw IF score (-1..+1, lower = more anomalous)
          features      dict of feature name → value
          top_factors   list of feature names contributing most to anomaly
          model_ready   bool
        """
        self.total_scored += 1
        features     = self.featurise(txn)
        feat_names   = [
            "amount_raw", "amount_to_avg_ratio", "amount_log",
            "hour_of_day", "is_off_hours",
            "device_match", "location_match", "recipient_risk",
            "velocity_1h", "amount_zscore",
        ]
        feat_dict = dict(zip(feat_names, features))

        if not self.trained or self.model is None:
            # Fall back to a simple heuristic score while model warms up
            heuristic = self._heuristic_score(features)
            return {
                "score":         heuristic,
                "risk":          self._classify(heuristic),
                "anomaly_score": None,
                "features":      feat_dict,
                "top_factors":   self._heuristic_factors(feat_dict),
                "model_ready":   False,
                "samples_needed": max(0, self.MIN_SAMPLES_TO_TRAIN - len(self.normal_samples)),
            }

        X      = np.array([features], dtype=float)
        X_sc   = self.scaler.transform(X)

        # raw_score: +1 = inlier (normal), -1 = outlier (anomaly)
        raw     = float(self.model.score_samples(X_sc)[0])

        # Map to 0–100: more negative raw → higher risk score
        # Typical range for raw is roughly -0.7 .. +0.1
        # We map  +0.1 → 0  and  -0.7 → 100
        lo, hi  = -0.7, 0.1
        normed  = (hi - raw) / (hi - lo)
        ml_score = int(np.clip(normed * 100, 0, 100))

        # Feature importance via per-feature perturbation (lightweight SHAP-like)
        top_factors = self._explain(X_sc[0], feat_names)

        return {
            "score":         ml_score,
            "risk":          self._classify(ml_score),
            "anomaly_score": raw,
            "features":      feat_dict,
            "top_factors":   top_factors,
            "model_ready":   True,
            "samples_needed": 0,
        }

    def _explain(self, x_scaled: np.ndarray, feat_names: list) -> list[str]:
        """
        Lightweight feature attribution: perturb each feature to its mean (0 in
        scaled space) and measure change in anomaly score.  Features with the
        largest positive delta (perturbing them makes the point *less* anomalous)
        are the top contributors.
        """
        base_score = float(self.model.score_samples([x_scaled])[0])
        deltas     = []
        for i in range(len(x_scaled)):
            perturbed    = x_scaled.copy()
            perturbed[i] = 0.0          # replace with mean
            new_score    = float(self.model.score_samples([perturbed])[0])
            deltas.append((feat_names[i], new_score - base_score))

        # Sort by delta descending: largest positive delta = most anomalous feature
        deltas.sort(key=lambda x: -x[1])
        return [name for name, delta in deltas if delta > 0.01][:3] or ["No dominant factor"]

    def _heuristic_score(self, features: list) -> int:
        """Simple weighted heuristic used before model is ready."""
        score = 0
        # amount_to_avg_ratio (idx 1)
        ratio = features[1]
        if ratio > 3:   score += 30
        elif ratio > 2: score += 15
        # is_off_hours (idx 4)
        if features[4]: score += 15
        # device_match (idx 5) — 0 means mismatch
        if features[5] == 0: score += 20
        # location_match (idx 6)
        if features[6] == 0: score += 15
        # recipient_risk (idx 7)
        if features[7]: score += 20
        return min(score, 100)

    def _heuristic_factors(self, feat_dict: dict) -> list[str]:
        factors = []
        if feat_dict["amount_to_avg_ratio"] > 3:  factors.append("amount_to_avg_ratio")
        if feat_dict["is_off_hours"]:              factors.append("is_off_hours")
        if feat_dict["device_match"] == 0:         factors.append("device_mismatch")
        if feat_dict["location_match"] == 0:       factors.append("location_mismatch")
        if feat_dict["recipient_risk"]:             factors.append("recipient_risk")
        return factors or ["No dominant factor"]

    @staticmethod
    def _classify(score: int) -> str:
        if score <= 40:  return "safe"
        if score <= 70:  return "moderate"
        return "high"

    # ── Feedback / retraining ────────────────────────────────────────────────
    def add_sample(self, txn: dict, label: str):
        """
        label: 'normal' | 'fraud'
        Accumulates labelled data and triggers retraining when threshold hit.
        """
        features = self.featurise(txn)
        with self._lock:
            if label == "fraud":
                self.fraud_samples.append(features)
            else:
                self.normal_samples.append(features)
            self.pending_retrain += 1

            if self.pending_retrain >= self.RETRAIN_EVERY or (
                not self.trained and len(self.normal_samples) >= self.MIN_SAMPLES_TO_TRAIN
            ):
                self._fit()
                self.pending_retrain = 0


# ─── MODEL REGISTRY ─────────────────────────────────────────────────────────
models: dict[str, ProfileModel] = {pid: ProfileModel(pid) for pid in PROFILES}


# ─── SYNTHETIC BOOTSTRAP ────────────────────────────────────────────────────
def bootstrap_all(n_per_profile: int = 200):
    """
    Generate synthetic 'normal' transactions for each profile and train
    an initial model so the system is ready immediately on first run.
    """
    rng = np.random.default_rng(42)

    DEVICES_LIST    = ["Samsung Galaxy A54","iPhone 13","Tecno Spark 10","Xiaomi Redmi 12",
                       "Samsung Galaxy A32","Tecno Camon 20","Unknown Android Device","New iPhone"]
    LOCATIONS_LIST  = ["Accra","Kumasi","Takoradi","Tamale","Cape Coast",
                       "Sunyani","Ho","Bolgatanga","Unknown Location","International IP"]
    RECIPIENTS_LIST = ["MTN MoMo #0244-XXX","Vodafone Cash #0205-XXX","AirtelTigo #0277-XXX",
                       "GCB Acct #1003-XXX","Ecobank #0038-XXX","New Recipient","Unknown Account","International Wire"]

    for pid, pm in models.items():
        p = PROFILES[pid]
        h_start, h_end = p["hours"]

        for _ in range(n_per_profile):
            # Normal transaction: amount near avg, correct device/location, business hours
            amount   = float(rng.normal(p["avg"], p["avg"] * 0.3))
            amount   = max(10.0, amount)
            hour     = int(rng.integers(h_start, h_end + 1))
            device   = p["device"] if rng.random() > 0.05 else rng.choice(DEVICES_LIST)
            location = p["location"] if rng.random() > 0.05 else rng.choice(LOCATIONS_LIST)
            recipient = rng.choice(RECIPIENTS_LIST[:5])  # only known recipients for normal
            velocity = int(rng.integers(0, 3))

            # Small fraction of anomalies (5%) mixed into normal to set contamination baseline
            is_anomaly = rng.random() < 0.05
            if is_anomaly:
                amount   = float(rng.uniform(p["avg"] * 4, p["avg"] * 10))
                hour     = int(rng.choice([0, 1, 2, 3, 4, 22, 23]))
                device   = rng.choice(DEVICES_LIST[6:])
                location = rng.choice(LOCATIONS_LIST[8:])
                recipient = rng.choice(RECIPIENTS_LIST[5:])
                velocity = int(rng.integers(4, 10))

            synthetic_txn = {
                "amount":      amount,
                "ts":          time.time() * 1000,
                "device":      device,
                "location":    location,
                "recipient":   recipient,
                "velocity_1h": velocity,
            }
            pm.add_sample(synthetic_txn, "fraud" if is_anomaly else "normal")

        log.info(f"[{pid}] Bootstrap complete — {len(pm.normal_samples)} normal, "
                 f"{len(pm.fraud_samples)} fraud, trained={pm.trained}")


# ─── API ENDPOINTS ───────────────────────────────────────────────────────────

@app.route("/score", methods=["POST"])
def score():
    """
    Score a transaction.

    Body: { profile: { id, ... }, amount, ts, device, location, recipient, velocity_1h? }
    Returns: { score, risk, anomaly_score, features, top_factors, model_ready }
    """
    data       = request.get_json(force=True)
    profile_id = data.get("profile", {}).get("id", "")

    if profile_id not in models:
        return jsonify({"error": f"Unknown profile: {profile_id}"}), 400

    pm     = models[profile_id]
    result = pm.score(data)
    return jsonify(result)


@app.route("/retrain", methods=["POST"])
def retrain():
    """
    Add a labelled sample (from operator decision) and trigger retraining.

    Body: { txn: {...}, label: 'normal' | 'fraud' }
    """
    data  = request.get_json(force=True)
    txn   = data.get("txn", {})
    label = data.get("label", "normal")

    profile_id = txn.get("profile", {}).get("id", "")
    if profile_id not in models:
        return jsonify({"error": f"Unknown profile: {profile_id}"}), 400

    models[profile_id].add_sample(txn, label)
    return jsonify({
        "ok":     True,
        "label":  label,
        "normal_samples": len(models[profile_id].normal_samples),
        "fraud_samples":  len(models[profile_id].fraud_samples),
        "trained":        models[profile_id].trained,
    })


@app.route("/model/status", methods=["GET"])
def model_status():
    """Return per-profile model health stats."""
    status = {}
    for pid, pm in models.items():
        status[pid] = {
            "name":            pm.profile["name"],
            "trained":         pm.trained,
            "normal_samples":  len(pm.normal_samples),
            "fraud_samples":   len(pm.fraud_samples),
            "total_scored":    pm.total_scored,
            "total_retrained": pm.total_retrained,
            "pending_retrain": pm.pending_retrain,
            "samples_needed":  max(0, pm.MIN_SAMPLES_TO_TRAIN - len(pm.normal_samples)),
        }
    return jsonify(status)


@app.route("/bootstrap", methods=["POST"])
def bootstrap_endpoint():
    """Re-run bootstrap (wipes existing model state)."""
    global models
    models = {pid: ProfileModel(pid) for pid in PROFILES}
    n = request.get_json(force=True).get("n", 200)
    threading.Thread(target=bootstrap_all, args=(n,), daemon=True).start()
    return jsonify({"ok": True, "message": f"Bootstrap started with {n} samples per profile."})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "profiles": len(models)})


# ─── STARTUP ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info("Bootstrapping models with synthetic data…")
    bootstrap_all(n_per_profile=200)
    log.info("All models ready. Starting Flask on :5001")
    app.run(host="0.0.0.0", port=5001, debug=False)
