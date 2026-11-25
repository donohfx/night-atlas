// Two night-time touches shared by the web and desktop maps:
//   fog               when visibility drops, a drifting haze that the lighthouse beams carve through
//   sky and rain      cloud cover sets the light (moonlit or overcast); rain and snow fall, lit by the beams
//   ship of the night a spotlight that follows the biggest vessel in Halifax Harbour
// The host map calls begin() and finish() around its beam drawing, and cut() for each beam wedge.

const HARBOUR = [-63.66, 44.56, -63.49, 44.73];      // approaches to Bedford Basin
const SHIP_FRESH = 3600;                              // seconds since last report
const CLEAR_AT = 6000, THICK_AT = 400;                // visibility in metres

// Fog by visibility: under 5 km a light haze, under 1 km proper fog, under 200 m pea soup.
const FOG_STEPS = [[5000,0],[2500,.22],[1000,.42],[500,.65],[200,.9],[100,1]];
export function fogFrom(weather) {
  if (!weather) return 0;
  const visibility = weather.visibility;
  let fog = 0;
  if (Number.isFinite(visibility) && visibility < FOG_STEPS[0][0]) {
    fog = 1;
    for (let i=1; i<FOG_STEPS.length; ++i) {
      const [far,low] = FOG_STEPS[i-1], [near,high] = FOG_STEPS[i];
      if (visibility >= near) { fog = low+(high-low)*(far-visibility)/(far-near); break; }
    }
  }
  if (weather.weather_code === 45 || weather.weather_code === 48) fog = Math.max(fog, .45);
  return fog;
}

// 0 clear to 1 overcast, weighted toward the low cloud that sits over the harbour. null if unreported.
export function cloudFrom(weather) {
  const low = weather?.cloud_cover_low, all = weather?.cloud_cover;
  if (!Number.isFinite(low) && !Number.isFinite(all)) return null;
  return Math.min(1, Math.max(0, ((Number.isFinite(low) ? low : all)*.6 + (Number.isFinite(all) ? all : low)*.4)/100));
}

export function precipitationFrom(weather) {
  const code = weather?.weather_code, amount = weather?.precipitation || 0;
  const snow = (code >= 71 && code <= 77) || code === 85 || code === 86;
  const rain = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
  if (!snow && !rain && !(amount > 0)) return null;
  const byCode = [55,57,65,67,75,82,86,99].includes(code) ? .9 : [53,63,73,81,95].includes(code) ? .6 : .35;
  return {kind: snow ? "snow" : "rain", amount: Math.min(1, Math.max(byCode, amount/2))};
}

// Fraction of the moon that is lit (from the mean lunar month; rise and set times are ignored).
export function moonlight(seconds) {
  const age = ((seconds - 947182440)/86400) % 29.530589;       // new moon of 2000-01-06 18:14 UTC
  return (1-Math.cos(2*Math.PI*((age+29.530589)%29.530589)/29.530589))/2;
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
  let haze = null, pattern = null, weather = null, pretend = preview;
  let layers = {fog:true, sky:true, rain:true, spotlight:true}, fog = 0, shown = 0, drift = [0,0], last = 0;
  let falling = null, blurred = 0;
  const drops = Array.from({length:700}, (_,i) => [(i*0.7548776662)%1, (i*0.5698402909)%1, .6+((i*0.3819660113)%1)*.8]);
  const conditions = () => pretend ? {...weather, ...pretend} : weather;

  // Rain streaks or snowflakes in screen space; the same positions can be drawn twice (dim, then lit).
  function precipitate(context, width, height, now, alpha) {
    const count = Math.round(Math.min(drops.length, width*height/2600)*falling.amount);
    const snow = falling.kind === "snow";
    const from = ((conditions()?.wind_direction_10m ?? 225)+180)*Math.PI/180;
    const slant = Math.sin(from)*Math.min(.45, (conditions()?.wind_speed_10m ?? 8)/60);
    context.save();
    context.strokeStyle = context.fillStyle = `rgba(205,222,224,${alpha})`;
    context.lineWidth = 1;
    context.beginPath();
    for (let i=0; i<count; ++i) {
      const [u,v,depth] = drops[i];
      const speed = (snow ? 28 : 520)*depth;
      const y = (v*height + now*speed) % (height+20) - 10;
      const sway = snow ? Math.sin(now*.9+i)*6 : 0;
      const x = ((u*width + y*slant + sway) % width + width) % width;
      if (snow) { context.moveTo(x+depth*1.3,y); context.arc(x,y,depth*1.3,0,Math.PI*2); }
      else { context.moveTo(x,y); context.lineTo(x-slant*11*depth, y-11*depth); }
    }
    if (snow) context.fill(); else context.stroke();
    context.restore();
  }

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
    // Pretend weather (Open-Meteo field names) to see an effect on a fine day.
    setPreview(value) { pretend = value && typeof value === "object" ? value : null; },
    setLayers(value) {
      layers = Object.fromEntries(["fog","sky","rain","spotlight"].map(name => [name, value[name] !== false]));
    },
    strength: () => 1 + 1.7*shown,
    spread: () => 1 + .9*shown,             // beams widen and bloom as the fog thickens

    begin(width, height, density, now, night) {
      fog = layers.fog ? fogFrom(conditions()) : 0;
      falling = layers.rain ? precipitationFrom(conditions()) : null;
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
      // Soften coastline and ships; the beams and lamp glows are painted above, so they stay.
      const blur = Math.round(Math.max(0,shown-.25)*8)/4;
      if (blur !== blurred) { blurred = blur; map.getCanvas().style.filter = blur ? `blur(${blur}px)` : ""; }

      const cloud = layers.sky ? cloudFrom(conditions()) : null;
      if (cloud !== null) {
        const moon = moonlight(now)*(1-cloud);
        if (night && moon > 0) {
          fogContext.fillStyle = `rgba(150,180,215,${.075*moon})`;
          fogContext.fillRect(0,0,width,height);
        }
        const dim = night ? .3*Math.max(0,cloud-.35)/.65 : 0;
        const grey = night ? 0 : .22*Math.max(0,cloud-.25)/.75;
        if (dim || grey) {
          fogContext.fillStyle = night ? `rgba(0,0,0,${dim})` : `rgba(112,122,126,${grey})`;
          fogContext.fillRect(0,0,width,height);
        }
      }
      if (falling) precipitate(fogContext,width,height,now,falling.kind === "snow" ? .32 : .22);
      if (shown <= 0) return;
      haze ??= hazeTile();
      pattern ??= fogContext.createPattern(haze,"repeat");
      fogContext.fillStyle = `rgba(150,170,164,${(night ? .065 : .13)*(.3+.7*shown)})`;
      fogContext.fillRect(0,0,width,height);
      const toward = ((conditions()?.wind_direction_10m ?? 225)+180)*Math.PI/180;
      const speed = 4 + Math.min(30, conditions()?.wind_speed_10m ?? 8)*.5;
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
      if (falling) {                         // drops catch the light wherever a beam is
        context.globalCompositeOperation = "source-atop";
        precipitate(context,context.canvas.clientWidth,context.canvas.clientHeight,now,.85);
        context.globalCompositeOperation = "source-over";
      }
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
