import { Forma } from "forma-embedded-view-sdk/auto";
import { getPosition } from "suncalc";

export type ShadowGroup = "context" | "design";

export type ShadowOverlaySettings = {
  contextShadows: { enabled: boolean; color: string };
  designShadows: { enabled: boolean; color: string };
  terrain: { enabled: boolean; color: string };
};

const GROUND_TEXTURE_NAME = "shadow-study";
const SHADOW_ALPHA = 0.55;
const SUN_POLL_INTERVAL_MS = 500;

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

type CasterFootprint = { x: number; y: number; minZ: number };

type CasterMesh = {
  positions: Float32Array;
  /** Elevation of the ground plane this mesh's shadow is projected onto. */
  groundZ: number;
};

/**
 * Renders shadows cast by buildings as a colored ground texture overlay,
 * so shadows from context and design buildings can be told apart.
 *
 * Shadows are computed by projecting each building triangle along the sun
 * direction onto a horizontal ground plane at the terrain elevation of the
 * building's footprint, and rasterizing the projected triangles into a canvas
 * which is draped over the terrain. The sun position is derived from the
 * scene date and the project geolocation using suncalc.
 *
 * Limitation: each mesh is projected onto a single ground plane, so shadows
 * can still drift where the terrain elevation changes a lot along the shadow
 * (steep slopes, or merged context meshes spanning uneven ground).
 */
class ShadowOverlay {
  private casters: Record<ShadowGroup, CasterMesh[]> = { context: [], design: [] };
  private bbox:
    | { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
    | undefined;
  private latitude = 0;
  private longitude = 0;
  private hasGeometry = false;

  private settings: ShadowOverlaySettings = {
    contextShadows: { enabled: false, color: "#4d4d4d" },
    designShadows: { enabled: false, color: "#31437c" },
    terrain: { enabled: false, color: "#ffffff" },
  };

  private textureVisible = false;
  private lastDrawKey = "";
  private lastSunTime = 0;
  private pollTimer: number | undefined;
  private refreshQueue: Promise<void> = Promise.resolve();

  /**
   * Fetch the mesh for each group of building paths, together with the
   * terrain extents and project location needed to place shadows.
   */
  async loadGeometry(groupPaths: Record<ShadowGroup, string[]>): Promise<void> {
    const [bbox, geoLocation] = await Promise.all([
      Forma.terrain.getBbox(),
      Forma.project.getGeoLocation(),
    ]);
    this.bbox = bbox;
    if (geoLocation) {
      [this.latitude, this.longitude] = geoLocation;
      console.debug(`[shadow-study] project location: lat ${this.latitude}, lon ${this.longitude}`);
    } else {
      console.warn(
        "[shadow-study] project has no geolocation -- shadow overlay directions will be wrong",
      );
    }
    console.debug(
      `[shadow-study] terrain bbox x ${bbox.min.x.toFixed(0)}..${bbox.max.x.toFixed(0)}, ` +
        `y ${bbox.min.y.toFixed(0)}..${bbox.max.y.toFixed(0)}, ` +
        `z ${bbox.min.z.toFixed(1)}..${bbox.max.z.toFixed(1)}`,
    );

    for (const group of ["context", "design"] as ShadowGroup[]) {
      const meshes = await Promise.all(
        groupPaths[group].map((path) => Forma.geometry.getTriangles({ path })),
      );
      const casters: CasterMesh[] = [];
      for (let index = 0; index < meshes.length; index++) {
        const footprint = this.casterFootprint(meshes[index], group, groupPaths[group][index]);
        if (footprint != null) {
          casters.push({
            positions: meshes[index],
            groundZ: await this.groundElevationFor(footprint),
          });
        }
      }
      this.casters[group] = casters;
    }

    this.hasGeometry = true;
    this.lastDrawKey = "";
    this.requestRefresh();
    this.startPolling();
  }

  /**
   * Decide whether a mesh can cast a meaningful shadow, filtering out flat
   * overlays (roads, zones, site limits) which have no height. For casters,
   * returns the footprint center and base elevation used to pick the ground
   * plane their shadow is projected onto.
   */
  private casterFootprint(
    mesh: Float32Array,
    group: ShadowGroup,
    path: string,
  ): CasterFootprint | null {
    if (mesh.length < 9) {
      return null;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i + 2 < mesh.length; i += 3) {
      minX = Math.min(minX, mesh[i]);
      maxX = Math.max(maxX, mesh[i]);
      minY = Math.min(minY, mesh[i + 1]);
      maxY = Math.max(maxY, mesh[i + 1]);
      minZ = Math.min(minZ, mesh[i + 2]);
      maxZ = Math.max(maxZ, mesh[i + 2]);
    }

    const keep = maxZ - minZ >= 0.5;
    console.debug(
      `[shadow-study] ${group} caster ${path}: ` +
        `xy ${(maxX - minX).toFixed(0)}x${(maxY - minY).toFixed(0)}m, ` +
        `z ${minZ.toFixed(1)}..${maxZ.toFixed(1)}m, ` +
        `${mesh.length / 9} triangles -> ${keep ? "kept" : "skipped (flat)"}`,
    );
    return keep ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2, minZ } : null;
  }

