-- ─────────────────────────────────────────────────────────────────────────────
-- Fleet Telemetry Server — Supabase schema
-- Run this entire file once in the Supabase SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── fleet_vehicles ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_vehicles (
  id           BIGSERIAL    PRIMARY KEY,
  vin          VARCHAR      NOT NULL UNIQUE,
  display_name VARCHAR,
  model        VARCHAR,
  year         INTEGER,
  color        VARCHAR,
  first_seen   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  source       VARCHAR      NOT NULL DEFAULT 'SUPA'
);

ALTER TABLE fleet_vehicles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_vehicles_all" ON fleet_vehicles FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_trips ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_trips (
  id              BIGSERIAL    PRIMARY KEY,
  vin             VARCHAR      NOT NULL,
  start_time      TIMESTAMPTZ  NOT NULL,
  end_time        TIMESTAMPTZ,
  start_location  JSONB,
  end_location    JSONB,
  start_battery   INTEGER,
  end_battery     INTEGER,
  start_odometer  DOUBLE PRECISION,
  end_odometer    DOUBLE PRECISION,
  distance_miles  DOUBLE PRECISION,
  energy_used_kwh DOUBLE PRECISION,
  avg_speed       DOUBLE PRECISION,
  max_speed       DOUBLE PRECISION,
  start_bms_state   VARCHAR,
  end_bms_state     VARCHAR,
  status            VARCHAR      NOT NULL DEFAULT 'active',
  charge_accounted  BOOLEAN      DEFAULT NULL,  -- NULL = not yet counted toward a charge session
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  cut_off           BOOLEAN      NOT NULL DEFAULT false,
  source            VARCHAR      NOT NULL DEFAULT 'SUPA'
);

CREATE INDEX IF NOT EXISTS fleet_trips_vin_start_time ON fleet_trips(vin, start_time DESC);

ALTER TABLE fleet_trips ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_trips_all" ON fleet_trips FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_charging_sessions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_charging_sessions (
  id                      BIGSERIAL    PRIMARY KEY,
  vin                     VARCHAR      NOT NULL,
  start_time              TIMESTAMPTZ  NOT NULL,
  end_time                TIMESTAMPTZ,
  start_battery           INTEGER,
  end_battery             INTEGER,
  start_range             DOUBLE PRECISION,
  end_range               DOUBLE PRECISION,
  energy_added_kwh        DOUBLE PRECISION,
  charge_rate_avg         DOUBLE PRECISION,
  charge_rate_max         DOUBLE PRECISION,
  duration_minutes        DOUBLE PRECISION,
  location                JSONB,
  status                  VARCHAR      NOT NULL DEFAULT 'active',
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  cut_off                 BOOLEAN      NOT NULL DEFAULT true,
  charger_power                      INTEGER,
  start_odometer                     DOUBLE PRECISION,
  miles_since_last_charge            DOUBLE PRECISION,
  end_odometer                       DOUBLE PRECISION,
  energy_used_since_last_charge_kwh  DOUBLE PRECISION,  -- sum of trip kWh since previous charge
  end_ideal_range_mi                 DOUBLE PRECISION,
  end_rated_range_mi                 DOUBLE PRECISION,
  charging_cable_type                VARCHAR,
  fast_charger_type                  VARCHAR,
  start_bms_state                    VARCHAR,
  end_bms_state                      VARCHAR,
  source                             VARCHAR      NOT NULL DEFAULT 'SUPA'
);

CREATE INDEX IF NOT EXISTS fleet_charging_sessions_vin_start_time
  ON fleet_charging_sessions(vin, start_time DESC);

