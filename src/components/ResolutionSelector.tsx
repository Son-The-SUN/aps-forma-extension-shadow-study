import { useTranslation } from "../i18n/useTranslation";

type ResolutionSelectorProps = {
  resolution: string;
  setResolution: (resolution: string) => void;
};

export default function ResolutionSelector(props: ResolutionSelectorProps) {
  const { t } = useTranslation();
  const { resolution, setResolution } = props;
  return (
    <div class="row">
      <div class="row-title">{t("size.label")}</div>
      <div class="row-item">
        <weave-select
          value={resolution}
          onChange={(event) => setResolution((event as CustomEvent).detail.value)}
        >
          <weave-select-option value="512x384">
            {t("size.small", { resolution: "512x384" })}
          </weave-select-option>
          <weave-select-option value="1024x768">
            {t("size.medium", { resolution: "1024x768" })}
          </weave-select-option>
          <weave-select-option value="2048x1536">
            {t("size.large", { resolution: "2048x1536" })}
          </weave-select-option>
          <weave-select-option value="3840x2160">
            {t("size.fourK", { resolution: "3840x2160" })}
          </weave-select-option>
        </weave-select>
      </div>
    </div>
  );
}
