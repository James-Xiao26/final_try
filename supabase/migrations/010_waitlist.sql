-- Early-access waitlist email capture, replacing the third-party Waitlister.me proxy. Written
-- directly by the /api/waitlist route using the web app's anon key, so — unlike every other table
-- here, which is populated by the service-role ingest pipeline — this one is RLS-gated: the anon
-- role may INSERT but has no SELECT policy, so the public key can add an address yet never read the
-- list back out. Collect signups from the Supabase dashboard (Table editor / SQL editor / CSV
-- export) or any service-role client.
CREATE EXTENSION IF NOT EXISTS citext;  -- case-insensitive email so You@x.com and you@x.com dedupe

CREATE TABLE waitlist (
  id         BIGSERIAL PRIMARY KEY,
  email      CITEXT UNIQUE NOT NULL,
  source     TEXT,                          -- which form sent it ("hero" / "cta"), for light attribution
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;

-- Anon may add themselves; the absence of any SELECT/UPDATE/DELETE policy means the public key
-- cannot read, change, or harvest the list under RLS.
CREATE POLICY waitlist_anon_insert ON waitlist
  FOR INSERT TO anon
  WITH CHECK (true);
