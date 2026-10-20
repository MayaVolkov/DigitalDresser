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

// Everyone runs hot or cold differently. Positive = you run cold
// (treats the weather as this many degrees colder than it is).
const COLD_BIAS_F = 0;

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

async function getCoordinates() {
  const param = (args.widgetParameter || "").trim();
  if (param) {
    const [lat, lon] = param.split(",").map(Number);
    if (isFinite(lat) && isFinite(lon)) return { lat, lon };
  }
  try {
    Location.setAccuracyToThreeKilometers();
    // Location can hang inside widgets, so don't wait forever.
    const loc = await Promise.race([
      Location.current(),
      new Promise((_, reject) => Timer.schedule(10000, false, () => reject(new Error("timeout")))),
    ]);
    const coords = { lat: loc.latitude, lon: loc.longitude };
    writeCache("coords.json", coords);
    return coords;
  } catch (e) {
    const cached = readCache("coords.json");
    if (cached) return cached;
    throw new Error("Couldn't get your location. Allow Scriptable location access, or set the widget parameter to \"lat,lon\".");
  }
}

async function getHourlyForecast({ lat, lon }) {
  // /points tells us which NWS grid square we're in. It rarely changes, so cache it.
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  let point = readCache("point.json");
  if (!point || point.key !== key) {
    const json = await getJSON(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
    const rel = json.properties.relativeLocation.properties;
    point = { key, hourlyUrl: json.properties.forecastHourly, place: `${rel.city}, ${rel.state}` };
    writeCache("point.json", point);
  }
  const json = await getJSON(point.hourlyUrl);
  return { place: point.place, periods: json.properties.periods };
}

async function loadForecast() {
  try {
    const coords = await getCoordinates();
    const forecast = await getHourlyForecast(coords);
    writeCache("forecast.json", { savedAt: Date.now(), ...forecast });
    return { ...forecast, stale: false };
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

function summarizeDay(periods) {
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
    return {
      hour: hourOf(p),
      temp,
      feels: feelsLike(temp, wind, rh) - COLD_BIAS_F,
      pop: (p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value) || 0,
      wind,
      sky: p.shortForecast || "",
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

  return {
    label,
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
    sunny: rows.filter(r => r.isDaytime && /sunny|clear/i.test(r.sky)).length >= Math.max(2, rows.length / 3),
    mainSky: mostCommon(rows.map(r => r.sky)),
    cloudy: /cloudy|overcast/i.test(mostCommon(rows.map(r => r.sky))) && !/partly/i.test(mostCommon(rows.map(r => r.sky))),
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
// What `day` contains (temperatures in °F, "feels" includes wind chill / heat index):
//   day.label       "Today" or "Tomorrow" (switches after 7pm)
//   day.high        warmest temp            day.low        coldest temp
//   day.feelsHigh   warmest feels-like      day.feelsLow   coldest feels-like
//   day.pop         highest chance of rain/snow, 0-100
//   day.wind        strongest wind, mph
//   day.snow        true if snow/sleet/ice is mentioned
//   day.storms      true if thunderstorms are mentioned
//   day.sunny       true if a good chunk of the day is sunny/clear
//   day.mainSky     most common description, e.g. "Partly Cloudy"
//   day.rows        hour by hour: [{ hour: 7, temp, feels, pop, wind, sky, isDaytime }, ...]
//   day.evening     same as rows, but for 8pm-midnight (going out)
//   day.weekday     "Monday", "Tuesday", ...
//   day.cloudy      true if it's mostly "Cloudy" or "Mostly Cloudy" (not "Partly Cloudy")
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
    outfit.top = "t-shirt or tank top, and a zip up"
    outfit.bottom = "jeans"
    outfit.shoes = "sneakers or clogs"
    outfit.emojis = "🍂☀️🧥☕👟"
  }

// Base outfit D conditions
  else if((day.feelsLow <= 50) && (day.feelsHigh >= 56 && day.feelsHigh <= 71)){
    outfit.top = "tank top or t-shirt"
    outfit.bottom = "jeans or leggings"
    outfit.shoes = "sneakers"
    outfit.tips.push("grab a zip up for the morning")
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
if (nineAM && nineAM.feels < 50) {
  outfit.tips.push("add sweatpants and hoodie for your workout in the morning");
} else if (nineAM && nineAM.feels >= 50 && nineAM.feels <= 70) {
  outfit.tips.push("add hoodie for your workout in the morning");
}
//going out 
//1. two checks
if(["Thursday", "Friday", "Saturday"].includes(day.weekday) && day.evening.length > 0 && (day.evening.every(r => r.feels <= 50))){
  outfit.tips.push("bring a jacket when you go out!")
}

  return outfit;
}

// ---------- Drawing the widget ----------

const WHITE = Color.white();
const SOFT = new Color("#ffffff", 0.75);

function backgroundFor(feels) {
  const g = new LinearGradient();
  g.locations = [0, 1];
  const stops =
    feels < 32 ? ["#3a5ba0", "#1e2f5c"] :
    feels < 50 ? ["#4a7bb7", "#2b4a7a"] :
    feels < 65 ? ["#4f9a94", "#2e6460"] :
    feels < 80 ? ["#e0a03a", "#b8672a"] :
                 ["#e0603a", "#a8322a"];
  g.colors = stops.map(c => new Color(c));
  return g;
}

function addText(parent, str, font, color = WHITE, lines = 1) {
  const t = parent.addText(str);
  t.font = font;
  t.textColor = color;
  t.lineLimit = lines;
  t.minimumScaleFactor = 0.7;
  return t;
}

function hourLabel(h) {
  if (h === 0) return "12a";
  if (h === 12) return "12p";
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

function buildWidget(forecast, family) {
  const day = summarizeDay(forecast.periods);
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
    addText(w, `${day.label} ${day.low}–${day.high}°`, Font.semiboldSystemFont(13));
    addText(w, outfit.emojis, Font.systemFont(14));
    addText(w, outfit.outer || outfit.top, Font.systemFont(12));
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

  w.backgroundGradient = backgroundFor((day.feelsHigh + day.feelsLow) / 2);
  w.setPadding(14, 14, 14, 14);

  const rain = day.pop >= 20 ? `  💧${day.pop}%` : "";
  const header = `${day.label} · ${day.low}°–${day.high}°${rain}`;

  if (family === "small") {
    addText(w, header, Font.mediumSystemFont(11), SOFT);
    w.addSpacer(4);
    addText(w, outfit.headline, Font.boldSystemFont(15), WHITE, 2);
    w.addSpacer(6);
    addText(w, outfit.emojis, Font.systemFont(24));
    w.addSpacer();
    addText(w, outfit.outer ? `${outfit.top} + ${outfit.outer.toLowerCase()}` : outfit.top, Font.systemFont(11), SOFT, 2);
  } else {
    addText(w, `${header}  ·  ${forecast.place}`, Font.mediumSystemFont(12), SOFT);
    w.addSpacer(4);
    addText(w, outfit.headline, Font.boldSystemFont(18));
    w.addSpacer(8);

    const row = w.addStack();
    row.layoutHorizontally();
    row.topAlignContent();
    addText(row, outfit.emojis, Font.systemFont(30), WHITE, 2).minimumScaleFactor = 0.5;
    row.addSpacer(12);
    const col = row.addStack();
    col.layoutVertically();
    addText(col, [outfit.top, outfit.bottom].filter(Boolean).join(" · "), Font.semiboldSystemFont(13));
    const layers = [outfit.outer, outfit.shoes].filter(Boolean).join(" · ");
    if (layers) addText(col, layers, Font.semiboldSystemFont(13));
    if (outfit.extras.length) addText(col, outfit.extras.map(x => x.t).join(" · "), Font.systemFont(12), SOFT, 2);
    row.addSpacer();

    if (family === "large") {
      w.addSpacer(12);
      for (const t of tips) { addText(w, t, Font.systemFont(13), SOFT, 2); w.addSpacer(4); }
      if (tips.length) w.addSpacer(6);
      addText(w, day.mainSky, Font.mediumSystemFont(13), SOFT);
      w.addSpacer(6);
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
    } else if (tips.length) {
      w.addSpacer(6);
      addText(w, tips.join(" · "), Font.systemFont(11), SOFT, 2);
    }
    w.addSpacer();
  }

  if (forecast.stale) {
    addText(w, "Offline: showing last saved forecast", Font.systemFont(9), SOFT);
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
  widget = buildWidget(forecast, config.widgetFamily || "medium");
} catch (err) {
  widget = errorWidget(err.message);
}

if (config.runsInWidget || config.runsInAccessoryWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
