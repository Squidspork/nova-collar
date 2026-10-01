"""Long-lived Nova Pup reader. One JSON line in, one JSON line out."""

from __future__ import annotations

import json
import os
import sys
import time
import warnings
from pathlib import Path

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parents[1]
MODEL = Path(os.environ.get("NP_LAYA_MODEL") or (ROOT / "models" / "laya-np"))
DATA = Path(os.environ.get("NP_LAYA_DATA") or (ROOT / "data"))
QUESTIONS = {
    "job": json.loads((DATA / "laya-np-question.json").read_text()),
    "loop": json.loads((DATA / "laya-np-loop.json").read_text()),
    "goal": json.loads((DATA / "laya-np-goal.json").read_text()),
    "audit": json.loads((DATA / "laya-np-audit.json").read_text()),
}


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    if not (MODEL / "model.safetensors").is_file():
        emit({"ready": False, "error": "no laya-np checkpoint"})
        return
    import laya

    device = "mps" if __import__("torch").backends.mps.is_available() else "cpu"
    agent = laya.Agent(str(MODEL), device=device)
    emit({"ready": True, "device": device})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            text = str(payload.get("text") or "")
            ask = str(payload.get("ask") or "job")
        except json.JSONDecodeError:
            emit({"ok": False, "error": "bad json"})
            continue
        if ask not in QUESTIONS:
            emit({"ok": False, "error": "unknown ask"})
            continue
        if not text.strip():
            emit({"ok": True, "answers": None})
            continue
        started = time.perf_counter()
        try:
            result = agent.predict(text, {ask: QUESTIONS[ask]})
            answer = result["answers"][ask]
            emit({
                "ok": True,
                "ms": round((time.perf_counter() - started) * 1000, 1),
                "ask": ask,
                "choice": answer["choice"],
                "confidence": answer.get("answer_confidence", 0),
                "probabilities": answer.get("probabilities", {}),
            })
        except Exception as exc:
            emit({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
