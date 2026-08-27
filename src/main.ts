import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  GridHelper,
  Group,
  IcosahedronGeometry,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  RingGeometry,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
  type Material
} from "three";

type RenderMode = "webgl" | "css-fallback" | "reduced-motion";
type Phase = "aperture" | "approach" | "reveal" | "faceoff" | "identity" | "handoff";

interface IntroState {
  mode: RenderMode;
  phase: Phase;
  elapsedMs: number;
  paused: boolean;
  completed: boolean;
}

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag?: (...args: unknown[]) => void;
    __INTRO_STATE__?: IntroState;
  }
}

const INTRO_DURATION_MS = 6_800;
const REDIRECT_PATH = "/blog/about";
const root = document.documentElement;
const host = requireElement<HTMLElement>("#canvas-host");
const narration = requireElement<HTMLElement>("#narration");

const phaseCopy: Record<Phase, string> = {
  aperture: "Signal acquired",
  approach: "Approaching the arena",
  reveal: "Static enters range",
  faceoff: "Engage",
  identity: "James Shih // Lv42",
  handoff: "Entering the blog..."
};

const state: IntroState = {
  mode: "css-fallback",
  phase: "aperture",
  elapsedMs: 0,
  paused: document.hidden,
  completed: false
};

window.__INTRO_STATE__ = state;

async function boot(): Promise<void> {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let battle: BattleScene | null = null;

  if (reducedMotion) {
    state.mode = "reduced-motion";
  } else {
    try {
      battle = await BattleScene.create(host);
      state.mode = "webgl";
    } catch (error) {
      console.warn("WebGL intro unavailable; using the static renderer.", error);
      state.mode = "css-fallback";
    }
  }

  root.dataset.mode = state.mode;
  track("intro_started", {
    render_mode: state.mode,
    reduced_motion: reducedMotion
  });
  track("intro_render_ready", {
    render_mode: state.mode
  });

  runTimeline(battle);
}

