-- Airport Inspection Platform — Postgres initialization
-- Runs once on first container start via /docker-entrypoint-initdb.d/

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- PostGIS extension lands in T-105 alongside runway geometry modeling.
-- Application schema is created by the migration runner, not here.