ALTER TABLE fleet_charging_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_charging_sessions_all" ON fleet_charging_sessions FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_telemetry_data ───────────────────────────────────────────────────
-- Append-only row per message. Enable via ENABLE_TELEMETRY_EVENTS=true env var.
CREATE TABLE IF NOT EXISTS fleet_telemetry_data (
  id                    BIGSERIAL    PRIMARY KEY,
  vin                   VARCHAR      NOT NULL,
  recorded_at           TIMESTAMPTZ  NOT NULL,
  -- Location
  latitude              DOUBLE PRECISION,
  longitude             DOUBLE PRECISION,
  gps_heading           DOUBLE PRECISION,
  -- Motion
  speed                 DOUBLE PRECISION,
  odometer              DOUBLE PRECISION,
  miles_since_reset     DOUBLE PRECISION,
  self_driving_miles_since_reset DOUBLE PRECISION,
  shift_state           VARCHAR,
  -- Battery
  battery_level         INTEGER,
  usable_battery_level  DOUBLE PRECISION,
  pack_voltage_v        DOUBLE PRECISION,
  pack_current_a        DOUBLE PRECISION,
  energy_remaining_kwh  DOUBLE PRECISION,
  est_battery_range     DOUBLE PRECISION,
  rated_range_mi        DOUBLE PRECISION,
  ideal_range_mi        DOUBLE PRECISION,
  -- Charging
  charge_state          VARCHAR,
  charge_amps           DOUBLE PRECISION,
  charger_voltage_v     DOUBLE PRECISION,
  ac_charging_power_kw  DOUBLE PRECISION,
  dc_charging_power_kw  DOUBLE PRECISION,
  charge_rate           DOUBLE PRECISION,
  charger_power         INTEGER,
  charge_limit_soc      INTEGER,
  time_to_full_charge_h DOUBLE PRECISION,
  fast_charger_present  BOOLEAN,
  charge_port_door_open BOOLEAN,
  -- Climate
  inside_temp_c         DOUBLE PRECISION,
  outside_temp_c        DOUBLE PRECISION,
  -- Security / misc
  locked                BOOLEAN,
  sentry_mode           VARCHAR,
  software_version      VARCHAR,
  -- Legacy / catch-all
  power                 INTEGER,
  raw_data              JSONB,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  cut_off               BOOLEAN      NOT NULL DEFAULT true,
  source                VARCHAR      NOT NULL DEFAULT 'SUPA'
);

CREATE INDEX IF NOT EXISTS fleet_telemetry_data_vin_recorded_at
  ON fleet_telemetry_data(vin, recorded_at DESC);

ALTER TABLE fleet_telemetry_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_telemetry_data_all" ON fleet_telemetry_data FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_telemetry_state ─────────────────────────────────────────────────
-- Latest merged state per VIN — upserted on every message (dashboard use).
CREATE TABLE IF NOT EXISTS fleet_telemetry_state (
  vin                       VARCHAR      PRIMARY KEY,
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  gear                      VARCHAR,
  vehicle_speed_mph         DOUBLE PRECISION,
  odometer_mi               DOUBLE PRECISION,
  miles_since_reset         DOUBLE PRECISION,
  soc_pct                   DOUBLE PRECISION,
  battery_level_pct         DOUBLE PRECISION,
  pack_voltage_v            DOUBLE PRECISION,
  pack_current_a            DOUBLE PRECISION,
  energy_remaining_kwh      DOUBLE PRECISION,
  rated_range_mi            DOUBLE PRECISION,
  est_battery_range_mi      DOUBLE PRECISION,
  ideal_battery_range_mi    DOUBLE PRECISION,
  lifetime_energy_used_kwh  DOUBLE PRECISION,
  self_driving_miles_since_reset DOUBLE PRECISION,
  detailed_charge_state     VARCHAR,
  charge_amps               DOUBLE PRECISION,
  charger_voltage_v         DOUBLE PRECISION,
  ac_charging_power_kw      DOUBLE PRECISION,
  dc_charging_power_kw      DOUBLE PRECISION,
  charge_limit_soc_pct      DOUBLE PRECISION,
  time_to_full_charge_h     DOUBLE PRECISION,
  fast_charger_present      BOOLEAN,
  charge_port_door_open     BOOLEAN,
  inside_temp_c             DOUBLE PRECISION,
  outside_temp_c            DOUBLE PRECISION,
  locked                    BOOLEAN,
  sentry_mode               VARCHAR,
  vehicle_name              VARCHAR,
  software_version          VARCHAR,
  raw_state                 JSONB,
  source                    VARCHAR      NOT NULL DEFAULT 'SUPA'
);

