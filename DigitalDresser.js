// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: tshirt;

// DigitalDresser: a home-screen widget that reads the NOAA (api.weather.gov)
// hourly forecast and tells you what to wear.
//
// Widget parameter (optional): "lat,lon" to pin a location instead of using GPS,
// e.g. "40.7128,-74.0060".

// ---------- Settings ----------

// NWS asks every app to identify itself. Put your own contact info here.
const USER_AGENT = "DigitalDresser/1.0 (personal widget; github.com/MayaVolkov/DigitalDresser)";

const DAY_START_HOUR = 7;   // first hour you're usually out
const DAY_END_HOUR = 21;    // last hour you care about
const SWITCH_TO_TOMORROW_HOUR = 19; // after this, show tomorrow's outfit
const GOING_OUT_DAYS = ["Thursday", "Friday", "Saturday"];
const GOING_OUT_SWITCH_HOUR = 21;   // on going-out days, switch later so tonight stays visible
const CACHE_MAX_AGE_HOURS = 6;      // how long a saved forecast is usable offline
const POINT_REFRESH_MILES = 1.5;    // look up the NWS grid square again after moving this far
const GYM_CALENDAR = "Gym";         // iOS calendar with your workouts (matched by name)
const GYM_BEFORE_HOUR = 11;         // a Gym event starting before this counts as a morning workout
const USUAL_GYM_DAYS = ["Monday", "Tuesday", "Wednesday"]; // used if the calendar can't be read

// Everyone runs hot or cold differently. Positive = you run cold
// (treats the weather as this many degrees colder than it is).
const COLD_BIAS_F = 0;

// Sun makes a day feel warmer than the thermometer says, especially in Colorado.
// At 100% cloud cover, daytime hours feel this many degrees colder (scaled by cloud %).
const OVERCAST_COOLING_F = 5;

// ---------- Weather ----------

const fm = FileManager.local();
const cacheDir = fm.joinPath(fm.cacheDirectory(), "DigitalDresser");
if (!fm.fileExists(cacheDir)) fm.createDirectory(cacheDir, true);

function readCache(name) {
  const path = fm.joinPath(cacheDir, name);
  if (!fm.fileExists(path)) return null;
  try { return JSON.parse(fm.readString(path)); } catch (e) { return null; }
}

function writeCache(name, value) {
  fm.writeString(fm.joinPath(cacheDir, name), JSON.stringify(value));
}

async function getJSON(url) {
  const req = new Request(url);
  req.headers = { "User-Agent": USER_AGENT, "Accept": "application/geo+json" };
  req.timeoutInterval = 20;
  const json = await req.loadJSON();
  const status = req.response && req.response.statusCode;
  if (status && status >= 400) {
    throw new Error(`NOAA ${status}: ${json.detail || json.title || "request failed"}`);
  }
  return json;
}

function milesBetween(a, b) {
  const rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 3959 * 2 * Math.asin(Math.sqrt(h));
}

// Returns { lat, lon, source, savedAt }. source is "pinned" (widget parameter),
// "gps" (a fresh fix), or "cached" (GPS failed, so this is the last known spot).
async function getCoordinates() {
  const param = (args.widgetParameter || "").trim();
  if (param) {
    const [lat, lon] = param.split(",").map(Number);
    if (isFinite(lat) && isFinite(lon)) return { lat, lon, source: "pinned", savedAt: Date.now() };
  }
  try {
    // 100m accuracy makes iOS get a fresh fix instead of handing back an old one.
    Location.setAccuracyToHundredMeters();
    // Location can hang inside widgets, so don't wait forever.
    const loc = await Promise.race([
      Location.current(),
      new Promise((_, reject) => Timer.schedule(10000, false, () => reject(new Error("timeout")))),
    ]);
    const coords = { lat: loc.latitude, lon: loc.longitude, savedAt: Date.now() };
    writeCache("coords.json", coords);
    console.log(`Location: fresh GPS ${coords.lat.toFixed(3)},${coords.lon.toFixed(3)}`);
    return { ...coords, source: "gps" };
  } catch (e) {
    const cached = readCache("coords.json");
    if (cached) {
      console.log(`Location: GPS failed (${e.message}), using cached spot from ${new Date(cached.savedAt || 0)}`);
      return { ...cached, source: "cached" };
    }
    throw new Error("Couldn't get your location. Allow Scriptable location access, or set the widget parameter to \"lat,lon\".");
  }
}

