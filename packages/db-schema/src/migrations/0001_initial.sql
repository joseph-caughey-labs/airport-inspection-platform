-- Migration 0001 — initial schema
--
-- Creates the six core entities, FK relationships, CHECK constraints
-- mirroring shared-contracts enums, idempotency-key indexes, and the
-- audit-table grant revocations that enforce append-only at the DB
-- role level (see ADR 0010).
--
-- All timestamps are `timestamptz`. All ids on entities created by the
-- system are UUIDs; sensor ids follow the operational TYPE-LOCATION-INDEX
-- convention.

-- Extensions are created by infrastructure/docker/postgres/init.sql on
-- first container start. This migration assumes uuid-ossp + pgcrypto are
-- available.

-- ─── Airports ────────────────────────────────────────────────────────
CREATE TABLE airports (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  icao_code    char(4)     NOT NULL UNIQUE,
  iata_code    char(3),
  name         varchar(200) NOT NULL,
  city         varchar(100) NOT NULL,
  country      char(2)     NOT NULL,
  timezone     text         NOT NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT airports_icao_code_chk CHECK (icao_code ~ '^[A-Z]{4}$'),
  CONSTRAINT airports_iata_code_chk CHECK (iata_code IS NULL OR iata_code ~ '^[A-Z]{3}$'),
  CONSTRAINT airports_country_chk CHECK (country ~ '^[A-Z]{2}$')
);

-- ─── Runways ─────────────────────────────────────────────────────────
CREATE TABLE runways (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  airport_id          uuid NOT NULL REFERENCES airports(id) ON DELETE CASCADE,
  designator          varchar(4) NOT NULL,
  paired_designator   varchar(4) NOT NULL,
  length_m            double precision NOT NULL,
  width_m             double precision NOT NULL,
  surface             text NOT NULL,
  status              text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runways_designator_chk CHECK (designator ~ '^(0[1-9]|[12][0-9]|3[0-6])[LRC]?$'),
  CONSTRAINT runways_paired_designator_chk CHECK (paired_designator ~ '^(0[1-9]|[12][0-9]|3[0-6])[LRC]?$'),
  CONSTRAINT runways_length_chk CHECK (length_m > 0),
  CONSTRAINT runways_width_chk CHECK (width_m > 0),
  CONSTRAINT runways_surface_chk CHECK (surface IN ('asphalt','concrete','gravel','turf','other')),
  CONSTRAINT runways_status_chk CHECK (status IN ('open','closed','restricted','maintenance')),
  UNIQUE (airport_id, designator)
);

CREATE INDEX runways_airport_idx ON runways(airport_id);

-- ─── Sensors ─────────────────────────────────────────────────────────
CREATE TABLE sensors (
  id           varchar(64) PRIMARY KEY,
  airport_id   uuid NOT NULL REFERENCES airports(id) ON DELETE CASCADE,
  type         text NOT NULL,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  alt_m        double precision,
  status       text NOT NULL,
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sensors_id_chk CHECK (id ~ '^[A-Z]{2,4}-[A-Z0-9]+-[0-9]{2,3}$'),
  CONSTRAINT sensors_type_chk CHECK (type IN ('camera','lidar','gps','imu','weather','perimeter')),
  CONSTRAINT sensors_status_chk CHECK (status IN ('online','degraded','offline')),
  CONSTRAINT sensors_lat_chk CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT sensors_lng_chk CHECK (lng BETWEEN -180 AND 180)
);

CREATE INDEX sensors_airport_idx ON sensors(airport_id);
CREATE INDEX sensors_type_idx ON sensors(type);

-- ─── Users ───────────────────────────────────────────────────────────
CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email        varchar(320) NOT NULL UNIQUE,
  name         varchar(200) NOT NULL,
  role         text         NOT NULL,
  organization varchar(200) NOT NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT users_role_chk CHECK (role IN ('operator','reviewer','admin'))
);

-- ─── Incidents ───────────────────────────────────────────────────────
CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  airport_id       uuid NOT NULL REFERENCES airports(id) ON DELETE RESTRICT,
  runway_id        uuid REFERENCES runways(id) ON DELETE SET NULL,
  severity         text NOT NULL,
  status           text NOT NULL DEFAULT 'new',
  title            varchar(300) NOT NULL,
  details          jsonb,
  acknowledged_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at  timestamptz,
  assigned_to      uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  idempotency_key  varchar(200),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incidents_severity_chk CHECK (severity IN ('critical','high','medium','low','info')),
  CONSTRAINT incidents_status_chk CHECK (
    status IN ('new','acknowledged','assigned','in_progress','resolved','escalated','archived','rejected')
  )
);

CREATE INDEX incidents_airport_status_idx ON incidents(airport_id, status);
CREATE INDEX incidents_severity_idx ON incidents(severity);
CREATE INDEX incidents_created_at_idx ON incidents(created_at DESC);

-- Partial unique index — only enforced when idempotency_key is NOT NULL,
-- so concurrent NULL keys do not collide.
CREATE UNIQUE INDEX incidents_idempotency_key_uniq
  ON incidents(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Keep updated_at fresh on row update.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER incidents_set_updated_at
  BEFORE UPDATE ON incidents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Audit events (append-only) ──────────────────────────────────────
CREATE TABLE audit_events (
  seq             bigserial PRIMARY KEY,
  event_id        uuid NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  source          varchar(100) NOT NULL,
  event_type      varchar(200) NOT NULL,
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  subject_id      varchar(200),
  payload         jsonb NOT NULL,
  prev_hash       char(64),
  entry_hash      char(64) NOT NULL,
  correlation_id  uuid,
  rationale       text
);

CREATE INDEX audit_events_subject_idx ON audit_events(subject_id);
CREATE INDEX audit_events_correlation_idx ON audit_events(correlation_id);
CREATE INDEX audit_events_event_type_idx ON audit_events(event_type);
CREATE INDEX audit_events_occurred_at_idx ON audit_events(occurred_at DESC);

-- Enforce append-only at the role level. The application user
-- (whichever role connects from services) is denied UPDATE/DELETE on
-- audit_events. A separate, more-privileged role can be created for
-- legal-hold / forensic cleanup procedures (out of scope here).
--
-- We revoke on the connecting role explicitly. `current_user` is the
-- session role at migration time; for the local docker compose stack
-- this is the POSTGRES_USER (e.g. `airport_ops`).
DO $$
DECLARE
  app_role text := current_user;
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE ON audit_events FROM %I', app_role);
  EXECUTE format('REVOKE TRUNCATE ON audit_events FROM %I', app_role);
END;
$$;