ALTER TABLE fleet_telemetry_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_telemetry_state_all" ON fleet_telemetry_state FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_daily_summary ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_daily_summary (
  id                     BIGSERIAL   PRIMARY KEY,
  vin                    VARCHAR     NOT NULL,
  date                   DATE        NOT NULL,
  total_miles            DOUBLE PRECISION DEFAULT 0,
  total_energy_used_kwh  DOUBLE PRECISION DEFAULT 0,
  total_energy_added_kwh DOUBLE PRECISION DEFAULT 0,
  num_trips              INTEGER          DEFAULT 0,
  num_charges            INTEGER          DEFAULT 0,
  avg_efficiency         DOUBLE PRECISION,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cut_off                BOOLEAN     NOT NULL DEFAULT true,
  source                 VARCHAR     NOT NULL DEFAULT 'SUPA',
  UNIQUE (vin, date)
);

CREATE INDEX IF NOT EXISTS fleet_daily_summary_vin_date
  ON fleet_daily_summary(vin, date DESC);

ALTER TABLE fleet_daily_summary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_daily_summary_all" ON fleet_daily_summary FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_auth_tokens ─────────────────────────────────────────────────────
-- Single row ("default") storing the Tesla OAuth token so it survives Render restarts.
CREATE TABLE IF NOT EXISTS fleet_auth_tokens (
  id            TEXT        PRIMARY KEY DEFAULT 'default',
  user_id       TEXT        NOT NULL,
  access_token  TEXT        NOT NULL,
  refresh_token TEXT        NOT NULL,
  expires_at    BIGINT      NOT NULL,
  scope         TEXT        DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source        VARCHAR     NOT NULL DEFAULT 'SUPA'
);

ALTER TABLE fleet_auth_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_auth_tokens_all" ON fleet_auth_tokens FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_software_versions ───────────────────────────────────────────────
-- One row per (vin, current_version) — tracks every OTA firmware update.
CREATE TABLE IF NOT EXISTS fleet_software_versions (
  id               BIGSERIAL   PRIMARY KEY,
  vin              VARCHAR     NOT NULL,
  update_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_version  VARCHAR     NOT NULL,
  previous_version VARCHAR,
  source           VARCHAR     NOT NULL DEFAULT 'SUPA',
  CONSTRAINT fleet_software_versions_vin_version_key UNIQUE (vin, current_version)
);

CREATE INDEX IF NOT EXISTS fleet_software_versions_vin_time
  ON fleet_software_versions(vin, update_time DESC);

ALTER TABLE fleet_software_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_software_versions_all" ON fleet_software_versions FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_api_tracking ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_api_tracking (
  id           BIGSERIAL   PRIMARY KEY,
  vin          VARCHAR     NOT NULL,
  date         DATE        NOT NULL,
  signal_count INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source       VARCHAR     NOT NULL DEFAULT 'SUPA',
  UNIQUE (vin, date)
);

CREATE INDEX IF NOT EXISTS fleet_api_tracking_vin_date
  ON fleet_api_tracking(vin, date DESC);

ALTER TABLE fleet_api_tracking ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_api_tracking_all" ON fleet_api_tracking FOR ALL USING (true) WITH CHECK (true);

