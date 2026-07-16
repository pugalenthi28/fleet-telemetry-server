-- ─────────────────────────────────────────────────────────────────────────────
-- Fix: energy_used_since_last_charge_kwh inflation (charge_accounted never stuck)
--
-- Root cause:
--   sumAndMarkTripsAccounted fire-and-forget UPDATEs timed out because
--   tr_geocode_fleet_trips was calling Nominatim on EVERY fleet_trips UPDATE
--   (missing/ineffective WHEN clause). Marks failed → every later charge
--   re-summed all unmarked trips (e.g. session 58 stored 77.1 kWh instead of ~2.9).
--
-- Run once in the Supabase SQL Editor, then redeploy the server that awaits marks.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Ensure geocode trigger only runs when locations actually change.
--    INSERT and UPDATE must be separate: INSERT WHEN clauses cannot reference OLD.
DROP TRIGGER IF EXISTS tr_geocode_fleet_trips ON fleet_trips;
DROP TRIGGER IF EXISTS tr_geocode_fleet_trips_insert ON fleet_trips;
DROP TRIGGER IF EXISTS tr_geocode_fleet_trips_update ON fleet_trips;

CREATE TRIGGER tr_geocode_fleet_trips_insert
BEFORE INSERT ON fleet_trips
FOR EACH ROW
WHEN (NEW.start_location IS NOT NULL OR NEW.end_location IS NOT NULL)
EXECUTE FUNCTION public.process_trip_geocoding();

CREATE TRIGGER tr_geocode_fleet_trips_update
BEFORE UPDATE ON fleet_trips
FOR EACH ROW
WHEN (
  NEW.start_location IS DISTINCT FROM OLD.start_location
  OR NEW.end_location IS DISTINCT FROM OLD.end_location
)
EXECUTE FUNCTION public.process_trip_geocoding();

-- 2. Recompute energy_used_since_last_charge_kwh from trips in each charge window
--    (previous session end_time → this session start_time)
WITH ordered AS (
  SELECT
    id,
    vin,
    start_time,
    LAG(end_time) OVER (PARTITION BY vin ORDER BY start_time) AS prev_end_time
  FROM fleet_charging_sessions
),
recomputed AS (
  SELECT
    o.id AS session_id,
    COALESCE(SUM(t.energy_used_kwh), 0) AS energy_kwh
  FROM ordered o
  LEFT JOIN fleet_trips t
    ON t.vin = o.vin
   AND t.status = 'completed'
   AND t.end_time IS NOT NULL
   AND t.end_time <= o.start_time
   AND (o.prev_end_time IS NULL OR t.end_time >= o.prev_end_time)
  WHERE o.start_time >= '2026-07-02'::timestamptz   -- from the first broken window onward
  GROUP BY o.id
)
UPDATE fleet_charging_sessions cs
SET energy_used_since_last_charge_kwh = r.energy_kwh
FROM recomputed r
WHERE cs.id = r.session_id;

-- 3. Mark all completed trips as accounted up through the latest charge start
--    (they have now been attributed to a session by step 2)
UPDATE fleet_trips t
SET charge_accounted = true
WHERE t.status = 'completed'
  AND t.charge_accounted IS NULL
  AND t.end_time IS NOT NULL
  AND t.end_time <= (
    SELECT MAX(start_time) FROM fleet_charging_sessions WHERE vin = t.vin
  );

-- Spot-check (optional):
-- SELECT id, start_time, energy_used_since_last_charge_kwh, miles_since_last_charge
-- FROM fleet_charging_sessions ORDER BY start_time DESC LIMIT 8;
--
-- SELECT COUNT(*) FILTER (WHERE charge_accounted IS NULL) AS still_null,
--        COUNT(*) FILTER (WHERE charge_accounted = true) AS marked
-- FROM fleet_trips WHERE status = 'completed';
