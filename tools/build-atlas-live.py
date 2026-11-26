"""Build the padded Mercator relief for live Night Atlas."""
import argparse
import gzip
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from contourpy import contour_generator

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("elevation", type=Path)
parser.add_argument("land", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--halifax-elevation", type=Path)
parser.add_argument("--region", type=Path, help="Build unshaded web relief for this region config")
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)

# Keep a data margin around the screen-constrained live viewport, including
# the four corners when it is rotated five degrees.
WEST, SOUTH, EAST, NORTH = -69.70, 42.35, -55.50, 48.18
WIDTH, HEIGHT = 4096, 2800
if args.region:
    WEST, SOUTH, EAST, NORTH = json.loads(args.region.read_text())["dataBounds"]
    WIDTH = round(WIDTH * (EAST - WEST) / 14.2)

def mercator(lat):
    return np.arcsinh(np.tan(np.deg2rad(lat)))

north_m, south_m = mercator(NORTH), mercator(SOUTH)
if args.region:
    HEIGHT = round(HEIGHT * (north_m - south_m) / (mercator(48.18) - mercator(42.35)))
def pixel(lon, lat):
    return (np.asarray(lon) - WEST) * (WIDTH - 1) / (EAST - WEST), (
        north_m - mercator(lat)
    ) * (HEIGHT - 1) / (north_m - south_m)

def screen(points):
    x, y = pixel(*np.asarray(points).T)
    return list(zip(x, y))

lat, lon, values = np.loadtxt(args.elevation, delimiter=",", skiprows=2, unpack=True)
lat_grid, lon_grid = np.unique(lat), np.unique(lon)
elevation = values.reshape(lat_grid.size, lon_grid.size)
dy, dx = np.gradient(elevation)
shade = np.tanh((dy - dx) / 35)
lons = np.linspace(WEST, EAST, WIDTH)
lats = np.rad2deg(np.arctan(np.sinh(np.linspace(north_m, south_m, HEIGHT))))
iy = np.interp(lats, lat_grid, np.arange(lat_grid.size))
ix = np.interp(lons, lon_grid, np.arange(lon_grid.size))
y0, x0 = iy.astype(int), ix.astype(int)
yf, xf = (iy - y0)[:, None], (ix - x0)[None, :]

def resample(grid):
    upper = grid[y0[:, None], x0] * (1 - xf) + grid[y0[:, None], x0 + 1] * xf
    lower = grid[y0[:, None] + 1, x0] * (1 - xf) + grid[y0[:, None] + 1, x0 + 1] * xf
    return upper * (1 - yf) + lower * yf

levels = resample(elevation)
relief = resample(shade)
exposure = 1
if not args.region:
    fundy = np.interp(lons, [-69, -67, -65.8, -64.8, -64.2, -63.8, -63.3],
                      [43.7, 44.57, 44.97, 45.47, 45.80, 46.04, 47.6])
    exposure = 1 - 0.82 * np.clip((lats[:, None] - fundy) / .48, 0, 1)
    # Islands stay bright: PEI straddles the Fundy/Northumberland dimming curve (longitude-only), and
    # Newfoundland's corner sits just north of its eastern end. Keep the mainland backdrop (NB, Maine)
    # dim, but lift PEI (outline drawn through Northumberland Strait, clear of NB's coast) and
    # everything east of 62W.
    PEI_REGION = [(-64.45, 46.60), (-64.45, 46.97), (-64.00, 47.14), (-62.60, 46.58), (-61.85, 46.48),
                  (-61.88, 45.95), (-62.50, 45.95), (-63.30, 46.10), (-63.65, 46.20), (-64.10, 46.38)]
    _island = Image.new("L", (len(lons), len(lats)), 0)
    ImageDraw.Draw(_island).polygon([tuple(map(float, pixel(lo, la))) for lo, la in PEI_REGION], fill=255)
    _island = np.asarray(_island.filter(ImageFilter.GaussianBlur(10)), dtype=float) / 255
    _east = np.clip((lons + 62.4) / .4, 0, 1)[None, :]
    exposure = np.maximum(exposure, np.maximum(_island, _east))
land_tones = np.array([11, 22, 22]) + np.asarray(exposure)[..., None] * (
    np.array([14, 22, 15]) + (np.clip(levels, 0, 400) * .045 + relief * 6)[..., None]
)
water_tones = np.array([11, 22, 22]) + (
    np.clip((lons + 69) / 11, 0, 1) * 4 - np.clip(-levels, 0, 3600) / 900
)[..., None]

