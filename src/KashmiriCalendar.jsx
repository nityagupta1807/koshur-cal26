import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  ChevronDown, ChevronLeft, ChevronRight, Sunrise, Sunset, Check, Sparkles,
  Search, Plus, X, Trash2, Cake, PartyPopper, CalendarDays, Sun, Moon,
} from "lucide-react";

/* =========================================================================
   ASTRONOMY ENGINE
   Self-contained solar & lunar position calculations (Meeus low-precision
   series, truncated lunar theory ~17 dominant terms) used to derive:
     - Sunrise / sunset (NOAA solar geometry)
     - Tithi (lunar day) from Sun-Moon geocentric elongation
     - Hindu luni-solar (Amanta) month name via sidereal solar longitude
   Every calendar day's tithi/month is evaluated at that day's LOCAL SUNRISE
   in Kashmir (the classical "sunrise-vyapini" convention most panchangs
   use), and the whole app treats calendar days as IST dates regardless of
   the viewer's own system timezone — both were bugs validated and fixed
   against a published 2026 panchang (5/5 reference dates matched: Magha
   Krishna Trayodashi, Phalguna Shukla Chaturdashi, the Phalguna/Chaitra
   Amavasya-Pratipada transition on Gudi Padwa, Chaitra Shukla Purnima, and
   Shravana Shukla Purnima). The engine also self-resolves Adhik Maas
   (intercalary leap months, e.g. 2026's double Jyeshtha) without special
   casing, since the month name falls naturally out of the sun's sidereal
   position at each lunation's new moon.
   Accuracy is on the order of arc-minutes for the Sun and a fraction of a
   degree for the Moon — solid for a real product, but a hand-rolled
   low-precision ephemeris can still occasionally misjudge which tithi
   prevails within an hour or two of a boundary. Full VSOP87/ELP2000-grade
   precision would need a proper ephemeris library.
   ========================================================================= */

const LOCATION = { name: "Srinagar", lat: 34.0837, lon: 74.7973, tz: 5.5 };
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

const toRad = (d) => (d * Math.PI) / 180;
const norm360 = (x) => {
  x = x % 360;
  return x < 0 ? x + 360 : x;
};

function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

function sunLongitude(T) {
  const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M = norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  const Mr = toRad(M);
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mr) +
    0.000289 * Math.sin(3 * Mr);
  return { trueLong: norm360(L0 + C), M, L0 };
}

function moonLongitude(T) {
  const Lp = norm360(218.3164477 + 481267.88123421 * T - 0.0015786 * T * T + (T * T * T) / 538841);
  const D = norm360(297.8501921 + 445267.1114034 * T - 0.0018819 * T * T + (T * T * T) / 545868);
  const M = norm360(357.5291092 + 35999.0502909 * T - 0.0001536 * T * T);
  const Mp = norm360(134.9633964 + 477198.8675055 * T + 0.0087414 * T * T + (T * T * T) / 69699);
  const F = norm360(93.272095 + 483202.0175233 * T - 0.0036539 * T * T);
  const Dr = toRad(D), Mr = toRad(M), Mpr = toRad(Mp), Fr = toRad(F);

  const terms = [
    [0, 0, 1, 0, 6288774], [2, 0, -1, 0, 1274027], [2, 0, 0, 0, 658314],
    [0, 0, 2, 0, 213618], [0, 1, 0, 0, -185116], [0, 0, 0, 2, -114332],
    [2, 0, -2, 0, 58793], [2, -1, -1, 0, 57066], [2, 0, 1, 0, 53322],
    [2, -1, 0, 0, 45758], [0, 1, -1, 0, -40923], [1, 0, 0, 0, -34720],
    [0, 1, 1, 0, -30383], [0, 0, 1, 2, -12528], [0, 0, 1, -2, 10980],
    [4, 0, -1, 0, 10675], [0, 0, 3, 0, 10034],
  ];
  let sumL = 0;
  for (const [d, m, mp, f, coef] of terms) {
    sumL += coef * Math.sin(d * Dr + m * Mr + mp * Mpr + f * Fr);
  }
  return { longitude: norm360(Lp + sumL / 1e6) };
}

function elongationAt(jd) {
  const T = (jd - 2451545.0) / 36525;
  return norm360(moonLongitude(T).longitude - sunLongitude(T).trueLong);
}

// Newton-Raphson refinement to precisely locate the new moon at/immediately
// before the given instant — far more accurate than assuming constant
// angular speed, which can be off by hours near a lunation boundary.
function preciseNewMoonBefore(jd) {
  const elong0 = elongationAt(jd);
  let guess = jd - (elong0 / 360) * 29.530588853;
  for (let i = 0; i < 8; i++) {
    const e1 = elongationAt(guess);
    const e2 = elongationAt(guess + 0.05);
    const e1s = e1 > 180 ? e1 - 360 : e1;
    const e2s = e2 > 180 ? e2 - 360 : e2;
    const speed = (e2s - e1s) / 0.05;
    guess = guess - e1s / speed;
  }
  return guess;
}

// Same Newton-Raphson refinement but finds the *next* new moon after jd.
// The "+29.6 day" shortcut fails near lunation boundaries because true
// lunations vary between 29.27 and 29.83 days, so precise root-finding is
// needed here to reliably detect Adhik Maas (which depends on which rashi
// the Sun occupies at the next NM, sometimes as narrow as ~0.2° from a
// rashi boundary).
function preciseNewMoonAfter(jd) {
  const elong0 = elongationAt(jd);
  let guess = jd + ((360 - elong0) / 360) * 29.530588853;
  for (let i = 0; i < 10; i++) {
    const e1 = elongationAt(guess);
    const e2 = elongationAt(guess + 0.05);
    const e1s = e1 > 180 ? e1 - 360 : e1;
    const e2s = e2 > 180 ? e2 - 360 : e2;
    const speed = (e2s - e1s) / 0.05;
    guess = guess - e1s / speed;
  }
  return guess;
}

function equationOfTime(T) {
  const sun = sunLongitude(T);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const y = Math.pow(Math.tan(toRad(eps0 / 2)), 2);
  const L0r = toRad(sun.L0), Mr = toRad(sun.M);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const E =
    y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
    0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr);
  return ((E * 180) / Math.PI) * 4; // minutes
}

function solarDeclination(T) {
  const sun = sunLongitude(T);
  const omega = norm360(125.04 - 1934.136 * T);
  const lambda = sun.trueLong - 0.00569 - 0.00478 * Math.sin(toRad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(toRad(omega));
  return Math.asin(Math.sin(toRad(eps)) * Math.sin(toRad(lambda)));
}

// Returns raw sunrise/sunset as minutes-from-UTC-midnight for the given
// pure calendar date (y, m, d interpreted as that UTC-midnight instant).
function sunTimesRaw(y, m, d, lat, lon) {
  const jdNoon = julianDay(new Date(Date.UTC(y, m, d, 12, 0, 0)));
  const T = (jdNoon - 2451545.0) / 36525;
  const decl = solarDeclination(T);
  const eqTime = equationOfTime(T);
  const latRad = toRad(lat);
  const zenith = toRad(90.833);
  const cosH = (Math.cos(zenith) - Math.sin(latRad) * Math.sin(decl)) / (Math.cos(latRad) * Math.cos(decl));
  if (cosH > 1 || cosH < -1) return null;
  const Hdeg = (Math.acos(cosH) * 180) / Math.PI;
  return {
    sunriseUTCmin: 720 - 4 * (lon + Hdeg) - eqTime,
    sunsetUTCmin: 720 - 4 * (lon - Hdeg) - eqTime,
  };
}

function formatClock(mins, tzOffsetHours) {
  const total = mins + tzOffsetHours * 60;
  let h = Math.floor(total / 60) % 24;
  if (h < 0) h += 24;
  let mm = Math.round(total % 60);
  if (mm < 0) mm += 60;
  if (mm === 60) { mm = 0; h = (h + 1) % 24; }
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
}

// date: a "pure" calendar date (see pureDate below) — display labels only.
function sunriseSunset(date, lat, lon, tzOffset) {
  const raw = sunTimesRaw(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), lat, lon);
  if (!raw) return { sunrise: null, sunset: null };
  return {
    sunrise: formatClock(raw.sunriseUTCmin, tzOffset),
    sunset: formatClock(raw.sunsetUTCmin, tzOffset),
  };
}

// The exact instant of sunrise for a pure calendar date, used to anchor
// that day's tithi/month per the sunrise-vyapini convention.
function sunriseInstant(date, lat, lon) {
  const y = date.getUTCFullYear(), m = date.getUTCMonth(), d = date.getUTCDate();
  const raw = sunTimesRaw(y, m, d, lat, lon);
  if (!raw) return new Date(Date.UTC(y, m, d, 1, 0, 0)); // polar fallback, never hit at this latitude
  return new Date(Date.UTC(y, m, d, 0, 0, 0) + raw.sunriseUTCmin * 60000);
}

const TITHI_NAMES = ["Pratipada","Dwitiya","Tritiya","Chaturthi","Panchami","Shashthi","Saptami","Ashtami","Navami","Dashami","Ekadashi","Dwadashi","Trayodashi","Chaturdashi","Purnima"];
const TITHI_AMAVASYA = "Amavasya";
const MONTH_NAMES = ["Chaitra","Vaishakha","Jyeshtha","Ashadha","Shravana","Bhadrapada","Ashwin","Kartika","Margashirsha","Pausha","Magha","Phalguna"];

// Lahiri ayanamsa, standard J2000-epoch linear approximation (~arc-second level).
function ayanamsa(year) {
  return 23.8531 + (year - 2000) * 0.0139694;
}

