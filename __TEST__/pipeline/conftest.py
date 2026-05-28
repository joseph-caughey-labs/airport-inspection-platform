"""Shared pytest fixtures for the AI pipeline tier.

The async Redis fakes live in `_fakes.py` so tests can import the
classes directly. Fixtures here just wrap them.
"""

from __future__ import annotations

import pytest
from _fakes import FakeBroker, FakeRedis


@pytest.fixture
def fake_broker() -> FakeBroker:
    return FakeBroker()


@pytest.fixture
def fake_redis(fake_broker: FakeBroker) -> FakeRedis:
    return FakeRedis(broker=fake_broker)
