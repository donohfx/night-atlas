"""Host the GPU Night Atlas chart in a GTK layer below desktop windows."""
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import calendar
import json
import math
from pathlib import Path
import os
import subprocess
import threading
import time

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Gtk4LayerShell", "1.0")
gi.require_version("WebKit", "6.0")
from gi.repository import Gdk, GLib, Gtk, Gtk4LayerShell as Layer, WebKit

from geometry import REGION

ROOT = Path(__file__).resolve().parent
RUNTIME = Path(os.environ["XDG_RUNTIME_DIR"])
ORIGIN = "http://127.0.0.1:8766"
PREFERRED_OUTPUT = os.environ.get("NIGHT_ATLAS_OUTPUT")
CONFIG = Path.home() / ".config/night-atlas"
STARTED = time.time()
ASSETS = {
    "/": ("index.html", "text/html"),
    "/map.mjs": ("map.mjs", "text/javascript"),
    "/atlas-extras.mjs": ("atlas-extras.mjs", "text/javascript"),
    "/style.css": ("style.css", "text/css"),
    "/chart-data.json": ("chart-data.json", "application/json"),
    "/land.json": ("land.json.gz", "application/json"),
    "/contours.json": ("contours.json.gz", "application/json"),
    "/relief.jpg": ("relief.jpg", "image/jpeg"),
    "/relief-detail.jpg": ("relief-detail.jpg", "image/jpeg"),
    "/seamarks.json": ("seamarks.json", "application/json"),
    "/vendor/maplibre-gl.mjs": ("vendor/maplibre-gl.mjs", "text/javascript"),
    "/vendor/maplibre-gl-shared.mjs": ("vendor/maplibre-gl-shared.mjs", "text/javascript"),
    "/vendor/maplibre-gl-worker.mjs": ("vendor/maplibre-gl-worker.mjs", "text/javascript"),
    "/vendor/maplibre-gl.css": ("vendor/maplibre-gl.css", "text/css"),
}


def load_json(path, fallback):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return fallback


def sweep_overrides():
    path = CONFIG / "sweeps.conf"
    if not path.is_file():
        path = ROOT / "sweeps.conf"
    try:
        settings = {}
        for raw in path.read_text().splitlines():
            key, divider, value = raw.split("#", 1)[0].partition("=")
            value = value.strip().lower()
            if divider and key.strip() and value in {"yes", "no"}:
                settings[key.strip()] = value == "yes"
        return settings
    except (OSError, UnicodeError):
        return {}


SETTINGS_PATH = CONFIG / "settings.json"
DEFAULT_SETTINGS = {"mode": "auto", "override": None,
                    "layers": {"ships": True, "ghosts": True, "buoys": True,
                               "seamarks": True, "lights": True, "weather": True, "fog": True,
                               "spotlight": True, "labels": False}}


def atlas_settings():
    """Mode (chart / night / auto) and layer toggles, written by the anchor menu."""
    saved = load_json(SETTINGS_PATH, {})
    layers = dict(DEFAULT_SETTINGS["layers"], **(saved.get("layers") or {}))
    mode = saved.get("mode") if saved.get("mode") in {"chart", "night", "auto"} else "auto"
    return {"mode": mode, "override": saved.get("override"), "layers": layers,
            "fogPreview": saved.get("fogPreview")}


# Live offshore weather buoys (NOAA NDBC realtime2; verified reporting 2026-11-24).
BUOY_STATIONS = {
    "44258": ("Halifax Harbour", -63.40, 44.50), "44150": ("La Have Bank", -64.02, 42.50),
    "44137": ("East Scotia Slope", -62.03, 42.26), "44139": ("Banquereau Bank", -57.10, 44.24),
    "44488": ("East of Chedabucto Bay", -60.95, 45.44), "44011": ("Georges Bank", -66.55, 41.09),
}
BUOYS = {"updated": 0, "stations": []}