  /**
   * Ground plane elevation for a caster: the terrain elevation at its
   * footprint center, so the shadow stays attached to the building base the
   * same way Forma's own shadows are. Falls back to the mesh base elevation
   * if the terrain query fails or disagrees with the mesh coordinate frame.
   */
  private async groundElevationFor(footprint: CasterFootprint): Promise<number> {
    if (this.bbox != null) {
      try {
        const elevation = await Forma.terrain.getElevationAt({ x: footprint.x, y: footprint.y });
        // Terrain elevations live inside the terrain bbox z range; a value
        // outside it means the query did not resolve in the mesh coordinate
        // frame and cannot be trusted.
        if (elevation >= this.bbox.min.z - 1 && elevation <= this.bbox.max.z + 1) {
          console.debug(
            `[shadow-study] ground plane at (${footprint.x.toFixed(0)}, ${footprint.y.toFixed(0)}): ` +
              `terrain z ${elevation.toFixed(1)}, mesh base z ${footprint.minZ.toFixed(1)}`,
          );
          return elevation;
        }
        console.warn(
          `[shadow-study] terrain elevation ${elevation.toFixed(1)} is outside the terrain bbox ` +
            `z range -- using mesh base z ${footprint.minZ.toFixed(1)} instead`,
        );
      } catch (error) {
        console.warn("[shadow-study] getElevationAt failed -- using mesh base elevation", error);
      }
    }
    return footprint.minZ;
  }

  setSettings(settings: ShadowOverlaySettings): void {
    this.settings = settings;
    this.requestRefresh();
  }

  /**
   * Redraw the overlay for the given date (defaults to the current scene
   * date). Awaiting this guarantees the ground texture is up to date, which
   * matters when capturing images right after moving the sun.
   */
  refresh(date?: Date): Promise<void> {
    this.refreshQueue = this.refreshQueue.then(() => this.draw(date));
    return this.refreshQueue;
  }

  private requestRefresh(): void {
    void this.refresh();
  }

  /**
   * Poll the scene for sun changes (e.g. the user dragging Forma's own sun
   * slider) since the SDK has no subscription for the sun position.
   */
  private startPolling(): void {
    if (this.pollTimer != null) {
      return;
    }
    this.pollTimer = setInterval(async () => {
      const date = await Forma.sun.getDate();
      if (date.getTime() !== this.lastSunTime) {
        this.requestRefresh();
      }
    }, SUN_POLL_INTERVAL_MS);
  }

