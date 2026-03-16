import { render } from "preact";
import { Forma } from "forma-embedded-view-sdk/auto";
import i18n from "./i18n/i18n";
import App from "./app.tsx";

const langOverride = new URLSearchParams(window.location.search).get("lang");
if (langOverride) {
  i18n.changeLanguage(langOverride);
}

Forma.onLocaleUpdate(({ locale }) => {
  i18n.changeLanguage(locale);
});

render(<App />, document.getElementById("app")!);
