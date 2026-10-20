// Test DigitalDresser.js on your Mac, without your phone.
//
//   node testRun.mjs          real NOAA weather for LIVE_LOCATION
//   node testRun.mjs fake     the made-up day in FAKE_DAY below
//
// Add "small", "medium", or "large" at the end to pick a widget size,
// e.g.  node testRun.mjs fake large

import fs from "fs";
import os from "os";
import path from "path";

// ---------- Edit these ----------

const LIVE_LOCATION = { lat: 39.7392, lon: -104.9903 }; // Denver

// A made-up day for testing your rules. Temperatures rise from `low`
// at 6am to `high` at 3pm, then cool off in the evening.
const FAKE_DAY = {
  date: "2026-10-22",        // pick a date to test weekday rules (this one is a Thursday)
  low: 28,
  high: 45,
  sky: "Cloudy",             // e.g. "Sunny", "Mostly Cloudy", "Light Snow", "Chance Showers And Thunderstorms"
  rain: { from: 14, to: 17, chance: 70 }, // rain from 2pm to 5pm; use null for a dry day
  wind: 0,                   // mph. Above 3 makes cold days feel colder (wind chill)
  humidity: 40,
};

// ---------- Test plumbing (no need to edit) ----------

const [mode, size = "medium"] = process.argv[2] === "fake" ? ["fake", process.argv[3]] : ["live", process.argv[2]];

function fakePeriods(d) {
  const periods = [];
  for (let h = 6; h <= 23; h++) {
    const temp = h <= 15
      ? d.low + (d.high - d.low) * (h - 6) / 9
      : d.high - (d.high - d.low) * 0.7 * (h - 15) / 8;
    const raining = d.rain && h >= d.rain.from && h < d.rain.to;
    periods.push({
      startTime: `${d.date}T${String(h).padStart(2, "0")}:00:00-06:00`,
      isDaytime: h >= 6 && h < 18,
      temperature: Math.round(temp),
      temperatureUnit: "F",
      probabilityOfPrecipitation: { value: raining ? d.rain.chance : 0 },
      relativeHumidity: { value: d.humidity },
      windSpeed: `${d.wind} mph`,
      shortForecast: raining && !/rain|shower|snow|thunder/i.test(d.sky) ? "Rain" : d.sky,
    });
  }
  return periods;
}

const lines = [];
class FakeText { centerAlignText() {} }
class FakeStack {
  constructor(depth) { this.depth = depth; }
  addText(s) { lines.push("  ".repeat(this.depth) + s); return new FakeText(); }
  addStack() { return new FakeStack(this.depth + 1); }
  addSpacer() {} layoutHorizontally() {} layoutVertically() {}
  topAlignContent() {} centerAlignContent() {} setPadding() {}
}

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "digitaldresser-"));
Object.assign(globalThis, {
  ListWidget: class extends FakeStack { constructor() { super(0); } async presentMedium() {} },
  LinearGradient: class {},
  Color: class { static white() { return {}; } },
  Font: new Proxy({}, { get: () => () => ({}) }),
  Location: { setAccuracyToThreeKilometers() {}, async current() { return { latitude: LIVE_LOCATION.lat, longitude: LIVE_LOCATION.lon }; } },
  Timer: { schedule: (ms, repeat, fn) => setTimeout(fn, ms).unref() },
  FileManager: { local: () => ({
    cacheDirectory: () => cacheDir, joinPath: path.join, fileExists: fs.existsSync,
    createDirectory: p => fs.mkdirSync(p, { recursive: true }),
    readString: p => fs.readFileSync(p, "utf8"), writeString: (p, s) => fs.writeFileSync(p, s),
  }) },
  Request: class {
    constructor(url) { this.url = url; }
    async loadJSON() {
      if (mode === "fake") {
        this.response = { statusCode: 200 };
        return this.url.includes("/points/")
          ? { properties: { forecastHourly: "fake", relativeLocation: { properties: { city: "Fake Town", state: "CO" } } } }
          : { properties: { periods: fakePeriods(FAKE_DAY) } };
      }
      const res = await fetch(this.url, { headers: this.headers });
      this.response = { statusCode: res.status };
      return res.json();
    }
  },
  args: { widgetParameter: null },
  config: { runsInWidget: true, widgetFamily: size },
  Script: { setWidget() {}, complete() {} },
});

// Run the real script, and peek at `day` and `outfit` on the way through.
let src = fs.readFileSync(new URL("./DigitalDresser.js", import.meta.url), "utf8");
src = src.replace("const outfit = chooseOutfit(day);", "const outfit = chooseOutfit(day); globalThis.__day = day; globalThis.__outfit = outfit;");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
await new AsyncFunction(src)();

const day = globalThis.__day, outfit = globalThis.__outfit;
if (day) {
  const { rows, evening, ...summary } = day;
  console.log("\n=== day ===");
  console.log(summary);
  console.log("hours:", rows.map(r => `${r.hour}:${Math.round(r.feels)}°${r.pop ? "/" + r.pop + "%" : ""}`).join("  "));
  console.log("evening:", evening.map(r => `${r.hour}:${Math.round(r.feels)}°`).join("  "));
  console.log("\n=== outfit ===");
  console.log(outfit);
}
console.log(`\n=== ${size} widget ===`);
console.log(lines.join("\n"));