def parse_buoy(text):
    rows = [line.split() for line in text.splitlines() if line.strip()]
    names = [name.lstrip("#") for name in rows[0]]
    for row in rows[2:]:                       # newest first; take the first row with any data
        values = dict(zip(names, row))
        def num(key):
            try:
                return float(values[key]) if values.get(key, "MM") != "MM" else None
            except ValueError:
                return None
        reading = {key: num(key) for key in ("WDIR", "WSPD", "GST", "WVHT", "DPD", "WTMP", "ATMP", "PRES")}
        if any(value is not None for value in reading.values()):
            stamp = calendar.timegm(time.strptime(" ".join(row[:5]), "%Y %m %d %H %M"))  # NDBC times are UTC
            return {"observed": stamp, **reading}
    return None


def buoy_loop():
    import urllib.request
    while True:
        stations = []
        for station, (name, lon, lat) in BUOY_STATIONS.items():
            try:
                request = urllib.request.Request(f"https://www.ndbc.noaa.gov/data/realtime2/{station}.txt",
                                                 headers={"User-Agent": "night-atlas/1.0"})
                with urllib.request.urlopen(request, timeout=20) as response:
                    reading = parse_buoy(response.read().decode("ascii", "replace"))
            except Exception:
                reading = None
            if reading:
                stations.append({"id": station, "name": name, "coordinates": [lon, lat], **reading})
        if stations:
            BUOYS.update(updated=time.time(), stations=stations)
        time.sleep(1800)                       # NDBC updates hourly; poll twice an hour


# Current Halifax weather for the map widget (Open-Meteo: free, no key). Every 15 min.
WEATHER = {}
WEATHER_URL = ("https://api.open-meteo.com/v1/forecast?latitude=44.65&longitude=-63.58"
               "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,"
               "wind_gusts_10m,precipitation,visibility,is_day&wind_speed_unit=kn&timezone=America%2FHalifax")


def weather_loop():
    import urllib.request
    while True:
        try:
            request = urllib.request.Request(WEATHER_URL, headers={"User-Agent": "night-atlas/1.0"})
            with urllib.request.urlopen(request, timeout=20) as response:
                current = json.load(response)["current"]
            WEATHER.clear()
            WEATHER.update(current, fetched=time.time())
        except Exception:
            pass                               # keep the last good reading
        time.sleep(900)


def current_command():
    path = RUNTIME / "night-atlas-live-command.json"
    try:
        return load_json(path, None) if path.stat().st_mtime >= STARTED else None
    except OSError:
        return None


PRESETS = {"nova-scotia", "halifax-coast", "halifax"}


def viewport_bounds(data):
    if not isinstance(data, list) or len(data) != 4 or not all(
            type(value) in (int, float) and math.isfinite(value) for value in data):
        raise ValueError("invalid bounds")
    west, south, east, north = data
    if east <= west or north <= south or east - west > 14 or north - south > 7:
        raise ValueError("invalid viewport")
    dx, dy = max(.035, (east - west) * .12), max(.027, (north - south) * .12)
    padded = [max(REGION[0], west - dx), max(REGION[1], south - dy),
              min(REGION[2], east + dx), min(REGION[3], north + dy)]
    if padded[2] <= padded[0] or padded[3] <= padded[1]:
        raise ValueError("viewport outside region")
    return [round(value, 3) for value in padded]


