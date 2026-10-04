import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { ThemeMode } from '../services/themeService';

interface ThreeBackgroundCanvasProps {
  currentTheme?: ThemeMode;
  className?: string;
  intensity?: number;
  enabled?: boolean;
}

interface ThemePalette {
  background: number;
  primary: number;
  secondary: number;
  accent: number;
  particle: number;
}

const THEME_PALETTES: Record<ThemeMode, ThemePalette> = {
  dark: {
    background: 0x070d18,
    primary: 0x10b981,
    secondary: 0x14b8a6,
    accent: 0x06b6d4,
    particle: 0x34d399,
  },
  frosted_glass: {
    background: 0xe2e8f0,
    primary: 0x059669,
    secondary: 0x0d9488,
    accent: 0x0284c7,
    particle: 0x10b981,
  },
  light: {
    background: 0xf1f5f9,
    primary: 0x0284c7,
    secondary: 0x0d9488,
    accent: 0x2563eb,
    particle: 0x38bdf8,
  },
  oled: {
    background: 0x000000,
    primary: 0x00f2fe,
    secondary: 0x4facfe,
    accent: 0x00d2ff,
    particle: 0x80e9ff,
  },
  royal_gold: {
    background: 0x14100e,
    primary: 0xd97706,
    secondary: 0xf59e0b,
    accent: 0x10b981,
    particle: 0xfcd34d,
  },
  high_contrast: {
    background: 0x000000,
    primary: 0xfacc15,
    secondary: 0xfacc15,
    accent: 0xffffff,
    particle: 0xfef08a,
  },
};

