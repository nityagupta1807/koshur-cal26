import React from "react";
import { createRoot } from "react-dom/client";
import KashmiriCalendar from "./KashmiriCalendar.jsx";

// The calendar component persists reminders through `window.storage`, an API
// that exists inside Claude's artifact runtime. In a standalone build we
// provide a small localStorage-backed shim with the same async interface so
// reminders survive page reloads.
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key) {
      const v = localStorage.getItem("kc:" + key);
      if (v === null) throw new Error("not found");
      return { key, value: v, shared: false };
    },
    async set(key, value) {
      localStorage.setItem("kc:" + key, value);
      return { key, value, shared: false };
    },
    async delete(key) {
      localStorage.removeItem("kc:" + key);
      return { key, deleted: true, shared: false };
    },
    async list(prefix = "") {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("kc:" + prefix)) keys.push(k.slice(3));
      }
      return { keys, prefix, shared: false };
    },
  };
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <KashmiriCalendar />
  </React.StrictMode>
);
