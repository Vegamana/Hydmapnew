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


def _pt_eq(a: dict, b: dict, eps: float = 1e-5) -> bool:
    return abs(a["lat"] - b["lat"]) < eps and abs(a["lng"] - b["lng"]) < eps


def stitch_segments(segments: list[list[dict]]) -> list[dict]:
    """Chain a relation's way-member geometries into one continuous path.

    OSM route relations don't reliably list members in physical order or a
    consistent direction — Overpass hands them back in whatever order the
    relation happens to store them. Concatenating that order as-is draws a
    line that zigzags across the map wherever two adjacent members are
    actually reversed or out of sequence relative to each other (this hit
    Hyderabad's Red Line specifically: 7 jumps of several km each). Greedily
    growing a chain from whichever end matches the next unplaced segment's
    start *or* end fixes the common case; a segment that truly doesn't touch
    the chain (a real gap in the source data) gets appended rather than
    dropped, so no data silently vanishes even though that spot will still
    show a jump.
    """
    remaining = [s for s in segments if s]
    if not remaining:
        return []

    chain = list(remaining.pop(0))
    while remaining:
        for i, seg in enumerate(remaining):
            if _pt_eq(chain[-1], seg[0]):
                chain.extend(seg[1:])
            elif _pt_eq(chain[-1], seg[-1]):
                chain.extend(list(reversed(seg))[1:])
            elif _pt_eq(chain[0], seg[-1]):
                chain = seg[:-1] + chain
            elif _pt_eq(chain[0], seg[0]):
                chain = list(reversed(seg))[:-1] + chain
            else:
                continue
            remaining.pop(i)
            break
        else:
            # Nothing left touches either end of the chain — a genuine gap
            # in the source data, not an ordering problem. Append it so the
            # rest of the network still makes it into the file.
            chain.extend(remaining.pop(0))
    return chain


def main() -> None:
    log.info("querying Overpass...")
    # Overpass's own usage policy asks for an identifying User-Agent, and in
    # practice rejects the default `python-httpx/...` one with a bare 406 —
    # library-shaped user agents get blanket-filtered as bot traffic.
    headers = {"User-Agent": "hyd-map-transit-builder/1.0 (github.com/hyd-map)"}
    with httpx.Client(timeout=180, headers=headers) as client:
        res = client.post(OVERPASS, data={"data": QUERY})
        res.raise_for_status()
        payload = res.json()

    metro_lines, metro_stations, train_stations, bus_stops = [], [], [], []

    for element in payload.get("elements", []):
        tags = element.get("tags", {})
        name = tags.get("name", "")

        if element["type"] == "relation" and tags.get("route") == "subway":
            segments = []
            for member in element.get("members", []):
                geom = member.get("geometry") or []
                points = [{"lat": p["lat"], "lng": p["lon"]} for p in geom]
                if points:
                    segments.append(points)
            path = stitch_segments(segments)
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
