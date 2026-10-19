import type { Metadata } from "next";
import { Inter, Noto_Nastaliq_Urdu, Noto_Naskh_Arabic, Vazirmatn } from "next/font/google";
import "./globals.css";
import { LangProvider } from "../lib/lang";
import { ThemeProvider } from "../lib/theme";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const urdu = Noto_Nastaliq_Urdu({ subsets: ["arabic"], variable: "--font-urdu" });
const naskh = Noto_Naskh_Arabic({ subsets: ["arabic"], variable: "--font-arabic" });
const vazir = Vazirmatn({ subsets: ["arabic", "latin"], variable: "--font-fa" });

export const metadata: Metadata = {
  title: "Genze",
  description: "A calm place to think, write and create.",
};

// Sets theme class + language + reading direction before first paint, so there is no flash.
const BOOT_SCRIPT = `(function(){try{
var t=localStorage.getItem('genze_theme');
if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}
var l=localStorage.getItem('genze_lang');
var rtl={ur:1,ar:1,fa:1};
if(l==='en'||l==='ur'||l==='ar'||l==='tr'||l==='fa'){document.documentElement.lang=l;document.documentElement.dir=rtl[l]?'rtl':'ltr';}
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${urdu.variable} ${naskh.variable} ${vazir.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <LangProvider>{children}</LangProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
