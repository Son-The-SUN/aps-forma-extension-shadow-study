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

/**
 * Renders shadows cast by buildings as a colored ground texture overlay,
 * so shadows from context and design buildings can be told apart.
 *
 * Shadows are computed by projecting each building triangle along the sun
 * direction onto a horizontal ground plane and rasterizing the projected
 * triangles into a canvas which is draped over the terrain. The sun position
 * is derived from the scene date and the project geolocation using suncalc.
 *
 * Limitation: the projection uses a single ground plane at the elevation of
 * the terrain center, so shadow positions drift on strongly sloped sites.
 */
class ShadowOverlay {
  private positions: Record<ShadowGroup, Float32Array[]> = { context: [], design: [] };
  private bbox:
    | { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
    | undefined;
  private latitude = 0;
  private longitude = 0;
  private groundElevation = 0;
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
    // Use the terrain bounding box for the ground plane elevation since it is
    // guaranteed to be in the same coordinate frame as the element meshes.
    this.groundElevation = (bbox.min.z + bbox.max.z) / 2;
    console.debug(
      `[shadow-study] terrain bbox x ${bbox.min.x.toFixed(0)}..${bbox.max.x.toFixed(0)}, ` +
        `y ${bbox.min.y.toFixed(0)}..${bbox.max.y.toFixed(0)}, ` +
        `z ${bbox.min.z.toFixed(1)}..${bbox.max.z.toFixed(1)} -> ` +
        `ground plane at z ${this.groundElevation.toFixed(1)}`,
    );

    for (const group of ["context", "design"] as ShadowGroup[]) {
      const meshes = await Promise.all(
        groupPaths[group].map((path) => Forma.geometry.getTriangles({ path })),
      );
      this.positions[group] = meshes.filter((mesh, index) =>
        this.isShadowCaster(mesh, group, groupPaths[group][index]),
      );
    }

    this.hasGeometry = true;
    this.lastDrawKey = "";
    this.requestRefresh();
    this.startPolling();
  }

  /**
   * Keep only meshes that can cast a meaningful shadow, filtering out flat
   * overlays (roads, zones, site limits) which have no height. Near-ground
   * geometry such as terrain is additionally filtered per triangle when
   * drawing.
   */
  private isShadowCaster(mesh: Float32Array, group: ShadowGroup, path: string): boolean {
    if (mesh.length < 9) {
      return false;
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
    return keep;
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
          this.drawGroupShadows(ctx, this.positions.context, sun, contextShadows.color);
        }
        if (designShadows.enabled) {
          this.drawGroupShadows(ctx, this.positions.design, sun, designShadows.color);
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
   * Project every triangle of a group onto the ground plane and fill the
   * union of the projected triangles in one pass, so overlapping shadow
   * triangles keep a uniform opacity.
   */
  private drawGroupShadows(
    ctx: CanvasRenderingContext2D,
    meshes: Float32Array[],
    sun: { x: number; y: number; z: number },
    color: string,
  ): void {
    if (this.bbox == null) {
      return;
    }
    const { min, max } = this.bbox;
    const z0 = this.groundElevation;

    ctx.fillStyle = hexToRgba(color, SHADOW_ALPHA);
    ctx.beginPath();

    const projected = new Float64Array(6);
    for (const positions of meshes) {
      for (let i = 0; i + 8 < positions.length; i += 9) {
        for (let v = 0; v < 3; v++) {
          const x = positions[i + v * 3];
          const y = positions[i + v * 3 + 1];
          const z = positions[i + v * 3 + 2];
          const t = (z - z0) / sun.z;
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
