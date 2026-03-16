import _ from "lodash";
import { useTranslation } from "../i18n/useTranslation";

type DateSelectorProps = {
  month: number;
  setMonth: (month: number) => void;
  day: number;
  setDay: (day: number) => void;
};

const getMonthName = (month: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { month: "long" }).format(new Date(2024, month));

export default function DateSelector(props: DateSelectorProps) {
  const { t, locale } = useTranslation();
  const { month, setMonth, day, setDay } = props;

  return (
    <div class="row">
      <div class="row-title">{t("date.label")}</div>
      <div class="row-item">
        <weave-select
          value={month}
          onChange={(event) => setMonth(parseInt((event as CustomEvent).detail.value, 10))}
          style={{ width: "100px" }}
        >
          {/* Luxon uses 1-indexed months, so we add 1 to the value */}
          {_.range(12).map((index) => (
            <weave-select-option value={index + 1}>{getMonthName(index, locale)}</weave-select-option>
          ))}
        </weave-select>
        <weave-select
          value={day}
          onChange={(event) => setDay(parseInt((event as CustomEvent).detail.value, 10))}
          style={{ width: "70px", marginLeft: "5px" }}
        >
          {_.range(1, 31).map((value) => (
            <weave-select-option value={value}>{value.toString()}</weave-select-option>
          ))}
        </weave-select>
      </div>
    </div>
  );
}
