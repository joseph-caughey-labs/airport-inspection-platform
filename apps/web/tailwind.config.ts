import type { Config } from "tailwindcss";

/**
 * Tailwind config — dark-mode first, enterprise ops-center palette.
 * See ROLES/05_ui-ux-designer.md for the design system rationale.
 */
export default {
  darkMode: "class",
  content: [
    "./components/**/*.{vue,ts}",
    "./layouts/**/*.vue",
    "./pages/**/*.vue",
    "./plugins/**/*.{ts,vue}",
    "./app.vue",
    "./error.vue",
  ],
  theme: {
    extend: {
      colors: {
        // Background tiers: near-black base, slightly lighter panels,
        // even lighter elevated surfaces. No pure black anywhere.
        aip: {
          base: "#0b0f14",
          panel: "#11161c",
          elevated: "#161d25",
          border: "#1f2933",
          fg: "#e6ebf1",
          muted: "#8b9aa9",
          accent: "#22d3ee", // cyan accent — single brand moment
        },
        // Severity scale — shape + position pair with color per UX role doc.
        severity: {
          critical: "#dc2626",
          high: "#ea580c",
          medium: "#d97706",
          low: "#0284c7",
          info: "#475569",
          resolved: "#16a34a",
          ack: "#64748b",
        },
        // Connection state pill.
        conn: {
          ok: "#16a34a",
          stale: "#d97706",
          down: "#dc2626",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      fontVariantNumeric: {
        tabular: "tabular-nums",
      },
    },
  },
  plugins: [],
} satisfies Config;