async function getHourlyForecast({ lat, lon }) {
  // /points tells us which NWS grid square we're in and the nearest town's name.
  // Both are saved together and looked up again once you've moved far enough.
  let point = readCache("point.json");
  if (!point || point.lat == null || !point.gridUrl || milesBetween(point, { lat, lon }) > POINT_REFRESH_MILES) {
    const json = await getJSON(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
    const rel = json.properties.relativeLocation.properties;
    point = { lat, lon, hourlyUrl: json.properties.forecastHourly, gridUrl: json.properties.forecastGridData, place: `${rel.city}, ${rel.state}` };
    writeCache("point.json", point);
    console.log(`Grid point updated: ${point.place}`);
  }
  const json = await getJSON(point.hourlyUrl);
  return { place: point.place, periods: json.properties.periods, skyCover: await getSkyCover(point.gridUrl) };
}

// Hourly cloud cover (%) from the NWS grid data, as { "<hour start in ms>": percent }.
// If it can't be fetched we return null and fall back to the forecast wording.
async function getSkyCover(gridUrl) {
  try {
    const json = await getJSON(gridUrl);
    const byHour = {};
    const until = Date.now() + 48 * 3600 * 1000;
    for (const v of json.properties.skyCover.values) {
      // validTime looks like "2026-10-25T12:00:00+00:00/PT2H"
      const [start, dur] = v.validTime.split("/");
      const m = dur.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?)?/);
      const hours = (Number(m[1] || 0) * 24 + Number(m[2] || 0)) || 1;
      const t0 = Date.parse(start);
      if (t0 > until) break;
      for (let i = 0; i < hours; i++) byHour[t0 + i * 3600 * 1000] = v.value;
    }
    return byHour;
  } catch (e) {
    console.log(`Sky cover unavailable (${e.message}), using forecast wording`);
    return null;
  }
}

async function loadForecast() {
  try {
    const coords = await getCoordinates();
    const forecast = { ...(await getHourlyForecast(coords)), locationSource: coords.source, locationSavedAt: coords.savedAt };
    writeCache("forecast.json", { savedAt: Date.now(), ...forecast });
    return { ...forecast, savedAt: Date.now(), stale: false };
  } catch (err) {
    const cached = readCache("forecast.json");
    if (cached && Date.now() - cached.savedAt < CACHE_MAX_AGE_HOURS * 3600 * 1000) {
      return { ...cached, stale: true };
    }
    throw err;
  }
}

// ---------- Turning hours into a day summary ----------

function parseWindMph(windSpeed) {
  // "10 mph" or "5 to 15 mph" -> the higher number
  const nums = (windSpeed || "").match(/\d+/g);
  return nums ? Math.max(...nums.map(Number)) : 0;
}

function feelsLike(tempF, windMph, humidity) {
  if (tempF <= 50 && windMph > 3) {
    const w = Math.pow(windMph, 0.16);
    return 35.74 + 0.6215 * tempF - 35.75 * w + 0.4275 * tempF * w;
  }
  if (tempF >= 80 && humidity != null) {
    const T = tempF, R = humidity;
    return -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R
      - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R
      + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
  }
  return tempF;
}

function toF(temp, unit) {
  return unit === "C" ? temp * 9 / 5 + 32 : temp;
}

// Rough cloud % from the forecast wording, used when the grid data isn't available.
function cloudFromText(text) {
  const t = text.toLowerCase();
  if (/overcast|^cloudy/.test(t)) return 95;
  if (/rain|shower|snow|thunder|drizzle|sleet|fog/.test(t)) return 85;
  if (/mostly cloudy/.test(t)) return 75;
  if (/partly/.test(t)) return 45;
  if (/mostly (sunny|clear)/.test(t)) return 20;
  return 5; // Sunny / Clear
}

