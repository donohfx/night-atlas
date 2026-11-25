"""Stream public AIS ship positions as normalized Night Atlas chart points."""
import json
import math
import os
import random
from pathlib import Path
import time
import tempfile

from websockets.sync.client import connect

from geometry import REGION


KEY_PATH = Path.home() / ".config/night-atlas/aisstream.key"
URL = "wss://stream.aisstream.io/v0/stream"
POSITION_TYPES = ("PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport")
STATIC_TYPES = ("ShipStaticData", "StaticDataReport")
MESSAGE_TYPES = (*POSITION_TYPES, *STATIC_TYPES)
FRESH_SECONDS = 1200
DAY_SECONDS = 86400
RETENTION_SECONDS = 7 * DAY_SECONDS
CACHE_PATH = KEY_PATH.with_name("last-vessels.json")
SNAPSHOT_PATH = Path(os.environ["XDG_RUNTIME_DIR"]) / "night-atlas-vessels.json"
VIEWPORT_PATH = SNAPSHOT_PATH.with_name("night-atlas-live-viewport.json")


def write_json(path, data):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as file:
        temp_path = Path(file.name)
        try:
            json.dump(data, file, separators=(",", ":"))
            file.close()
            temp_path.replace(path)
        finally:
            temp_path.unlink(missing_ok=True)


def load_vessels(path=CACHE_PATH):
    try:
        cache = json.loads(path.read_text())
        cutoff = time.time() - RETENTION_SECONDS
        return {
            int(point["mmsi"]): (point["timestamp"], point)
            for point in cache if point["timestamp"] >= cutoff
        }
    except (OSError, ValueError, KeyError, TypeError):
        return {}



def clean_text(value):
    if not isinstance(value, str):
        return ""
    return "".join(char for char in value if char.isprintable()).strip(" @")[:60]


def update(event, vessels, seen, metadata_cache, now):
    kind = event.get("MessageType")
    if kind not in MESSAGE_TYPES:
        return
    report = event.get("Message", {}).get(kind, {})
    metadata = event.get("MetaData", {})
    if report.get("Valid") is False:
        return
    ship_id = report.get("UserID", metadata.get("MMSI"))
    if type(ship_id) is not int:
        return

    previous = vessels.get(ship_id)
    name = clean_text(metadata.get("ShipName"))
    if kind in STATIC_TYPES:
        part_a = report.get("ReportA") or {}
        part_b = report.get("ReportB") or {}
        fields = {
            "name": clean_text(report.get("Name") or part_a.get("Name")) or name,
            "destination": clean_text(report.get("Destination")),
            "type": report.get("Type") or report.get("ShipType") or part_b.get("ShipType"),
        }
        if type(fields["type"]) is not int or not 1 <= fields["type"] < 100:
            fields.pop("type")
        size = report.get("Dimension") or part_b.get("Dimension") or {}
        for key, pair in (("length", ("A", "B")), ("width", ("C", "D"))):
            parts = [size.get(side) for side in pair]
            if all(type(part) in (int, float) and part >= 0 for part in parts) and 0 < sum(parts) <= 500:
                fields[key] = sum(parts)
        fields = {key: value for key, value in fields.items() if value}
        if fields:
            if len(metadata_cache) >= 3000 and ship_id not in metadata_cache:
                del metadata_cache[next(iter(metadata_cache))]
            metadata_cache.setdefault(ship_id, {}).update(fields)
            if previous:
                previous[1].update(fields)
        return

    lat = report.get("Latitude", metadata.get("Latitude", metadata.get("latitude")))
    lon = report.get("Longitude", metadata.get("Longitude", metadata.get("longitude")))
    if not all(type(value) in (int, float) and math.isfinite(value) for value in (lat, lon)):
        return
    if not (REGION[1] <= lat <= REGION[3] and REGION[0] <= lon <= REGION[2]):
        vessels.pop(ship_id, None)
        return
    seen.add(ship_id)
    speed, course, heading = report.get("Sog"), report.get("Cog"), report.get("TrueHeading")
    speed = speed if isinstance(speed, (int, float)) and 0 <= speed < 102.3 else None
    course = course if isinstance(course, (int, float)) and 0 <= course < 360 else None
    heading = heading if isinstance(heading, (int, float)) and 0 <= heading < 360 else None
    fields = dict(previous[1]) if previous else {}
    fields.update(metadata_cache.get(ship_id, {}))
    fields.update(mmsi=ship_id, name=name or fields.get("name", ""), speed=speed, course=course,
                  heading=heading, lat=round(lat, 5), lon=round(lon, 5))
    vessels[ship_id] = (now, fields)