-- ── fleet_trips reverse geocoding ────────────────────────────────────────────
-- Resolves start_location/end_location (JSONB {latitude, longitude} written by the
-- app) into human-readable addresses, entirely inside Postgres — no application
-- code involved. Runs via the `http` extension calling Nominatim (OpenStreetMap)
-- reverse geocoding, synchronously, before the row is written.
--
-- Caveats:
--   - Nominatim's public API has a ~1 req/sec rate limit and no SLA — under load
--     this trigger can slow down or fail trip writes. On exception it falls back
--     to 'Location Fetch Error' rather than failing the write; on a non-200
--     response (no exception) the address column is simply left unset.
--   - SECURITY DEFINER: runs with the privileges of the function owner, not the
--     caller — required for the `http` extension call to work from all clients.
--   - Address is truncated to the first two comma-separated segments of
--     Nominatim's `display_name` (typically road + locality) to keep it short.
--   - The trigger's WHEN clause only fires when start_location/end_location
--     actually changes (not on every UPDATE — trips are updated frequently for
--     last_seen_at/max_speed/etc.). Note the function itself re-geocodes BOTH
--     sides whenever either is non-null, regardless of which one changed — e.g.
--     closing a trip (setting end_location) will also re-fetch start_address.
CREATE EXTENSION IF NOT EXISTS http;

ALTER TABLE fleet_trips
  ADD COLUMN IF NOT EXISTS start_address TEXT,
  ADD COLUMN IF NOT EXISTS end_address TEXT;

CREATE OR REPLACE FUNCTION public.process_trip_geocoding()
RETURNS TRIGGER AS $$
DECLARE
    start_lat TEXT;
    start_lon TEXT;
    end_lat TEXT;
    end_lon TEXT;
    api_response RECORD;
BEGIN
    -- 1. Safely check if JSON exists, then extract using standard JSONB operators.
    -- start_location is JSONB, never '' — comparing it to '' would try to cast
    -- '' to jsonb and raise "invalid input syntax for type json", so this only
    -- checks IS NOT NULL. Lat/lon are kept as TEXT since they're only ever
    -- interpolated into a URL string below.
    IF NEW.start_location IS NOT NULL THEN
        start_lat := (NEW.start_location::jsonb)->>'latitude';
        start_lon := (NEW.start_location::jsonb)->>'longitude';
    END IF;

    IF NEW.end_location IS NOT NULL THEN
        end_lat := (NEW.end_location::jsonb)->>'latitude';
        end_lon := (NEW.end_location::jsonb)->>'longitude';
    END IF;

    -- 2. Fetch Start Address
    IF start_lat IS NOT NULL AND start_lon IS NOT NULL THEN
        BEGIN
            SELECT * INTO api_response FROM http((
                'GET',
                'https://nominatim.openstreetmap.org/reverse?lat=' || start_lat || '&lon=' || start_lon || '&format=json',
                ARRAY[http_header('User-Agent', 'SupabaseFleetTracker/1.0')],
                NULL, NULL
            ));
            IF api_response.status = 200 THEN
                NEW.start_address := split_part((api_response.content::jsonb)->>'display_name', ',', 1) || ', ' || split_part((api_response.content::jsonb)->>'display_name', ',', 2);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            NEW.start_address := 'Location Fetch Error';
        END;
    END IF;

    -- 3. Fetch End Address
    IF end_lat IS NOT NULL AND end_lon IS NOT NULL THEN
        BEGIN
            SELECT * INTO api_response FROM http((
                'GET',
                'https://nominatim.openstreetmap.org/reverse?lat=' || end_lat || '&lon=' || end_lon || '&format=json',
                ARRAY[http_header('User-Agent', 'SupabaseFleetTracker/1.0')],
                NULL, NULL
            ));
            IF api_response.status = 200 THEN
                NEW.end_address := split_part((api_response.content::jsonb)->>'display_name', ',', 1) || ', ' || split_part((api_response.content::jsonb)->>'display_name', ',', 2);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            NEW.end_address := 'Location Fetch Error';
        END;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER tr_geocode_fleet_trips
