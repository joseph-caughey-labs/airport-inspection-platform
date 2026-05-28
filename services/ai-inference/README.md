# `ai-inference`

Simulated computer-vision / ML inference. This PR lands the **shell** — FastAPI app, healthchecks, Redis connection, project layout. Real detectors (FOD, pavement crack, snowbank, wildlife, generic anomaly), confidence calibration, batch inference, GPU-unavailable fallback, and false-positive suppression arrive in Phase 3 (T-301 → T-309).

## Endpoints

| Method | Path       | Returns                                    |
| ------ | ---------- | ------------------------------------------ |
| GET    | `/health`  | 200 ok                                     |
| GET    | `/ready`   | 200 when Redis answers PING; 503 otherwise |
| GET    | `/metrics` | Prometheus exposition                      |

## Project layout

```
src/
├── main.py            # entrypoint
├── app.py             # FastAPI app builder
├── health.py          # readiness + Redis probe
├── redis_client.py    # Redis wrapper
├── models/            # mock ONNX/TensorRT wrappers (T-301)
├── detectors/         # FOD, crack, snowbank, wildlife, anomaly (T-302–T-305)
├── pipeline/          # batch + streaming orchestrator (T-307)
├── confidence/        # calibration + thresholds (T-306)
├── consumers/         # Redis frame consumers (T-301)
├── publishers/        # detection event publishers (T-301)
└── fallback/          # GPU-unavailable simulation (T-308)
```

## Configuration

| Var          | Default |
| ------------ | ------- |
| `PORT`       | `8000`  |
| `LOG_LEVEL`  | `info`  |
| `REDIS_HOST` | `redis` |
| `REDIS_PORT` | `6379`  |

## Local dev

```bash
cd services/ai-inference
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn src.app:app --reload --port 8000
```

## Tests

Tests live in `__TEST__/pipeline/` (per the brief's centralized location).

```bash
pip install -e ".[dev]"
pytest -q
```

Phase 3 will add detector-specific tests, calibration assertions, and fixture frames.
