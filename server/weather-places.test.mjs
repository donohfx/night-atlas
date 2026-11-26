import {test} from "node:test";
import assert from "node:assert/strict";
import {halifaxWeather, pickWeatherPlace, weatherPlaces} from "../web/weather-places.mjs";

const town = name => weatherPlaces.find(place => place.name === name);

test("town centres resolve to their local weather place", () => {
  for (const place of weatherPlaces) {
    assert.equal(pickWeatherPlace(place, 11), place);
    assert.equal(pickWeatherPlace(place, 11, halifaxWeather), place);
  }
});

test("overview uses Halifax and zoom hysteresis avoids toggling at the transition", () => {
  const kingston = town("Kingston");
  assert.equal(pickWeatherPlace(kingston, 7.9), null);
  assert.equal(pickWeatherPlace(kingston, 8), kingston);
  assert.equal(pickWeatherPlace(kingston, 7.9, kingston), kingston);
  assert.equal(pickWeatherPlace(kingston, 7.49, kingston), null);
});

test("panning near the midpoint between neighbours keeps the previous town", () => {
  const yarmouth = town("Yarmouth"), shelburne = town("Shelburne");
  const midpoint = {lng:-65.70, lat:43.80};
  assert.equal(pickWeatherPlace(midpoint, 10, yarmouth), yarmouth);
  assert.equal(pickWeatherPlace(midpoint, 10, shelburne), shelburne);
  assert.equal(pickWeatherPlace(shelburne, 10, yarmouth), shelburne);
});

test("distant offshore centres keep a local selection or fall back to Halifax", () => {
  const sea = {lng:-57, lat:43}, sydney = town("Sydney");
  assert.equal(pickWeatherPlace(sea, 10, sydney), sydney);
  assert.equal(pickWeatherPlace(sea, 10), halifaxWeather);
  assert.equal(pickWeatherPlace(sea, 6, sydney), null);
});