BEFORE INSERT OR UPDATE ON fleet_trips
FOR EACH ROW
WHEN (
  NEW.start_location IS DISTINCT FROM OLD.start_location
  OR NEW.end_location IS DISTINCT FROM OLD.end_location
)
EXECUTE FUNCTION public.process_trip_geocoding();

-- ── Pacific-time display columns ─────────────────────────────────────────────
-- All canonical timestamp columns above (start_time, end_time, created_at,
-- updated_at, etc.) remain UTC and UNCHANGED — the app's trip/charge detection
-- engine (vehicleMonitor.ts) depends on comparing them against Date.now(), and
-- shifting the canonical values would silently break stale-session detection,
-- gap-trip suppression, and progress-log throttling by exactly the Pacific/UTC
-- offset (7-8h). fleet_api_tracking is untouched entirely — Tesla bills by UTC day.
--
-- Instead, every relevant table gets companion `*_pst` columns (TIMESTAMP,
-- no time zone) holding the same instant expressed as Pacific wall-clock time,
-- for display/browsing only. A shared BEFORE INSERT/UPDATE trigger keeps them
-- in sync automatically — `AT TIME ZONE 'America/Los_Angeles'` uses the IANA
-- tz database, so this correctly reflects PST in winter / PDT in summer rather
-- than a fixed -8h offset.
ALTER TABLE fleet_vehicles           ADD COLUMN IF NOT EXISTS first_seen_pst   TIMESTAMP;
ALTER TABLE fleet_vehicles           ADD COLUMN IF NOT EXISTS last_seen_pst    TIMESTAMP;
ALTER TABLE fleet_trips              ADD COLUMN IF NOT EXISTS start_time_pst   TIMESTAMP;
ALTER TABLE fleet_trips              ADD COLUMN IF NOT EXISTS end_time_pst     TIMESTAMP;
ALTER TABLE fleet_trips              ADD COLUMN IF NOT EXISTS created_at_pst   TIMESTAMP;
ALTER TABLE fleet_trips              ADD COLUMN IF NOT EXISTS last_seen_at_pst TIMESTAMP;
ALTER TABLE fleet_charging_sessions  ADD COLUMN IF NOT EXISTS start_time_pst   TIMESTAMP;
ALTER TABLE fleet_charging_sessions  ADD COLUMN IF NOT EXISTS end_time_pst     TIMESTAMP;
ALTER TABLE fleet_charging_sessions  ADD COLUMN IF NOT EXISTS created_at_pst   TIMESTAMP;
ALTER TABLE fleet_telemetry_data     ADD COLUMN IF NOT EXISTS recorded_at_pst  TIMESTAMP;
ALTER TABLE fleet_telemetry_data     ADD COLUMN IF NOT EXISTS created_at_pst   TIMESTAMP;
ALTER TABLE fleet_telemetry_state    ADD COLUMN IF NOT EXISTS updated_at_pst   TIMESTAMP;
ALTER TABLE fleet_daily_summary      ADD COLUMN IF NOT EXISTS created_at_pst   TIMESTAMP;
ALTER TABLE fleet_software_versions  ADD COLUMN IF NOT EXISTS update_time_pst  TIMESTAMP;