function runTimeline(battle: BattleScene | null): void {
  let elapsedMs = 0;
  let previousTime = performance.now();
  let frameId = 0;

  const onVisibilityChange = (): void => {
    previousTime = performance.now();
    state.paused = document.hidden;
  };

  const finish = (): void => {
    if (state.completed) return;
    state.completed = true;
    state.elapsedMs = INTRO_DURATION_MS;

    track("intro_completed", {
      render_mode: state.mode,
      duration_ms: Math.round(elapsedMs),
      transport_type: "beacon"
    });

    window.removeEventListener("resize", battle?.resizeHandler ?? noop);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    battle?.dispose();
    window.cancelAnimationFrame(frameId);
    window.location.replace(REDIRECT_PATH);
  };

  const frame = (now: number): void => {
    const delta = Math.max(0, now - previousTime);
    previousTime = now;

    if (!document.hidden) {
      elapsedMs = Math.min(INTRO_DURATION_MS, elapsedMs + delta);
      state.elapsedMs = Math.round(elapsedMs);
      updateTimelineShell(elapsedMs);
      battle?.update(elapsedMs);
    }

    if (elapsedMs >= INTRO_DURATION_MS) {
      finish();
      return;
    }

    frameId = window.requestAnimationFrame(frame);
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  frameId = window.requestAnimationFrame(frame);
}

function updateTimelineShell(elapsedMs: number): void {
  const phase = getPhase(elapsedMs);
  if (phase !== state.phase) {
    state.phase = phase;
    root.dataset.phase = phase;
    narration.textContent = phaseCopy[phase];
  }

  const opening = smooth(clamp(elapsedMs / 600));
  const closing = smooth(clamp((elapsedMs - 6_200) / 600));
  const curtainOpen = elapsedMs < 6_200 ? opening : 1 - closing;

  root.style.setProperty("--curtain-open", curtainOpen.toFixed(4));
  root.style.setProperty("--timeline-progress", clamp(elapsedMs / INTRO_DURATION_MS).toFixed(4));
}

function getPhase(elapsedMs: number): Phase {
  if (elapsedMs < 600) return "aperture";
  if (elapsedMs < 1_800) return "approach";
  if (elapsedMs < 3_000) return "reveal";
  if (elapsedMs < 4_800) return "faceoff";
  if (elapsedMs < 6_200) return "identity";
  return "handoff";
}

function track(eventName: string, parameters: Record<string, unknown>): void {
  window.gtag?.("event", eventName, parameters);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smooth(value: number): number {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function noop(): void {}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required intro element: ${selector}`);
  return element;
}

class BattleScene {
  readonly resizeHandler = (): void => this.resize();

  private readonly host: HTMLElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(44, 1, 0.1, 36);
  private readonly head = new Group();
  private readonly rival = new Group();
  private readonly headBillboard: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly leftEnergy: Mesh<SphereGeometry, MeshBasicMaterial>;
  private readonly rightEnergy: Mesh<SphereGeometry, MeshBasicMaterial>;
  private readonly impactRing: Mesh<RingGeometry, MeshBasicMaterial>;
  private readonly rivalRing: Mesh<TorusGeometry, MeshStandardMaterial>;
  private readonly warmDust: Points<BufferGeometry, PointsMaterial>;
  private readonly coolDust: Points<BufferGeometry, PointsMaterial>;
  private readonly impactLight = new PointLight(0xffc85a, 0, 6, 2);
  private readonly compact: boolean;
  private readonly pixelRatioCap: number;
  private readonly headBase = new Vector3();
  private readonly rivalBase = new Vector3();
  private readonly center = new Vector3();
  private portrait = false;

  static async create(hostElement: HTMLElement): Promise<BattleScene> {
    const texture = await loadTexture("/assets/js-head.webp", 1_800);
    try {
      return new BattleScene(hostElement, texture);
    } catch (error) {
      texture.dispose();
      throw error;
    }
  }

  private constructor(hostElement: HTMLElement, headTexture: Texture) {
    this.host = hostElement;

    const memory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8);
    const cores = navigator.hardwareConcurrency || 8;
    this.compact = window.innerWidth < 640 || memory <= 4 || cores <= 4;
    this.pixelRatioCap = this.compact ? 1.2 : 1.65;

    this.renderer = new WebGLRenderer({
      antialias: !this.compact,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    this.host.replaceChildren(this.renderer.domElement);

    this.scene.background = new Color(0x07090d);
    this.scene.fog = new FogExp2(0x090d12, 0.11);

    const ambient = new AmbientLight(0xdde8e5, 1.35);
    const key = new DirectionalLight(0xff735f, 4.2);
    key.position.set(-3, 4, 5);
    const rim = new DirectionalLight(0x53e6dc, 4.8);
    rim.position.set(4, 1, 3);
    this.scene.add(ambient, key, rim, this.impactLight);

    this.addArena();

    headTexture.colorSpace = SRGBColorSpace;
    const headMaterial = new MeshBasicMaterial({
      map: headTexture,
      alphaTest: 0.015,
      transparent: true,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false
    });
    this.headBillboard = new Mesh(new PlaneGeometry(1.55, 1.9), headMaterial);
    this.headBillboard.position.z = 0.56;
    this.headBillboard.renderOrder = 10;

    const headHalo = new Mesh(
      new IcosahedronGeometry(1.02, 1),
      new MeshStandardMaterial({
        color: 0x161b22,
        emissive: 0x29181a,
        emissiveIntensity: 1.1,
        flatShading: true,
        metalness: 0.28,
        roughness: 0.72
      })
    );
    headHalo.scale.set(0.78, 1, 0.45);
    this.head.add(headHalo, this.headBillboard);
    this.scene.add(this.head);

    const rivalPieces = this.createRival();
    this.rivalRing = rivalPieces.ring;
    this.rival.add(rivalPieces.group);
    this.scene.add(this.rival);

    this.leftEnergy = this.createEnergy(0xffc84f);
    this.rightEnergy = this.createEnergy(0x53e6dc);
    this.impactRing = new Mesh(
      new RingGeometry(0.22, 0.27, 32),
      new MeshBasicMaterial({
        color: 0xd7ef49,
        transparent: true,
        opacity: 0,
        side: DoubleSide,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false
      })
    );
    this.leftEnergy.visible = false;
    this.rightEnergy.visible = false;
    this.impactRing.visible = false;
    this.scene.add(this.leftEnergy, this.rightEnergy, this.impactRing);

    const particleCount = this.compact ? 90 : 190;
    this.warmDust = this.createDust(particleCount, 0xff6a54, 42);
    this.coolDust = this.createDust(particleCount, 0x53e6dc, 142);
    this.scene.add(this.warmDust, this.coolDust);

    this.resize();
    window.addEventListener("resize", this.resizeHandler, { passive: true });
  }

  update(elapsedMs: number): void {
    const seconds = elapsedMs / 1_000;
    const approach = smooth(clamp((elapsedMs - 600) / 1_200));
    const reveal = smooth(clamp((elapsedMs - 1_800) / 1_200));
    const faceoff = clamp((elapsedMs - 3_000) / 1_800);
    const identity = smooth(clamp((elapsedMs - 4_800) / 1_400));
    const exit = smooth(clamp((elapsedMs - 6_200) / 600));
    const breathe = Math.sin(seconds * 3.6) * 0.035;
    const lunge = faceoff > 0 && faceoff < 0.72 ? Math.sin((faceoff / 0.72) * Math.PI) : 0;

    const headDirectionX = this.portrait ? 0.22 : 0.68;
    const headDirectionY = this.portrait ? 0.42 : 0.08;
    const rivalDirectionX = this.portrait ? -0.22 : -0.68;
    const rivalDirectionY = this.portrait ? -0.42 : -0.08;

    this.head.position.set(
      this.headBase.x + headDirectionX * lunge,
      this.headBase.y + breathe + headDirectionY * lunge,
      this.headBase.z + lunge * 0.2
    );
    this.rival.position.set(
      this.rivalBase.x + rivalDirectionX * lunge,
      this.rivalBase.y - breathe + rivalDirectionY * lunge,
      this.rivalBase.z + lunge * 0.16
    );

    const headScale = (this.portrait ? 0.78 : 1) * MathUtils.lerp(1.55, 1, approach);
    this.head.scale.setScalar(headScale * (1 + breathe * 0.2));
    const rivalScale = (this.portrait ? 0.72 : 0.92) * MathUtils.lerp(0.02, 1, reveal);
    this.rival.scale.setScalar(rivalScale);
    this.rival.rotation.y = -0.5 + reveal * 0.72 + Math.sin(seconds * 1.8) * 0.08;
    this.rival.rotation.z = this.portrait ? -0.34 : -0.12;
    this.rivalRing.rotation.z = seconds * 1.2;
    this.rivalRing.rotation.x = 0.65 + Math.sin(seconds * 1.4) * 0.14;

    const baseCameraZ = this.portrait ? 6.45 : 5.35;
    const cameraZ = MathUtils.lerp(baseCameraZ + 3.5, baseCameraZ, approach) + identity * 0.55 - exit * 1.1;
    const orbitX = Math.sin(reveal * Math.PI) * (this.portrait ? 0.2 : 0.52);
    const orbitY = this.portrait ? 0.04 : Math.sin(reveal * Math.PI * 0.8) * 0.16;
    const impactWindow = clamp(1 - Math.abs(elapsedMs - 4_050) / 280);
    const shake = impactWindow * (this.compact ? 0.018 : 0.035);
    this.camera.position.set(
      orbitX + Math.sin(seconds * 83) * shake,
      orbitY + Math.cos(seconds * 67) * shake,
      cameraZ
    );
    this.camera.lookAt(0, this.portrait ? 0.04 : -0.08, 0);
    this.headBillboard.quaternion.copy(this.camera.quaternion);

    this.updateEnergy(elapsedMs);
    this.impactRing.quaternion.copy(this.camera.quaternion);
    this.warmDust.rotation.y = seconds * 0.035;
    this.coolDust.rotation.y = -seconds * 0.04;
    this.warmDust.position.x = -reveal * 0.24;
    this.coolDust.position.x = reveal * 0.24;

    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const width = Math.max(1, this.host.clientWidth || window.innerWidth);
    const height = Math.max(1, this.host.clientHeight || window.innerHeight);
    this.portrait = width / height < 0.76;

    if (this.portrait) {
      this.headBase.set(-0.42, height < 650 ? 0.03 : -0.2, 0.32);
      this.rivalBase.set(0.5, 0.72, -0.28);
      this.center.set(0, -0.02, 0.2);
    } else {
      this.headBase.set(-1.52, -0.14, 0.28);
      this.rivalBase.set(1.56, 0.16, -0.28);
      this.center.set(0.04, 0.02, 0.2);
    }

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap));
    this.renderer.setSize(width, height, false);
  }

  dispose(): void {
    window.removeEventListener("resize", this.resizeHandler);
    this.scene.traverse((object) => {
      if (!(object instanceof Mesh) && !(object instanceof Points)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(disposeMaterial);
    });
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.host.replaceChildren();
  }

  private addArena(): void {
    const floor = new Mesh(
      new PlaneGeometry(24, 24),
      new MeshStandardMaterial({
        color: 0x111820,
        metalness: 0.18,
        roughness: 0.86
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.42;
    floor.position.z = -1;

    const grid = new GridHelper(22, 28, 0x399a96, 0x273038);
    grid.position.y = -1.405;
    const gridMaterial = grid.material as Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.34;

    const horizon = new Mesh(
      new TorusGeometry(5.2, 0.025, 4, 64),
      new MeshBasicMaterial({
        color: 0xff5d52,
        transparent: true,
        opacity: 0.42,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false
      })
    );
    horizon.position.set(0, 0.2, -4.4);
    horizon.scale.y = 0.42;

    this.scene.add(floor, grid, horizon);
  }

  private createRival(): { group: Group; ring: Mesh<TorusGeometry, MeshStandardMaterial> } {
    const group = new Group();
    const shellMaterial = new MeshStandardMaterial({
      color: 0x202934,
      emissive: 0x0c2f31,
      emissiveIntensity: 1.4,
      flatShading: true,
      metalness: 0.62,
      roughness: 0.34
    });
    const accentMaterial = new MeshStandardMaterial({
      color: 0x6d3137,
      emissive: 0x5b171e,
      emissiveIntensity: 1.6,
      flatShading: true,
      metalness: 0.45,
      roughness: 0.38
    });
    const body = new Mesh(new IcosahedronGeometry(0.78, 1), shellMaterial);
    body.scale.set(0.85, 1, 0.72);
    group.add(body);

    for (let index = 0; index < 7; index += 1) {
      const angle = (index / 7) * Math.PI * 2;
      const shard = new Mesh(
        new ConeGeometry(0.16 + (index % 2) * 0.04, 1.12, 3),
        index % 3 === 0 ? accentMaterial : shellMaterial
      );
      shard.position.set(Math.cos(angle) * 0.78, Math.sin(angle) * 0.78, -0.04);
      shard.rotation.z = angle - Math.PI / 2;
      shard.rotation.y = (index % 2 ? 0.28 : -0.28);
      group.add(shard);
    }

    const core = new Mesh(
      new IcosahedronGeometry(0.28, 0),
      new MeshStandardMaterial({
        color: 0xd7ef49,
        emissive: 0x53e6dc,
        emissiveIntensity: 4.8,
        flatShading: true,
        metalness: 0.12,
        roughness: 0.24
      })
    );
    core.position.z = 0.7;
    const coreLight = new PointLight(0x53e6dc, 4, 4, 2);
    coreLight.position.z = 0.9;

    const ring = new Mesh(
      new TorusGeometry(1.03, 0.032, 5, 36),
      new MeshStandardMaterial({
        color: 0x53e6dc,
        emissive: 0x53e6dc,
        emissiveIntensity: 3.2,
        metalness: 0.4,
        roughness: 0.25
      })
    );
    group.add(core, coreLight, ring);
    return { group, ring };
  }

  private createEnergy(color: number): Mesh<SphereGeometry, MeshBasicMaterial> {
    return new Mesh(
      new SphereGeometry(0.13, this.compact ? 10 : 16, this.compact ? 8 : 12),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.92,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false
      })
    );
  }

  private createDust(count: number, color: number, seed: number): Points<BufferGeometry, PointsMaterial> {
    const random = seededRandom(seed);
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = (random() - 0.5) * 11;
      positions[index * 3 + 1] = random() * 5 - 1.7;
      positions[index * 3 + 2] = random() * 7 - 4.2;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    return new Points(
      geometry,
      new PointsMaterial({
        color,
        size: this.compact ? 0.025 : 0.032,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
        blending: AdditiveBlending,
        sizeAttenuation: true,
        toneMapped: false
      })
    );
  }

  private updateEnergy(elapsedMs: number): void {
    const energyTime = clamp((elapsedMs - 3_180) / 920);
    const active = elapsedMs >= 3_180 && elapsedMs <= 4_180;
    this.leftEnergy.visible = active;
    this.rightEnergy.visible = active;

    if (active) {
      this.leftEnergy.position.lerpVectors(this.head.position, this.center, energyTime);
      this.rightEnergy.position.lerpVectors(this.rival.position, this.center, energyTime);
      const pulse = 0.84 + Math.sin(elapsedMs * 0.032) * 0.22;
      this.leftEnergy.scale.setScalar(pulse);
      this.rightEnergy.scale.setScalar(pulse);
    }

    const impactTime = clamp((elapsedMs - 3_900) / 620);
    const impactActive = elapsedMs >= 3_900 && elapsedMs <= 4_540;
    this.impactRing.visible = impactActive;
    if (impactActive) {
      this.impactRing.position.copy(this.center);
      this.impactRing.scale.setScalar(0.5 + impactTime * 8.5);
      this.impactRing.material.opacity = (1 - impactTime) * 0.85;
      this.impactLight.position.copy(this.center);
      this.impactLight.intensity = Math.sin(impactTime * Math.PI) * 18;
    } else {
      this.impactLight.intensity = 0;
    }
  }
}

function loadTexture(url: string, timeoutMs: number): Promise<Texture> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      settled = true;
      reject(new Error("Head texture timed out."));
    }, timeoutMs);

    new TextureLoader().load(
      url,
      (texture) => {
        if (settled) {
          texture.dispose();
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        resolve(texture);
      },
      undefined,
      (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function disposeMaterial(material: Material): void {
  Object.values(material).forEach((value) => {
    if (value instanceof Texture) value.dispose();
  });
  material.dispose();
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value / 4_294_967_296;
  };
}

void boot();