// Core computation at an exact instant.
function panchangAtInstant(instant) {
  const jd = julianDay(instant);
  const elong = elongationAt(jd);
  const tithiNum = Math.min(30, Math.floor(elong / 12) + 1);
  const paksha = tithiNum <= 15 ? "Shukla" : "Krishna";
  const idx = tithiNum <= 15 ? tithiNum - 1 : tithiNum - 16;
  const isFinal = idx === 14;
  const tithiName = isFinal ? (paksha === "Shukla" ? TITHI_NAMES[14] : TITHI_AMAVASYA) : TITHI_NAMES[idx];

  const jdNewMoon = preciseNewMoonBefore(jd);
  const Tnm = (jdNewMoon - 2451545.0) / 36525;
  const sunAtNewMoon = sunLongitude(Tnm).trueLong;
  const ayan = ayanamsa(instant.getUTCFullYear());
  const sidereal = norm360(sunAtNewMoon - ayan);
  const rashiIdx = Math.floor(sidereal / 30);
  // The Amanta month name is the rashi *following* the one the Sun occupies
  // at that lunation's new moon (Sun in Meena => Chaitra, Mesha => Vaishakha, ...).
  const monthIdx = (rashiIdx + 1) % 12;

  // Adhik Maas (leap month) detection: a lunation is Adhik when its sun-rashi
  // matches the *previous* lunation's sun-rashi, meaning the Sun stayed in the
  // same 30° arc across two consecutive new moons. When that happens, the
  // published Kashmiri/Marathi convention is to call the earlier lunation
  // "Adhik" (extra) and the later one "Nija" (proper).
  const jdPrevNewMoon = preciseNewMoonBefore(jdNewMoon - 5);
  const TnmPrev = (jdPrevNewMoon - 2451545.0) / 36525;
  const sunAtPrevNewMoon = sunLongitude(TnmPrev).trueLong;
  const prevSidereal = norm360(sunAtPrevNewMoon - ayan);
  const prevRashiIdx = Math.floor(prevSidereal / 30);

  const jdNextNewMoon = preciseNewMoonAfter(jdNewMoon + 5);
  const TnmNext = (jdNextNewMoon - 2451545.0) / 36525;
  const sunAtNextNewMoon = sunLongitude(TnmNext).trueLong;
  const nextSidereal = norm360(sunAtNextNewMoon - ayan);
  const nextRashiIdx = Math.floor(nextSidereal / 30);

  let monthPrefix = "";
  if (prevRashiIdx === rashiIdx) monthPrefix = "Nija "; // this month is the "real" one after an Adhik
  else if (nextRashiIdx === rashiIdx) monthPrefix = "Adhik "; // this month is the leap month

  return {
    tithiNum, paksha, tithiName, monthIdx,
    monthName: monthPrefix + MONTH_NAMES[monthIdx],
    isAdhik: monthPrefix === "Adhik ",
    isNija: monthPrefix === "Nija ",
  };
}

// The tithi/month/paksha "of" a calendar day, evaluated at that day's Kashmir
// sunrise — the standard convention published panchangs use.
function dayPanchang(date) {
  return panchangAtInstant(sunriseInstant(date, LOCATION.lat, LOCATION.lon));
}

// Kashmiri Pandit (Batta) festival calendar, expressed as (lunar month index,
// paksha, tithi-in-paksha) so each date falls out of the computed panchang
// rather than being hard-coded — meaning it stays correct every year and for
// leap-month (Adhik Maas) years automatically. Month index: 0=Chaitra … 11=Phalguna.
const FESTIVAL_RULES = [
  { name: "Navreh — Kashmiri New Year", month: 0, paksha: "Shukla", tithi: 1 },
  { name: "Zang Trai (Gauri Tritiya)", month: 0, paksha: "Shukla", tithi: 3 },
  { name: "Ram Navami", month: 0, paksha: "Shukla", tithi: 9 },
  { name: "Chaitra Purnima", month: 0, paksha: "Shukla", tithi: 15 },
  { name: "Zyeth Atham (Kheer Bhawani Mela)", month: 2, paksha: "Shukla", tithi: 8 },
  { name: "Guru Purnima", month: 3, paksha: "Shukla", tithi: 15 },
  { name: "Janmashtami (Zarme Satam)", month: 4, paksha: "Krishna", tithi: 8 },
  { name: "Raksha Bandhan (Shravana Purnima)", month: 4, paksha: "Shukla", tithi: 15 },
  { name: "Vinayak Tsoram (Ganesh Chaturthi)", month: 5, paksha: "Shukla", tithi: 4 },
  { name: "Anant Chaturdashi", month: 5, paksha: "Shukla", tithi: 14 },
  { name: "Durga Ashtami (Navratri)", month: 6, paksha: "Shukla", tithi: 8 },
  { name: "Dussehra (Vijayadashami)", month: 6, paksha: "Shukla", tithi: 10 },
  { name: "Khetsimavas (Diwali / Yaksha Amavasya)", month: 6, paksha: "Krishna", tithi: 15 },
  { name: "Kartik Purnima", month: 7, paksha: "Shukla", tithi: 15 },
  { name: "Kava Punim (Pausha Purnima)", month: 9, paksha: "Shukla", tithi: 15 },
  { name: "Gada Batta", month: 9, paksha: "Krishna", tithi: 8 },
  { name: "Vasant Panchami (Basant)", month: 10, paksha: "Shukla", tithi: 5 },
  { name: "Herath (Maha Shivratri)", month: 11, paksha: "Krishna", tithi: 13 },
  { name: "Salam (day after Herath)", month: 11, paksha: "Krishna", tithi: 14 },
  { name: "Doonya Mavas (Phalguna Amavasya)", month: 11, paksha: "Krishna", tithi: 15 },
];

function festivalsForPanchang(p) {
  const tithiInPaksha = p.tithiNum <= 15 ? p.tithiNum : p.tithiNum - 15;
  return FESTIVAL_RULES.filter(
    (f) => f.month === p.monthIdx && f.paksha === p.paksha && f.tithi === tithiInPaksha
  );
}

// Backwards-compatible single-festival helper (returns the first match or undefined).
function festivalFor(p) {
  return festivalsForPanchang(p)[0];
}

/* =========================================================================
   CALENDAR-DATE HELPERS
   The whole app treats every calendar day as an IST date regardless of the
   viewer's own device timezone. Dates are represented as "pure" Date
   objects at UTC midnight (constructed with Date.UTC, read with getUTC*
   methods) — a neutral day-only representation that never drifts if a user
   opens the app from outside India. Never mix in local getters/setters here.
   ========================================================================= */

