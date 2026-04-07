import { render } from "preact";
import { Forma } from "forma-embedded-view-sdk/auto";
import i18n, { resolveLocale } from "./i18n/i18n";
import App from "./app.tsx";

const langOverride = new URLSearchParams(window.location.search).get("lang");
if (langOverride) {
  i18n.changeLanguage(resolveLocale(langOverride));
}

const onLocale = ({ locale }: { locale: string }) => {
  i18n.changeLanguage(resolveLocale(locale));
};

const formaWithLocale = Forma as typeof Forma & {
  onLocaleUpdate?: (handler: (payload: { locale: string }) => void) => Promise<unknown>;
  createSubscription?: (
    name: string,
    handler: (payload: { locale: string }) => void,
  ) => Promise<{ unsubscribe: () => void }>;
};

if (typeof formaWithLocale.onLocaleUpdate === "function") {
  void formaWithLocale.onLocaleUpdate(onLocale);
} else if (typeof formaWithLocale.createSubscription === "function") {
  // SDK 0.87 fallback: subscribe to the same event channel used by onLocaleUpdate in newer SDKs.
  void formaWithLocale.createSubscription("on-locale-update", onLocale);
}

render(<App />, document.getElementById("app")!);