def bounds():
    try:
        view = json.loads(VIEWPORT_PATH.read_text())
        w, s, e, n = view
        if REGION[0] <= w < e <= REGION[2] and REGION[1] <= s < n <= REGION[3]:
            return tuple(view)
    except (OSError, ValueError, TypeError):
        pass
    return REGION


def subscribe(socket, key, view):
    west, south, east, north = view
    socket.send(json.dumps({
        "APIKey": key,
        "BoundingBoxes": [[[north, west], [south, east]]],
        "FilterMessageTypes": MESSAGE_TYPES,
    }))


def publish(status, vessels, seen, viewport=None):
    now = time.time()
    expired = [ship for ship, (timestamp, _) in vessels.items() if now - timestamp >= RETENTION_SECONDS]
    for ship in expired:
        del vessels[ship]
    ordered = sorted(vessels.values(), key=lambda entry: entry[0], reverse=True)
    points = [dict(point, age=max(0, round(now - timestamp))) for timestamp, point in ordered]
    snapshot = {"status": status, "points": points, "received": len(seen), "viewport": viewport}
    try:
        write_json(SNAPSHOT_PATH, snapshot)
        latest = [dict(point, timestamp=timestamp) for timestamp, point in ordered]
        # Write only when a position or its receipt time changed.
        if latest != publish.last_saved:
            write_json(CACHE_PATH, latest)
            publish.last_saved = latest
    except OSError:
        # A cache write failure must not stop the streaming desktop layer.
        pass
    print(json.dumps({"status": status, "points": len(points), "received": len(seen)}), flush=True)


publish.last_saved = None


def listen(key, vessels, seen, metadata_cache):
    with connect(URL, open_timeout=30, close_timeout=2) as socket:
        active_bounds = bounds()
        subscribe(socket, key, active_bounds)
        publish("waiting", vessels, seen, active_bounds)
        status = "waiting"
        next_update = time.monotonic() + 3
        while True:
            try:
                payload = socket.recv(timeout=3)
            except TimeoutError:
                payload = None
            if payload is not None:
                event = json.loads(payload)
                if "error" in event or "Error" in event:
                    # Service errors are never forwarded verbatim.
                    return
                update(event, vessels, seen, metadata_cache, time.time())
                if event.get("MessageType") in (*MESSAGE_TYPES, "SubscriptionConfirmation"):
                    status = "live"
            if time.monotonic() >= next_update:
                new_bounds = bounds()
                if new_bounds != active_bounds:
                    subscribe(socket, key, new_bounds)
                    active_bounds = new_bounds
                publish(status, vessels, seen, active_bounds)
                next_update = time.monotonic() + 3


def main():
    vessels = load_vessels()
    seen = set()
    metadata_cache = {}
    publish("waiting", vessels, seen)
    delay = 5
    while True:
        started = time.monotonic()
        try:
            key = KEY_PATH.read_text().strip()
            if not key:
                raise ValueError("empty key")
            listen(key, vessels, seen, metadata_cache)
        except Exception:
            # Never expose handshake details, payloads, or credentials.
            pass
        publish("offline", vessels, seen)
        if time.monotonic() - started > 60:
            delay = 5
        time.sleep(delay + random.uniform(0, delay * 0.2))
        delay = min(delay * 2, 120)


if __name__ == "__main__":
    main()
