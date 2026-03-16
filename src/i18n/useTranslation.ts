import { signal } from "@preact/signals";
import i18n from "./i18n";

export const localeSignal = signal(i18n.language);

i18n.on("languageChanged", (lng: string) => {
  localeSignal.value = lng;
});

export function useTranslation() {
  localeSignal.value;

  return {
    t: (key: string, options?: Record<string, unknown>): string => {
      return i18n.t(key, options) as string;
    },
    locale: localeSignal.value,
  };
}
