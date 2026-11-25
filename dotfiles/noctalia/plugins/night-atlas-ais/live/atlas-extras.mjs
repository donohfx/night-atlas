// Two night-time touches shared by the web and desktop maps:
//   fog               when visibility drops, a drifting haze that the lighthouse beams carve through
//   ship of the night a spotlight that follows the biggest vessel in Halifax Harbour
// The host map calls begin() and finish() around its beam drawing, and cut() for each beam wedge.

const HARBOUR = [-63.66, 44.56, -63.49, 44.73];      // approaches to Bedford Basin
const SHIP_FRESH = 3600;                              // seconds since last report
const CLEAR_AT = 6000, THICK_AT = 400;                // visibility in metres

export function fogFrom(weather) {
  if (!weather) return 0;
  const visibility = weather.visibility;
  let fog = Number.isFinite(visibility) ? Math.min(1, Math.max(0, (CLEAR_AT-visibility)/(CLEAR_AT-THICK_AT))) : 0;
  if (weather.weather_code === 45 || weather.weather_code === 48) fog = Math.max(fog, .55);
  return fog;
}

export function biggestInHarbour(ships) {
  const [west,south,east,north] = HARBOUR;
  let best = null;
  for (const p of ships) {
    if (!(p.length > 0) || p.age > SHIP_FRESH || p.lon < west || p.lon > east || p.lat < south || p.lat > north) continue;
    if (!best || p.length > best.length || (p.length === best.length && (p.width || 0) > (best.width || 0))) best = p;
  }
  return best;
}