function summarizeDay(periods, skyCover = null) {
  // startTime is local to the forecast location, e.g. "2026-10-19T13:00:00-04:00",
  // so we can read the date and hour straight out of the string.
  const dateOf = p => p.startTime.slice(0, 10);
  const hourOf = p => parseInt(p.startTime.slice(11, 13), 10);

  const today = dateOf(periods[0]);
  let target = today;
  let label = "Today";
  const switchHour = GOING_OUT_DAYS.includes(weekdayOf(today)) ? GOING_OUT_SWITCH_HOUR : SWITCH_TO_TOMORROW_HOUR;
  if (hourOf(periods[0]) >= switchHour) {
    const next = periods.find(p => dateOf(p) !== today);
    if (next) { target = dateOf(next); label = "Tomorrow"; }
  }

  let hours = periods.filter(p => dateOf(p) === target && hourOf(p) >= DAY_START_HOUR && hourOf(p) <= DAY_END_HOUR);
  if (hours.length === 0) hours = periods.slice(0, 12);

  const toRow = p => {
    const temp = toF(p.temperature, p.temperatureUnit);
    const wind = parseWindMph(p.windSpeed);
    const rh = p.relativeHumidity ? p.relativeHumidity.value : null;
    const cloud = skyCover && skyCover[Date.parse(p.startTime)] != null
      ? skyCover[Date.parse(p.startTime)]
      : cloudFromText(p.shortForecast || "");
    const overcastCooling = p.isDaytime ? OVERCAST_COOLING_F * cloud / 100 : 0;
    return {
      hour: hourOf(p),
      temp,
      feels: feelsLike(temp, wind, rh) - COLD_BIAS_F - overcastCooling,
      pop: (p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value) || 0,
      wind,
      sky: p.shortForecast || "",
      cloud,
      isDaytime: p.isDaytime,
    };
  };
  const rows = hours.map(toRow);

  // Going-out hours (8pm to midnight), kept separate so a cold night
  // doesn't change the daytime numbers.
  const evening = periods.filter(p => dateOf(p) === target && hourOf(p) >= 20).map(toRow);

  const max = (k) => Math.max(...rows.map(r => r[k]));
  const min = (k) => Math.min(...rows.map(r => r[k]));
  const skies = rows.map(r => r.sky.toLowerCase());
  const has = (re) => skies.some(s => re.test(s));
  const daylight = rows.filter(r => r.isDaytime).length ? rows.filter(r => r.isDaytime) : rows;
  const cloudCover = Math.round(daylight.reduce((sum, r) => sum + r.cloud, 0) / daylight.length);

  return {
    label,
    date: target,
    weekday: weekdayOf(target),
    rows,
    evening,
    high: Math.round(max("temp")),
    low: Math.round(min("temp")),
    feelsHigh: Math.round(max("feels")),
    feelsLow: Math.round(min("feels")),
    pop: max("pop"),
    wind: max("wind"),
    snow: has(/snow|sleet|flurr|ice|wintry/),
    storms: has(/thunder|t-storm/),
    sunny: daylight.filter(r => r.cloud <= 30).length >= Math.max(2, daylight.length / 3),
    mainSky: mostCommon(rows.map(r => r.sky)),
    cloudCover,
    overcast: cloudCover >= 70,
    cloudy: cloudCover >= 60,
    rainWindow: findRainWindow(rows),
  };
}

function weekdayOf(date) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(date + "T12:00:00").getDay()];
}

