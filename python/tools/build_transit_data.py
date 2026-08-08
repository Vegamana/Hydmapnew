#!/usr/bin/env python3
"""build_transit_data.py — regenerate frontend/data/transit.json from OpenStreetMap.

The old app hardcoded 3 metro lines and 56 stations that were pasted in once and
never refreshed. This does the same job as a repeatable step: query Overpass for
Hyderabad's metro lines, metro stations, railway stations and bus stops, and
write a single static JSON the frontend loads from the CDN — no runtime API, no
per-view cost.

Run it manually when the network changes (a new line opens, stations rename):
    python tools/build_transit_data.py
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx

from lib.config import ROOT
from lib.log import get_logger

log = get_logger("transit")

OVERPASS = "https://overpass-api.de/api/interpreter"
OUT = ROOT / "frontend" / "data" / "transit.json"

# Hyderabad bounding box (south, west, north, east)
BBOX = "17.20,78.20,17.65,78.65"

QUERY = f"""
[out:json][timeout:120];
(
  relation["route"="subway"]({BBOX});
  node["railway"="station"]["station"="subway"]({BBOX});
  node["railway"="station"]["station"!="subway"]({BBOX});
  node["highway"="bus_stop"]({BBOX});
);
out body geom;
"""

LINE_COLOURS = {"red": "#C4453B", "blue": "#2F6DB5", "green": "#2F8B57"}


def guess_colour(name: str, tags: dict) -> str:
    if tags.get("colour"):
        return tags["colour"]
    lowered = name.lower()
    for key, value in LINE_COLOURS.items():
        if key in lowered:
            return value
    return "#4A5A64"


def main() -> None:
    log.info("querying Overpass...")
    with httpx.Client(timeout=180) as client:
        res = client.post(OVERPASS, data={"data": QUERY})
        res.raise_for_status()
        payload = res.json()

    metro_lines, metro_stations, train_stations, bus_stops = [], [], [], []

    for element in payload.get("elements", []):
        tags = element.get("tags", {})
        name = tags.get("name", "")

        if element["type"] == "relation" and tags.get("route") == "subway":
            path = []
            for member in element.get("members", []):
                for point in member.get("geometry", []) or []:
                    path.append({"lat": point["lat"], "lng": point["lon"]})
            if path:
                metro_lines.append({"name": name, "color": guess_colour(name, tags), "path": path})

        elif element["type"] == "node":
            point = {"name": name, "lat": element["lat"], "lng": element["lon"]}
            if not name:
                continue
            if tags.get("station") == "subway":
                metro_stations.append(point)
            elif tags.get("railway") == "station":
                train_stations.append(point)
            elif tags.get("highway") == "bus_stop":
                bus_stops.append(point)

    data = {
        "generated_from": "OpenStreetMap via Overpass API (ODbL)",
        "metro_lines": metro_lines,
        "metro_stations": metro_stations,
        "train_stations": train_stations,
        "bus_stops": bus_stops[:1200],   # cap the payload; bus stops are dense
    }

    OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    log.info("wrote %s — %d lines, %d metro, %d train, %d bus",
             OUT, len(metro_lines), len(metro_stations), len(train_stations), len(data["bus_stops"]))


if __name__ == "__main__":
    main()