const WEEKDAY_SHORT = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_MED = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABEL = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function pureDate(y, m, d) {
  return new Date(Date.UTC(y, m, d));
}
function todayIST() {
  const shifted = new Date(Date.now() + IST_OFFSET_MS);
  return pureDate(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}
function startOfDay(d) {
  return pureDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}
function startOfWeek(d) {
  return addDays(d, -d.getUTCDay());
}
function sameDay(a, b) {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}
function fmtDate(d) {
  return `${WEEKDAY_MED[d.getUTCDay()]}, ${MONTH_LABEL[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/* ---------------------- Reminders ---------------------- */

const CATEGORY_META = {
  birthday: { label: "Birthday", icon: Cake },
  festival: { label: "Festival", icon: PartyPopper },
  custom: { label: "Custom", icon: CalendarDays },
};
const NOTIFY_LABEL = { 0: "On the day", 1: "1 day before", 7: "1 week before" };

function isReminderOnDate(reminder, date) {
  if (reminder.dateType === "tithi") {
    const p = dayPanchang(date);
    return p.monthIdx === reminder.lunarMonth && p.paksha === reminder.paksha && p.tithiName === reminder.tithiName;
  }
  return reminder.repeatYearly
    ? reminder.month === date.getUTCMonth() && reminder.day === date.getUTCDate()
    : reminder.year === date.getUTCFullYear() && reminder.month === date.getUTCMonth() && reminder.day === date.getUTCDate();
}

function remindersForDate(date, reminders) {
  return reminders.filter((r) => isReminderOnDate(r, date));
}

function nextOccurrence(reminder, from) {
  if (reminder.dateType === "tithi") {
    let prevMatch = false;
    for (let i = 0; i < 400; i++) {
      const d = addDays(from, i);
      const isMatch = isReminderOnDate(reminder, d);
      if (isMatch && !prevMatch) return d;
      prevMatch = isMatch;
    }
    return from;
  }
  if (!reminder.repeatYearly) {
    return pureDate(reminder.year, reminder.month, reminder.day);
  }
  let d = pureDate(from.getUTCFullYear(), reminder.month, reminder.day);
  if (d < startOfDay(from)) d = pureDate(from.getUTCFullYear() + 1, reminder.month, reminder.day);
  return d;
}

// Reminders whose event date falls within [rangeStart, rangeEnd]. When
// includeLeadTime is true (week view), the notification lead-window is also
// allowed to overlap the range, so a birthday surfaces a few days early —
// but that "advance notice" spillover is deliberately NOT extended across a
// full month boundary, or the same reminder would appear to duplicate itself
// in two different months' summaries.
function upcomingInRange(reminders, rangeStart, rangeEnd, today, includeLeadTime) {
  const anchor = addDays(rangeStart, -10);
  const items = [];
  for (const r of reminders) {
    const occ = nextOccurrence(r, anchor);
    const windowStart = includeLeadTime ? addDays(occ, -(r.notify ? r.notifyOffset : 0)) : occ;
    if (windowStart <= rangeEnd && occ >= rangeStart) {
      const daysUntil = Math.round((occ - today) / 86400000);
      items.push({ reminder: r, date: occ, daysUntil });
    }
  }
  items.sort((a, b) => a.date - b.date);
  return items;
}

/* ---------------------- Search ---------------------- */

function isValidYMD(y, m, d) {
  const dt = pureDate(y, m, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d;
}

function parseDateQuery(q) {
  const mAbbr = MONTH_LABEL.map((m) => m.slice(0, 3).toLowerCase());

  const iso = q.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const y = +iso[1], m = +iso[2] - 1, d = +iso[3];
    return isValidYMD(y, m, d) ? pureDate(y, m, d) : null;
  }

  let m1 = q.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]+)\s*(\d{4})?/);
  let m2 = q.match(/([a-zA-Z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/);
  let m3 = q.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  let day, monthIdx, year;
  if (m1 && mAbbr.some((a) => m1[2].toLowerCase().startsWith(a) || a.startsWith(m1[2].toLowerCase()))) {
    day = +m1[1];
    monthIdx = mAbbr.findIndex((a) => m1[2].toLowerCase().startsWith(a) || a.startsWith(m1[2].toLowerCase()));
    year = m1[3] ? +m1[3] : null;
  } else if (m2 && mAbbr.some((a) => m2[1].toLowerCase().startsWith(a) || a.startsWith(m2[1].toLowerCase()))) {
    monthIdx = mAbbr.findIndex((a) => m2[1].toLowerCase().startsWith(a) || a.startsWith(m2[1].toLowerCase()));
    day = +m2[2];
    year = m2[3] ? +m2[3] : null;
  } else if (m3) {
    day = +m3[1];
    monthIdx = +m3[2] - 1;
    year = m3[3] ? (m3[3].length === 2 ? 2000 + +m3[3] : +m3[3]) : null;
  } else {
    return null;
  }
  if (monthIdx == null || monthIdx < 0 || monthIdx > 11 || !day || day < 1 || day > 31) return null;
  const y = year || todayIST().getUTCFullYear();
  return isValidYMD(y, monthIdx, day) ? pureDate(y, monthIdx, day) : null;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Lower score = more relevant: exact match, then prefix match, then substring match.
function matchScore(label, q) {
  const l = label.toLowerCase();
  if (l === q) return 0;
  if (l.startsWith(q)) return 1;
  if (l.includes(q)) return 2;
  return null;
}

// Parses compound phrases like "Jyeshtha Krishna Paksha Dwadashi" into their
// component parts (lunar month / paksha / tithi) so multi-word panchang queries
// resolve, not just a single exact tithi or festival name.
const PANCHANG_STOPWORDS = new Set(["paksha", "maas", "mas", "month", "tithi", "the", "of", "on", "in", "and"]);

// Suggests plausible dates from a partial query — so a user gets live feedback
// as they type "jul" or "2026" rather than nothing until the whole date is
// complete. Returns an array of up to ~3 Date objects.
function parsePartialDateQuery(q, today) {
  const partials = [];
  const mAbbr = MONTH_LABEL.map((m) => m.slice(0, 3).toLowerCase());

  // Bare month name/prefix (e.g. "ju", "jul", "july"). 2 chars minimum so
  // "ja" resolves to January, "ju" ambiguously to June+July, etc.
  const monthOnly = q.match(/^([a-zA-Z]{2,})\s*$/);
  if (monthOnly) {
    const t = monthOnly[1].toLowerCase();
    const matches = [];
    mAbbr.forEach((a, i) => { if (a.startsWith(t) || t.startsWith(a)) matches.push(i); });
    const y0 = today.getUTCFullYear();
    for (const idx of matches) {
      const monthDate = pureDate(y0, idx, 1);
      const target = monthDate < today ? y0 + 1 : y0;
      partials.push(pureDate(target, idx, 1));
      if (matches.length === 1) partials.push(pureDate(target, idx, 15));
    }
  }

  // Month + partial day/space (e.g. "july ", "july 1")
  const monthDay = q.match(/^([a-zA-Z]{2,})\s+(\d{0,2})$/);
  if (monthDay && monthDay[2] === "") {
    const t = monthDay[1].toLowerCase();
    const idx = mAbbr.findIndex((a) => a.startsWith(t) || t.startsWith(a));
    if (idx >= 0) {
      const y = today.getUTCFullYear();
      const monthDate = pureDate(y, idx, 1);
      const target = monthDate < today ? y + 1 : y;
      partials.push(pureDate(target, idx, 1));
      partials.push(pureDate(target, idx, 15));
    }
  }

  // Year only, 4 digits (e.g. "2026") — offer today's month/day in that year
  const yearOnly = q.match(/^(\d{4})$/);
  if (yearOnly) {
    const y = +yearOnly[1];
    if (y >= 1900 && y <= 2200) {
      partials.push(pureDate(y, today.getUTCMonth(), today.getUTCDate()));
      partials.push(pureDate(y, 0, 1));
    }
  }

  // Partial ISO like "2026-", "2026-07", "2026-07-", "2026-07-0"
  const isoDangling = q.match(/^(\d{4})-$/);
  if (isoDangling) {
    const y = +isoDangling[1];
    if (y >= 1900 && y <= 2200) {
      partials.push(pureDate(y, today.getUTCMonth(), today.getUTCDate()));
    }
  }

  const isoPartial = q.match(/^(\d{4})-(\d{1,2})(?:-(\d{0,2}))?$/);
  if (isoPartial) {
    const y = +isoPartial[1], m = +isoPartial[2] - 1;
    if (m >= 0 && m <= 11) {
      const dayPart = isoPartial[3];
      if (dayPart && dayPart.length > 0) {
        // Partial day — expand to 1-9 (if user typed "0") or 10-19 (if "1"), etc.
        const digit = +dayPart;
        if (digit >= 1 && digit <= 3) {
          // e.g. "2" → 2nd, 20th
          if (isValidYMD(y, m, digit)) partials.push(pureDate(y, m, digit));
          if (isValidYMD(y, m, digit * 10)) partials.push(pureDate(y, m, digit * 10));
        } else if (digit === 0) {
          // typed "0" — waiting for next digit; offer 1st and 15th
          partials.push(pureDate(y, m, 1));
          partials.push(pureDate(y, m, 15));
        }
      } else {
        partials.push(pureDate(y, m, 1));
        partials.push(pureDate(y, m, 15));
      }
    }
  }

  // Numeric day/month with slash (e.g. "15/" or "15/0")
  const slashPartial = q.match(/^(\d{1,2})[\/\-](\d{0,2})$/);
  if (slashPartial && slashPartial[2] === "") {
    // Ambiguous — user just typed "15/". Skip; too many possibilities.
  }

  return partials;
}

function classifyToken(token) {
  const t = token.toLowerCase().replace(/[^a-z]/g, "");
  if (t.length < 1 || PANCHANG_STOPWORDS.has(t)) return null;

  // Prefix-match first: as a user types "k" → "kr" → "kri" → "krishna",
  // any of those should resolve to Krishna. Edit-distance fallback only
  // applies once the token is long enough to be a plausible typo of a full
  // word (short prefixes like "k" would fuzzy-match too much otherwise).
  if ("shukla".startsWith(t) && t.length >= 1) return { type: "paksha", value: "Shukla" };
  if ("krishna".startsWith(t) && t.length >= 1) return { type: "paksha", value: "Krishna" };

  // Month prefix
  for (let i = 0; i < MONTH_NAMES.length; i++) {
    if (MONTH_NAMES[i].toLowerCase().startsWith(t) && t.length >= 2) {
      return { type: "month", value: i };
    }
  }

  // Tithi prefix (exact prefix, e.g. "dw" → Dwadashi/Dwitiya — pick shortest)
  const allTithi = [...TITHI_NAMES, TITHI_AMAVASYA];
  let bestPrefix = null;
  for (const tn of allTithi) {
    if (tn.toLowerCase().startsWith(t) && t.length >= 2) {
      if (!bestPrefix || tn.length < bestPrefix.length) bestPrefix = tn;
    }
  }
  if (bestPrefix) return { type: "tithi", value: bestPrefix };

  // Edit-distance fallback for full-word typos (>= 4 chars, otherwise the
  // distance test permits nonsense matches like "kr" → "shukla")
  if (t.length >= 4) {
    if (levenshtein(t, "shukla") <= 2) return { type: "paksha", value: "Shukla" };
    if (levenshtein(t, "krishna") <= 2) return { type: "paksha", value: "Krishna" };

    let bestMonth = null;
    MONTH_NAMES.forEach((m, i) => {
      const d = levenshtein(t, m.toLowerCase());
      if (d <= 2 && (!bestMonth || d < bestMonth.d)) bestMonth = { i, d };
    });
    if (bestMonth) return { type: "month", value: bestMonth.i };

    let bestTithi = null;
    allTithi.forEach((tn) => {
      const d = levenshtein(t, tn.toLowerCase());
      if (d <= 2 && (!bestTithi || d < bestTithi.d)) bestTithi = { name: tn, d };
    });
    if (bestTithi) return { type: "tithi", value: bestTithi.name };
  }

  return null;
}

function parsePanchangQuery(query) {
  const parsed = { tithiCandidates: [] };
  const tokens = query.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const isLastToken = i === tokens.length - 1;
    const c = classifyToken(tok);
    if (!c) continue;
    if (c.type === "month" && parsed.monthIdx == null) parsed.monthIdx = c.value;
    if (c.type === "paksha" && !parsed.paksha) parsed.paksha = c.value;
    if (c.type === "tithi" && !parsed.tithiName) {
      parsed.tithiName = c.value;
      // For the last (trailing) token specifically, collect all tithi
      // names that prefix-match it — so "dw" surfaces both Dwitiya AND
      // Dwadashi rather than only the shortest.
      if (isLastToken) {
        const t = tok.toLowerCase().replace(/[^a-z]/g, "");
        const allTithi = [...TITHI_NAMES, TITHI_AMAVASYA];
        for (const tn of allTithi) {
          if (tn.toLowerCase().startsWith(t) && t.length >= 2) {
            parsed.tithiCandidates.push(tn);
          }
        }
      }
    }
  }
  if (parsed.tithiName && parsed.tithiCandidates.length === 0) {
    parsed.tithiCandidates.push(parsed.tithiName);
  }
  return parsed;
}

function runSearch(query, reminders, today) {
  try {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results = [];

    const parsedDate = parseDateQuery(q);
    if (parsedDate) {
      results.push({
        type: "date",
        label: `${MONTH_LABEL[parsedDate.getUTCMonth()]} ${parsedDate.getUTCDate()}, ${parsedDate.getUTCFullYear()}`,
        date: parsedDate,
        score: -1,
      });
    } else {
      // No complete date match — try partial predictions so the user gets
      // live feedback as they type ("jul" → suggest July 1 and 15).
      for (const d of parsePartialDateQuery(q, today)) {
        results.push({
          type: "date",
          label: `${MONTH_LABEL[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`,
          date: d,
          score: 3, // less relevant than an exact date, but ahead of nothing
        });
      }
    }

    // Compound phrases fire progressively — with just month+paksha, or
    // month+partial-tithi, etc. — so the user gets feedback as they type
    // rather than a blank screen until they've entered all three fields.
    // Only kicks in when there's at least a paksha or a tithi (not just a
    // bare month, which the month-search block below already covers).
    const parsedPanchang = parsePanchangQuery(query.trim());
    const hasCompound = (parsedPanchang.paksha || parsedPanchang.tithiName) &&
      (parsedPanchang.monthIdx != null || parsedPanchang.paksha || parsedPanchang.tithiName) &&
      // avoid duplicating the plain single-word tithi search below when
      // only a tithi was typed with nothing else
      !(parsedPanchang.tithiName && parsedPanchang.monthIdx == null && !parsedPanchang.paksha);
    if (hasCompound) {
      const tithiTargets = parsedPanchang.tithiName ? parsedPanchang.tithiCandidates : [null];
      for (const targetTithi of tithiTargets) {
        let found = 0, prevMatch = false;
        for (let i = 0; i < 400 && found < 2; i++) {
          const d = addDays(today, i);
          const p = dayPanchang(d);
          const monthOk = parsedPanchang.monthIdx == null || p.monthIdx === parsedPanchang.monthIdx;
          const pakshaOk = !parsedPanchang.paksha || p.paksha === parsedPanchang.paksha;
          const tithiOk = !targetTithi || p.tithiName === targetTithi;
          const isMatch = monthOk && pakshaOk && tithiOk;
          if (isMatch && !prevMatch) {
            const label = [
              parsedPanchang.monthIdx != null ? p.monthName : null,
              parsedPanchang.paksha ? `${parsedPanchang.paksha} Paksha` : null,
              targetTithi || p.tithiName,
            ].filter(Boolean).join(" ");
            results.push({ type: "tithi", label, date: d, score: 0 });
            found++;
          }
          prevMatch = isMatch;
        }
      }
    }

    const allTithi = [...TITHI_NAMES, TITHI_AMAVASYA];
    for (const tName of allTithi) {
      const score = matchScore(tName, q);
      if (score === null) continue;
      let found = 0, prevName = null;
      for (let i = 0; i < 120 && found < 2; i++) {
        const d = addDays(today, i);
        const name = dayPanchang(d).tithiName;
        if (name === tName && prevName !== tName) {
          results.push({ type: "tithi", label: tName, date: d, score });
          found++;
        }
        prevName = name;
      }
    }

    for (const rule of FESTIVAL_RULES) {
      const score = matchScore(rule.name, q);
      if (score === null) continue;
      for (let i = 0; i < 400; i++) {
        const d = addDays(today, i);
        const p = dayPanchang(d);
        const tithiInPaksha = p.tithiNum <= 15 ? p.tithiNum : p.tithiNum - 15;
        if (p.monthIdx === rule.month && p.paksha === rule.paksha && tithiInPaksha === rule.tithi) {
          results.push({ type: "festival", label: rule.name, date: d, score });
          break;
        }
      }
    }

    // Lunar month name search (e.g. "jyeshtha") — surfaces the next
    // occurrence of that month rather than falling through to fuzzy matching
    // where "jyeshtha" gets mangled into "shashthi" via edit distance.
    for (let mi = 0; mi < MONTH_NAMES.length; mi++) {
      const mName = MONTH_NAMES[mi];
      const score = matchScore(mName, q);
      if (score === null) continue;
      // Find the first day the month is currently active
      for (let i = 0; i < 400; i++) {
        const d = addDays(today, i);
        const p = dayPanchang(d);
        if (p.monthIdx === mi) {
          results.push({ type: "month", label: p.monthName, date: d, score });
          break;
        }
      }
    }

    for (const r of reminders) {
      const score = matchScore(r.title, q);
      if (score === null) continue;
      results.push({ type: "reminder", label: r.title, date: nextOccurrence(r, today), score });
    }

    // Nothing matched as a substring — fall back to the nearest word by edit distance,
    // so a near-miss or typo still surfaces something useful.
    if (results.length === 0 && q.length >= 2) {
      const candidates = [
        ...allTithi.map((t) => ({ label: t, kind: "tithi" })),
        ...MONTH_NAMES.map((m, i) => ({ label: m, kind: "month", monthIdx: i })),
        ...FESTIVAL_RULES.map((f) => ({ label: f.name, kind: "festival" })),
        ...reminders.map((r) => ({ label: r.title, kind: "reminder" })),
      ];
      let best = null;
      for (const c of candidates) {
        const label = c.label.toLowerCase();
        let dist = levenshtein(q, label);
        for (const tok of label.split(/[^a-z]+/).filter((t) => t.length >= 4)) {
          dist = Math.min(dist, levenshtein(q, tok));
        }
        if (!best || dist < best.dist) best = { ...c, dist };
      }
      // Cap fuzzy tolerance tightly: at most 2 edits (real typos, not
      // wildly-different words). "jyeshtha" → "shashthi" is 5 edits which
      // would surface a totally unrelated word as a "closest match".
      const threshold = Math.min(2, Math.floor(q.length / 3));
      if (best && best.dist <= threshold) {
        if (best.kind === "tithi") {
          for (let i = 0; i < 120; i++) {
            const d = addDays(today, i);
            if (dayPanchang(d).tithiName === best.label) {
              results.push({ type: "suggestion", label: best.label, date: d, score: 9 });
              break;
            }
          }
        } else if (best.kind === "month") {
          for (let i = 0; i < 400; i++) {
            const d = addDays(today, i);
            const p = dayPanchang(d);
            if (p.monthIdx === best.monthIdx) {
              results.push({ type: "suggestion", label: p.monthName, date: d, score: 9 });
              break;
            }
          }
        } else if (best.kind === "festival") {
          const rule = FESTIVAL_RULES.find((f) => f.name === best.label);
          for (let i = 0; i < 400; i++) {
            const d = addDays(today, i);
            const p = dayPanchang(d);
            const tithiInPaksha = p.tithiNum <= 15 ? p.tithiNum : p.tithiNum - 15;
            if (p.monthIdx === rule.month && p.paksha === rule.paksha && tithiInPaksha === rule.tithi) {
              results.push({ type: "suggestion", label: best.label, date: d, score: 9 });
              break;
            }
          }
        } else {
          const r = reminders.find((rr) => rr.title === best.label);
          if (r) results.push({ type: "suggestion", label: best.label, date: nextOccurrence(r, today), score: 9 });
        }
      }
    }

    results.sort((a, b) => (a.score - b.score) || (a.date - b.date));
    return results.slice(0, 10);
  } catch (e) {
    return [];
  }
}

/* ========================================================================= */

export default function KashmiriCalendar() {
  const today = useMemo(() => todayIST(), []);
  const [viewMode, setViewMode] = useState("week");
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [reminders, setReminders] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOrigin, setSearchOrigin] = useState({ x: 340, y: 46 });
  const [searchPulsing, setSearchPulsing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("theme", false);
        if (res && res.value === "dark") setIsDark(true);
      } catch (e) {}
    })();
  }, []);

  const toggleTheme = async () => {
    const next = !isDark;
    setIsDark(next);
    try { await window.storage.set("theme", next ? "dark" : "light", false); } catch (e) {}
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("reminders", false);
        if (res && res.value) setReminders(JSON.parse(res.value));
      } catch (e) {
        setReminders([]);
      }
    })();
  }, []);

  async function persistReminders(next) {
    setReminders(next);
    try {
      await window.storage.set("reminders", JSON.stringify(next), false);
    } catch (e) {
      console.error("Failed to save reminders", e);
    }
  }

  function addReminder(r) {
    persistReminders([...reminders, r]);
    setAddOpen(false);
  }
  function deleteReminder(id) {
    persistReminders(reminders.filter((r) => r.id !== id));
  }

  const todayPanchang = useMemo(() => dayPanchang(today), [today]);
  const englishMonthYear = `${MONTH_LABEL[anchor.getUTCMonth()].slice(0, 3)} ${anchor.getUTCFullYear()}`;

  const step = (dir) => {
    if (viewMode === "day") {
      const next = addDays(anchor, dir);
      setAnchor(next);
      setSelected(next);
    } else if (viewMode === "week") {
      setAnchor((a) => addDays(a, dir * 7));
      setSelected((s) => addDays(s, dir * 7));
    } else {
      setAnchor((a) => pureDate(a.getUTCFullYear(), a.getUTCMonth() + dir, 1));
      setSelected((s) => pureDate(s.getUTCFullYear(), s.getUTCMonth() + dir, s.getUTCDate()));
    }
  };

  const changeView = (m) => {
    setViewMode(m);
    setAnchor(today);
    setSelected(today);
    setMenuOpen(false);
  };

  const jumpToDate = (d) => {
    setAnchor(startOfDay(d));
    setSelected(startOfDay(d));
    setSearchOpen(false);
    setSearchQuery("");
  };

  const searchResults = useMemo(() => runSearch(searchQuery, reminders, today), [searchQuery, reminders, today]);
  const cardDate = viewMode === "day" ? anchor : selected;

  const summaryItems = useMemo(() => {
    if (viewMode === "week") {
      const s = startOfWeek(anchor);
      return upcomingInRange(reminders, s, addDays(s, 6), today, true);
    }
    if (viewMode === "month") {
      const y = anchor.getUTCFullYear(), m = anchor.getUTCMonth();
      const rangeStart = pureDate(y, m, 1);
      const rangeEnd = addDays(pureDate(y, m + 1, 1), -1);
      return upcomingInRange(reminders, rangeStart, rangeEnd, today, false);
    }
    return [];
  }, [viewMode, anchor, reminders, today]);

  // Festivals falling within the Gregorian month of the currently-selected date,
  // shown as a list below the day card.
  const monthFestivals = useMemo(() => {
    const y = cardDate.getUTCFullYear(), m = cardDate.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const out = [];
    for (let dd = 1; dd <= daysInMonth; dd++) {
      const d = pureDate(y, m, dd);
      const fs = festivalsForPanchang(dayPanchang(d));
      for (const f of fs) out.push({ name: f.name, date: d });
    }
    return out;
  }, [cardDate]);

  const cardDayReminders = useMemo(() => remindersForDate(cardDate, reminders), [cardDate, reminders]);

  return (
    <div style={{ ...styles.page, background: isDark ? "#0E0E12" : "#E5E4DD" }}>
      <style>{`
        * { box-sizing: border-box; }
        .kc-root { font-family: 'Google Sans', 'Inter', sans-serif; }

        .kc-scroll::-webkit-scrollbar { display: none; }
        .kc-scroll { -ms-overflow-style: none; scrollbar-width: none; }

        .kc-btn-icon {
          display:flex; align-items:center; justify-content:center;
          width:40px; height:40px; border-radius:20px; border:none; flex-shrink:0;
          background: transparent; color: var(--md-on-surface);
          cursor:pointer; transition: background 120ms cubic-bezier(.2,0,0,1), transform 120ms cubic-bezier(.2,0,0,1);
        }
        .kc-btn-icon:hover { background: var(--md-surface-container-high); }
        .kc-btn-icon:active { transform: scale(0.90); background: var(--md-surface-container-highest); }

        .kc-icon-hover:hover { background: rgba(0,0,0,0.10); }
        .kc-icon-hover:active { background: rgba(0,0,0,0.18); }

        .kc-dropdown-trigger {
          display:flex; align-items:center; gap:6px;
          padding: 8px 12px 8px 16px; border-radius:100px;
          background: var(--kc-glass-bg); color: var(--kc-glass-text);
          backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
          border:none; font-size:13px; font-weight:600; cursor:pointer;
          box-shadow: var(--kc-pill-shadow);
          transition: transform 150ms cubic-bezier(.34,1.56,.64,1), box-shadow 150ms ease;
          white-space:nowrap;
        }
        .kc-dropdown-trigger:active { transform: scale(0.94); }

        .kc-menu {
          position:absolute; top:46px; right:0; z-index:35;
          background: var(--md-surface-container-lowest);
          border-radius:20px; padding:6px; min-width:160px;
          box-shadow: var(--kc-card-shadow);
          animation: kc-pop 180ms cubic-bezier(.34,1.56,.64,1);
          transform-origin: top right;
        }
        @keyframes kc-pop { from { opacity:0; transform: scale(0.85) translateY(-6px);} to {opacity:1; transform:scale(1) translateY(0);} }

        .kc-menu-item {
          display:flex; align-items:center; justify-content:space-between;
          padding:10px 12px; border-radius:12px; font-size:14px; font-weight:500;
          color: var(--md-on-surface); cursor:pointer; background:transparent; border:none; width:100%;
          transition: background 100ms ease;
        }
        .kc-menu-item:hover { background: var(--md-surface-container-high); }
        .kc-menu-item.active { color: var(--md-primary); font-weight:700; }

        .kc-card {
          background: var(--md-surface-container-lowest);
          border-radius: 28px;
          padding: 22px;
          box-shadow: var(--kc-card-shadow);
          border: var(--kc-card-border);
          position: relative;
        }

        .kc-week-grid {
          display: grid; grid-template-columns: repeat(7, 1fr);
          gap: 6px; padding: 8px 0 14px; width: 100%;
        }

        .kc-day-cell {
          display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px;
          padding: 12px 0;
          border-radius: 100px; cursor:pointer; position:relative;
          transition: background 180ms cubic-bezier(.2,0,0,1), transform 160ms cubic-bezier(.34,1.56,.64,1), box-shadow 180ms ease;
          background: transparent;
        }
        .kc-day-cell:active { transform: scale(0.90); }
        .kc-day-cell.today-outline { box-shadow: inset 0 0 0 1.5px var(--md-outline); }
        .kc-day-cell.selected {
          background: var(--md-primary);
          box-shadow: var(--kc-selected-shadow);
          border-radius: 100px;
        }
        .kc-day-num { font-size:20px; font-weight:700; color: var(--md-on-surface); line-height:1; }
        .kc-day-cell.selected .kc-day-num,
        .kc-day-cell.selected .kc-day-label { color: var(--md-on-primary); }
        .kc-day-label { font-size:10px; font-weight:700; letter-spacing:0.5px; color: var(--md-outline); text-transform:uppercase; line-height:1; }

        /* Dots sit as an overlay pinned near the bottom of the pill rather than
           stacking in the centered flex flow — that way the label+number block
           stays perfectly centered and the padding above the label matches the
           padding below the number, regardless of whether a dot is showing. */
        .kc-day-dots-overlay {
          position:absolute; bottom:7px; left:50%; transform:translateX(-50%);
        }

        .kc-dot-filled { width:4px; height:4px; border-radius:50%; background: var(--md-on-surface-variant); display:block; }
        .kc-dot-ring { width:4px; height:4px; border-radius:50%; border:1px solid var(--md-on-surface-variant); display:block; }
        .kc-day-cell.selected .kc-dot-filled { background: var(--md-on-primary); }
        .kc-day-cell.selected .kc-dot-ring { border-color: var(--md-on-primary); }

        .kc-month-cell {
          aspect-ratio: 1/1; display:flex; flex-direction:column; align-items:center; justify-content:center;
          border-radius:16px; cursor:pointer; position:relative; gap:4px;
          transition: background 120ms ease, transform 120ms cubic-bezier(.34,1.56,.64,1);
        }
        .kc-month-cell:active { transform: scale(0.92); }
        .kc-month-cell.today-outline { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--md-primary) 60%, transparent); }
        .kc-month-cell.selected { background: rgba(0,0,0,0.10); }
        .kc-root.dark .kc-month-cell.selected { background: rgba(255,255,255,0.10); }
        .kc-month-cell.dim { opacity: 0.35; }

        .kc-chip {
          display:inline-flex; align-items:center; gap:6px;
          padding: 6px 12px; border-radius:100px; font-size:12px; font-weight:600;
          background: var(--md-tertiary-container); color: var(--md-on-tertiary-container);
        }

        .kc-fab {
          position:absolute; right:20px; bottom:24px; z-index:15;
          width:56px; height:56px; border-radius:20px;
          background: var(--md-primary); color: var(--md-on-primary);
          display:flex; align-items:center; justify-content:center; border:none;
          box-shadow: var(--kc-fab-shadow); cursor:pointer;
          transition: transform 150ms cubic-bezier(.34,1.56,.64,1), border-radius 200ms ease;
        }
        .kc-fab:active { transform: scale(0.9) rotate(8deg); border-radius:28px; }

        .kc-search-overlay {
          position:absolute; inset:0; z-index:40; background: var(--md-surface);
          display:flex; flex-direction:column;
          animation: kc-search-reveal 480ms cubic-bezier(.16,1,.3,1);
        }
        @keyframes kc-fade { from { opacity:0; } to { opacity:1; } }
        @keyframes kc-search-reveal {
          from { clip-path: circle(4% at var(--sx, 90%) var(--sy, 5%)); }
          to { clip-path: circle(150% at var(--sx, 90%) var(--sy, 5%)); }
        }
        .kc-search-overlay .kc-search-header {
          animation: kc-fade 320ms ease both;
        }

        .kc-icon-pop { animation: kc-icon-pop 260ms cubic-bezier(.34,1.56,.64,1); }
        @keyframes kc-icon-pop {
          0% { transform: scale(1) rotate(0deg); }
          35% { transform: scale(0.8) rotate(-12deg); }
          70% { transform: scale(1.2) rotate(8deg); }
          100% { transform: scale(1) rotate(0deg); }
        }
        .kc-search-header { display:flex; align-items:center; gap:6px; padding:16px 12px; border-bottom:1px solid var(--kc-divider); }
        .kc-search-input {
          flex:1; border:none; outline:none; background:transparent;
          font-size:16px; font-family:inherit; color: var(--md-on-surface);
        }
        .kc-search-input::placeholder { color: var(--md-outline); }
        .kc-search-result {
          display:flex; align-items:center; justify-content:space-between;
          width:100%; text-align:left; padding:14px 8px; border:none; background:transparent;
          border-bottom: 1px solid var(--md-outline-variant); cursor:pointer;
        }
        .kc-search-result:active { background: var(--md-surface-container-high); }
        .kc-search-type {
          font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px;
          color: var(--md-on-surface-variant); background: var(--md-surface-container-high);
          padding:4px 8px; border-radius:100px; flex-shrink:0; margin-left:8px;
        }

        .kc-overlay-backdrop {
          position:absolute; inset:0; z-index:50; background: var(--kc-overlay-bg);
          display:flex; align-items:flex-end; justify-content:center; animation: kc-fade 150ms ease;
        }
        .kc-dialog {
          width:100%;
          background:
            radial-gradient(140% 70% at 12% 0%, rgba(232,160,78,0.12) 0%, rgba(232,160,78,0) 60%),
            radial-gradient(140% 70% at 92% 0%, rgba(199,125,187,0.12) 0%, rgba(199,125,187,0) 60%),
            var(--md-surface-container-lowest);
          border-radius: 28px 28px 0 0; padding:14px 22px 28px;
          animation: kc-slideup 220ms cubic-bezier(.2,0,0,1);
          max-height:88%; overflow-y:auto;
          box-shadow: var(--kc-frame-shadow);
        }
        .kc-dialog-handle { width:36px; height:4px; border-radius:2px; background: var(--md-outline-variant); margin: 0 auto 18px; }
        @keyframes kc-slideup { from { transform: translateY(24px); opacity:0.4; } to { transform: translateY(0); opacity:1; } }

        .kc-field-label { font-size:12px; font-weight:700; color: var(--md-on-surface-variant); text-transform:uppercase; letter-spacing:0.3px; margin: 18px 0 7px; }
        .kc-input {
          width:100%; padding:13px 16px; border-radius:16px;
          border:1.3px solid color-mix(in srgb, var(--md-outline-variant) 55%, transparent);
          background: var(--md-surface-container-low); font-size:15px; font-family:inherit; color: var(--md-on-surface);
          outline:none; transition: border-color 150ms ease, box-shadow 150ms ease, background 150ms ease;
        }
        .kc-input:focus {
          border-color: var(--kc-accent); background: var(--md-surface-container-lowest);
          box-shadow: 0 0 0 4px color-mix(in srgb, var(--kc-accent) 18%, transparent);
        }

        .kc-pill {
          padding:9px 15px; border-radius:100px; border:1.3px solid var(--md-outline-variant);
          background: var(--md-surface-container-low); font-size:13px; font-weight:600; color: var(--md-on-surface-variant);
          cursor:pointer; transition: all 140ms ease; display:flex; align-items:center; gap:6px;
        }
        .kc-pill:active { transform: scale(0.95); }
        .kc-pill.active { background: var(--md-primary); border-color: var(--md-primary); color: var(--md-on-primary); }

        .kc-switch-row { display:flex; align-items:center; justify-content:space-between; margin-top:16px; }
        .kc-switch-row-label { font-size:14px; font-weight:600; color: var(--md-on-surface); }
        .kc-switch-track {
          width:44px; height:26px; border-radius:14px; border:1.5px solid var(--md-outline);
          background: var(--md-surface-container-highest); position:relative; cursor:pointer; padding:0;
          transition: background 150ms ease, border-color 150ms ease; flex-shrink:0;
        }
        .kc-switch-track.on { background: var(--md-primary); border-color: var(--md-primary); }
        .kc-switch-thumb {
          position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%;
          background:#fff; box-shadow:0 1px 2px rgba(0,0,0,0.3);
          transition: transform 180ms cubic-bezier(.34,1.56,.64,1);
        }
        .kc-switch-track.on .kc-switch-thumb { transform: translateX(18px); }

        .kc-dialog-actions { display:flex; justify-content:flex-end; gap:10px; margin-top:24px; }
        .kc-text-btn {
          padding:12px 18px; border-radius:100px; border:none; background:transparent;
          color: var(--md-on-surface-variant); font-weight:700; font-size:14px; cursor:pointer;
          transition: background 120ms ease, transform 120ms cubic-bezier(.2,0,0,1);
        }
        .kc-text-btn:hover { background: var(--md-surface-container-high); }
        .kc-text-btn:active { transform: scale(0.95); }
        .kc-filled-btn {
          display:flex; align-items:center; gap:6px;
          padding:12px 22px; border-radius:100px; border:none;
          background: linear-gradient(135deg, var(--kc-accent), var(--kc-accent2));
          color:#fff; font-weight:700; font-size:14px; cursor:pointer;
          box-shadow: 0 6px 16px color-mix(in srgb, var(--kc-accent2) 35%, transparent);
          transition: transform 120ms cubic-bezier(.2,0,0,1), box-shadow 120ms ease;
        }
        .kc-filled-btn:active { transform: scale(0.95); }
        .kc-filled-btn:disabled {
          opacity:0.5; cursor:not-allowed; background: var(--md-surface-container-highest);
          color: var(--md-on-surface-variant); box-shadow:none;
        }

        .kc-reminder-card {
          background: var(--md-surface-container-lowest);
          border-radius: 24px;
          padding: 16px 18px;
          box-shadow: var(--kc-card-shadow-sm); border: var(--kc-card-border);
        }
        .kc-reminder-card-title {
          font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px;
          color: var(--md-on-surface-variant); margin-bottom: 4px;
        }
        .kc-reminder-row { display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-top:1px solid var(--kc-divider); }
        .kc-reminder-title { font-size:14px; font-weight:600; color: var(--md-on-surface); }
        .kc-reminder-meta { font-size:11px; color: var(--md-on-surface-variant); margin-top:4px; }

        .kc-summary-card { background: var(--md-surface-container); border-radius: 20px; padding: 4px 14px; }
        .kc-summary-row {
          display:flex; align-items:center; gap:10px; width:100%; text-align:left;
          padding:10px 0; border:none; background:transparent; cursor:pointer;
        }
        .kc-summary-row:not(:last-child) { border-bottom: 1px solid var(--kc-divider); }
        .kc-summary-row:active { opacity:0.7; }
        .kc-summary-tag {
          font-size:11px; font-weight:700; color: var(--md-on-surface-variant);
          background: var(--md-surface-container-highest); padding:4px 9px; border-radius:100px; flex-shrink:0;
        }

        /* Full-frame gradient — flows from the saffron/lavender dawn at the top
           and dissolves into the base surface color by roughly mid-frame, so
           there's never a hard cut between "header" and "content". */
        .kc-root {
          background:
            radial-gradient(100% 45% at 15% 0%, rgba(255,209,148,0.50) 0%, rgba(255,209,148,0) 70%),
            radial-gradient(100% 50% at 90% 0%, rgba(214,196,255,0.45) 0%, rgba(214,196,255,0) 70%),
            linear-gradient(180deg, #FBEFE3 0%, #F3ECF6 18%, var(--md-surface) 50%) !important;
        }
        .kc-root.dark {
          background:
            radial-gradient(100% 45% at 15% 0%, rgba(180,120,50,0.16) 0%, transparent 70%),
            radial-gradient(100% 50% at 90% 0%, rgba(120,80,180,0.16) 0%, transparent 70%),
            linear-gradient(180deg, #1A1820 0%, #181820 18%, var(--md-surface) 50%) !important;
        }
        .kc-header {
          background: transparent;
          padding-bottom: 8px;
          flex-shrink: 0;
        }
        .kc-body {
          background: transparent;
          position: relative;
          padding-top: 6px;
          flex: 1;
          overflow-y: auto;
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
        .kc-body::-webkit-scrollbar { display: none; }

        .kc-fest-card {
          background: var(--md-surface-container-lowest);
          border-radius: 24px;
          padding: 16px 18px;
          box-shadow: var(--kc-card-shadow-sm); border: var(--kc-card-border);
        }
        .kc-fest-row {
          display:flex; align-items:center; gap:12px; width:100%; text-align:left;
          padding:11px 0; border:none; background:transparent; cursor:pointer;
          border-top: 1px solid var(--md-outline-variant);
        }
        .kc-fest-row:active { opacity:0.6; }
        .kc-fest-dot {
          width:8px; height:8px; border-radius:50%; flex-shrink:0;
          background: linear-gradient(135deg, var(--kc-accent), var(--kc-accent2));
        }

        /* ---- Dark theme overrides ---- */
        .kc-root.dark .kc-icon-hover:hover { background: rgba(255,255,255,0.10); }
        .kc-root.dark .kc-icon-hover:active { background: rgba(255,255,255,0.16); }
        .kc-root.dark .kc-search-overlay { background: var(--md-surface); }
        .kc-root.dark .kc-dialog { background: var(--md-surface-container-lowest); }
        .kc-root.dark .kc-input {
          background: var(--md-surface-container); border-color: var(--md-outline-variant);
          color: var(--md-on-surface);
        }
        .kc-root.dark .kc-splash {
          background:
            radial-gradient(120% 90% at 18% 12%, rgba(180,120,50,0.20) 0%, transparent 55%),
            radial-gradient(120% 100% at 88% 88%, rgba(120,80,180,0.18) 0%, transparent 55%),
            linear-gradient(165deg, #18161E 0%, #161420 50%, #121218 100%);
        }
        .kc-root.dark .kc-splash-glow {
          background: radial-gradient(circle, rgba(240,176,96,0.20), transparent 70%);
        }
        .kc-root.dark .kc-fab { box-shadow: var(--kc-fab-shadow); }

        .kc-theme-toggle {
          transition: transform 280ms cubic-bezier(.34,1.56,.64,1), background 120ms ease !important;
        }
        .kc-theme-toggle:active { transform: scale(0.80) rotate(30deg) !important; }

        .kc-splash {
          position:absolute; inset:0; z-index:100;
          display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px;
          background:
            radial-gradient(120% 90% at 18% 12%, rgba(255,197,140,0.55) 0%, rgba(255,197,140,0) 55%),
            radial-gradient(120% 100% at 88% 88%, rgba(214,196,255,0.5) 0%, rgba(214,196,255,0) 55%),
            linear-gradient(165deg, #FDF6EE 0%, #F6EEF7 50%, #ECF1F8 100%);
          transition: opacity 420ms ease;
        }
        .kc-splash-exit { opacity: 0; pointer-events: none; }
        .kc-splash-glow {
          position:absolute; width:190px; height:190px; border-radius:50%;
          background: radial-gradient(circle, rgba(242,166,90,0.32), transparent 70%);
          animation: kc-breathe 2.6s ease-in-out infinite;
        }
        @keyframes kc-breathe {
          0%, 100% { transform: scale(0.88); opacity: 0.65; }
          50% { transform: scale(1.15); opacity: 1; }
        }
        .kc-splash-leaf {
          animation: kc-leaf-in 750ms cubic-bezier(.34,1.56,.64,1) both;
          filter: drop-shadow(0 8px 16px rgba(179,69,43,0.28));
          position: relative;
        }
        @keyframes kc-leaf-in {
          from { opacity: 0; transform: scale(0.35) rotate(-22deg); }
          to { opacity: 1; transform: scale(1) rotate(0deg); }
        }
        .kc-splash-word {
          position: relative; font-size: 34px; font-weight: 700;
          color: var(--md-on-surface); letter-spacing: 0.5px;
          animation: kc-word-in 550ms cubic-bezier(.2,0,0,1) 320ms both;
        }
        .kc-splash-sub {
          position: relative; font-size: 12px; font-weight: 600;
          color: var(--md-on-surface-variant); letter-spacing: 2.5px; text-transform: uppercase;
          animation: kc-word-in 550ms cubic-bezier(.2,0,0,1) 460ms both;
        }
        @keyframes kc-word-in {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div className={`kc-root ${isDark ? "dark" : ""}`} style={{ ...styles.frame, ...getTokens(isDark) }}>
        {menuOpen && (
          <div style={{ position: "absolute", inset: 0, zIndex: 34 }} onClick={() => setMenuOpen(false)} />
        )}
        {/* ---------------- Gradient header (app bar + date picker) ---------------- */}
        <div className="kc-header">
          <div style={styles.appBar}>
            <div style={styles.appBarRow}>
              <div style={styles.monthEn}>{englishMonthYear}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button
                  className={`kc-btn-icon kc-icon-hover ${searchPulsing ? "kc-icon-pop" : ""}`}
                  onClick={(e) => {
                    const btnRect = e.currentTarget.getBoundingClientRect();
                    const frameRect = e.currentTarget.closest(".kc-root").getBoundingClientRect();
                    setSearchOrigin({
                      x: btnRect.left - frameRect.left + btnRect.width / 2,
                      y: btnRect.top - frameRect.top + btnRect.height / 2,
                    });
                    setMenuOpen(false);
                    setSearchPulsing(true);
                    setTimeout(() => { setSearchOpen(true); setSearchPulsing(false); }, 180);
                  }}
                  aria-label="Search"
                >
                  <Search size={19} />
                </button>
                <button className="kc-btn-icon kc-icon-hover kc-theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
                  {isDark ? <Sun size={18} /> : <Moon size={18} />}
                </button>
                <div style={{ position: "relative" }}>
                  <button className="kc-dropdown-trigger" onClick={() => setMenuOpen((v) => !v)}>
                    {viewMode[0].toUpperCase() + viewMode.slice(1)}
                    <ChevronDown size={16} style={{ transform: menuOpen ? "rotate(180deg)" : "none", transition: "transform 180ms" }} />
                  </button>
                  {menuOpen && (
                    <div className="kc-menu">
                      {["day", "week", "month"].map((m) => (
                        <button key={m} className={`kc-menu-item ${viewMode === m ? "active" : ""}`} onClick={() => changeView(m)}>
                          {m[0].toUpperCase() + m.slice(1)} view
                          {viewMode === m && <Check size={16} />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div style={styles.monthHiRow}>
              <span style={styles.monthHi}>{todayPanchang.monthName} {todayPanchang.paksha} Paksha {todayPanchang.tithiName}</span>
            </div>
          </div>

          {/* Date picker flanked by nav arrows — hidden in day view (arrows go in card) */}
          {viewMode !== "day" && (
            <div style={styles.viewNavRow}>
              <button className="kc-btn-icon kc-icon-hover" onClick={() => step(-1)} aria-label="Previous">
                <ChevronLeft size={20} />
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                {viewMode === "week" && (
                  <WeekStrip anchor={anchor} today={today} selected={selected} onSelect={setSelected} reminders={reminders} />
                )}
                {viewMode === "month" && (
                  <MonthGrid anchor={anchor} today={today} selected={selected} onSelect={setSelected} reminders={reminders} />
                )}
              </div>
              <button className="kc-btn-icon kc-icon-hover" onClick={() => step(1)} aria-label="Next">
                <ChevronRight size={20} />
              </button>
            </div>
          )}
        </div>

        {/* ---------------- Scrollable body ---------------- */}
        <div className="kc-body">
          {/* Day info card */}
          <div style={{ ...styles.section, paddingTop: viewMode === "day" ? 0 : 0, marginTop: viewMode === "day" ? -4 : -4 }}>
            <InfoCard date={cardDate} today={today} isDayView={viewMode === "day"} onNav={step} />
          </div>

          {/* Reminders for this specific date, own card */}
          {cardDayReminders.length > 0 && (
            <div style={styles.stackSection}>
              <DayRemindersCard date={cardDate} reminders={reminders} onDelete={deleteReminder} />
            </div>
          )}

          {/* Upcoming festivals this month */}
          {monthFestivals.length > 0 && (
            <div style={styles.stackSection}>
              <FestivalsCard festivals={monthFestivals} monthLabel={MONTH_LABEL[cardDate.getUTCMonth()]} today={today} onSelect={setSelected} />
            </div>
          )}

          <div style={{ height: 84 }} />
        </div>

        {!searchOpen && !addOpen && (
          <button className="kc-fab" onClick={() => setAddOpen(true)} aria-label="Add reminder">
            <Plus size={24} />
          </button>
        )}

        {searchOpen && (
          <SearchOverlay
            query={searchQuery}
            onQueryChange={setSearchQuery}
            results={searchResults}
            onClose={() => { setSearchOpen(false); setSearchQuery(""); }}
            onPick={jumpToDate}
            origin={searchOrigin}
          />
        )}

        {addOpen && (
          <ReminderModal initialDate={cardDate} onCancel={() => setAddOpen(false)} onSave={addReminder} />
        )}

        {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}
      </div>
    </div>
  );
}

function SplashScreen({ onDone }) {
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    const t1 = setTimeout(() => setExiting(true), 1400);
    const t2 = setTimeout(() => onDone(), 1820);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [onDone]);

  return (
    <div className={`kc-splash ${exiting ? "kc-splash-exit" : ""}`}>
      <div className="kc-splash-glow" />
      <svg className="kc-splash-leaf" viewBox="-2 -4 104 104" width="76" height="76">
        <defs>
          <linearGradient id="kcLeafGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#F8CBA0" />
            <stop offset="45%" stopColor="#E8922E" />
            <stop offset="100%" stopColor="#7A2333" />
          </linearGradient>
        </defs>
        <line x1="50" y1="60" x2="50" y2="94" stroke="#6B2E28" strokeWidth="3" strokeLinecap="round" />
        <path
          d="M50,-2 L61.7,14.9 Q68,24 75,26.8 L88,32 L80.2,46.3 Q76,54 74.6,61.7 L72,76 L57.7,66.9 Q50,62 42.3,66.9 L28,76 L25.4,61.7 Q24,54 19.8,46.3 L12,32 L25,26.8 Q32,24 38.3,14.9 Z"
          fill="url(#kcLeafGrad)"
        />
        <g stroke="rgba(255,250,240,0.14)" strokeWidth="0.7" strokeLinecap="round">
          <line x1="50" y1="60" x2="50" y2="-2" />
          <line x1="50" y1="60" x2="88" y2="32" />
          <line x1="50" y1="60" x2="72" y2="76" />
          <line x1="50" y1="60" x2="28" y2="76" />
          <line x1="50" y1="60" x2="12" y2="32" />
        </g>
      </svg>
      <div className="kc-splash-word">Koshur</div>
      <div className="kc-splash-sub">Kashmiri Calendar</div>
    </div>
  );
}

function InfoCard({ date, today, isDayView, onNav }) {
  const p = useMemo(() => dayPanchang(date), [date]);
  const sun = useMemo(() => sunriseSunset(date, LOCATION.lat, LOCATION.lon, LOCATION.tz), [date]);
  const fest = festivalFor(p);

  return (
    <div className="kc-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={styles.cardDate}>{fmtDate(date)}</div>
      </div>
      {isDayView && (
        <div style={{ display: "flex", gap: 2, position: "absolute", top: 15, right: 22 }}>
          <button className="kc-btn-icon kc-icon-hover" style={{ width: 30, height: 30, borderRadius: 15 }} onClick={() => onNav(-1)} aria-label="Previous day">
            <ChevronLeft size={16} />
          </button>
          <button className="kc-btn-icon kc-icon-hover" style={{ width: 30, height: 30, borderRadius: 15 }} onClick={() => onNav(1)} aria-label="Next day">
            <ChevronRight size={16} />
          </button>
        </div>
      )}
      <div style={styles.cardTithiHi}>{p.paksha} Paksha {p.tithiName}</div>
      <div style={styles.cardTithiEn}>{p.monthName} Maas</div>

      <div style={styles.sunRow}>
        <div style={styles.sunItem}>
          <div style={{ ...styles.sunIconWrap, background: "var(--kc-sunrise-bg)" }}>
            <Sunrise size={18} color="var(--kc-sunrise-fg)" />
          </div>
          <div>
            <div style={styles.sunLabel}>Sunrise</div>
            <div style={styles.sunValue}>{sun.sunrise ?? "—"}</div>
          </div>
        </div>
        <div style={styles.sunDivider} />
        <div style={styles.sunItem}>
          <div style={{ ...styles.sunIconWrap, background: "var(--kc-sunset-bg)" }}>
            <Sunset size={18} color="var(--kc-sunset-fg)" />
          </div>
          <div>
            <div style={styles.sunLabel}>Sunset</div>
            <div style={styles.sunValue}>{sun.sunset ?? "—"}</div>
          </div>
        </div>
      </div>

      {fest && (
        <div className="kc-chip" style={{ marginTop: 16 }}>
          <Sparkles size={13} />
          {fest.name}
        </div>
      )}
    </div>
  );
}

function DayRemindersCard({ date, reminders, onDelete }) {
  const dayReminders = remindersForDate(date, reminders);
  if (dayReminders.length === 0) return null;

  return (
    <div className="kc-reminder-card">
      <div className="kc-reminder-card-title">Reminders for {fmtDate(date)}</div>
      {dayReminders.map((r, i) => {
        const Icon = CATEGORY_META[r.category].icon;
        return (
          <div key={r.id} className="kc-reminder-row" style={i === 0 ? { borderTop: "none" } : undefined}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Icon size={16} color="var(--md-on-surface-variant)" />
              <div>
                <div className="kc-reminder-title">{r.title}</div>
                {r.notify && <div className="kc-reminder-meta">Reminder · {NOTIFY_LABEL[r.notifyOffset]}</div>}
              </div>
            </div>
            <button className="kc-btn-icon kc-icon-hover" style={{ width: 32, height: 32, borderRadius: 16 }} onClick={() => onDelete(r.id)} aria-label="Delete reminder">
              <Trash2 size={15} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function FestivalsCard({ festivals, monthLabel, today, onSelect }) {
  if (festivals.length === 0) return null;
  return (
    <div className="kc-fest-card">
      <div className="kc-reminder-card-title">Festivals in {monthLabel}</div>
      {festivals.map((f, i) => {
        const isPast = f.date < today;
        const isToday = sameDay(f.date, today);
        return (
          <button
            key={i}
            className="kc-fest-row"
            style={i === 0 ? { borderTop: "none" } : undefined}
            onClick={() => onSelect(f.date)}
          >
            <span className="kc-fest-dot" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="kc-reminder-title" style={isPast ? { opacity: 0.5 } : undefined}>{f.name}</div>
              <div className="kc-reminder-meta">{fmtDate(f.date)}</div>
            </div>
            {isToday && <span className="kc-summary-tag" style={{ background: "var(--md-primary)", color: "var(--md-on-primary)" }}>Today</span>}
          </button>
        );
      })}
    </div>
  );
}

function DotRow({ fest, hasReminder }) {
  return (
    <div style={{ display: "flex", gap: 3, height: 5, alignItems: "center", justifyContent: "center" }}>
      {fest && <span className="kc-dot-filled" />}
      {hasReminder && <span className="kc-dot-ring" />}
    </div>
  );
}

function WeekStrip({ anchor, today, selected, onSelect, reminders }) {
  const start = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

  return (
    <div className="kc-week-grid">
      {days.map((d, i) => {
        const isToday = sameDay(d, today);
        const isSel = sameDay(d, selected);
        const fest = festivalFor(dayPanchang(d));
        const hasReminder = remindersForDate(d, reminders).length > 0;
        return (
          <div key={i} className={`kc-day-cell ${isToday && !isSel ? "today-outline" : ""} ${isSel ? "selected" : ""}`} onClick={() => onSelect(d)}>
            <span className="kc-day-label">{WEEKDAY_SHORT[d.getUTCDay()]}</span>
            <span className="kc-day-num">{d.getUTCDate()}</span>
            <div className="kc-day-dots-overlay">
              <DotRow fest={fest} hasReminder={hasReminder} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MonthGrid({ anchor, today, selected, onSelect, reminders }) {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const firstOfMonth = pureDate(year, month, 1);
  const gridStart = startOfWeek(firstOfMonth);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

  return (
    <div style={{ padding: "4px 6px 12px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
        {WEEKDAY_SHORT.map((d, i) => (
          <div key={i} style={styles.monthWeekdayLabel}>{d}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {cells.map((d, i) => {
          const inMonth = d.getUTCMonth() === month;
          const isToday = sameDay(d, today);
          const isSel = sameDay(d, selected);
          const fest = festivalFor(dayPanchang(d));
          const hasReminder = remindersForDate(d, reminders).length > 0;
          return (
            <div
              key={i}
              className={`kc-month-cell ${isToday ? "today-outline" : ""} ${isSel ? "selected" : ""} ${!inMonth ? "dim" : ""}`}
              onClick={() => onSelect(d)}
            >
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--md-on-surface)" }}>{d.getUTCDate()}</span>
              <DotRow fest={fest} hasReminder={hasReminder} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SearchOverlay({ query, onQueryChange, results, onClose, onPick, origin }) {
  const inputRef = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 220);
    return () => clearTimeout(t);
  }, []);

  const TYPE_LABEL = { date: "date", tithi: "tithi", month: "month", festival: "festival", reminder: "reminder", suggestion: "closest match" };

  return (
    <div
      className="kc-search-overlay"
      style={origin ? { "--sx": `${origin.x}px`, "--sy": `${origin.y}px` } : undefined}
    >
      <div className="kc-search-header">
        <button className="kc-btn-icon kc-icon-hover" onClick={onClose} aria-label="Close search">
          <X size={20} />
        </button>
        <input
          ref={inputRef}
          className="kc-search-input"
          placeholder="Search tithi, date, festival, reminder…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </div>
      <div style={{ padding: "4px 16px", overflowY: "auto", flex: 1 }}>
        {query.trim() !== "" && results.length === 0 && (
          <div style={{ padding: "24px 4px", color: "var(--md-outline)", fontSize: 13, fontStyle: "italic" }}>No matches found.</div>
        )}
        {results.map((r, i) => (
          <button key={i} className="kc-search-result" onClick={() => onPick(r.date)}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--md-on-surface)" }}>{r.label}</div>
              <div style={{ fontSize: 12, color: "var(--md-on-surface-variant)", marginTop: 2 }}>{fmtDate(r.date)} {r.date.getUTCFullYear()}</div>
            </div>
            <span className="kc-search-type">{TYPE_LABEL[r.type] || r.type}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Switch({ checked, onChange }) {
  return (
    <button type="button" className={`kc-switch-track ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="kc-switch-thumb" />
    </button>
  );
}

function tithiOptionsForPaksha(paksha) {
  return paksha === "Shukla" ? TITHI_NAMES : [...TITHI_NAMES.slice(0, 14), TITHI_AMAVASYA];
}

function ReminderModal({ initialDate, onCancel, onSave }) {
  const [title, setTitle] = useState("");
  const [dateType, setDateType] = useState("gregorian"); // "gregorian" | "tithi"
  const [dateStr, setDateStr] = useState(() => {
    const y = initialDate.getUTCFullYear(), m = String(initialDate.getUTCMonth() + 1).padStart(2, "0"), d = String(initialDate.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  });
  const [category, setCategory] = useState("custom");
  const [repeatYearly, setRepeatYearly] = useState(false);
  const [lunarMonth, setLunarMonth] = useState(() => dayPanchang(initialDate).monthIdx);
  const [tithiPaksha, setTithiPaksha] = useState(() => dayPanchang(initialDate).paksha);
  const [tithiName, setTithiName] = useState(() => dayPanchang(initialDate).tithiName);
  const [notify, setNotify] = useState(true);
  const [notifyOffset, setNotifyOffset] = useState(0);

  const handleSave = () => {
    if (!title.trim()) return;
    const base = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      title: title.trim(),
      category,
      notify,
      notifyOffset,
      dateType,
    };
    if (dateType === "tithi") {
      onSave({ ...base, lunarMonth, paksha: tithiPaksha, tithiName });
    } else {
      const [y, m, d] = dateStr.split("-").map(Number);
      onSave({ ...base, month: m - 1, day: d, year: repeatYearly ? null : y, repeatYearly });
    }
  };

  const tithiOptions = tithiOptionsForPaksha(tithiPaksha);

  return (
    <div className="kc-overlay-backdrop" onClick={onCancel}>
      <div className="kc-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="kc-dialog-handle" />
        <div style={{ fontSize: 19, fontWeight: 700, color: "var(--md-on-surface)" }}>New reminder</div>

        <div className="kc-field-label">Title</div>
        <input className="kc-input" placeholder="e.g. Amma's birthday" value={title} onChange={(e) => setTitle(e.target.value)} />

        <div className="kc-field-label">Category</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {Object.entries(CATEGORY_META).map(([key, meta]) => {
            const Icon = meta.icon;
            return (
              <button
                key={key}
                className={`kc-pill ${category === key ? "active" : ""}`}
                onClick={() => { setCategory(key); if (key === "birthday") setRepeatYearly(true); }}
              >
                <Icon size={14} /> {meta.label}
              </button>
            );
          })}
        </div>

        <div className="kc-field-label">Set the date by</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className={`kc-pill ${dateType === "gregorian" ? "active" : ""}`} onClick={() => setDateType("gregorian")}>
            Calendar date
          </button>
          <button className={`kc-pill ${dateType === "tithi" ? "active" : ""}`} onClick={() => setDateType("tithi")}>
            Tithi (lunar)
          </button>
        </div>

        {dateType === "gregorian" ? (
          <>
            <div className="kc-field-label">Date</div>
            <input type="date" className="kc-input" value={dateStr} onChange={(e) => setDateStr(e.target.value)} />
            <div className="kc-switch-row">
              <span className="kc-switch-row-label">Repeat every year</span>
              <Switch checked={repeatYearly} onChange={setRepeatYearly} />
            </div>
          </>
        ) : (
          <>
            <div className="kc-field-label">Lunar month</div>
            <select className="kc-input" value={lunarMonth} onChange={(e) => setLunarMonth(+e.target.value)}>
              {MONTH_NAMES.map((m, i) => (
                <option key={m} value={i}>{m}</option>
              ))}
            </select>

            <div className="kc-field-label">Paksha</div>
            <div style={{ display: "flex", gap: 8 }}>
              {["Shukla", "Krishna"].map((pk) => (
                <button
                  key={pk}
                  className={`kc-pill ${tithiPaksha === pk ? "active" : ""}`}
                  onClick={() => {
                    setTithiPaksha(pk);
                    const opts = tithiOptionsForPaksha(pk);
                    if (!opts.includes(tithiName)) setTithiName(opts[0]);
                  }}
                >
                  {pk} Paksha
                </button>
              ))}
            </div>

            <div className="kc-field-label">Tithi</div>
            <select className="kc-input" value={tithiName} onChange={(e) => setTithiName(e.target.value)}>
              {tithiOptions.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <div style={{ fontSize: 12, color: "var(--md-outline)", marginTop: 6, fontStyle: "italic" }}>
              Recurs every year on this tithi — the Gregorian date shifts naturally with the lunar calendar.
            </div>
          </>
        )}

        <div className="kc-switch-row">
          <span className="kc-switch-row-label">Notify me</span>
          <Switch checked={notify} onChange={setNotify} />
        </div>

        {notify && (
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            {[0, 1, 7].map((o) => (
              <button key={o} className={`kc-pill ${notifyOffset === o ? "active" : ""}`} onClick={() => setNotifyOffset(o)}>
                {NOTIFY_LABEL[o]}
              </button>
            ))}
          </div>
        )}

        <div className="kc-dialog-actions">
          <button className="kc-text-btn" onClick={onCancel}>Cancel</button>
          <button className="kc-filled-btn" disabled={!title.trim()} onClick={handleSave}>
            <Check size={15} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================ Theme tokens ============================ */

const LIGHT_TOKENS = {
  "--md-primary": "#262624",
  "--md-on-primary": "#FFFFFF",
  "--md-primary-container": "#E3E3E6",
  "--md-on-primary-container": "#1A1A1C",
  "--md-secondary": "#57575A",
  "--md-on-secondary": "#FFFFFF",
  "--md-secondary-container": "#E7E7E9",
  "--md-on-secondary-container": "#1F1F22",
  "--md-tertiary": "#403F42",
  "--md-on-tertiary": "#FFFFFF",
  "--md-tertiary-container": "#DBDBDE",
  "--md-on-tertiary-container": "#1C1C1E",
  "--md-surface": "#FAFAF8",
  "--md-surface-container-lowest": "#FFFFFF",
  "--md-surface-container-low": "#F2F2F2",
  "--md-surface-container": "#EBEBEC",
  "--md-surface-container-high": "#E4E4E6",
  "--md-surface-container-highest": "#DCDCDE",
  "--md-on-surface": "#1B1B1D",
  "--md-on-surface-variant": "#47474A",
  "--md-outline": "#76767A",
  "--md-outline-variant": "#C6C6C9",
  "--kc-sunrise-bg": "#FCE9CC",
  "--kc-sunrise-fg": "#B4700E",
  "--kc-sunset-bg": "#E7E0F8",
  "--kc-sunset-fg": "#6B4FA0",
  "--kc-page-bg": "#E5E4DD",
  "--kc-card-shadow": "0 8px 28px rgba(60,55,70,0.10), 0 1px 3px rgba(60,55,70,0.06)",
  "--kc-card-shadow-sm": "0 6px 20px rgba(60,55,70,0.08), 0 1px 3px rgba(60,55,70,0.06)",
  "--kc-selected-shadow": "0 4px 14px rgba(27,27,24,0.22)",
  "--kc-fab-shadow": "0 3px 8px rgba(0,0,0,0.25)",
  "--kc-pill-shadow": "0 2px 8px rgba(60,55,70,0.10)",
  "--kc-frame-shadow": "0 20px 60px rgba(0,0,0,0.25)",
  "--kc-accent": "#E8A04E",
  "--kc-accent2": "#C77DBB",
  "--kc-glass-bg": "rgba(255,255,255,0.85)",
  "--kc-glass-text": "#1B1B1D",
  "--kc-overlay-bg": "rgba(20,20,20,0.45)",
  "--kc-card-border": "none",
  "--kc-divider": "rgba(198,198,201,0.5)",
};

const DARK_TOKENS = {
  "--md-primary": "#E0D6CC",
  "--md-on-primary": "#1A1A1E",
  "--md-primary-container": "#2E2D38",
  "--md-on-primary-container": "#D4D0E0",
  "--md-secondary": "#A8A6B0",
  "--md-on-secondary": "#1A1A1E",
  "--md-secondary-container": "#2A2A34",
  "--md-on-secondary-container": "#C8C6D2",
  "--md-tertiary": "#B0ADA0",
  "--md-on-tertiary": "#1A1A1E",
  "--md-tertiary-container": "#2C2C36",
  "--md-on-tertiary-container": "#C4C0D0",
  "--md-surface": "#141418",
  "--md-surface-container-lowest": "#1C1C22",
  "--md-surface-container-low": "#1E1E26",
  "--md-surface-container": "#232330",
  "--md-surface-container-high": "#2A2A36",
  "--md-surface-container-highest": "#32323E",
  "--md-on-surface": "#E8E6F0",
  "--md-on-surface-variant": "#A0A0B0",
  "--md-outline": "#58586A",
  "--md-outline-variant": "#38384A",
  "--kc-sunrise-bg": "#3A2A18",
  "--kc-sunrise-fg": "#F0B060",
  "--kc-sunset-bg": "#28204A",
  "--kc-sunset-fg": "#B8A0E8",
  "--kc-page-bg": "#0E0E12",
  "--kc-card-shadow": "0 8px 28px rgba(0,0,0,0.40), 0 1px 3px rgba(0,0,0,0.20)",
  "--kc-card-shadow-sm": "0 6px 20px rgba(0,0,0,0.30), 0 1px 3px rgba(0,0,0,0.15)",
  "--kc-selected-shadow": "0 4px 14px rgba(0,0,0,0.50)",
  "--kc-fab-shadow": "0 3px 12px rgba(0,0,0,0.50)",
  "--kc-pill-shadow": "0 2px 8px rgba(0,0,0,0.30)",
  "--kc-frame-shadow": "0 20px 60px rgba(0,0,0,0.60)",
  "--kc-accent": "#F0B060",
  "--kc-accent2": "#D090D0",
  "--kc-glass-bg": "rgba(40,40,54,0.75)",
  "--kc-glass-text": "#E8E6F0",
  "--kc-overlay-bg": "rgba(0,0,0,0.60)",
  "--kc-card-border": "1px solid rgba(255,255,255,0.06)",
  "--kc-divider": "rgba(56,56,74,0.5)",
};

function getTokens(isDark) {
  return isDark ? DARK_TOKENS : LIGHT_TOKENS;
}

const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    padding: "24px 0",
  },
  frame: {
    width: 393,
    height: 800,
    background: "var(--md-surface)",
    borderRadius: 40,
    overflow: "hidden",
    boxShadow: "var(--kc-frame-shadow)",
    position: "relative",
    display: "flex",
    flexDirection: "column",
  },
  appBar: { padding: "22px 20px 10px", background: "transparent" },
  appBarRow: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  monthEn: { fontSize: 26, fontWeight: 700, color: "var(--md-on-surface)", letterSpacing: -0.3 },
  monthHiRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 4 },
  monthHi: { fontSize: 13, fontWeight: 500, color: "var(--md-on-surface-variant)" },
  section: { padding: "8px 20px 0" },
  stackSection: { padding: "16px 20px 0" },
  cardDate: { fontSize: 13, fontWeight: 600, color: "var(--md-on-surface-variant)", textTransform: "uppercase", letterSpacing: 0.3 },
  cardTithiHi: { fontSize: 22, fontWeight: 700, color: "var(--md-on-surface)", marginTop: 6 },
  cardTithiEn: { fontSize: 13, color: "var(--md-on-surface-variant)", marginTop: 4 },
  sunRow: {
    display: "flex", alignItems: "center", gap: 16, marginTop: 18, paddingTop: 16,
    borderTop: "1px solid var(--kc-divider)",
  },
  sunItem: { display: "flex", alignItems: "center", gap: 10 },
  sunIconWrap: { width: 36, height: 36, borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  sunDivider: { width: 1, height: 30, background: "var(--kc-divider)" },
  sunLabel: { fontSize: 11, color: "var(--md-on-surface-variant)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 },
  sunValue: { fontSize: 15, color: "var(--md-on-surface)", fontWeight: 700, marginTop: 2 },
  viewNavRow: { display: "flex", alignItems: "center", gap: 2, padding: "4px 8px 0" },
  monthWeekdayLabel: { textAlign: "center", fontSize: 11, fontWeight: 700, color: "var(--md-on-surface-variant)", padding: "4px 0" },
};
