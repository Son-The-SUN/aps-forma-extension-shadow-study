import { Forma } from "forma-embedded-view-sdk/auto";
import { useEffect, useMemo, useState } from "preact/hooks";
import { FormaElement, Urn } from "forma-embedded-view-sdk/elements/types";
import { useTranslation } from "../i18n/useTranslation";

const GROUND_TEXTURE_NAME = "shadow-study";

const DEFAULT_CONTEXT_BUILDINGS_COLOR = "#cccccc";
const DEFAULT_DESIGN_BUILDINGS_COLOR = "#ffffff";
const DEFAULT_TERRAIN_COLOR = "#ffffff";

type ElementGroups = {
  context: string[];
  design: string[];
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

/**
 * Group the paths of all elements in the hierarchy into context elements
 * (imported surroundings from the integrate element system) and design
 * elements (everything else). Terrain elements are excluded since the
 * terrain is colored through the ground texture instead.
 */
function groupElementPaths(rootUrn: Urn, elements: Record<Urn, FormaElement>): ElementGroups {
  const groups: ElementGroups = { context: [], design: [] };

  const walk = (urn: Urn, path: string, inContext: boolean) => {
    const element = elements[urn];
    if (element == null || isTerrainElement(urn, element)) {
      return;
    }

    const isContext = inContext || getElementSystem(urn) === "integrate";
    if (path !== "root") {
      (isContext ? groups.context : groups.design).push(path);
    }

    for (const child of element.children ?? []) {
      walk(child.urn, `${path}/${child.key}`, isContext);
    }
  };

  walk(rootUrn, "root", false);
  return groups;
}

/**
 * Color the ground texture with a given color
 */
async function colorGround(color: string) {
  const bbox = await Forma.terrain.getBbox();
  const canvas = document.createElement("canvas");
  const width = bbox.max.x - bbox.min.x;
  const height = bbox.max.y - bbox.min.y;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return await Forma.terrain.groundTexture.add({
    name: GROUND_TEXTURE_NAME,
    canvas: canvas,
    position: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1 },
  });
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

  const [shouldPaintContext, setShouldPaintContext] = useState(false);
  const [shouldPaintDesign, setShouldPaintDesign] = useState(false);
  const [shouldPaintTerrain, setShouldPaintTerrain] = useState(false);

  const [contextColor, setContextColor] = useState(DEFAULT_CONTEXT_BUILDINGS_COLOR);
  const [designColor, setDesignColor] = useState(DEFAULT_DESIGN_BUILDINGS_COLOR);
  const [terrainColor, setTerrainColor] = useState(DEFAULT_TERRAIN_COLOR);

  const [elementGroups, setElementGroups] = useState<ElementGroups>({ context: [], design: [] });
  const [rootUrn, setRootUrn] = useState<Urn | undefined>();

  const setContextColorDebounced = useMemo(() => debounce(setContextColor, 50), []);
  const setDesignColorDebounced = useMemo(() => debounce(setDesignColor, 50), []);
  const setTerrainColorDebounced = useMemo(() => debounce(setTerrainColor, 50), []);

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
    if (shouldPaintTerrain) {
      colorGround(terrainColor);
    } else {
      Forma.terrain.groundTexture.remove({ name: GROUND_TEXTURE_NAME });
    }
  }, [shouldPaintTerrain, terrainColor]);

  const onResetColors = () => {
    setShouldPaintContext(false);
    setShouldPaintDesign(false);
    setShouldPaintTerrain(false);
    setContextColor(DEFAULT_CONTEXT_BUILDINGS_COLOR);
    setDesignColor(DEFAULT_DESIGN_BUILDINGS_COLOR);
    setTerrainColor(DEFAULT_TERRAIN_COLOR);
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
    </>
  );
}
