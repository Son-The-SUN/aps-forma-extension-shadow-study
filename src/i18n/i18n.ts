import i18next, { type Resource } from "i18next";

const localeFiles = import.meta.glob<Record<string, unknown>>("./translations/*/texts.json", {
  eager: true,
  import: "default",
});

const resources: Resource = {};
for (const path in localeFiles) {
  const locale = /translations\/([^/]+)\//.exec(path)?.[1];
  if (locale) {
    resources[locale] = {
      translation: localeFiles[path],
    };
  }
}

const supportedLocales = new Set(Object.keys(resources));

const toBcp47 = (locale: string) =>
  locale
    .replace(/_/g, "-")
    .split("-")
    .map((segment, index) => {
      if (index === 0) return segment.toLowerCase();
      if (segment.length === 2) return segment.toUpperCase();
      return segment;
    })
    .join("-");

export const resolveLocale = (locale: string) => {
  const cleaned = locale.trim();
  if (!cleaned) return "en-US";

  if (supportedLocales.has(cleaned)) return cleaned;

  const bcp47 = toBcp47(cleaned);
  if (supportedLocales.has(bcp47)) return bcp47;

  const language = bcp47.split("-")[0];
  const languageMatch = [...supportedLocales].find((supported) => supported.startsWith(`${language}-`));
  return languageMatch ?? "en-US";
};

i18next.init({
  lng: "en-US",
  fallbackLng: "en-US",
  resources,
  nonExplicitSupportedLngs: true,
  interpolation: { escapeValue: false },
});

export default i18next;
