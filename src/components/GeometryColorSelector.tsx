import { Forma } from "forma-embedded-view-sdk/auto";
import { useEffect, useMemo, useState } from "preact/hooks";
import { FormaElement, Urn } from "forma-embedded-view-sdk/elements/types";
import { useTranslation } from "../i18n/useTranslation";
import { DEFAULT_SHADOW_OPACITY, shadowOverlay } from "../shadowOverlay";

const DEFAULT_CONTEXT_BUILDINGS_COLOR = "#cccccc";
const DEFAULT_DESIGN_BUILDINGS_COLOR = "#ffffff";
const DEFAULT_CONTEXT_SHADOWS_COLOR = "#4d4d4d";
const DEFAULT_DESIGN_SHADOWS_COLOR = "#31437c";
const DEFAULT_TERRAIN_COLOR = "#ffffff";

type ElementGroups = {
  context: string[];
  design: string[];
  terrain: string[];
};

/**
 * Element URNs follow the scheme `urn:adsk-forma-elements:{system}:{authcontext}:{id}:{revision}`.
 */
function getElementSystem(urn: Urn): string {
  return urn.split(":")[2];
}

function isTerrainElement(urn: Urn, element: FormaElement): boolean {
  return element.properties?.category === "terrain" || getElementSystem(urn) === "terrain";
}

function isBaseElement(urn: Urn): boolean {
  return getElementSystem(urn) === "base";
}

/**
 * Group the paths of all elements in the hierarchy into context elements
 * (everything in a base layer, i.e. the surroundings shared between
 * proposals) and design elements (everything else in the proposal, whether
 * drawn natively in Forma or uploaded). Terrain elements are grouped
 * separately: they cast no shadows and are colored through the ground
 * texture, but their mesh is what shadows are projected onto.
 *
 * If the proposal has no base layer, falls back to treating elements
 * imported through the integrate element system as design and everything
 * else as context.
 */
function groupElementPaths(rootUrn: Urn, elements: Record<Urn, FormaElement>): ElementGroups {
  const groups: ElementGroups = { context: [], design: [], terrain: [] };
  const hasBase = Object.keys(elements).some((urn) => isBaseElement(urn as Urn));

  const walk = (urn: Urn, path: string, inBase: boolean, inDesign: boolean) => {
    const element = elements[urn];
    if (element == null) {
      return;
    }
    if (isTerrainElement(urn, element)) {
      if (path !== "root") {
        groups.terrain.push(path);
      }
      return;
    }

    const isInBase = inBase || isBaseElement(urn);
    const isDesign = hasBase ? !isInBase : inDesign || getElementSystem(urn) === "integrate";
    if (path !== "root") {
      (isDesign ? groups.design : groups.context).push(path);
    }

    for (const child of element.children ?? []) {
      walk(child.urn, `${path}/${child.key}`, isInBase, isDesign);
    }
  };

  walk(rootUrn, "root", false, false);
  return groups;
}

/**
 * Reduce a group of paths to only the topmost ones, since hiding an element
 * also hides all of its children.
 */
function topLevelPaths(paths: string[]): string[] {
  const set = new Set(paths);
  return paths.filter((path) => !set.has(path.slice(0, path.lastIndexOf("/"))));
}

/**
 * Will debounce the function call to avoid calling it too often.
 * Useful for avoiding color input events to be called too often.
 */
export const debounce = <F extends (...args: any[]) => ReturnType<F>>(func: F, waitFor: number) => {
  let timeout: number | undefined;

  return (...args: Parameters<F>): Promise<ReturnType<F>> =>
    new Promise((resolve) => {
      if (timeout) {
        clearTimeout(timeout);
      }

      timeout = setTimeout(() => resolve(func(...args)), waitFor);
    });
};

type ColorRowProps = {
  label: string;
  checked: boolean;
  setChecked: (checked: boolean) => void;
  color: string;
  setColor: (color: string) => void;
};

function ColorRow({ label, checked, setChecked, color, setColor }: ColorRowProps) {
  return (
    <div class="row">
      <div class="row-title" style={{ width: "60%" }}>
        <weave-checkbox
          checked={checked}
          label={label}
          showlabel
          onChange={(e) => setChecked(e.detail.checked)}
        ></weave-checkbox>
      </div>
      <div class="row-item">
        <input
          type="color"
          class={"color-picker"}
          value={color}
          onInput={(e) => {
            if (e.target instanceof HTMLInputElement) setColor(e.target.value);
          }}
        />
      </div>
    </div>
  );
}

