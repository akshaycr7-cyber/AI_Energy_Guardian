# AI Energy Guardian

AI Energy Guardian is an intelligent classroom command center connecting real-time environmental monitoring, trained appliance-count intelligence, an advisory decision engine, and a live holographic dashboard.

Recommendations are advisory: the application does not control physical appliances and does not invent unmeasured power, energy, or cost-savings values.

## Storage modes

- **Local simulation (default):** In-memory demo history that immediately populates the dashboard with live telemetry and holographic analytics.
- **Supabase PostgreSQL:** When `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are provided in `.env`, `/evaluate` persistently stores readings, model predictions, AI decisions, timestamps, and sensor provenance.

## Quick start

```bash
# Install dependencies
npm install

# Start the command center on port 3000
npm run dev
```

Open `http://localhost:3000/dashboard/` or `http://localhost:3000/` in your browser.

## API Endpoints

- `GET /health` — Health check returning service status and active storage provider.
- `GET /history?limit=20` — Retrieves recent environmental observations, model predictions, and recommendations.
- `POST /evaluate` — Validates a classroom observation, evaluates model estimates and rule-based AI decisions, and records it to history.
- `POST /predict` — Produces validated occupancy and appliance count predictions.
- `POST /decision` — Generates a hardware-neutral, rule-governed classroom comfort recommendation.
- `GET /readings/latest` & `GET /readings/recent` — Accesses recorded classroom observations.
- `GET /model/status` & `GET /model/versions` — Model registry and training metadata.
- `POST /simulator/run` — Generates and evaluates new simulated sensor readings.
