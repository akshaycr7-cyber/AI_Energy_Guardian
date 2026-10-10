"""Post explicitly simulated readings through the same API as future sensors."""
from __future__ import annotations

import argparse
import json
import random
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def generate_reading() -> dict:
    """Create one plausible context record, explicitly labelled as simulated."""
    now = datetime.now(timezone.utc)
    hour = random.choice([9, 10, 11, 12, 13, 14, 15])
    minute = random.choice([0, 10])
    suffix = "am" if hour < 12 else "pm"
    display_hour = hour if hour <= 12 else hour - 12
    weather = random.choice(["Clear", "Cloudy", "Rainy"])
    return {
        "timestamp": now.isoformat(), "date": now.date().isoformat(),
        "time": f"{display_hour}:{minute:02d} {suffix}",
        "lecture": random.choice(["EM", "SOM", "BSE", "UHV"]),
        "occupancy": random.randint(8, 58),
        "temperature_c": round(random.uniform(22, 34), 1),
        "humidity_pct": round(random.uniform(40, 85), 1),
        "cloud_cover_pct": random.randint(0, 100),
        "precipitation_mm": 0.0 if weather != "Rainy" else round(random.uniform(0.1, 5), 1),
        "weather_condition": weather, "light_level": round(random.uniform(100, 650), 0),
        "no_of_lights_on": random.randint(0, 6), "no_of_fans_on": random.randint(0, 5),
        "smart_board_on": random.choice([True, False]), "measured_power_w": None,
        "data_source": "simulated",
    }


def post_reading(api_url: str, reading: dict) -> dict:
    request = Request(
        f"{api_url.rstrip('/')}/evaluate", data=json.dumps(reading).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"API returned HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')}") from exc
    except URLError as exc:
        raise RuntimeError(f"Could not reach API at {api_url}: {exc.reason}") from exc


def run(api_url: str, count: int, interval: float = 0) -> list[dict]:
    results = []
    for index in range(count):
        result = post_reading(api_url, generate_reading())
        results.append(result)
        print(json.dumps({"simulation": index + 1, "id": result["id"], "ai_mode": result["decision"]["ai_mode"]}))
        if interval and index + 1 < count:
            time.sleep(interval)
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Send no-hardware classroom simulation data to the API.")
    parser.add_argument("--api-url", default="http://127.0.0.1:8000")
    parser.add_argument("--count", type=int, default=3)
    parser.add_argument("--interval", type=float, default=0)
    arguments = parser.parse_args()
    if arguments.count < 1:
        parser.error("--count must be at least 1")
    run(arguments.api_url, arguments.count, arguments.interval)