function formatHour(h) {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${h < 12 || h === 24 ? "am" : "pm"}`;
}

// First stretch of 3+ hours in a row where rain is over 50% likely, or null.
function findRainWindow(rows) {
  let run = [];
  for (const r of rows) {
    if (r.pop > 50 && (run.length === 0 || r.hour === run[run.length - 1].hour + 1)) run.push(r);
    else if (run.length >= 3) break;
    else run = r.pop > 50 ? [r] : [];
  }
  if (run.length < 3) return null;
  const start = run[0].hour, end = run[run.length - 1].hour + 1;
  return { start, end, startText: formatHour(start), endText: formatHour(end) };
}

function mostCommon(list) {
  const counts = {};
  for (const x of list) counts[x] = (counts[x] || 0) + 1;
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || "";
}

// ---------- YOUR RULES GO HERE ----------
//
// chooseOutfit gets a summary of the hours you're out (7am-9pm by default)
// and returns what the widget should show. Everything else in this file
// is plumbing, so this is the only function you need to edit.
//
// What `day` contains (temperatures in °F; "feels" includes wind chill / heat index,
// and cloudy daytime hours feel up to OVERCAST_COOLING_F colder):
//   day.label       "Today" or "Tomorrow" (switches after 7pm)
//   day.high        warmest temp            day.low        coldest temp
//   day.feelsHigh   warmest feels-like      day.feelsLow   coldest feels-like
//   day.pop         highest chance of rain/snow, 0-100
//   day.wind        strongest wind, mph
//   day.snow        true if snow/sleet/ice is mentioned
//   day.storms      true if thunderstorms are mentioned
//   day.mainSky     most common description, e.g. "Partly Cloudy"
//   day.rows        hour by hour: [{ hour: 7, temp, feels, pop, wind, sky, cloud, isDaytime }, ...]
//   day.evening     same as rows, but for 8pm-midnight (going out)
//   day.weekday     "Monday", "Tuesday", ...
//   day.date        the outfit day, e.g. "2026-10-26"
//   day.gymMorning  true if your Gym calendar has an event before 11am that day
//                   (falls back to Mon/Tue/Wed if the calendar can't be read)
//   day.cloudCover  average cloud cover during daylight, 0-100%
//   day.cloudy      true if cloud cover is 60%+ (about "Mostly Cloudy" or more)
//   day.overcast    true if cloud cover is 70%+
//   day.sunny       true if at least a third of daylight hours are 30% cloud or less
//   day.rainWindow  first stretch of 3+ hours in a row with rain over 50%, or null:
//                   { start: 14, end: 17, startText: "2pm", endText: "5pm" }
//
// What to return (only headline and top are required):
//   headline  big bold line, e.g. "Chilly, rain later"
//   top       e.g. "Long sleeve"
//   bottom    e.g. "Jeans"
//   outer     e.g. "Rain jacket", or null for none
//   extras    list of { e: emoji, t: text }, e.g. [{ e: "☂️", t: "Umbrella" }]
//   tips      list of extra sentences; add one with outfit.tips.push("...")
//   emojis    string of emoji to show big, e.g. "👚👖🧥☂️"

function chooseOutfit(day) {

  const outfit = {
    headline: `Feels like ${day.feelsLow}°–${day.feelsHigh}°`,
    top: "T-shirt",
    bottom: "Jeans",
    outer: null,
    extras: [],
    tips: [],
    emojis: "👕👖",
    shoes: "sneakers",
  };

//Base outfit A conditions
  if(day.feelsHigh < 32){
    outfit.top = "A long sleeve and sweatshirt"
    outfit.bottom = "jeans or sweatpants"
    outfit.outer = "coat"
    outfit.shoes = "sneakers, boots, or clogs - no flip flops!"
    outfit.extras.push({ e:"🧣" , t: "scarf"})
    if(day.pop >= 50){
      outfit.shoes = "sneakers or boots"
    }
    outfit.emojis = "🧶👖🧥🥾🧣"

  }
//Base outfit B conditions
  else if((day.feelsHigh >= 32 && day.feelsHigh <= 50) && (day.pop >= 50 || day.cloudy)){
    outfit.top ="sweatset"
    outfit.bottom = null
    outfit.shoes = "birks or clogs"
    outfit.emojis = "☁️🛋️☕"
    if (day.pop >= 50){
      outfit.shoes = "sneakers or boots"
      outfit.emojis += "☂️"
    }
  }
//Base outfit C conditions
  else if ((day.feelsLow >= 30 && day.feelsLow <=50) && day.feelsHigh <= 55){
    outfit.top = "crewneck or hoodie"
    outfit.bottom = "sweatpants"
    outfit.shoes = "sneakers"
    outfit.emojis = "🍂🧸☕👟🍁"
  }

// Base outfit D conditions
  else if((day.feelsLow <= 50) && (day.feelsHigh >= 56 && day.feelsHigh <= 71)){
    outfit.top = "tank top or t-shirt"
    outfit.bottom = "jeans or leggings"
    outfit.shoes = "sneakers"
    if (!day.gymMorning) outfit.tips.push("grab a zip up for the morning")
    outfit.emojis = "🌤️🧋👖👟🌼"
  }

// Base oufti E conditions:
  else if ((day.feelsLow >= 50) && (day.feelsHigh <= 71)){
    outfit.top = "short sleeve top and zip up"
    outfit.bottom = "jeans or leggings"
    outfit.shoes = "sneakers or flip flops"
    outfit.emojis = "🌷🧃🌿😌👟"
  }

// Base outfit F conditions: 
  else if ((day.feelsHigh >= 72) && (day.feelsHigh <= 89)){
    outfit.top = "short sleeve"
    outfit.bottom = "jeans"
    outfit.shoes = "sneakers or flip flops"
    outfit.emojis = "🌞🧃🛼🌼✨"
  }
// Base outfit G conditions:
  else if (day.feelsHigh >= 90){
    outfit.top = "oversized t shirt"
    outfit.bottom = "athletic shorts"
    if(day.cloudy){
      outfit.bottom = "shorts or jeans"
    }
    outfit.shoes = "flip flops"
    outfit.emojis = "🥵🌊🍹🩴☀️"
  }

//Base outfit H conditions: 
  else if((day.feelsLow <= 30 )&& (day.feelsHigh >= 32 && (day.feelsHigh <= 55))){
    outfit.top = "long sleeve and jacket or t-shirt and hoodie"
    outfit.bottom = "jeans, sweatpants, or leggings"
    outfit.shoes = "sneakers, boots, or clogs"
    outfit.emojis = "🥶🧥☕👖🌬️"
  };

// no flip flops on overcast days, and no sun emojis when it isn't sunny
  if (day.overcast) {
    outfit.shoes = outfit.shoes.replace(" or flip flops", "").replace("flip flops", "sneakers");
  }
  if (!day.sunny) outfit.emojis = outfit.emojis.replace(/☀️|🌞/g, "☁️");

// adjustments on top of base conditions
// if theres 50% chance of rain during "out" hours
  if (day.pop >= 50){
    outfit.extras.push({e: "☂️" , t:"umbrella"})
    if(day.feelsHigh < 60){
      outfit.shoes = "sneakers or boots"
    }
    else if (day.feelsHigh >= 60){
      outfit.shoes = "sneakers"
    };
  }

// if its snowing
  if (day.snow) {
    if (day.feelsHigh >= 25) {
      outfit.shoes = "sneakers or boots";
    } else {
      outfit.shoes = "boots";
      outfit.outer = "coat";
    }
  }

// if theres afternoon rain 
   if(day.rainWindow){
    outfit.tips.push(`Heads up, it might rain starting at ${day.rainWindow.startText} until ${day.rainWindow.endText}, if you're going to be out then grab an umbrella`)
    };