function kind(type) {
  if (type === 30) return "Fishing vessel";
  if (type === 31 || type === 32 || type === 52) return "Tug";
  if (type === 35) return "Naval vessel";
  if (type === 36 || type === 37) return "Pleasure craft";
  return {5:"Service vessel", 6:"Passenger vessel", 7:"Cargo ship", 8:"Tanker"}[Math.floor(type/10)] || "Vessel";
}
const title = name => String(name || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

function hazeTile() {
  const size = 512, tile = document.createElement("canvas");
  tile.width = tile.height = size;
  const context = tile.getContext("2d");
  let seed = 7;
  const random = () => (seed = (seed*16807) % 2147483647)/2147483647;
  for (let i = 0; i < 70; ++i) {
    const x = random()*size, y = random()*size, radius = 40+random()*110;
    for (const dx of [-size,0,size]) for (const dy of [-size,0,size]) {      // wraps seamlessly
      const glow = context.createRadialGradient(x+dx,y+dy,0,x+dx,y+dy,radius);
      glow.addColorStop(0,"rgba(190,208,201,.16)");
      glow.addColorStop(1,"rgba(190,208,201,0)");
      context.fillStyle = glow;
      context.fillRect(x+dx-radius,y+dy-radius,radius*2,radius*2);
    }
  }
  return tile;
}

export function createExtras({map, beamCanvas, accent, ships, preview = null}) {
  const style = document.createElement("style");
  style.textContent = `.ship-card{padding:6px 12px 8px;pointer-events:auto;cursor:pointer;max-width:260px}
.ship-card[hidden]{display:none}
.ship-card span{display:block;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.ship-card strong{display:block;font-size:14px;color:var(--accent)}
.ship-card small{display:block;font-size:11px;color:var(--muted)}
@media (max-width:540px),(max-height:500px) and (pointer:coarse){.ship-card{padding:2px 8px 3px}.ship-card span,.ship-card small{display:none}.ship-card strong{font-size:11px}}`;
  document.head.append(style);

  const fogCanvas = document.createElement("canvas");
  fogCanvas.className = "light-beams";
  fogCanvas.setAttribute("aria-hidden","true");
  beamCanvas.before(fogCanvas);                      // same stacking level, painted under the beams
  const fogContext = fogCanvas.getContext("2d");
  let haze = null, pattern = null, weather = null, previewFog = preview;
  let layers = {fog:true, spotlight:true}, fog = 0, shown = 0, drift = [0,0], last = 0;

  const card = document.createElement("button");
  card.type = "button";
  card.className = "ship-card";
  card.hidden = true;
  card.style.font = "inherit";
  card.style.textAlign = "left";
  card.style.color = "inherit";
  document.querySelector("#dock").prepend(card);
  let star = null, starChecked = 0, cardText = "";
  card.addEventListener("click", () => {
    if (star) map.flyTo({center:[star.lon,star.lat], zoom:Math.max(map.getZoom(),13), duration:2200});
  });

  function describe(night) {
    card.hidden = !(night && layers.spotlight && star);
    if (card.hidden) return;
    const lines = [
      ["span","Ship of the night"], ["strong", title(star.name) || `MMSI ${star.mmsi}`],
      ["small", `${Math.round(star.length)} m${star.width ? ` × ${Math.round(star.width)} m` : ""} · ${kind(star.type)}`],
    ];
    const text = JSON.stringify(lines);
    if (text === cardText) return;
    cardText = text;
    card.replaceChildren(...lines.map(([tag,value]) => { const node = document.createElement(tag); node.textContent = value; return node; }));
  }

  return {
    setWeather(value) { weather = value; },
    setPreview(value) { previewFog = Number.isFinite(value) ? Math.min(1,Math.max(0,value)) : null; },
    setLayers(value) { layers = {fog:value.fog !== false, spotlight:value.spotlight !== false}; },
    strength: () => 1 + 1.7*shown,

    begin(width, height, density, now, night) {
      fog = layers.fog ? (previewFog ?? fogFrom(weather)) : 0;
      const step = Math.min(.1, Math.max(0, now-last));
      last = now;
      shown += (fog-shown)*Math.min(1, step*.8);       // fog rolls in and out gently
      if (Math.abs(fog-shown) < .004) shown = fog;
      if (fogCanvas.width !== Math.round(width*density) || fogCanvas.height !== Math.round(height*density)) {
        fogCanvas.width = Math.round(width*density);
        fogCanvas.height = Math.round(height*density);
      }
      fogContext.setTransform(density,0,0,density,0,0);
      fogContext.globalCompositeOperation = "source-over";
      fogContext.clearRect(0,0,width,height);
      if (shown <= 0) return;
      haze ??= hazeTile();
      pattern ??= fogContext.createPattern(haze,"repeat");
      fogContext.fillStyle = `rgba(150,170,164,${(night ? .065 : .13)*(.3+.7*shown)})`;
      fogContext.fillRect(0,0,width,height);
      const toward = ((weather?.wind_direction_10m ?? 225)+180)*Math.PI/180;
      const speed = 4 + Math.min(30, weather?.wind_speed_10m ?? 8)*.5;
      drift = [(drift[0]+Math.sin(toward)*speed*step) % 4096, (drift[1]-Math.cos(toward)*speed*step) % 4096];
      for (const [scale,rate,alpha] of [[2.2,1,1],[1.3,1.7,.7]]) {
        fogContext.save();
        fogContext.globalAlpha = Math.min(1, shown*alpha*(night ? .38 : .62));
        pattern.setTransform(new DOMMatrix().translate(drift[0]*rate,drift[1]*rate).scale(scale));
        fogContext.fillStyle = pattern;
        fogContext.fillRect(0,0,width,height);
        fogContext.restore();
      }
    },

    // Thin the haze where a beam passes.
    cut(path, center, length) {
      if (shown <= 0) return;
      const gradient = fogContext.createRadialGradient(center.x,center.y,0,center.x,center.y,length);
      gradient.addColorStop(0,`rgba(0,0,0,${.85*shown})`);
      gradient.addColorStop(1,"rgba(0,0,0,0)");
      fogContext.globalCompositeOperation = "destination-out";
      fogContext.fillStyle = gradient;
      fogContext.fill(path);
      fogContext.globalCompositeOperation = "source-over";
    },

    // lamps: [{point, color}] for the lights that are lit right now.
    finish(context, now, night, lamps) {
      if (shown > 0) {
        context.globalCompositeOperation = "lighter";
        const radius = 6+10*shown;
        for (const {point,color} of lamps) {
          const glow = context.createRadialGradient(point.x,point.y,0,point.x,point.y,radius);
          glow.addColorStop(0,color+(night ? "aa" : "88"));
          glow.addColorStop(.3,color+"40");
          glow.addColorStop(1,color+"00");
          context.fillStyle = glow;
          context.fillRect(point.x-radius,point.y-radius,radius*2,radius*2);
        }
        context.globalCompositeOperation = "source-over";
      }
      if (now-starChecked > 1) {
        starChecked = now;
        star = biggestInHarbour(ships());
        describe(night);
      } else if (card.hidden === Boolean(night && layers.spotlight && star)) describe(night);
      if (!(night && layers.spotlight && star)) return;
      const point = map.project([star.lon,star.lat]), zoom = map.getZoom();
      const reach = Math.max(20, Math.min(84, 22+(zoom-8)*13));
      const breath = 1+Math.sin(now*1.6)*.07;
      context.save();
      const pool = context.createRadialGradient(point.x,point.y,0,point.x,point.y,reach*breath);
      pool.addColorStop(0,accent+"66");
      pool.addColorStop(.45,accent+"26");
      pool.addColorStop(1,accent+"00");
      context.globalCompositeOperation = "lighter";
      context.fillStyle = pool;
      context.beginPath();
      context.arc(point.x,point.y,reach*breath,0,Math.PI*2);
      context.fill();
      context.globalCompositeOperation = "source-over";
      context.strokeStyle = accent+"cc";
      context.lineWidth = 1.2;
      context.setLineDash([reach*.5, reach*.285]);       // four arcs, turning slowly
      context.lineDashOffset = -now*7;
      context.beginPath();
      context.arc(point.x,point.y,reach*.5,0,Math.PI*2);
      context.stroke();
      context.restore();
    },
  };
}
