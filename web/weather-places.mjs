// ISED Geolocated placenames in Canada (MAG_EXO), rounded to 0.001°.
// https://open.canada.ca/data/en/dataset/fe945388-1dd9-4a4a-9a1e-5c552579a28c
export const weatherPlaces = [
  ["Halifax", -63.602, 44.649],
  ["Yarmouth", -66.120, 43.836],
  ["Digby", -65.764, 44.619],
  ["Shelburne", -65.317, 43.762],
  ["Bridgewater", -64.522, 44.375],
  ["Pictou", -62.705, 45.680],
  ["Port Hawkesbury", -61.360, 45.618],
  ["Chéticamp", -61.008, 46.636],
  ["Sydney", -60.177, 46.126],
  ["Saint John", -66.078, 45.277],
  ["Moncton", -64.791, 46.091],
  ["Miramichi", -65.179, 47.037],
  ["Caraquet", -64.956, 47.787],
  ["Charlottetown", -63.127, 46.243],
  ["Summerside", -63.789, 46.393],
  ["Souris", -62.249, 46.355],
  ["St. John's", -52.726, 47.564],
  ["Bonavista", -53.109, 48.652],
  ["Twillingate", -54.762, 49.649],
  ["Corner Brook", -57.947, 48.952],
  ["Channel-Port aux Basques", -59.143, 47.575],
  ["St. Anthony", -55.592, 51.367],
  ["Cartwright", -57.005, 53.707],
  ["Happy Valley-Goose Bay", -60.318, 53.299],
  ["Cap-aux-Meules", -61.867, 47.384],
  ["Gaspé", -64.492, 48.831],
  ["Havre-Saint-Pierre", -63.602, 50.240],
  ["Sept-Îles", -66.373, 50.218],
  ["Baie-Comeau", -68.175, 49.209],
  ["Rimouski", -68.524, 48.450],
  ["Tadoussac", -69.720, 48.148],
  ["Québec City", -71.225, 46.811],
  ["Trois-Rivières", -72.561, 46.346],
  ["Montréal", -73.562, 45.529],
  ["Cornwall", -74.726, 45.026],
  ["Brockville", -75.686, 44.597],
  ["Kingston", -76.501, 44.236],
].map(([name, lng, lat]) => ({name, lng, lat}));

export const halifaxWeather = weatherPlaces[0];
const radians = degrees => degrees * Math.PI / 180;
function distanceKm(a, b) {
  const halfLat = radians(b.lat - a.lat) / 2;
  const halfLng = radians(b.lng - a.lng) / 2;
  const haversine = Math.sin(halfLat) ** 2
    + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(halfLng) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

// A null selection means overview. Enter local mode at zoom 8, and leave at 7.5.
export function pickWeatherPlace(center, zoom, previous = null) {
  if (zoom < (previous ? 7.5 : 8)) return null;

  let nearest, nearestKm = Infinity;
  for (const place of weatherPlaces) {
    const km = distanceKm(center, place);
    if (km >= nearestKm) continue;
    nearest = place;
    nearestKm = km;
  }
  if (nearestKm > 85) return previous ?? halifaxWeather;
  if (previous && distanceKm(center, previous) <= nearestKm + 10) return previous;
  return nearest;
}