class Request(BaseHTTPRequestHandler):
    def headers_ok(self):
        return self.headers.get("Host") == "127.0.0.1:8766"

    def reply(self, body, mime, compressed=False, cache=False):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Cache-Control", "public, max-age=86400" if cache else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy",
            "default-src 'self'; worker-src 'self' blob:; connect-src 'self' https://tiles.openfreemap.org; "
            "img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if not self.headers_ok():
            self.send_error(403)
        elif self.path == "/command":                # polled fast so presets feel instant
            self.reply(json.dumps(current_command()).encode(), "application/json")
        elif self.path == "/state":
            ships = load_json(RUNTIME / "night-atlas-vessels.json", {"status": "waiting", "points": []})
            command = current_command()
            self.reply(json.dumps({"ships": ships, "command": command, "sweeps": sweep_overrides(),
                                   "settings": atlas_settings(), "buoys": BUOYS["stations"],
                                   "weather": WEATHER or None}).encode(), "application/json")
        elif self.path == "/palette.json":
            self.reply((ROOT.parent.parent / "palettes/NightAtlas.json").read_bytes(), "application/json")
        elif self.path in ASSETS:
            name, mime = ASSETS[self.path]
            self.reply((ROOT / "live" / name).read_bytes(), mime, name.endswith(".gz"), self.path.startswith("/vendor/"))
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == "/preset" and self.headers_ok() and self.headers.get("Origin") == ORIGIN:
            # which view preset the map is showing (null after the user pans); read by the anchor menu.
            # Kept next to settings.json in ~/.config/night-atlas, where the menu already reads files.
            try:
                length = int(self.headers.get("Content-Length", "0"))
                preset = json.loads(self.rfile.read(length)) if 0 < length <= 60 else None
                (CONFIG / "preset.json").write_text(json.dumps({"preset": preset if preset in PRESETS else None}))
                self.reply(b"{}", "application/json")
            except (ValueError, OSError):
                self.send_error(400)
            return
        if self.path != "/viewport" or not self.headers_ok() or self.headers.get("Origin") != ORIGIN:
            self.send_error(403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 240:
                raise ValueError("invalid length")
            bounds = viewport_bounds(json.loads(self.rfile.read(length)))
            temp = RUNTIME / "night-atlas-live-viewport.tmp"
            with self.server.viewport_lock:
                temp.write_text(json.dumps(bounds))
                temp.replace(RUNTIME / "night-atlas-live-viewport.json")
            self.reply(b"{}", "application/json")
        except (ValueError, OSError):
            self.send_error(400)

    def log_message(self, *_args):
        pass


def covered(rectangles, screen):
    """Return whether the union of visible window rectangles covers the screen."""
    left, top, right, bottom = screen
    boxes = [(max(a, left), max(b, top), min(c, right), min(d, bottom)) for a, b, c, d in rectangles]
    boxes = [r for r in boxes if r[0] < r[2] and r[1] < r[3]]
    xs = sorted({left, right, *(p for a, _, b, _ in boxes for p in (a, b))})
    for a, b in zip(xs, xs[1:]):
        reach = top
        for start, end in sorted((y, z) for x, y, r, z in boxes if x <= a and r >= b):
            if start > reach:
                break
            reach = max(reach, end)
        if reach < bottom:
            return False
    return bool(boxes)


def hypr_json(*args):
    return json.loads(subprocess.check_output(["hyprctl", *args, "-j"], timeout=2))


def desktop_visible(output):
    try:
        mon = next(m for m in hypr_json("monitors") if m["name"] == output)
        workspaces = {mon[k].get("address") for k in ("activeWorkspace", "specialWorkspace")}
        windows = [w for w in hypr_json("clients") if w["monitor"] == mon["id"] and w["mapped"] and
                   not w["hidden"] and (w["pinned"] or w["workspace"]["address"] in workspaces)]
        if any(w["fullscreen"] & 2 for w in windows):
            return False
        left, top, right, bottom = mon["reserved"]
        width = round(mon["width"] / mon["scale"])
        height = round(mon["height"] / mon["scale"])
        if mon["transform"] % 2:
            width, height = height, width
        x, y = mon["x"], mon["y"]
        # Grow each window by more than Hyprland's gaps + border, so tiled windows with thin gaps
        # between them (and gaps_out at the edges) count as covering the desktop.
        pad = 24
        rects = [(l - pad, t - pad, l + w + pad, t + h + pad)
                 for win in windows for (l, t), (w, h) in [(win["at"], win["size"])]]
        return not covered(rects, (x + left, y + top, x + width - right, y + height - bottom))
    except (OSError, ValueError, StopIteration, KeyError, subprocess.SubprocessError):
        return True


class Desktop(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="local.night_atlas.desktop")
        self.window = None
        self.check = None
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.is_visible = True
        self.loaded = False
        self.output = None

    def do_activate(self):
        if self.window:
            return
        self.hold()
        self.window = Gtk.ApplicationWindow(application=self, decorated=False, focusable=False)
        Layer.init_for_window(self.window)
        Layer.set_namespace(self.window, "night-atlas-live")
        Layer.set_layer(self.window, Layer.Layer.BOTTOM)
        Layer.set_keyboard_mode(self.window, Layer.KeyboardMode.NONE)
        Layer.set_exclusive_zone(self.window, -1)
        for edge in (Layer.Edge.TOP, Layer.Edge.BOTTOM, Layer.Edge.LEFT, Layer.Edge.RIGHT):
            Layer.set_anchor(self.window, edge, True)
        monitors = Gdk.Display.get_default().get_monitors()
        outputs = [monitors.get_item(index) for index in range(monitors.get_n_items())]
        if outputs:
            monitor = next((item for item in outputs if item.get_connector() == PREFERRED_OUTPUT), outputs[0])
            self.output = monitor.get_connector()
            Layer.set_monitor(self.window, monitor)
        self.web = WebKit.WebView()
        self.web.get_settings().set_enable_webgl(True)
        self.web.get_settings().set_enable_write_console_messages_to_stdout(True)
        self.web.get_settings().set_hardware_acceleration_policy(WebKit.HardwareAccelerationPolicy.ALWAYS)
        self.web.get_settings().set_enable_page_cache(False)
        self.web.connect("load-changed", self.on_load)
        self.web.connect("decide-policy", self.navigation)
        self.window.set_child(self.web)
        self.window.set_visible(True)
        self.web.load_uri(ORIGIN + "/")
        GLib.timeout_add(650, self.tick)

    def navigation(self, _web, decision, kind):
        if kind == WebKit.PolicyDecisionType.NEW_WINDOW_ACTION:
            decision.ignore()
            return True
        if kind == WebKit.PolicyDecisionType.NAVIGATION_ACTION:
            uri = decision.get_navigation_action().get_request().get_uri()
            if not uri.startswith(ORIGIN + "/"):
                decision.ignore()
                return True
        return False

    def on_load(self, _web, event):
        if event == WebKit.LoadEvent.FINISHED:
            self.loaded = True
            print("Night Atlas layer loaded", flush=True)

    def tick(self):
        if self.check is None:
            self.check = self.executor.submit(desktop_visible, self.output)
        elif self.check.done():
            visible = self.check.result()
            self.check = self.executor.submit(desktop_visible, self.output)
            if visible != self.is_visible and self.loaded:
                self.is_visible = visible
                # Keep the layer mapped and only pause the page: hiding the window made the map
                # resize on return (view nudged, everything redrawn). A paused map draws nothing.
                self.web.evaluate_javascript(
                    "window.setAtlasPaused?.(" + ("false" if visible else "true") + ")",
                    -1, None, None, None, None, None)
                print("Night Atlas rendering resumed" if visible else "Night Atlas rendering paused", flush=True)
        return GLib.SOURCE_CONTINUE


def main():
    CONFIG.mkdir(mode=0o700, parents=True, exist_ok=True)
    Gtk.init()
    if not Layer.is_supported():
        raise SystemExit("gtk4-layer-shell is unavailable in this Wayland session")
    os.umask(0o077)
    for attempt in range(25):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", 8766), Request)
            break
        except OSError:
            if attempt == 24:
                raise
            time.sleep(.2)
    server.viewport_lock = threading.Lock()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=buoy_loop, daemon=True).start()
    threading.Thread(target=weather_loop, daemon=True).start()
    return Desktop().run()


if __name__ == "__main__":
    raise SystemExit(main())
