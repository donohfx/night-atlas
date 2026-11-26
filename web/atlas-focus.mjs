// A land-only overlay below water and chart symbols. Samples estimate which
// parts of each province occupy the centre and the wider viewport.
const smooth = (start, end, value) => {
  const fraction = Math.max(0, Math.min(1, (value-start)/(end-start)));
  return fraction*fraction*(3-2*fraction);
};

export function provinceFocus(map, source, samples, tiled, isNight, openingCamera) {
  let update = () => {};
  map.once("load", () => {
    map.addSource("provinces", {...source, promoteId:"region"});
    map.addLayer({
      id:"province-shade", type:"fill", source:"provinces",
      ...(tiled ? {"source-layer":"_geojsonTileLayer"} : {}),
      paint:{"fill-color":"#0b1616", "fill-antialias":false, "fill-opacity":["coalesce", ["feature-state","shade"], 0],
        "fill-opacity-transition":{duration:0}},
    }, "fine-water");
    let previousNight;
    const previous = new Map();
    function shadeRegion(id, shade) {
      const value = Math.round(shade*1000)/1000;
      if (previous.get(id) === value) return;
      previous.set(id, value);
      map.setFeatureState({source:"provinces", id, ...(tiled ? {sourceLayer:"_geojsonTileLayer"} : {})}, {shade:value});
    }
    update = () => {
      const {clientWidth:width, clientHeight:height} = map.getContainer();
      if (!width || !height) return;
      const zoom = map.getZoom();
      const opening = openingCamera();
      const origin = map.project(opening.center);
      const shift = Math.hypot((origin.x-width/2)/width, (origin.y-height/2)/height);
      // At the opening scale a broad view can still favour Nova Scotia.
      // Zooming out or recentering that broad view lets other provinces join it.
      const broad = 1-smooth(.02, .46, zoom-opening.zoom);
      const wide = broad*Math.max(smooth(0,.17,opening.zoom-zoom), smooth(.07,.30,shift));
      const night = isNight();
      const opacity = night ? .72 : .76;
      if (previousNight !== night) {
        previousNight = night;
        map.setPaintProperty("province-shade", "fill-color", night ? "#040808" : "#0b1616");
      }
      shadeRegion("US", opacity);
      // A floor on the scale prevents the footprint grid from showing up at
      // harbour zoom. Using screen coordinates accounts for rotation and aspect.
      const gridScale = 2**Math.max(0, zoom-8);
      const halfWidth = Math.max(width/2, 260*gridScale);
      const halfHeight = Math.max(height/2, 220*gridScale);
      for (const [region, points] of Object.entries(samples)) {
        let distance = Infinity;
        for (const point of points) {
          const {x,y} = map.project(point);
          distance = Math.min(distance, Math.hypot((x-width/2)/halfWidth, (y-height/2)/halfHeight));
        }
        const central = 1-smooth(.24, .57, distance);
        const visible = 1-smooth(.9, 1.35, distance);
        shadeRegion(region, opacity*(1-Math.max(central, wide*visible)));
      }
    };
    map.on("move", update);
    map.on("resize", update);
    update();
  });
  return () => update();
}
