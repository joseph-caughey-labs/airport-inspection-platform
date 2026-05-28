"""Smoke tests for the ai-inference service.

Proves the FastAPI app boots, the runtime lifespan starts + stops
cleanly with an empty detector registry, and the HTTP probes behave
correctly with and without a working broker.
"""

from __future__ import annotations

import pytest
from _fakes import FakeRedis
from fastapi.testclient import TestClient

from src.app import build_app


@pytest.fixture
def healthy_client(fake_redis: FakeRedis) -> TestClient:
    return TestClient(build_app(redis_client=fake_redis))


@pytest.fixture
def unhealthy_client() -> TestClient:
    redis = FakeRedis(ping_exception=Exception("connection refused"))
    return TestClient(build_app(redis_client=redis))


def test_health_endpoint_returns_ok(healthy_client: TestClient) -> None:
    response = healthy_client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_endpoint_returns_ready_when_redis_responds(
    healthy_client: TestClient,
) -> None:
    response = healthy_client.get("/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert isinstance(body["latency_ms"], int | float)


def test_ready_endpoint_returns_503_when_redis_throws(
    unhealthy_client: TestClient,
) -> None:
    response = unhealthy_client.get("/ready")
    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "unhealthy"
    assert body["error"] == "connection refused"


def test_ready_endpoint_does_not_leak_stack_traces(
    unhealthy_client: TestClient,
) -> None:
    response = unhealthy_client.get("/ready")
    text = response.text
    assert "Traceback" not in text
    assert "site-packages" not in text


def test_metrics_endpoint_returns_prometheus_format(
    healthy_client: TestClient,
) -> None:
    response = healthy_client.get("/metrics")
    assert response.status_code == 200
    assert "service_info" in response.text
    assert 'service="ai-inference"' in response.text


def test_unknown_route_returns_404(healthy_client: TestClient) -> None:
    response = healthy_client.get("/does-not-exist")
    assert response.status_code == 404
