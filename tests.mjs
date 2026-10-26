// Scenario tests for DigitalDresser.
//
//   node tests.mjs
//
// Each test runs the real widget on a made-up day (through testRun.mjs)
// and checks the outfit, tips, and widget text.

import { execFileSync } from "child_process";

const BASE_DAY = { date: "2026-10-22", low: 40, high: 60, sky: "Sunny", rain: null, wind: 0, humidity: 40 };

function run(dayChanges, { gym = null, size = "medium" } = {}) {
  const out = execFileSync("node", ["testRun.mjs", "fake", size, "--json"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: {
      ...process.env,
      FAKE_DAY_JSON: JSON.stringify({ ...BASE_DAY, ...dayChanges }),
      FAKE_GYM_JSON: JSON.stringify(gym),
    },
    encoding: "utf8",
  });
  const json = out.split("@@JSON")[1];
  if (!json) throw new Error("widget didn't build:\n" + out.trim());
  return JSON.parse(json);
}

const tips = r => r.outfit.tips.join(" | ").toLowerCase();

const tests = [
  // ---------- 45-53° feels-like bracket ----------
  ["45-53 gives a sweat set", () => {
    const r = run({ low: 45, high: 53 });
    return r.outfit.top === "crewneck or hoodie" && r.outfit.bottom === "sweatpants" && r.outfit.shoes === "sneakers";
  }],
  ["45-53 on a cloudy day also gives a sweat set", () => {
    const r = run({ low: 45, high: 53, sky: "Cloudy" });
    return r.outfit.bottom === "sweatpants";
  }],
  ["45-53 Thursday with a cold evening keeps the going-out jacket tip", () => {
    const r = run({ low: 45, high: 53, date: "2026-10-22" });
    return tips(r).includes("jacket when you go out");
  }],

  // ---------- Overcast ----------
  ["overcast 70° is marked overcast with a cloud icon", () => {
    const r = run({ low: 62, high: 72, sky: "Cloudy" });
    return r.day.overcast === true && r.lines.some(l => l.includes("☁️ Today"));
  }],
  ["overcast 70° has no flip flops", () => {
    const r = run({ low: 62, high: 72, sky: "Cloudy" });
    return !r.outfit.shoes.includes("flip");
  }],
  ["overcast hot day has no flip flops", () => {
    const r = run({ low: 75, high: 95, sky: "Cloudy" });
    return !r.outfit.shoes.includes("flip");
  }],
  ["overcast day has no sun in the emojis", () => {
    const r = run({ low: 62, high: 72, sky: "Cloudy" });
    return !/☀️|🌞/.test(r.outfit.emojis);
  }],
  ["sunny 70° still allows flip flops", () => {
    const r = run({ low: 62, high: 72, sky: "Sunny" });
    return r.outfit.shoes.includes("flip");
  }],

  // ---------- Morning tips and the Gym calendar ----------
  ["Gym at 8am: workout tip, no zip-up tip", () => {
    const r = run({ low: 40, high: 65 }, { gym: 8 });
    return tips(r).includes("workout") && !tips(r).includes("zip up");
  }],
  ["no Gym event: zip-up tip, no workout tip", () => {
    const r = run({ low: 40, high: 65 }, { gym: null });
    return tips(r).includes("zip up") && !tips(r).includes("workout");
  }],
  ["Gym at 11am doesn't count as a morning workout", () => {
    const r = run({ low: 40, high: 65 }, { gym: 11 });
    return r.day.gymMorning === false;
  }],
  ["calendar error on a Monday falls back to a gym day", () => {
    const r = run({ date: "2026-10-26" }, { gym: "error" });
    return r.day.gymMorning === true && r.day.gymSource === "usual days";
  }],
  ["calendar error on a Thursday falls back to no gym", () => {
    const r = run({ date: "2026-10-22" }, { gym: "error" });
    return r.day.gymMorning === false;
  }],

  // ---------- Layout and existing rules ----------
  ["each outfit piece gets its own widget line", () => {
    const r = run({ low: 40, high: 65 });
    return [r.outfit.top, r.outfit.bottom, r.outfit.shoes].filter(Boolean).every(p => r.lines.includes(p));
  }],
  ["freezing day gives a coat", () => {
    const r = run({ low: 10, high: 25 });
    return r.outfit.outer === "coat";
  }],
  ["3 hours of rain gives the heads-up with times", () => {
    const r = run({ rain: { from: 14, to: 17, chance: 70 } });
    return tips(r).includes("starting at 2pm until 5pm");
  }],
];

let passed = 0;
for (const [name, test] of tests) {
  let ok = false, error = "";
  try { ok = test(); } catch (e) { error = e.message.split("\n").slice(0, 3).join(" "); }
  if (ok) passed++;
  console.log(`${ok ? "✅" : "❌"} ${name}${error ? `  (${error})` : ""}`);
}
console.log(`\n${passed}/${tests.length} passed`);
process.exitCode = passed === tests.length ? 0 : 1;