// if sunny outside
  if(day.sunny){
    outfit.tips.push("make sure to bring sunglasses!");
  };

// jacket count: 
  // 1. count the reasons 
  let jacketReasons = 0;
  if (day.wind >= 20) jacketReasons +=1; 
  if(day.pop >= 50) jacketReasons +=1; 
  if (day.feelsHigh < 50) jacketReasons +=1;
// 2. decide if needs jacket or coat
 if (jacketReasons >= 2) {
  outfit.outer = "coat";
} else if (day.wind >= 20) {
  outfit.outer = "jacket";
}

// time rules: 
//morning workout
// 1. find the 9am hour 
const nineAM = day.rows.find(r => r.hour === 9);
// 2. check that it exists 
if (day.gymMorning && nineAM && nineAM.feels < 50) {
  outfit.tips.push("add sweatpants and hoodie for your workout in the morning");
} else if (day.gymMorning && nineAM && nineAM.feels >= 50 && nineAM.feels <= 70) {
  outfit.tips.push("add hoodie for your workout in the morning");
}
//going out 
//1. two checks
if(["Thursday", "Friday", "Saturday"].includes(day.weekday) && day.evening.length > 0 && (day.evening.every(r => r.feels <= 50))){
  outfit.tips.push("bring a jacket when you go out!")
}

  return outfit;
}

// ---------- Calendar ----------

// Is there a Gym event starting before GYM_BEFORE_HOUR on the outfit day?
// Returns { gym: true/false, source: "calendar" | "usual days" }.
async function checkMorningWorkout(day) {
  try {
    const gym = await Calendar.forEventsByTitle(GYM_CALENDAR);
    const start = new Date(`${day.date}T00:00:00`);   // local midnight, not UTC
    const cutoff = new Date(`${day.date}T00:00:00`);
    cutoff.setHours(GYM_BEFORE_HOUR, 0, 0, 0);
    const events = await CalendarEvent.between(start, cutoff, [gym]);
    const morning = events.filter(e => !e.isAllDay && e.startDate >= start && e.startDate < cutoff);
    console.log(`Gym calendar: ${morning.length} morning event(s) on ${day.date}`);
    return { gym: morning.length > 0, source: "calendar" };
  } catch (e) {
    console.log(`Gym calendar unavailable (${e.message}), using usual gym days`);
    return { gym: USUAL_GYM_DAYS.includes(day.weekday), source: "usual days" };
  }
}

