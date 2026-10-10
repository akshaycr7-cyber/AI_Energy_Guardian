# AI Energy Guardian

AI Energy Guardian connects FastAPI, the existing trained count models, a
no-hardware simulator, and a browser dashboard. Recommendations are advisory:
the application does not control appliances and does not invent power, energy,
or cost-savings values.

## Storage modes

- **Local simulation (default):** when Supabase variables are absent, the
  dashboard uses a process-local history that is erased on restart.
- **Supabase PostgreSQL:** when `SUPABASE_URL` and exactly one backend-only
  Supabase key variable are present, `/evaluate` persistently stores the
  reading, model prediction, AI decision, timestamps, source status, and
  explicit unavailable-power status.

No Supabase key is shipped to the dashboard. Browser code communicates only
with FastAPI. See [Supabase setup](config/SUPABASE_SETUP.md) and apply
`supabase/migrations/001_dashboard_storage.sql` before enabling credentials.

## Run locally

From this project folder:

```powershell
.\start_backend.ps1
```

The startup script uses the workspace's `.venv`, binds only to
`127.0.0.1:8001`, enables code reloads, and refuses to stop or replace a
process that already owns the port. Restart the backend after changing `.env`.

Open `http://127.0.0.1:8001/dashboard/`. In a second terminal, send simulated
data through the same API expected by future devices:

```powershell
& "..\.venv\Scripts\python.exe" simulator\sensor_simulator.py --api-url http://127.0.0.1:8001 --count 1
```

Run the normal credential-free test suite:

```powershell
& "..\.venv\Scripts\python.exe" -m pytest -q
```

## API

- `GET /health` returns service and selected storage mode. It does not test a
  configured Supabase project connection.
- `POST /predict` returns validated model predictions.
- `POST /decision` returns a hardware-neutral AI recommendation.
- `POST /evaluate` validates a classroom reading, creates predictions and an
  AI decision, then stores all three as one history event.
- `GET /history?limit=20` supplies the dashboard history.

Example evaluation:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8000/evaluate -ContentType application/json -Body '{"date":"2026-10-09","time":"1:10 pm","lecture":"EM","occupancy":30,"temperature_c":27.2,"humidity_pct":58,"smart_board_on":true,"data_source":"manual"}'
```

## Supabase

Copy `.env.example` to `.env`, apply the SQL migration, and set:

```text
SUPABASE_URL=https://your-project-ref.supabase.co
# Preferred current Supabase Secret key (begins with sb_secret_).
SUPABASE_SECRET_KEY=sb_secret_backend-only-key
```

Never use the Secret key in frontend code, a dashboard build, logs, or source
control. For an existing Supabase project with only a legacy service-role JWT,
`SUPABASE_SERVICE_ROLE_KEY` remains supported; set it instead of, never with,
`SUPABASE_SECRET_KEY`. This repository prepares the integration but does
**not** claim it is live: configure a real Supabase project and verify an
`/evaluate` plus `/history` request before relying on persistent storage.

## Intentional limitations

Firebase and ESP32 are not connected. Power and savings are unavailable until
a future system submits genuine electrical measurements. Hardware actuation,
device authentication, and user-facing database access remain out of scope.
