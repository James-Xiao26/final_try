import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#0A0B0E",
        panel: "#101217",
        edge: "#00FF88",
        danger: "#FF3B5C",
        muted: "#8D95A3"
      },
      fontFamily: {
        mono: ["var(--font-plex-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        sans: ["var(--font-geist-sans)", "Inter", "ui-sans-serif", "system-ui"]
      }
    }
  },
  plugins: []
};

export default config;