// ---------- Drawing the widget ----------

const WHITE = Color.white();
const SOFT = new Color("#ffffff", 0.75);

function mixHex(a, b, t) {
  const ch = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return "#" + [0, 1, 2].map(i => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, "0")).join("");
}

// Temperature picks the color; clouds fade it toward gray.
function backgroundFor(feels, cloudCover = 0) {
  const g = new LinearGradient();
  g.locations = [0, 1];
  const stops =
    feels < 32 ? ["#3a5ba0", "#1e2f5c"] :
    feels < 50 ? ["#4a7bb7", "#2b4a7a"] :
    feels < 65 ? ["#4f9a94", "#2e6460"] :
    feels < 80 ? ["#e0a03a", "#b8672a"] :
                 ["#e0603a", "#a8322a"];
  const gray = ["#6b7480", "#3d444d"];
  const t = Math.min(1, Math.max(0, (cloudCover - 20) / 80)) * 0.75;
  g.colors = stops.map((c, i) => new Color(mixHex(c, gray[i], t)));
  return g;
}

function skyEmoji(day) {
  if (day.storms) return "⛈️";
  if (day.snow) return "🌨️";
  if (day.pop >= 50) return "🌧️";
  if (day.cloudCover >= 85) return "☁️";
  if (day.cloudCover >= 60) return "🌥️";
  if (day.pop >= 30) return "🌦️";
  if (day.cloudCover >= 35) return "⛅";
  if (day.cloudCover >= 15) return "🌤️";
  return "☀️";
}

function addText(parent, str, font, color = WHITE, lines = 1) {
  const t = parent.addText(str);
  t.font = font;
  t.textColor = color;
  t.lineLimit = lines;
  t.minimumScaleFactor = 0.7;
  return t;
}

// Each outfit piece gets its own line so nothing has to share space and get cut off.
function outfitLines(outfit) {
  return [outfit.top, outfit.bottom, outfit.shoes, outfit.outer].filter(Boolean);
}

function timeText(ms) {
  const d = new Date(ms);
  const h = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")}${d.getHours() < 12 ? "am" : "pm"}`;
}

// e.g. "Denver · 4:12pm", "Westminster (last known) · 4:12pm", "Denver · offline since 1:05pm"
function statusText(forecast) {
  const city = (forecast.place || "").split(",")[0];
  const where = forecast.locationSource === "cached" ? `${city} (last known)` : city;
  const when = forecast.stale ? `offline since ${timeText(forecast.savedAt)}` : timeText(forecast.savedAt || Date.now());
  return `${where} · ${when}`;
}

