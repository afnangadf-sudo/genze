// Mobile theme: calm light/dark palette following the system appearance.
// No jargon, no pop-ups anywhere; every surface uses these colors.

export interface Theme {
  dark: boolean;
  background: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentText: string;
  danger: string;
  success: string;
}

export const lightTheme: Theme = {
  dark: false,
  background: "#faf9f7",
  card: "#ffffff",
  text: "#1c1917",
  muted: "#78716c",
  border: "#e7e5e4",
  accent: "#4f46e5",
  accentText: "#ffffff",
  danger: "#b91c1c",
  success: "#15803d",
};

export const darkTheme: Theme = {
  dark: true,
  background: "#0c0a09",
  card: "#1c1917",
  text: "#f5f5f4",
  muted: "#a8a29e",
  border: "#292524",
  accent: "#818cf8",
  accentText: "#0c0a09",
  danger: "#f87171",
  success: "#4ade80",
};