const QUALITY = {
  desktop: {
    maxDpr: 1.5,
    particles: 260,
    dust: 90,
    geometryDetail: 1,
    targetFps: 60,
  },
  mobile: {
    maxDpr: 1.15,
    particles: 100,
    dust: 30,
    geometryDetail: 0,
    targetFps: 30,
  },
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

/** Interpolate between two hex colors */
const lerpColor = (a: number, b: number, t: number): number => {
  const ra = (a >> 16) & 255, ga = (a >> 8) & 255, ba = a & 255;
  const rb = (b >> 16) & 255, gb = (b >> 8) & 255, bb = b & 255;
  return (
    ((ra + (rb - ra) * t) << 16) |
    ((ga + (gb - ga) * t) << 8) |
    (ba + (bb - ba) * t)
  );
};

export const ThreeBackgroundCanvas: React.FC<
  ThreeBackgroundCanvasProps
> = ({
  currentTheme = 'dark',
  className = '',
  intensity = 1,
  enabled = true,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [colorState, setColorState] = useState<ThemePalette>(
    THEME_PALETTES[currentTheme] ?? THEME_PALETTES.dark
  );

  useEffect(() => {
    setColorState(THEME_PALETTES[currentTheme] ?? THEME_PALETTES.dark);
  }, [currentTheme]);

  useEffect(() => {
    if (!enabled) return;

    const container = mountRef.current;
    if (!container) return;

    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    const coarsePointer = window.matchMedia(
      '(pointer: coarse)',
    ).matches;

    const mobile =
      coarsePointer ||
      window.innerWidth < 768 ||
      navigator.maxTouchPoints > 0;

    const quality = mobile ? QUALITY.mobile : QUALITY.desktop;

    const palette = colorState;

    const visualIntensity = clamp(intensity, 0, 1.5);

    let width = Math.max(container.clientWidth, 1);
    let height = Math.max(container.clientHeight, 1);

    let targetPalette = palette;

    /* ------------------------------------------------------------------
       SCENE
    ------------------------------------------------------------------ */

    const scene = new THREE.Scene();

    scene.background = new THREE.Color(palette.background);
    scene.fog = new THREE.FogExp2(
      palette.background,
      mobile ? 0.012 : 0.016,
    );

    /* ------------------------------------------------------------------
       CAMERA
    ------------------------------------------------------------------ */

    const camera = new THREE.PerspectiveCamera(
      52,
      width / height,
      0.1,
      120,
    );

    camera.position.set(0, 0, 22);

    /* ------------------------------------------------------------------
       RENDERER
    ------------------------------------------------------------------ */

    let renderer: THREE.WebGLRenderer;

    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !mobile,
        alpha: false,
        powerPreference: 'high-performance',
        depth: true,
        stencil: false,
        preserveDrawingBuffer: false,
      });
    } catch {
      return;
    }

    const pixelRatio = Math.min(
      window.devicePixelRatio || 1,
      quality.maxDpr,
    );

    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;

    renderer.domElement.setAttribute(
      'aria-hidden',
      'true',
    );

    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    container.appendChild(renderer.domElement);

    /* ------------------------------------------------------------------
       LIGHTING
       Soft three-point lighting with colored point lights for depth.
    ------------------------------------------------------------------ */

    const ambientLight = new THREE.AmbientLight(
      palette.secondary,
      0.8 * visualIntensity,
    );
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(
      palette.primary,
      1.4 * visualIntensity,
    );
    keyLight.position.set(10, 15, 20);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(
      palette.accent,
      0.8 * visualIntensity,
    );
    rimLight.position.set(-15, -10, -10);
    scene.add(rimLight);

    const centerPoint = new THREE.PointLight(
      palette.particle,
      0.9 * visualIntensity,
      0,
      0,
    );
    centerPoint.position.set(0, 0, 0);
    scene.add(centerPoint);

    const edgePoint = new THREE.PointLight(
      palette.accent,
      0.6 * visualIntensity,
      0,
      0,
    );
    edgePoint.position.set(0, 6, 0);
    scene.add(edgePoint);

    /* ------------------------------------------------------------------
       MAIN OBJECT GROUP
    ------------------------------------------------------------------ */

    const world = new THREE.Group();
    scene.add(world);

    const centerGroup = new THREE.Group();
    world.add(centerGroup);

    const driftGroup = new THREE.Group();
    world.add(driftGroup);

    /* ------------------------------------------------------------------
       CENTRAL TORUS KNOT (breathing, color-shifting wireframe)
    ------------------------------------------------------------------ */

    const knotGeometry = new THREE.TorusKnotGeometry(
      4.8,
      1.05,
      mobile ? 72 : 112,
      mobile ? 10 : 16,
    );

    const knotMaterial = new THREE.MeshStandardMaterial({
      color: palette.primary,
      metalness: 0.8,
      roughness: 0.22,
      transparent: true,
      opacity: 0.5 * visualIntensity,
      wireframe: true,
    });

    const knot = new THREE.Mesh(
      knotGeometry,
      knotMaterial,
    );

    knot.position.set(-8.5, 2, -5);
    centerGroup.add(knot);

    /* ------------------------------------------------------------------
       ICOSAHEDRON (inner core)
    ------------------------------------------------------------------ */

    const icoGeometry = new THREE.IcosahedronGeometry(
      3.6,
      quality.geometryDetail,
    );

    const icoMaterial = new THREE.MeshStandardMaterial({
      color: palette.secondary,
      metalness: 0.75,
      roughness: 0.24,
      transparent: true,
      opacity: 0.42 * visualIntensity,
      wireframe: true,
    });

    const ico = new THREE.Mesh(
      icoGeometry,
      icoMaterial,
    );

    ico.position.set(9, -3, -7);
    centerGroup.add(ico);

    /* ------------------------------------------------------------------
       ORBIT RINGS
    ------------------------------------------------------------------ */

    const makeRing = (radius: number, size: number, rot: [number, number, number], group: THREE.Group, speed: number, axisTilt = 0) => {
      const ringGeometry = new THREE.TorusGeometry(
        radius,
        size,
        8,
        mobile ? 64 : 96,
      );
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: palette.accent,
        transparent: true,
        opacity: 0.2 * visualIntensity,
        depthWrite: false,
      });
      const orbit = new THREE.Mesh(ringGeometry, ringMaterial);
      orbit.position.x = rot[0];
      orbit.position.y = rot[1];
      orbit.position.z = rot[2];
      orbit.rotation.set(axisTilt, 0, 0);
      orbit.userData = { baseRot: rot, speed, axisTilt, offset: Math.random() * Math.PI };
      group.add(orbit);
      return orbit;
    };

    const orbit = makeRing(7.2, 0.045, [0, 0, 0], centerGroup, 0.08, 0.32);
    const ring2 = makeRing(4.6, 0.03, [3.2, -1.6, -2.5], centerGroup, 0.11, 0.12);
    const ring3 = makeRing(6.0, 0.035, [-2.8, 3.4, -4.0], centerGroup, 0.07, 0.22);
    const ring4 = makeRing(8.5, 0.04, [5.5, 0.8, 3.2], driftGroup, 0.06, 0.0);

    /* ------------------------------------------------------------------
       DRIFTING FLOATING POLYHEDRA (random shapes drifting slowly)
    ------------------------------------------------------------------ */

    const shapes = [
      {
        geo: new THREE.OctahedronGeometry(1.6, 0),
        mat: new THREE.MeshStandardMaterial({
          color: palette.particle,
          metalness: 0.65,
          roughness: 0.3,
          transparent: true,
          opacity: 0.35 * visualIntensity,
          wireframe: true,
        }),
      },
      {
        geo: new THREE.BoxGeometry(2.2, 2.2, 2.2, 1, 1, 1),
        mat: new THREE.MeshStandardMaterial({
          color: palette.secondary,
          metalness: 0.6,
          roughness: 0.32,
          transparent: true,
          opacity: 0.28 * visualIntensity,
        }),
      },
      {
        geo: new THREE.IcosahedronGeometry(2.0, 0),
        mat: new THREE.MeshStandardMaterial({
          color: palette.accent,
          metalness: 0.7,
          roughness: 0.26,
          transparent: true,
          opacity: 0.33 * visualIntensity,
          wireframe: true,
        }),
      },
      {
        geo: new THREE.SphereGeometry(1.5, 24, 24),
        mat: new THREE.MeshStandardMaterial({
          color: palette.primary,
          metalness: 0.55,
          roughness: 0.35,
          transparent: true,
          opacity: 0.3 * visualIntensity,
        }),
      },
    ];

    const drifters: { mesh: THREE.Mesh; vel: THREE.Vector3; rot: THREE.Vector3 }[] = [];

    for (let i = 0; i < (mobile ? 3 : 5); i++) {
      const s = shapes[i % shapes.length];
      const mesh = new THREE.Mesh(s.geo, s.mat.clone());
      mesh.position.set(
        (Math.random() - 0.5) * 20,
        (Math.random() - 0.5) * 16,
        (Math.random() - 0.5) * 12 - 4,
      );
      mesh.userData = {
        rotSpeed: new THREE.Vector3(
          (Math.random() - 0.5) * 0.01,
          (Math.random() - 0.5) * 0.01,
          (Math.random() - 0.5) * 0.01,
        ),
        drift: new THREE.Vector3(
          (Math.random() - 0.5) * 0.012,
          (Math.random() - 0.5) * 0.01,
          (Math.random() - 0.5) * 0.008,
        ),
      };
      mesh.scale.setScalar(0.7 + Math.random() * 0.6);
      driftGroup.add(mesh);
      drifters.push({ mesh, vel: mesh.userData.drift, rot: mesh.userData.rotSpeed });
    }

    /* ------------------------------------------------------------------
       PARTICLE FIELD (constellation)
    ------------------------------------------------------------------ */

    const particleCount = reducedMotion
      ? Math.floor(quality.particles * 0.4)
      : quality.particles;

    const particleGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const sizes = new Float32Array(particleCount);
    const alphas = new Float32Array(particleCount);

    for (let i = 0; i < particleCount; i++) {
      const index = i * 3;
      positions[index] = (Math.random() - 0.5) * 78;
      positions[index + 1] = (Math.random() - 0.5) * 68;
      positions[index + 2] = (Math.random() - 0.5) * 70;
      sizes[i] = Math.random() * 0.3 + 0.12;
      alphas[i] = Math.random() * 0.7 + 0.15;
    }

    particleGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3),
    );
    particleGeometry.setAttribute(
      'size',
      new THREE.BufferAttribute(sizes, 1),
    );
    particleGeometry.setAttribute(
      'alpha',
      new THREE.BufferAttribute(alphas, 1),
    );

    const particleMaterial = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(palette.particle) },
        time: { value: 0 },
      },
      vertexShader: `
        attribute float size;
        attribute float alpha;
        varying float vAlpha;
        uniform float time;
        uniform vec3 color;
        void main() {
          vAlpha = alpha;
          vec3 pos = position;
          pos.y += sin(time * 0.5 + position.x * 0.05) * 0.4;
          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          gl_PointSize = size * (28.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        varying float vAlpha;
        void main() {
          float d = distance(gl_PointCoord, vec2(0.5));
          float glow = 1.0 - smoothstep(0.0, 0.5, d);
          gl_FragColor = vec4(color, vAlpha * glow);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const particles = new THREE.Points(
      particleGeometry,
      particleMaterial,
    );
    scene.add(particles);

    /* ------------------------------------------------------------------
       DUST LAYER (slow floating specks)
    ------------------------------------------------------------------ */

    const dustCount = reducedMotion ? Math.floor(quality.dust * 0.5) : quality.dust;
    const dustGeometry = new THREE.BufferGeometry();
    const dustPositions = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i++) {
      const index = i * 3;
      dustPositions[index] = (Math.random() - 0.5) * 70;
      dustPositions[index + 1] = (Math.random() - 0.5) * 50;
      dustPositions[index + 2] = (Math.random() - 0.5) * 40;
    }
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
    const dustMaterial = new THREE.PointsMaterial({
      color: palette.particle,
      size: mobile ? 0.16 : 0.22,
      transparent: true,
      opacity: 0.25 * visualIntensity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const dust = new THREE.Points(dustGeometry, dustMaterial);
    scene.add(dust);

    /* ------------------------------------------------------------------
       INTERACTION
    ------------------------------------------------------------------ */

    let pointerX = 0;
    let pointerY = 0;

    let targetX = 0;
    let targetY = 0;

    const handlePointerMove = (event: PointerEvent) => {
      if (reducedMotion || mobile) return;
      pointerX =
        (event.clientX / Math.max(width, 1) - 0.5) *
        2;
      pointerY =
        (event.clientY / Math.max(height, 1) - 0.5) *
        2;
    };

    window.addEventListener(
      'pointermove',
      handlePointerMove,
      { passive: true },
    );

    /* ------------------------------------------------------------------
       VISIBILITY / PERFORMANCE
    ------------------------------------------------------------------ */

    let visible = true;
    const visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
      },
      {
        threshold: 0,
      },
    );
    visibilityObserver.observe(container);

    let documentVisible =
      document.visibilityState === 'visible';
    const handleVisibility = () => {
      documentVisible =
        document.visibilityState === 'visible';
    };
    document.addEventListener(
      'visibilitychange',
      handleVisibility,
    );

    /* ------------------------------------------------------------------
       RESIZE OBSERVER
    ------------------------------------------------------------------ */

    const resizeObserver = new ResizeObserver(() => {
      width = Math.max(
        container.clientWidth,
        1,
      );
      height = Math.max(
        container.clientHeight,
        1,
      );
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(
        width,
        height,
        false,
      );
      pointerX = 0;
      pointerY = 0;
    });
    resizeObserver.observe(container);

    /* ------------------------------------------------------------------
       COLOR BLENDING BETWEEN THEMES
    ------------------------------------------------------------------ */

    let currentColors: {
      background: number;
      primary: number;
      secondary: number;
      accent: number;
      particle: number;
    } = { ...palette };
    const blendProgress = { value: 0 };
    const lastPaletteRef = useRef<ThemePalette>(palette);

    const blendPalette = (from: typeof palette, to: typeof palette, t: number) => ({
      background: lerpColor(from.background, to.background, t),
      primary: lerpColor(from.primary, to.primary, t),
      secondary: lerpColor(from.secondary, to.secondary, t),
      accent: lerpColor(from.accent, to.accent, t),
      particle: lerpColor(from.particle, to.particle, t),
    });

    /* ------------------------------------------------------------------
       ANIMATION
    ------------------------------------------------------------------ */

    let animationFrameId = 0;
    const clock = new THREE.Clock();
    let lastFrame = 0;

    const frameInterval =
      reducedMotion
        ? 1000 / 12
        : mobile
          ? 1000 / quality.targetFps
          : 0;

    const animate = (now: number) => {
      animationFrameId =
        requestAnimationFrame(animate);

      if (!visible || !documentVisible) return;

      if (
        frameInterval > 0 &&
        now - lastFrame < frameInterval
      ) {
        return;
      }

      lastFrame = now;
      const elapsed = clock.getElapsedTime();

      // Blend theme colors smoothly
      if (blendProgress.value < 1) {
        blendProgress.value += 0.02;
        if (blendProgress.value >= 1) blendProgress.value = 1;
        currentColors = blendPalette(lastPaletteRef.current, palette, blendProgress.value);
      } else {
        currentColors = { ...palette };
        lastPaletteRef.current = palette;
      }

      const col = currentColors;

      if (scene.background instanceof THREE.Color) {
        scene.background.setHex(col.background);
      }
      if (scene.fog instanceof THREE.FogExp2) {
        scene.fog.color.setHex(col.background);
      }
      centerPoint.color.setHex(col.particle);
      edgePoint.color.setHex(col.accent);
      ambientLight.color.setHex(col.secondary);
      keyLight.color.setHex(col.primary);
      rimLight.color.setHex(col.accent);
      particleMaterial.uniforms.color.value.setHex(col.particle);
      dustMaterial.color.setHex(col.particle);
      particleMaterial.opacity = 0.45 * visualIntensity;
      dustMaterial.opacity = 0.25 * visualIntensity;

      /* --------------------------------------------------------------
         Reduced motion: keep scene alive but almost static.
      -------------------------------------------------------------- */

      if (!reducedMotion) {
        // Breathing rotation for central knot
        const breathe = 1 + Math.sin(elapsed * 0.7) * 0.06;
        knot.scale.setScalar(breathe);
        knot.rotation.x = elapsed * 0.16;
        knot.rotation.y = elapsed * 0.21;
        knot.rotation.z = Math.sin(elapsed * 0.3) * 0.1;

        ico.rotation.x = elapsed * -0.13;
        ico.rotation.z = elapsed * 0.17;

        [orbit, ring2, ring3, ring4].forEach((ring, i) => {
          ring.rotation.x += ring.userData.speed + (i * 0.005);
          ring.rotation.y = ring.userData.axisTilt + Math.sin(elapsed * 0.4 + ring.userData.offset) * 0.15;
        });

        // Floating polyhedra drift
        drifters.forEach((d, i) => {
          d.mesh.position.add(d.vel);
          d.mesh.rotation.x += d.rot.x;
          d.mesh.rotation.y += d.rot.y;
          d.mesh.rotation.z += d.rot.z;
          // bounce softly at boundaries
          const bounce = 13;
          if (Math.abs(d.mesh.position.x) > bounce) d.vel.x *= -1;
          if (Math.abs(d.mesh.position.y) > bounce) d.vel.y *= -1;
          if (Math.abs(d.mesh.position.z) > bounce) d.vel.z *= -1;
          d.mesh.position.y += Math.sin(elapsed * 0.5 + i) * 0.004;
        });

        particles.rotation.y = elapsed * 0.008;
        particles.rotation.x = elapsed * 0.004;
        dust.rotation.y = elapsed * -0.003;
      }

      /* --------------------------------------------------------------
         Smooth pointer parallax
      -------------------------------------------------------------- */

      if (!reducedMotion && !mobile) {
        targetX += (pointerX - targetX) * 0.035;
        targetY += (pointerY - targetY) * 0.035;
        camera.position.x = targetX * 2.5;
        camera.position.y = -targetY * 1.8;
      } else {
        camera.position.x += (0 - camera.position.x) * 0.04;
        camera.position.y += (0 - camera.position.y) * 0.04;
      }

      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    };

    animate(0);

    /* ------------------------------------------------------------------
       CLEANUP
    ------------------------------------------------------------------ */

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('visibilitychange', handleVisibility);
      visibilityObserver.disconnect();
      resizeObserver.disconnect();

      knotGeometry.dispose();
      knotMaterial.dispose();
      icoGeometry.dispose();
      icoMaterial.dispose();
      ring4.geometry.dispose();
      ring4.material.dispose();

      drifters.forEach((d) => {
        d.mesh.geometry.dispose();
        if (Array.isArray(d.mesh.material)) {
          d.mesh.material.forEach((m) => m.dispose());
        } else {
          d.mesh.material.dispose();
        }
      });

      particleGeometry.dispose();
      particleMaterial.dispose();
      dustGeometry.dispose();
      dustMaterial.dispose();

      renderer.renderLists.dispose();
      renderer.dispose();

      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }

      scene.clear();
    };
  }, [currentTheme, intensity, enabled, colorState]);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      className={[
        'fixed inset-0',
        'w-full h-full',
        'pointer-events-none',
        'overflow-hidden',
        'z-0',
        'select-none',
        'transition-opacity duration-700',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        contain: 'strict',
        isolation: 'isolate',
      }}
    />
  );
};
