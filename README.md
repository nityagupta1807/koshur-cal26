# Kashmiri Calendar

A mobile-first Kashmiri lunar calendar app. It computes **panchang** (tithi, paksha, lunar month) astronomically for any date, shows **sunrise/sunset** for Srinagar, lists **Kashmiri Pandit festivals**, and lets you set **reminders** by either Gregorian date or tithi.

## Features

- **Accurate panchang engine** — tithi, paksha, and Amanta lunar month computed from solar/lunar positions (Meeus algorithms), evaluated at Kashmir sunrise per the sunrise-vyapini convention. Handles Adhik Maas (leap months) automatically with proper Adhik/Nija labeling.
- **Sunrise & sunset** for Srinagar (NOAA solar-geometry algorithm).
- **Kashmiri Pandit festivals** — 20 festivals encoded as panchang rules, so they land on the correct Gregorian date every year automatically. A "Festivals in [month]" card lists everything coming up.
- **Day / Week / Month views** with a soft dawn-gradient theme and floating cards.
- **Light & dark themes** — Sun/Moon toggle in the app bar; preference persists across sessions.
- **Animated splash screen** — chinar-leaf logo and "Koshur" wordmark on load.
- **Search** — find tithis, dates, festivals, reminders, lunar months, or full panchang phrases (e.g. "Jyeshtha Krishna Paksha Dwadashi") with live incremental results and typo tolerance.
- **Reminders** — set by calendar date or by tithi (recurs yearly with the lunar calendar), with notification lead-times. Persisted in the browser via `localStorage`.

## Getting started

Requires [Node.js](https://nodejs.org/) 18 or newer.

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## Build for production

```bash
npm run build      # outputs to dist/
npm run preview    # preview the production build locally
```

## Project structure

```
index.html                  # entry HTML
src/main.jsx                # React bootstrap + localStorage storage shim
src/KashmiriCalendar.jsx    # the entire app (engine + UI) in one file
vite.config.js              # Vite + React plugin config
```

## Notes & known limitations

- The astronomy is a compact, self-contained ephemeris (arc-minute-level for the Sun, sub-degree for the Moon). It is validated against a published 2026 Maharashtra panchang. On days where a tithi changes within an hour or two of sunrise it can occasionally differ by one tithi at the boundary — the same ambiguity published panchangs show by printing two tithis on such days.
- **Ganesh Chaturthi** uses a special midday-tithi rule in tradition; this app matches it to the sunrise tithi like every other festival, so it may show one day off from some printed calendars.
- **Reminder notifications** are stored as a preference, not delivered as OS push notifications — that would require a backend or service worker.
- **Font:** the UI loads Google Sans via Google's font CDN (`fonts.googleapis.com/css2?family=Google+Sans...`), falling back to Inter, then system sans-serif. Note Google Sans is not a published/documented Google Fonts family (no public specimen page or open license like Inter's) — it's reachable at that endpoint today but could change or disappear without notice, so the Inter fallback is load-bearing, not decorative.

- **npm audit warnings:** `npm install` may report a couple of advisories in Vite/esbuild. These affect only the local dev server, are common to essentially every Vite project, and don't impact the production build. Don't run `npm audit fix --force` — it forces a major Vite upgrade that can break the build.

## License

Internal / team use.
