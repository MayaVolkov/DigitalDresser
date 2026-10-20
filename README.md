# DigitalDresser

An iPhone home-screen widget that reads today's weather forecast and tells me what to wear, based on my own outfit rules.

It runs in [Scriptable](https://scriptable.app) (free, JavaScript) and uses the National Weather Service's free [api.weather.gov](https://www.weather.gov/documentation/services-web-api) hourly forecast, so it works anywhere in the US and needs no API key.

## What it shows

- An outfit (top, bottom, shoes, outer layer) picked from the day's feels-like temperatures, clouds, rain, snow and wind
- Extras like an umbrella or scarf
- Tips, for example:
  - "Heads up, it might rain starting at 3pm until 6pm…"
  - what to wear for a morning workout
  - a jacket reminder for going out Thursday through Saturday
- An emoji row that matches the day's vibe

It looks at the hours you're likely to be out (7am–9pm). In the evening it switches to tomorrow's outfit: after 7pm, or after 9pm on Thursday through Saturday.

## Files

| File | What it is |
|---|---|
| `DigitalDresser.js` | The widget. The outfit rules live in `chooseOutfit()` |
| `dresserRules.txt` | The rules in plain English |
| `testRun.mjs` | Runs the widget on a Mac with Node, using live weather or a made-up day |

## Install on your iPhone

1. Install **Scriptable** from the App Store and open it once, with iCloud Drive on.
2. Copy `DigitalDresser.js` into **iCloud Drive → Scriptable** on your Mac. Or create a new script in Scriptable and paste in the code.
3. Run it once in Scriptable and allow location access ("While Using the App or Widgets").
4. Add a Scriptable widget to your home screen (small, medium, large or lock screen), then edit it and pick **DigitalDresser** as the script.

To use a fixed location instead of GPS, set the widget's **Parameter** to `lat,lon`, e.g. `39.7392,-104.9903`.

## Make it yours

Everything about *what to wear* is in `chooseOutfit(day)` in `DigitalDresser.js`. The comment above it lists everything `day` contains, such as `feelsHigh`, `feelsLow`, `pop` (chance of rain), `cloudy`, `snow`, `rows` (hour by hour) and `rainWindow`. It also lists what the function should return. Swap in your own rules and leave the rest as is.

Also change `USER_AGENT` near the top to your own contact info. The weather service asks every app to identify itself.

## Test on a Mac

Requires [Node.js](https://nodejs.org).

```sh
node testRun.mjs              # live weather (set LIVE_LOCATION in the file)
node testRun.mjs fake         # a made-up day (edit FAKE_DAY in the file)
node testRun.mjs fake large   # pick the widget size: small, medium, large
```