CREATE OR REPLACE FUNCTION public.sync_pst_timestamps()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'fleet_vehicles' THEN
    NEW.first_seen_pst   := NEW.first_seen   AT TIME ZONE 'America/Los_Angeles';
    NEW.last_seen_pst    := NEW.last_seen    AT TIME ZONE 'America/Los_Angeles';
  ELSIF TG_TABLE_NAME = 'fleet_trips' THEN
    NEW.start_time_pst   := NEW.start_time   AT TIME ZONE 'America/Los_Angeles';
    NEW.end_time_pst     := NEW.end_time     AT TIME ZONE 'America/Los_Angeles';
    NEW.created_at_pst   := NEW.created_at   AT TIME ZONE 'America/Los_Angeles';
    NEW.last_seen_at_pst := NEW.last_seen_at AT TIME ZONE 'America/Los_Angeles';
  ELSIF TG_TABLE_NAME = 'fleet_charging_sessions' THEN
    NEW.start_time_pst   := NEW.start_time   AT TIME ZONE 'America/Los_Angeles';
    NEW.end_time_pst     := NEW.end_time     AT TIME ZONE 'America/Los_Angeles';
    NEW.created_at_pst   := NEW.created_at   AT TIME ZONE 'America/Los_Angeles';
  ELSIF TG_TABLE_NAME = 'fleet_telemetry_data' THEN
    NEW.recorded_at_pst  := NEW.recorded_at  AT TIME ZONE 'America/Los_Angeles';
    NEW.created_at_pst   := NEW.created_at   AT TIME ZONE 'America/Los_Angeles';
  ELSIF TG_TABLE_NAME = 'fleet_telemetry_state' THEN
    NEW.updated_at_pst   := NEW.updated_at   AT TIME ZONE 'America/Los_Angeles';
  ELSIF TG_TABLE_NAME = 'fleet_daily_summary' THEN
    NEW.created_at_pst   := NEW.created_at   AT TIME ZONE 'America/Los_Angeles';
  ELSIF TG_TABLE_NAME = 'fleet_software_versions' THEN
    NEW.update_time_pst  := NEW.update_time  AT TIME ZONE 'America/Los_Angeles';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER tr_pst_fleet_vehicles          BEFORE INSERT OR UPDATE ON fleet_vehicles          FOR EACH ROW EXECUTE FUNCTION public.sync_pst_timestamps();
CREATE OR REPLACE TRIGGER tr_pst_fleet_trips              BEFORE INSERT OR UPDATE ON fleet_trips              FOR EACH ROW EXECUTE FUNCTION public.sync_pst_timestamps();
CREATE OR REPLACE TRIGGER tr_pst_fleet_charging_sessions  BEFORE INSERT OR UPDATE ON fleet_charging_sessions  FOR EACH ROW EXECUTE FUNCTION public.sync_pst_timestamps();
CREATE OR REPLACE TRIGGER tr_pst_fleet_telemetry_data     BEFORE INSERT OR UPDATE ON fleet_telemetry_data     FOR EACH ROW EXECUTE FUNCTION public.sync_pst_timestamps();
CREATE OR REPLACE TRIGGER tr_pst_fleet_telemetry_state    BEFORE INSERT OR UPDATE ON fleet_telemetry_state    FOR EACH ROW EXECUTE FUNCTION public.sync_pst_timestamps();
CREATE OR REPLACE TRIGGER tr_pst_fleet_daily_summary      BEFORE INSERT OR UPDATE ON fleet_daily_summary      FOR EACH ROW EXECUTE FUNCTION public.sync_pst_timestamps();
CREATE OR REPLACE TRIGGER tr_pst_fleet_software_versions  BEFORE INSERT OR UPDATE ON fleet_software_versions  FOR EACH ROW EXECUTE FUNCTION public.sync_pst_timestamps();

-- One-time backfill for existing rows — triggers only fire on future writes.
-- `SET source = source` is a no-op column assignment that forces every row
-- through the BEFORE UPDATE trigger above so the *_pst columns get computed
-- from history. `id` can't be used here — on tables where it's a GENERATED
-- ALWAYS identity column, Postgres rejects any UPDATE of `id` other than DEFAULT.
UPDATE fleet_vehicles           SET source = source;
UPDATE fleet_trips              SET source = source;
UPDATE fleet_charging_sessions  SET source = source;
UPDATE fleet_telemetry_data     SET source = source;
UPDATE fleet_telemetry_state    SET source = source;
UPDATE fleet_daily_summary      SET source = source;
UPDATE fleet_software_versions  SET source = source;
