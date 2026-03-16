import i18next, { type Resource } from "i18next";

const localeFiles = import.meta.glob("./translations/*/texts.json", {
  eager: true,
});

const resources: Resource = {};
for (const path in localeFiles) {
  const locale = /translations\/([^/]+)\//.exec(path)?.[1];
  if (locale) {
    resources[locale] = {
      translation: localeFiles[path] as Record<string, unknown>,
    };
  }
}

i18next.init({
  lng: "en-US",
  fallbackLng: "en-US",
  resources,
  nonExplicitSupportedLngs: true,
  interpolation: { escapeValue: false },
});

export default i18next;
