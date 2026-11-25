"""Shared position math for the AIS feed and native renderer."""
import math

# Same local projection and viewport as rices/render-atlas.py.
ANGLE = math.radians(-5)
LEFT, RIGHT, TOP = -3.15, 4.0, 2.2
HEIGHT = (RIGHT - LEFT) * 9 / 16
REGION = (-69.14, 42.83, -58.38, 47.63)

def project(lat, lon):
    east = (lon + 64.35) * math.cos(math.pi / 4)
    north = lat - 45
    x = east * math.cos(ANGLE) - north * math.sin(ANGLE)
    y = east * math.sin(ANGLE) + north * math.cos(ANGLE)
    return (x - LEFT) / (RIGHT - LEFT), (TOP - y) / HEIGHT


def track_angle(course, latitude):
    bearing = math.radians(course)
    # The chart uses a fixed longitude scale. At this latitude, rescale east
    # before rotating so the arrow follows a course over ground on the chart.
    east = math.sin(bearing) * math.cos(math.pi / 4) / math.cos(math.radians(latitude))
    north = math.cos(bearing)
    dx = east * math.cos(ANGLE) - north * math.sin(ANGLE)
    dy = east * math.sin(ANGLE) + north * math.cos(ANGLE)
    return round(math.degrees(math.atan2(dx, dy)), 1)
