import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        clay: {
          DEFAULT: "#C2613E",
          dark: "#A94E30",
          soft: "#F6E9E1",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "var(--font-urdu)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
