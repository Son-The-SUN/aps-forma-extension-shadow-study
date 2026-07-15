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
/** Upper bound on the ground texture canvas dimensions, in pixels. */
const MAX_TEXTURE_SIZE = 8192;
/** Upper bound on the terrain heightfield grid dimensions, in cells. */
const MAX_HEIGHTFIELD_SIZE = 2048;

const DEG = Math.PI / 180;

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

type CasterFootprint = { x: number; y: number; minZ: number };

type CasterMesh = {
  positions: Float32Array;
  /** Fallback ground plane elevation used when no terrain heightfield exists. */
  groundZ: number;
};

/** Regular grid of terrain elevations rasterized from the terrain mesh. */
type Heightfield = {
  originX: number;
  originY: number;
  cellSize: number;
  cols: number;
  rows: number;
  heights: Float32Array;
};

function normalizeLon(lon: number): number {
  return ((lon + 540) % 360) - 180;
}

/**
 * Meridian convergence at (latitude, longitude): the clockwise angle from
 * true north to grid north of the given projection, in degrees. Forma scenes
 * are axis-aligned with the project's projected CRS, so a sun azimuth
 * measured from true north lands in scene coordinates as azimuth minus this
 * angle. Returns undefined for unsupported projections.
 */
function gridConvergenceDeg(
  projString: string,
  latitude: number,
  longitude: number,
): number | undefined {
  const params = new Map<string, string>();
  for (const token of projString.trim().split(/\s+/)) {
    const match = token.match(/^\+([^=]+)(?:=(.*))?$/);
    if (match) {
      params.set(match[1], match[2] ?? "");
    }
  }
  const numParam = (name: string): number | undefined => {
    const value = params.get(name);
    if (value == null || value === "") {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const projection = params.get("proj");
  if (projection === "merc" || projection === "longlat") {
    return 0;
  }
  if (projection === "lcc") {
    const lat1 = numParam("lat_1") ?? numParam("lat_0") ?? 0;
    const lat2 = numParam("lat_2") ?? lat1;
    const lon0 = numParam("lon_0") ?? 0;
    const coneConstant =
      Math.abs(lat1 - lat2) < 1e-9
        ? Math.sin(lat1 * DEG)
        : Math.log(Math.cos(lat1 * DEG) / Math.cos(lat2 * DEG)) /
          Math.log(
            Math.tan(Math.PI / 4 + (lat2 * DEG) / 2) / Math.tan(Math.PI / 4 + (lat1 * DEG) / 2),
          );
    return coneConstant * normalizeLon(longitude - lon0);
  }
  if (projection === "stere" || projection === "sterea") {
    // First-order approximation near the projection center, exact for the
    // polar aspect (lat_0 = 90).
    const lat0 = numParam("lat_0") ?? 0;
    return Math.sin(lat0 * DEG) * normalizeLon(longitude - (numParam("lon_0") ?? 0));
  }

  let centralMeridian: number | undefined;
  if (projection === "utm") {
    const zone = numParam("zone");
    if (zone == null) {
      return undefined;
    }
    centralMeridian = zone * 6 - 183;
  } else if (projection === "tmerc" || projection === "etmerc") {
    centralMeridian = numParam("lon_0") ?? 0;
  }
  if (centralMeridian == null) {
    return undefined;
  }
  const dLon = normalizeLon(longitude - centralMeridian);
  return Math.atan(Math.tan(dLon * DEG) * Math.sin(latitude * DEG)) / DEG;
}

/**
 * Fill heightfield nodes the terrain mesh did not cover by dilating from
 * covered neighbors (gaps, bbox corners), matching how getElevationAt falls
 * back outside the terrain. Any remaining holes get the fallback value.
 */
function fillHoles(heights: Float32Array, cols: number, rows: number, fallback: number): void {
  for (let pass = 0; pass < 4; pass++) {
    let holes = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const index = r * cols + c;
        if (heights[index] !== -Infinity) {
          continue;
        }
        let sum = 0;
        let count = 0;
        if (c > 0 && heights[index - 1] !== -Infinity) {
          sum += heights[index - 1];
          count++;
        }
        if (c < cols - 1 && heights[index + 1] !== -Infinity) {
          sum += heights[index + 1];
          count++;
        }
        if (r > 0 && heights[index - cols] !== -Infinity) {
          sum += heights[index - cols];
          count++;
        }
        if (r < rows - 1 && heights[index + cols] !== -Infinity) {
          sum += heights[index + cols];
          count++;
        }
        if (count > 0) {
          heights[index] = sum / count;
        } else {
          holes++;
        }
      }
    }
    if (holes === 0) {
      return;
    }
  }
  for (let index = 0; index < heights.length; index++) {
    if (heights[index] === -Infinity) {
      heights[index] = fallback;
    }
  }
}

