# Supabase PostgreSQL setup

1. Create a Supabase project and open its SQL Editor.
2. Run `supabase/migrations/001_dashboard_storage.sql` in full.
3. Copy `.env.example` to `.env` locally and set `SUPABASE_URL` plus the
   preferred backend-only `SUPABASE_SECRET_KEY` value. Do not commit `.env`.
   This key begins with `sb_secret_` and is sent only in the backend's `apikey`
   header.
4. Start the backend. `GET /health` will report `storage: "Supabase PostgreSQL"`
   when variables are present. This only indicates configuration selection; it
   does not prove database connectivity.
5. Send a `POST /evaluate`, then query `GET /history`. Only after both return
   successfully against your own project should the integration be considered live.

The Secret key belongs only in the backend environment. The dashboard does not
receive a Supabase URL/key and communicates only with FastAPI. Never set both
`SUPABASE_SECRET_KEY` and `SUPABASE_SERVICE_ROLE_KEY`: the backend rejects
that ambiguous configuration at startup.

`SUPABASE_SERVICE_ROLE_KEY` remains available only for existing legacy JWT
keys. It uses the previous `apikey` and `Authorization: Bearer` headers. Use
exactly one of the two key variables; new projects should use the Secret key.

If `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and the legacy
`SUPABASE_SERVICE_ROLE_KEY` are all absent, the backend remains in
process-local demo mode. That history is erased when the process ends.