export default function GeometryColorSelector() {
  const { t } = useTranslation();

  const [showContext, setShowContext] = useState(true);
  const [showDesign, setShowDesign] = useState(true);

  const [shouldPaintContext, setShouldPaintContext] = useState(false);
  const [shouldPaintDesign, setShouldPaintDesign] = useState(false);
  const [shouldPaintContextShadows, setShouldPaintContextShadows] = useState(false);
  const [shouldPaintDesignShadows, setShouldPaintDesignShadows] = useState(false);
  const [shouldPaintTerrain, setShouldPaintTerrain] = useState(false);

  const [contextColor, setContextColor] = useState(DEFAULT_CONTEXT_BUILDINGS_COLOR);
  const [designColor, setDesignColor] = useState(DEFAULT_DESIGN_BUILDINGS_COLOR);
  const [contextShadowsColor, setContextShadowsColor] = useState(DEFAULT_CONTEXT_SHADOWS_COLOR);
  const [designShadowsColor, setDesignShadowsColor] = useState(DEFAULT_DESIGN_SHADOWS_COLOR);
  const [terrainColor, setTerrainColor] = useState(DEFAULT_TERRAIN_COLOR);
  const [shadowOpacity, setShadowOpacity] = useState(DEFAULT_SHADOW_OPACITY);

  const [elementGroups, setElementGroups] = useState<ElementGroups>({
    context: [],
    design: [],
    terrain: [],
  });
  const [rootUrn, setRootUrn] = useState<Urn | undefined>();

  const setContextColorDebounced = useMemo(() => debounce(setContextColor, 50), []);
  const setDesignColorDebounced = useMemo(() => debounce(setDesignColor, 50), []);
  const setContextShadowsColorDebounced = useMemo(() => debounce(setContextShadowsColor, 50), []);
  const setDesignShadowsColorDebounced = useMemo(() => debounce(setDesignShadowsColor, 50), []);
  const setTerrainColorDebounced = useMemo(() => debounce(setTerrainColor, 50), []);
  const setShadowOpacityDebounced = useMemo(() => debounce(setShadowOpacity, 50), []);

  useEffect(() => {
    Forma.proposal.getRootUrn().then((rootUrn) => {
      setRootUrn(rootUrn as Urn);
    });
    Forma.proposal.subscribe(
      ({ rootUrn }) => {
        setRootUrn(rootUrn as Urn);
      },
      { debouncedPersistedOnly: true },
    );
  }, []);

  useEffect(() => {
    if (rootUrn != null) {
      Forma.elements.get({ urn: rootUrn as Urn, recursive: true }).then(({ elements }) => {
        setElementGroups(groupElementPaths(rootUrn as Urn, elements));
      });
    }
  }, [rootUrn]);

  useEffect(() => {
    const pathsToColor = new Map<string, string>();
    if (shouldPaintContext) {
      for (const path of elementGroups.context) {
        pathsToColor.set(path, contextColor);
      }
    }
    if (shouldPaintDesign) {
      for (const path of elementGroups.design) {
        pathsToColor.set(path, designColor);
      }
    }

    if (pathsToColor.size === 0) {
      Forma.render.elementColors.clearAll();
      return;
    }

    const pathsToClear = [
      ...(shouldPaintContext ? [] : elementGroups.context),
      ...(shouldPaintDesign ? [] : elementGroups.design),
    ];
    if (pathsToClear.length > 0) {
      Forma.render.elementColors.clear({ paths: pathsToClear });
    }
    Forma.render.elementColors.set({ pathsToColor });
  }, [shouldPaintContext, shouldPaintDesign, contextColor, designColor, elementGroups]);

  useEffect(() => {
    for (const path of topLevelPaths(elementGroups.context)) {
      if (showContext) {
        Forma.render.unhideElement({ path });
      } else {
        Forma.render.hideElement({ path });
      }
    }
  }, [showContext, elementGroups]);

  useEffect(() => {
    for (const path of topLevelPaths(elementGroups.design)) {
      if (showDesign) {
        Forma.render.unhideElement({ path });
      } else {
        Forma.render.hideElement({ path });
      }
    }
  }, [showDesign, elementGroups]);

  useEffect(() => {
    if (elementGroups.context.length > 0 || elementGroups.design.length > 0) {
      shadowOverlay.loadGeometry(
        {
          context: topLevelPaths(elementGroups.context),
          design: topLevelPaths(elementGroups.design),
        },
        elementGroups.terrain,
      );
    }
  }, [elementGroups]);

  useEffect(() => {
    shadowOverlay.setSettings({
      // Hidden buildings should not cast shadows in the overlay either.
      contextShadows: {
        enabled: shouldPaintContextShadows && showContext,
        color: contextShadowsColor,
      },
      designShadows: {
        enabled: shouldPaintDesignShadows && showDesign,
        color: designShadowsColor,
      },
      terrain: { enabled: shouldPaintTerrain, color: terrainColor },
      shadowOpacity,
    });
  }, [
    shouldPaintContextShadows,
    shouldPaintDesignShadows,
    shouldPaintTerrain,
    contextShadowsColor,
    designShadowsColor,
    terrainColor,
    shadowOpacity,
    showContext,
    showDesign,
  ]);

  const onResetColors = () => {
    setShouldPaintContext(false);
    setShouldPaintDesign(false);
    setShouldPaintContextShadows(false);
    setShouldPaintDesignShadows(false);
    setShouldPaintTerrain(false);
    setContextColor(DEFAULT_CONTEXT_BUILDINGS_COLOR);
    setDesignColor(DEFAULT_DESIGN_BUILDINGS_COLOR);
    setContextShadowsColor(DEFAULT_CONTEXT_SHADOWS_COLOR);
    setDesignShadowsColor(DEFAULT_DESIGN_SHADOWS_COLOR);
    setTerrainColor(DEFAULT_TERRAIN_COLOR);
    setShadowOpacity(DEFAULT_SHADOW_OPACITY);
  };

  return (
    <>
      <div class="section-title">{t("colorConfig.title")}</div>
      <ColorRow
        label={t("colorConfig.contextBuildings")}
        checked={shouldPaintContext}
        setChecked={setShouldPaintContext}
        color={contextColor}
        setColor={setContextColorDebounced}
      />
      <ColorRow
        label={t("colorConfig.designBuildings")}
        checked={shouldPaintDesign}
        setChecked={setShouldPaintDesign}
        color={designColor}
        setColor={setDesignColorDebounced}
      />
      <ColorRow
        label={t("colorConfig.contextShadows")}
        checked={shouldPaintContextShadows}
        setChecked={setShouldPaintContextShadows}
        color={contextShadowsColor}
        setColor={setContextShadowsColorDebounced}
      />
      <ColorRow
        label={t("colorConfig.designShadows")}
        checked={shouldPaintDesignShadows}
        setChecked={setShouldPaintDesignShadows}
        color={designShadowsColor}
        setColor={setDesignShadowsColorDebounced}
      />
      <div class="row">
        <div class="row-title" style={{ width: "60%" }}>
          {t("colorConfig.shadowOpacity")}
        </div>
        <div class="row-item">
          <input
            type="range"
            class="opacity-slider"
            min="5"
            max="100"
            step="5"
            value={Math.round(shadowOpacity * 100)}
            onInput={(e) => {
              if (e.target instanceof HTMLInputElement) {
                setShadowOpacityDebounced(Number(e.target.value) / 100);
              }
            }}
          />
          <span class="opacity-value">{Math.round(shadowOpacity * 100)}%</span>
        </div>
      </div>
      <ColorRow
        label={t("colorConfig.terrain")}
        checked={shouldPaintTerrain}
        setChecked={setShouldPaintTerrain}
        color={terrainColor}
        setColor={setTerrainColorDebounced}
      />
      <div class="row">
        <weave-button variant="flat" onClick={onResetColors}>
          {t("colorConfig.resetColors")}
        </weave-button>
      </div>
      <div class="section-title">{t("visibility.title")}</div>
      <div class="row">
        <div class="row-title">
          <weave-checkbox
            checked={showContext}
            label={t("colorConfig.contextBuildings")}
            showlabel
            onChange={(e) => setShowContext(e.detail.checked)}
          ></weave-checkbox>
        </div>
      </div>
      <div class="row">
        <div class="row-title">
          <weave-checkbox
            checked={showDesign}
            label={t("colorConfig.designBuildings")}
            showlabel
            onChange={(e) => setShowDesign(e.detail.checked)}
          ></weave-checkbox>
        </div>
      </div>
    </>
  );
}