/**
 * Renders shadows cast by buildings as a colored ground texture overlay,
 * so shadows from context and design buildings can be told apart.
 *
 * Shadows are computed by projecting each building triangle along the sun
 * direction onto the terrain and rasterizing the projected triangles into a
 * canvas which is draped over the terrain. The sun position is derived from
 * the scene date and the project geolocation using suncalc, then rotated by
 * the meridian convergence of the project CRS so the azimuth is relative to
 * the scene's grid north (+Y) rather than true north.
 *
 * The terrain mesh is rasterized into a heightfield once, and every caster
 * vertex is projected along its sun ray onto that surface, so shadows follow
 * sloped terrain. When no terrain mesh is available, each mesh falls back to
 * a single horizontal ground plane at its footprint's terrain elevation.
 *
 * Remaining approximations: projected triangle edges are straight even where
 * the terrain undulates between their endpoints, and shadows are only drawn
 * on the terrain, not on other buildings.
 */
class ShadowOverlay {
  private casters: Record<ShadowGroup, CasterMesh[]> = { context: [], design: [] };
  private bbox:
    | { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
    | undefined;
  private heightfield: Heightfield | undefined;
  private latitude = 0;
  private longitude = 0;
  private convergenceDeg = 0;
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
   * terrain extents, terrain surface and project location needed to place
   * shadows.
   */
  async loadGeometry(
    groupPaths: Record<ShadowGroup, string[]>,
    terrainPaths: string[] = [],
  ): Promise<void> {
    const [bbox, geoLocation, project] = await Promise.all([
      Forma.terrain.getBbox(),
      Forma.project.getGeoLocation(),
      Forma.project.get().catch(() => undefined),
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

    // The scene's +Y axis is grid north of the project CRS, which differs
    // from the true north that sun azimuths are measured against by the
    // meridian convergence. Ignoring it rotates every shadow around its
    // building base.
    this.convergenceDeg = 0;
    if (project != null) {
      const convergence = gridConvergenceDeg(project.projString, this.latitude, this.longitude);
      if (convergence != null) {
        this.convergenceDeg = convergence;
        console.debug(
          `[shadow-study] grid convergence ${convergence.toFixed(2)}deg ` +
            `for "${project.projString}"`,
        );
      } else {
        console.warn(
          `[shadow-study] unsupported projection "${project.projString}" ` +
            `-- assuming grid north equals true north`,
        );
      }
    }

    this.heightfield = await this.loadHeightfield(terrainPaths);

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
            groundZ:
              this.heightfield != null
                ? this.sampleTerrain(this.heightfield, footprint.x, footprint.y)
                : await this.groundElevationFor(footprint),
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

  /**
   * Rasterize the terrain mesh into a regular elevation grid, so shadow rays
   * can be intersected with the actual terrain surface instead of a flat
   * plane per caster.
   */
  private async loadHeightfield(terrainPaths: string[]): Promise<Heightfield | undefined> {
    if (terrainPaths.length === 0) {
      console.warn(
        "[shadow-study] no terrain elements found -- falling back to flat ground planes",
      );
      return undefined;
    }
    try {
      const meshes = await Promise.all(
        terrainPaths.map((path) => Forma.geometry.getTriangles({ path })),
      );
      const heightfield = this.buildHeightfield(meshes);
      if (heightfield != null) {
        console.debug(
          `[shadow-study] terrain heightfield ${heightfield.cols}x${heightfield.rows} ` +
            `at ${heightfield.cellSize.toFixed(1)}m/cell`,
        );
      }
      return heightfield;
    } catch (error) {
      console.warn(
        "[shadow-study] failed to load terrain mesh -- falling back to flat ground planes",
        error,
      );
      return undefined;
    }
  }

  private buildHeightfield(meshes: Float32Array[]): Heightfield | undefined {
    if (this.bbox == null) {
      return undefined;
    }
    const { min, max } = this.bbox;
    const extentX = max.x - min.x;
    const extentY = max.y - min.y;
    if (extentX <= 0 || extentY <= 0) {
      return undefined;
    }
    const cellSize = Math.max(1, Math.max(extentX, extentY) / MAX_HEIGHTFIELD_SIZE);
    const cols = Math.ceil(extentX / cellSize) + 1;
    const rows = Math.ceil(extentY / cellSize) + 1;
    const heights = new Float32Array(cols * rows).fill(-Infinity);

    let minHeight = Infinity;
    for (const mesh of meshes) {
      for (let i = 0; i + 8 < mesh.length; i += 9) {
        const x1 = mesh[i];
        const y1 = mesh[i + 1];
        const z1 = mesh[i + 2];
        const x2 = mesh[i + 3];
        const y2 = mesh[i + 4];
        const z2 = mesh[i + 5];
        const x3 = mesh[i + 6];
        const y3 = mesh[i + 7];
        const z3 = mesh[i + 8];
        const denom = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
        if (Math.abs(denom) < 1e-9) {
          continue;
        }
        minHeight = Math.min(minHeight, z1, z2, z3);
        const c0 = Math.max(0, Math.ceil((Math.min(x1, x2, x3) - min.x) / cellSize));
        const c1 = Math.min(cols - 1, Math.floor((Math.max(x1, x2, x3) - min.x) / cellSize));
        const r0 = Math.max(0, Math.ceil((Math.min(y1, y2, y3) - min.y) / cellSize));
        const r1 = Math.min(rows - 1, Math.floor((Math.max(y1, y2, y3) - min.y) / cellSize));
        for (let r = r0; r <= r1; r++) {
          const py = min.y + r * cellSize;
          for (let c = c0; c <= c1; c++) {
            const px = min.x + c * cellSize;
            const w1 = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / denom;
            const w2 = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / denom;
            const w3 = 1 - w1 - w2;
            if (w1 < -1e-4 || w2 < -1e-4 || w3 < -1e-4) {
              continue;
            }
            const z = w1 * z1 + w2 * z2 + w3 * z3;
            const index = r * cols + c;
            if (z > heights[index]) {
              heights[index] = z;
            }
          }
        }
      }
    }
    if (!Number.isFinite(minHeight)) {
      return undefined;
    }
    fillHoles(heights, cols, rows, minHeight);
    return { originX: min.x, originY: min.y, cellSize, cols, rows, heights };
  }

  /** Bilinearly interpolated terrain elevation, clamped to the grid edges. */
  private sampleTerrain(hf: Heightfield, x: number, y: number): number {
    const fx = Math.min(Math.max((x - hf.originX) / hf.cellSize, 0), hf.cols - 1);
    const fy = Math.min(Math.max((y - hf.originY) / hf.cellSize, 0), hf.rows - 1);
    const c0 = Math.min(Math.floor(fx), hf.cols - 1);
    const r0 = Math.min(Math.floor(fy), hf.rows - 1);
    const c1 = Math.min(c0 + 1, hf.cols - 1);
    const r1 = Math.min(r0 + 1, hf.rows - 1);
    const tx = fx - c0;
    const ty = fy - r0;
    const top = hf.heights[r0 * hf.cols + c0] * (1 - tx) + hf.heights[r0 * hf.cols + c1] * tx;
    const bottom = hf.heights[r1 * hf.cols + c0] * (1 - tx) + hf.heights[r1 * hf.cols + c1] * tx;
    return top * (1 - ty) + bottom * ty;
  }

  /**
   * Distance along the (reversed) sun direction from a caster vertex down to
   * the terrain surface, found by fixed-point iteration against the
   * heightfield. Vertices at or below the terrain project onto their own
   * footprint. Falls back to the flat ground plane when no heightfield
   * exists.
   */
  private shadowRayLength(
    x: number,
    y: number,
    z: number,
    sun: { x: number; y: number; z: number },
    groundZ: number,
  ): number {
    const hf = this.heightfield;
    if (hf == null) {
      return Math.max(z - groundZ, 0) / sun.z;
    }
    let t = (z - this.sampleTerrain(hf, x, y)) / sun.z;
    if (!(t > 0)) {
      return 0;
    }
    for (let i = 0; i < 12; i++) {
      const height = this.sampleTerrain(hf, x - t * sun.x, y - t * sun.y);
      const next = (z - height) / sun.z;
      if (!(next > 0)) {
        return 0;
      }
      if (Math.abs(next - t) < 0.05) {
        return next;
      }
      // Average successive guesses so the iteration cannot oscillate on
      // slopes steeper than the sun altitude.
      t = (t + next) / 2;
    }
    return t;
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

    const extentX = this.bbox.max.x - this.bbox.min.x;
    const extentY = this.bbox.max.y - this.bbox.min.y;
    // Render at up to 2 px/m for crisp shadow edges, scaling down on large
    // sites to keep the canvas within GPU texture limits.
    const pixelsPerMeter = Math.min(2, MAX_TEXTURE_SIZE / Math.max(extentX, extentY));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(extentX * pixelsPerMeter));
    canvas.height = Math.max(1, Math.ceil(extentY * pixelsPerMeter));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    // Draw in meters; the transform maps meters to canvas pixels.
    ctx.setTransform(pixelsPerMeter, 0, 0, pixelsPerMeter, 0, 0);

    if (terrain.enabled) {
      ctx.fillStyle = terrain.color;
      ctx.fillRect(0, 0, canvas.width / pixelsPerMeter, canvas.height / pixelsPerMeter);
    }

    if (anyShadows) {
      // suncalc v2 returns degrees: azimuth clockwise from north (0 = N,
      // 90 = E), altitude above the horizon.
      const { azimuth, altitude } = getPosition(sunDate, this.latitude, this.longitude);
      // Rotate the true-north azimuth into the scene's grid north frame.
      const gridAzimuth = azimuth - this.convergenceDeg;
      console.debug(
        `[shadow-study] sun for ${sunDate.toISOString()}: ` +
          `azimuth ${azimuth.toFixed(1)}deg from true north ` +
          `(${gridAzimuth.toFixed(1)}deg from grid north), ` +
          `altitude ${altitude.toFixed(1)}deg, ` +
          `shadow bearing ${((gridAzimuth + 540) % 360).toFixed(1)}deg from grid north`,
      );
      // Only draw shadows while the sun is above the horizon.
      if (altitude > 0.5) {
        const azimuthRad = gridAzimuth * DEG;
        const altitudeRad = altitude * DEG;
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
        x: this.bbox.min.x + canvas.width / pixelsPerMeter / 2,
        y: this.bbox.max.y - canvas.height / pixelsPerMeter / 2,
        z: 0,
      },
      scale: { x: 1 / pixelsPerMeter, y: 1 / pixelsPerMeter },
    });
    this.textureVisible = true;
  }

  /**
   * Project every triangle of a group onto the terrain along the sun
   * direction and fill the union of the projected triangles in one pass, so
   * overlapping shadow triangles keep a uniform opacity.
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
          const t = this.shadowRayLength(x, y, z, sun, groundZ);
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
