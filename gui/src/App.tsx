import { useEffect, useState } from "react";
import Dashboard from "./pages/Dashboard";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Subagents from "./pages/Subagents";
import Logs from "./pages/Logs";
import { IconGrid, IconServer, IconBoxes, IconBot, IconList, IconGithub, IconSun, IconMoon, IconMonitor, IconGlobe } from "./icons";
import { useI18n, useT, LOCALES, type TKey } from "./i18n";

type Page = "dashboard" | "providers" | "models" | "subagents" | "logs";
type Theme = "light" | "dark" | "system";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const THEME_KEY = "ocx-theme";

const NAV: { id: Page; tkey: TKey; Icon: typeof IconGrid }[] = [
  { id: "dashboard", tkey: "nav.dashboard", Icon: IconGrid },
  { id: "providers", tkey: "nav.providers", Icon: IconServer },
  { id: "models", tkey: "nav.models", Icon: IconBoxes },
  { id: "subagents", tkey: "nav.subagents", Icon: IconBot },
  { id: "logs", tkey: "nav.logs", Icon: IconList },
];

const THEME_ICON = { light: IconSun, dark: IconMoon, system: IconMonitor } as const;
const THEME_TKEY: Record<Theme, TKey> = { light: "theme.light", dark: "theme.dark", system: "theme.system" };

function readStoredTheme(): Theme {
  const t = localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" ? t : "system";
}

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const { locale, setLocale } = useI18n();
  const t = useT();

  // Pin color-scheme via [data-theme]; "system" clears it so the OS preference applies (matches the
  // FOWT guard in index.html). Persisted so the choice survives reloads.
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") { el.removeAttribute("data-theme"); localStorage.removeItem(THEME_KEY); }
    else { el.setAttribute("data-theme", theme); localStorage.setItem(THEME_KEY, theme); }
  }, [theme]);

  const cycleTheme = () => setTheme(t => (t === "light" ? "dark" : t === "dark" ? "system" : "light"));
  const ThemeIcon = THEME_ICON[theme];

  const langName = LOCALES.find(l => l.code === locale)?.name ?? "English";
  const cycleLang = () => {
    const order = LOCALES.map(l => l.code);
    setLocale(order[(order.indexOf(locale) + 1) % order.length]);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-logo" role="img" aria-label="opencodex logo" />
          <span className="name">opencodex</span>
          <span className="ver">v{__APP_VERSION__}</span>
        </div>
        <nav>
          {NAV.map(({ id, tkey, Icon }) => (
            <button key={id} className={`nav-item${page === id ? " active" : ""}`} onClick={() => setPage(id)}
              aria-current={page === id ? "page" : undefined}>
              <Icon /> {t(tkey)}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="theme-toggle" onClick={cycleLang}
            aria-label={`${t("lang.label")}: ${langName}`} title={`${t("lang.label")}: ${langName}`}>
            <IconGlobe /> <span className="mode">{langName}</span>
          </button>
          <button type="button" className="theme-toggle" onClick={cycleTheme}
            aria-label={`${t("theme.label")}: ${t(THEME_TKEY[theme])}`} title={`${t("theme.label")}: ${t(THEME_TKEY[theme])}`}>
            <ThemeIcon /> <span className="mode">{t(THEME_TKEY[theme])}</span>
          </button>
          <a className="sidebar-link" href="https://github.com/lidge-jun/opencodex" target="_blank" rel="noreferrer">
            <IconGithub /> {t("common.github")}
          </a>
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">
          {page === "dashboard" && <Dashboard apiBase={API_BASE} />}
          {page === "providers" && <Providers apiBase={API_BASE} />}
          {page === "models" && <Models apiBase={API_BASE} />}
          {page === "subagents" && <Subagents apiBase={API_BASE} />}
          {page === "logs" && <Logs apiBase={API_BASE} />}
        </div>
      </main>
    </div>
  );
}
