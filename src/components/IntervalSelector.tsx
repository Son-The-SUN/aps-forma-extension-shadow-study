import { useTranslation } from "../i18n/useTranslation";

type IntervalSelectorProps = {
  interval: number;
  setInterval: (interval: number) => void;
};

export default function IntervalSelector(props: IntervalSelectorProps) {
  const { t } = useTranslation();
  const { interval, setInterval } = props;
  return (
    <div class="row">
      <div class="row-title">{t("frequency.label")}</div>
      <div class="row-item">
        <weave-select
          value={interval}
          onChange={(event) => setInterval(parseInt((event as CustomEvent).detail.value, 10))}
        >
          <weave-select-option value="5">{t("frequency.every5min")}</weave-select-option>
          <weave-select-option value="15">{t("frequency.every15min")}</weave-select-option>
          <weave-select-option value="30">{t("frequency.every30min")}</weave-select-option>
          <weave-select-option value="60">{t("frequency.everyHour")}</weave-select-option>
          <weave-select-option value="120">{t("frequency.every2hours")}</weave-select-option>
        </weave-select>
      </div>
    </div>
  );
}