# Fill the small data margin using relief, then replace the land mask in the
# chart area with complete, topological OSM polygons.
mask = Image.fromarray((levels > 0).astype("uint8") * 255)
draw = ImageDraw.Draw(mask)
mask_bounds = (WEST, SOUTH, EAST, NORTH) if args.region else (-69.14, 42.83, -55.50, 48.00)
mx0, my0 = pixel(mask_bounds[0], mask_bounds[3])
mx1, my1 = pixel(mask_bounds[2], mask_bounds[1])
draw.rectangle((float(mx0), float(my0), float(mx1), float(my1)), fill=0)
coast = Image.new("RGBA", mask.size)
coast_draw = ImageDraw.Draw(coast)
with gzip.open(args.land, "rt") as land:
    land_polygons = json.load(land)
    for polygon in land_polygons:
        for i, ring in enumerate(polygon):
            path = screen(ring)
            draw.polygon(path, fill=255 if i == 0 else 0)
            coast_draw.line(path, fill=(130, 157, 123, 102), width=1)

shore = np.asarray(mask)
details_bounds = (-64.1021, 44.2979, -62.9895, 44.9813)

def add_depth(points, major, detail=False):
    xs, ys = pixel(*points.T)
    run = []
    for i, (longitude, latitude) in enumerate(points):
        x, y = round(xs[i]), round(ys[i])
        in_detail = details_bounds[0] < longitude < details_bounds[2] and details_bounds[1] < latitude < details_bounds[3]
        if 0 <= x < WIDTH and 0 <= y < HEIGHT and shore[y, x] == 0 and (detail or not (args.halifax_elevation and in_detail)):
            run.append([round(float(longitude), 5), round(float(latitude), 5)])
        else:
            if len(run) > 1:
                contours.append({"type":"Feature", "properties":{"major":major,"detail":detail},
                                 "geometry":{"type":"LineString","coordinates":run}})
            run = []
    if len(run) > 1:
        contours.append({"type":"Feature", "properties":{"major":major,"detail":detail},
                         "geometry":{"type":"LineString","coordinates":run}})

def image(data):
    return Image.fromarray(np.clip(data, 0, 255).astype("uint8"))

base = Image.composite(image(land_tones), image(water_tones), mask).convert("RGBA")
generator = contour_generator(x=lon_grid, y=lat_grid, z=elevation)
overlay = Image.new("RGBA", mask.size)
lines = ImageDraw.Draw(overlay)
contours = []
for levels, color, clip in [
    ([-3500, -3000, -2500, -2000, -1500, -1000, -750, -500, -350, -250,
      -200, -150, -100, -75, -50, -25, -10], (86, 122, 113), False),
    ([25, 50, 75, 100, 150, 200, 300, 400, 500], (128, 151, 114), True),
]:
    overlay.paste((0, 0, 0, 0), (0, 0, WIDTH, HEIGHT))
    for index, level in enumerate(levels):
        for coordinates in generator.lines(level):
            lines.line(screen(coordinates), fill=(*color, 57 if clip else 106), width=1)
            if not clip:
                add_depth(coordinates, index % 3 == 0)
    alpha = np.asarray(overlay.getchannel("A")).copy()
    alpha[np.asarray(mask) != (255 if clip else 0)] = 0
    overlay.putalpha(Image.fromarray(alpha))
    if clip:
        # Keep terrain texture at all zoom levels, while bathymetry becomes
        # GPU-drawn line work as the camera gets closer.
        terrain = overlay.copy()
    else:
        depth = overlay.copy()

base.alpha_composite(terrain)
base.alpha_composite(coast)
# This texture has no shoreline mask. At close zoom, all land and water
# outlines are drawn by vector layers on top of continuous depth tones.
image(water_tones).filter(ImageFilter.GaussianBlur(4)).save(args.output / "relief-detail.jpg", quality=92)
# The web app serves a lossless WebP of that file (far smaller, same pixels); the desktop copy uses the JPEG.
Image.open(args.output / "relief-detail.jpg").save(args.output / "relief-detail.webp", lossless=True, method=6)
with (args.output / "land.json").open("w") as f:
    json.dump({"type":"FeatureCollection","features":[
        {"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":polygon}}
        for polygon in land_polygons
    ]}, f, separators=(",", ":"))
base.alpha_composite(depth)
base.convert("RGB").save(args.output / "relief.jpg", quality=91)
if args.halifax_elevation:
    hy, hx, hz = np.loadtxt(args.halifax_elevation, delimiter=",", skiprows=2, unpack=True)
    xaxis, yaxis = np.unique(hx) - 360, np.unique(hy)
    generator = contour_generator(x=xaxis, y=yaxis, z=hz.reshape(yaxis.size,xaxis.size))
    for index, level in enumerate([-90,-75,-60,-50,-40,-30,-20,-15,-10,-5]):
        for line in generator.lines(level):
            add_depth(line, index % 2 == 0, detail=True)
with (args.output / "contours.json").open("w") as f:
    json.dump({"type": "FeatureCollection", "features": contours}, f, separators=(",", ":"))