function hourLabel(h) {
  if (h === 0) return "12a";
  if (h === 12) return "12p";
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

function buildWidget(forecast, day, family) {
  const outfit = chooseOutfit(day);
  const tips = [...(outfit.tips || []), outfit.tip].filter(Boolean);
  const w = new ListWidget();
  w.refreshAfterDate = new Date(Date.now() + 60 * 60 * 1000);

  // Lock screen widgets: plain text, no background.
  if (family === "accessoryInline") {
    w.addText(`${outfit.emojis} ${day.high}° ${outfit.outer || outfit.top}`);
    return w;
  }
  if (family === "accessoryRectangular") {
    addText(w, `${skyEmoji(day)} ${day.label} ${day.low}–${day.high}°`, Font.semiboldSystemFont(12)).minimumScaleFactor = 0.5;
    for (const line of outfitLines(outfit).slice(0, 3)) {
      addText(w, line, Font.systemFont(11)).minimumScaleFactor = 0.5;
    }
    return w;
  }
  if (family === "accessoryCircular") {
    w.addSpacer();
    const t = addText(w, outfit.emojis.slice(0, 2), Font.systemFont(18));
    t.centerAlignText();
    const d = addText(w, `${day.high}°`, Font.semiboldSystemFont(12));
    d.centerAlignText();
    w.addSpacer();
    return w;
  }

  w.backgroundGradient = backgroundFor((day.feelsHigh + day.feelsLow) / 2, day.cloudCover);
  w.setPadding(12, 14, 12, 14);

  const rain = day.pop >= 20 ? `  💧${day.pop}%` : "";
  const header = `${skyEmoji(day)} ${day.label} · ${day.low}°–${day.high}°${rain}`;

  if (family === "small") {
    addText(w, header, Font.mediumSystemFont(11), SOFT);
    w.addSpacer(2);
    addText(w, outfit.emojis, Font.systemFont(18)).minimumScaleFactor = 0.5;
    w.addSpacer(4);
    for (const line of outfitLines(outfit)) addText(w, line, Font.semiboldSystemFont(11), WHITE, 2);
    w.addSpacer();
    if (forecast.stale || forecast.locationSource === "cached") {
      addText(w, statusText(forecast), Font.systemFont(8), SOFT);
    }
    return w;
  }

  // Medium and large: header row with the town and update time on the right.
  const top = w.addStack();
  top.layoutHorizontally();
  addText(top, header, Font.mediumSystemFont(11), SOFT);
  top.addSpacer();
  addText(top, statusText(forecast), Font.systemFont(10), SOFT);
  w.addSpacer(4);

  const vibe = w.addStack();
  vibe.layoutHorizontally();
  vibe.centerAlignContent();
  addText(vibe, outfit.emojis, Font.systemFont(family === "large" ? 30 : 20)).minimumScaleFactor = 0.5;
  vibe.addSpacer(8);
  addText(vibe, outfit.headline, Font.boldSystemFont(family === "large" ? 16 : 13), WHITE, 1);
  vibe.addSpacer();
  w.addSpacer(family === "large" ? 10 : 4);

  const size = family === "large" ? 15 : 13;
  for (const line of outfitLines(outfit)) addText(w, line, Font.semiboldSystemFont(size), WHITE, 2);
  const extras = outfit.extras.map(x => x.t).join(" · ");

  if (family === "large") {
    if (extras) { w.addSpacer(4); addText(w, extras, Font.systemFont(13), SOFT, 2); }
    w.addSpacer(10);
    for (const t of tips) { addText(w, t, Font.systemFont(13), SOFT, 3); w.addSpacer(4); }
    w.addSpacer();
    addText(w, day.mainSky, Font.mediumSystemFont(12), SOFT);
    w.addSpacer(4);
    const strip = w.addStack();
    strip.layoutHorizontally();
    const picks = day.rows.filter((r, i) => i % 3 === 0).slice(0, 6);
    for (const r of picks) {
      const c = strip.addStack();
      c.layoutVertically();
      c.centerAlignContent();
      addText(c, hourLabel(r.hour), Font.mediumSystemFont(12), SOFT);
      addText(c, `${Math.round(r.temp)}°`, Font.boldSystemFont(16));
      addText(c, r.pop >= 20 ? `💧${r.pop}%` : " ", Font.systemFont(10), SOFT);
      strip.addSpacer();
    }
  } else {
    // Medium only has room for a short extras/tips line; the large widget shows every tip in full.
    const notes = [extras, ...tips].filter(Boolean).join(" · ");
    if (notes) { w.addSpacer(3); addText(w, notes, Font.systemFont(10), SOFT, 2).minimumScaleFactor = 0.6; }
    w.addSpacer();
  }
  return w;
}

function errorWidget(message) {
  const w = new ListWidget();
  w.backgroundColor = new Color("#3a3a3c");
  w.setPadding(14, 14, 14, 14);
  addText(w, "DigitalDresser", Font.boldSystemFont(13));
  w.addSpacer(6);
  addText(w, message, Font.systemFont(11), SOFT, 5);
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  return w;
}

// ---------- Run ----------

let widget;
try {
  const forecast = await loadForecast();
  const day = summarizeDay(forecast.periods, forecast.skyCover);
  const workout = await checkMorningWorkout(day);
  day.gymMorning = workout.gym;
  day.gymSource = workout.source;
  widget = buildWidget(forecast, day, config.widgetFamily || "medium");
} catch (err) {
  widget = errorWidget(err.message);
}

if (config.runsInWidget || config.runsInAccessoryWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
