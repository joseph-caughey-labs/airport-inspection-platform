-- Migration 0002 — sensor events + outbox
--
-- Adds two tables:
--   1. `sensor_events` — durable record of every sensor frame that
--      survives dedup + prioritization. Idempotency-key column with a
--      unique constraint prevents re-processing on replay.
--   2. `event_outbox` — outbox pattern. The persistence path INSERTs
--      a (channel, payload) row in the same transaction as the
--      sensor_events row. An outbox worker drains rows and publishes
--      to Redis, marking them published. If the worker crashes before
--      publish, recovery is the simple poll-and-publish loop.

-- ─── sensor_events ─────────────────────────────────────────────────
CREATE TABLE sensor_events (
  event_id         uuid PRIMARY KEY,
  sensor_id        varchar(64) NOT NULL,
  sensor_type      text NOT NULL,
  frame_id         varchar(128) NOT NULL,
  captured_at      timestamptz NOT NULL,
  geo_lat          double precision NOT NULL,
  geo_lng          double precision NOT NULL,
  geo_alt_m        double precision,
  airport_id       uuid REFERENCES airports(id) ON DELETE SET NULL,
  metadata         jsonb NOT NULL,
  idempotency_key  varchar(200) NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sensor_events_sensor_type_chk
    CHECK (sensor_type IN ('camera','lidar','gps','imu','weather','perimeter')),
  CONSTRAINT sensor_events_lat_chk CHECK (geo_lat BETWEEN -90 AND 90),
  CONSTRAINT sensor_events_lng_chk CHECK (geo_lng BETWEEN -180 AND 180),
  CONSTRAINT sensor_events_idempotency_key_uniq UNIQUE (idempotency_key)
);

CREATE INDEX sensor_events_sensor_received_idx
  ON sensor_events (sensor_id, received_at DESC);
CREATE INDEX sensor_events_captured_idx ON sensor_events (captured_at DESC);
CREATE INDEX sensor_events_airport_idx ON sensor_events (airport_id);

-- ─── event_outbox ──────────────────────────────────────────────────
CREATE TABLE event_outbox (
  id            bigserial PRIMARY KEY,
  channel       varchar(200) NOT NULL,
  payload       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      int NOT NULL DEFAULT 0
);

-- Partial index: the outbox worker only ever wants unpublished rows.
CREATE INDEX event_outbox_unpublished_idx
  ON event_outbox (id)
  WHERE published_at IS NULL;