  private async draw(date?: Date): Promise<void> {
    if (!this.hasGeometry || this.bbox == null) {
      return;
    }

    const sunDate = date ?? (await Forma.sun.getDate());
    this.lastSunTime = sunDate.getTime();

    const { contextShadows, designShadows, terrain } = this.settings;
    const anyShadows = contextShadows.enabled || designShadows.enabled;
    if (!anyShadows && !terrain.enabled) {
      if (this.textureVisible) {
        this.textureVisible = false;
        this.lastDrawKey = "";
        await Forma.terrain.groundTexture.remove({ name: GROUND_TEXTURE_NAME });
      }
      return;
    }

    const drawKey = JSON.stringify([anyShadows ? sunDate.getTime() : 0, this.settings]);
    if (drawKey === this.lastDrawKey) {
      return;
    }
    this.lastDrawKey = drawKey;

    const width = Math.ceil(this.bbox.max.x - this.bbox.min.x);
    const height = Math.ceil(this.bbox.max.y - this.bbox.min.y);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    if (terrain.enabled) {
      ctx.fillStyle = terrain.color;
      ctx.fillRect(0, 0, width, height);
    }

    if (anyShadows) {
      // suncalc v2 returns degrees: azimuth clockwise from north (0 = N,
      // 90 = E), altitude above the horizon.
      const { azimuth, altitude } = getPosition(sunDate, this.latitude, this.longitude);
      console.debug(
        `[shadow-study] sun for ${sunDate.toISOString()}: ` +
          `azimuth ${azimuth.toFixed(1)}deg from north, altitude ${altitude.toFixed(1)}deg, ` +
          `shadow bearing ${((azimuth + 180) % 360).toFixed(1)}deg from north`,
      );
      // Only draw shadows while the sun is above the horizon.
      if (altitude > 0.5) {
        const azimuthRad = (azimuth * Math.PI) / 180;
        const altitudeRad = (altitude * Math.PI) / 180;
        // Unit vector pointing towards the sun in the local east/north/up frame.
        const sun = {
          x: Math.sin(azimuthRad) * Math.cos(altitudeRad),
          y: Math.cos(azimuthRad) * Math.cos(altitudeRad),
          z: Math.sin(altitudeRad),
        };
        if (contextShadows.enabled) {
          this.drawGroupShadows(ctx, this.casters.context, sun, contextShadows.color);
        }
        if (designShadows.enabled) {
          this.drawGroupShadows(ctx, this.casters.design, sun, designShadows.color);
        }
      }
    }

    // The position is where the center of the canvas is placed, which is the
    // center of the terrain bounding box the canvas was drawn to cover.
    await Forma.terrain.groundTexture.add({
      name: GROUND_TEXTURE_NAME,
      canvas,
      position: {
        x: this.bbox.min.x + width / 2,
        y: this.bbox.max.y - height / 2,
        z: 0,
      },
      scale: { x: 1, y: 1 },
    });
    this.textureVisible = true;
  }

  /**
   * Project every triangle of a group onto its mesh's ground plane and fill
   * the union of the projected triangles in one pass, so overlapping shadow
   * triangles keep a uniform opacity.
   */
  private drawGroupShadows(
    ctx: CanvasRenderingContext2D,
    casters: CasterMesh[],
    sun: { x: number; y: number; z: number },
    color: string,
  ): void {
    if (this.bbox == null) {
      return;
    }
    const { min, max } = this.bbox;

    ctx.fillStyle = hexToRgba(color, SHADOW_ALPHA);
    ctx.beginPath();

    const projected = new Float64Array(6);
    for (const { positions, groundZ } of casters) {
      for (let i = 0; i + 8 < positions.length; i += 9) {
        for (let v = 0; v < 3; v++) {
          const x = positions[i + v * 3];
          const y = positions[i + v * 3 + 1];
          const z = positions[i + v * 3 + 2];
          // Clamp so geometry below the ground plane projects to its own
          // footprint instead of poking out on the sun side.
          const t = Math.max(z - groundZ, 0) / sun.z;
          // Canvas rows go from north (top) to south, so flip the y axis.
          projected[v * 2] = x - t * sun.x - min.x;
          projected[v * 2 + 1] = max.y - (y - t * sun.y);
        }

        // Enforce a consistent winding so the nonzero fill rule produces the
        // union of the triangles instead of cancelling overlapping ones.
        const area =
          (projected[2] - projected[0]) * (projected[5] - projected[1]) -
          (projected[4] - projected[0]) * (projected[3] - projected[1]);
        if (area === 0) {
          continue;
        }
        ctx.moveTo(projected[0], projected[1]);
        if (area > 0) {
          ctx.lineTo(projected[2], projected[3]);
          ctx.lineTo(projected[4], projected[5]);
        } else {
          ctx.lineTo(projected[4], projected[5]);
          ctx.lineTo(projected[2], projected[3]);
        }
        ctx.closePath();
      }
    }

    ctx.fill();
  }
}

export const shadowOverlay = new ShadowOverlay();
