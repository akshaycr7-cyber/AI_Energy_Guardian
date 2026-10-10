"""Application entry point."""
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.history import history
from backend.routes import dashboard, decisions, models, predictions, readings

app = FastAPI(title="AI Energy Guardian API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8000", "http://localhost:8000"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
app.include_router(readings.router)
app.include_router(predictions.router)
app.include_router(decisions.router)
app.include_router(dashboard.router)
app.include_router(models.router)

dashboard_directory = Path(__file__).resolve().parents[1] / "dashboard"
app.mount("/dashboard", StaticFiles(directory=dashboard_directory, html=True), name="dashboard")


@app.get("/")
def root() -> dict:
    return {"service": "AI Energy Guardian", "phase": 2, "docs": "/docs", "dashboard": "/dashboard/"}


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "ai-energy-guardian", "storage": history.storage_name}
