import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import * as THREE from 'three'

/**
 * DitherFluid — an ambient background: a dense, viscous smoke "river" of domain-
 * warped fbm noise, resolved through a fine screen-space Bayer 8x8 dither so it
 * breaks into grain that is solid in the core and feathers to sparse dots at the
 * edges. Cold monochrome, autonomous (no pointer input). Self-contained (raw
 * three.js, no R3F) so it can sit behind any surface, with quality tiers, resize,
 * WebGL fallback, and offscreen/hidden pause.
 */

export interface DitherFluidProps {
  bgColor?: string
  inkColor?: string
  /** Feature size of the flow — smaller is larger, slower blobs (more viscous). */
  scale?: number
  /** Time multiplier for the flow. */
  speed?: number
  /** Overall coverage of the grain (higher = denser). */
  density?: number
  /** Edge feathering — higher thins the fringe, keeps the core solid. */
  contrast?: number
  /** Dither cell size in CSS pixels (smaller = finer, tighter grain). */
  ditherScale?: number
  /** How strongly the grain concentrates into a diagonal river (0 = full-field fog, 1 = tight band). */
  ribbon?: number
  /** Max fraction of pixels lit in the core — below 1 it keeps the grain from washing to solid white. */
  maxCoverage?: number
  /** Flow direction in degrees. */
  flowAngle?: number
  className?: string
  style?: CSSProperties
  quality?: 'low' | 'medium' | 'high'
}

const vertexShader = `
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`

const fragmentShader = `
  precision highp float;

  uniform float uTime;
  uniform vec2 uResolution;
  uniform float uPixelRatio;
  uniform vec3 uBg;
  uniform vec3 uInk;
  uniform float uScale;
  uniform float uDensity;
  uniform float uContrast;
  uniform float uDither;
  uniform float uRibbon;
  uniform float uMaxCoverage;
  uniform float uFlowCos;
  uniform float uFlowSin;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  const mat2 M = mat2(1.6, 1.2, -1.2, 1.6);
  float fbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 6; i++) {
      s += a * vnoise(p);
      p = M * p;
      a *= 0.5;
    }
    return s;
  }

  float Bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
  #define Bayer4(a) (Bayer2(0.5 * (a)) * 0.25 + Bayer2(a))
  #define Bayer8(a) (Bayer4(0.5 * (a)) * 0.25 + Bayer2(a))

  void main() {
    vec2 frag = gl_FragCoord.xy;
    vec2 st = frag / uResolution;
    vec2 uv = (frag - 0.5 * uResolution) / uResolution.y;
    float t = uTime;

    vec2 flow = vec2(uFlowCos, uFlowSin);
    vec2 p = uv * uScale + flow * t * 0.9;

    // Domain-warped fbm — the slow, thick, turbulent smoke.
    vec2 q = vec2(fbm(p + vec2(0.0, 1.7) + 0.2 * t), fbm(p + vec2(5.2, 1.3) - 0.15 * t));
    vec2 r = vec2(
      fbm(p + 3.5 * q + vec2(1.7, 9.2) + 0.2 * t),
      fbm(p + 3.5 * q + vec2(8.3, 2.8) - 0.16 * t)
    );
    float smoke = fbm(p + 4.0 * r);

    // Meandering diagonal river envelope: bright core, feathering to nothing.
    vec2 perp = vec2(-uFlowSin, uFlowCos);
    float across = dot(st - 0.5, perp);
    float along = dot(st - 0.5, flow);
    float meander = 0.16 * sin(along * 3.0 + t * 0.35)
                  + 0.13 * (fbm(vec2(along * 2.5, t * 0.12)) - 0.5);
    float width = mix(0.72, 0.13, uRibbon);
    float env = 1.0 - smoothstep(0.0, width, abs(across - meander));
    env = pow(env, 1.45);

    // The river envelope owns the shape (solid core), the smoke only carves veins.
    float body = mix(0.5, 1.0, smoke);
    float river = mix(smoke, env * body, uRibbon);
    float density = smoothstep(0.08, 0.74, river);
    density = pow(density, uContrast) * uDensity;
    density = min(density, uMaxCoverage);

    // Blue-noise-jittered ordered dither: keeps a crisp fine grain in the dense
    // core but dissolves the Bayer lattice into organic dots as it feathers out.
    float cell = max(uDither, 1.0) * uPixelRatio;
    vec2 cellId = floor(frag / cell);
    float threshold = mix(Bayer8(frag / cell), hash(cellId + 3.7), 0.55);
    float on = step(threshold, density);

    gl_FragColor = vec4(mix(uBg, uInk, on), 1.0);
  }
`

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

const DitherFluid = ({
  bgColor = '#00CDCD',
  inkColor = '#EEF1F6',
  scale = 3.0,
  speed = 1.0,
  density = 1.0,
  contrast = 1.0,
  ditherScale = 2.0,
  ribbon = 0.85,
  maxCoverage = 0.9,
  flowAngle = 45,
  className = '',
  style,
  quality = 'high',
}: DitherFluidProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [webGLSupported, setWebGLSupported] = useState(true)

  const propsRef = useRef({ scale, speed, density, contrast, ditherScale, ribbon, maxCoverage, flowAngle, bgColor, inkColor })
  propsRef.current = { scale, speed, density, contrast, ditherScale, ribbon, maxCoverage, flowAngle, bgColor, inkColor }

  useEffect(() => {
    const probe = document.createElement('canvas')
    if (!probe.getContext('webgl') && !probe.getContext('experimental-webgl')) setWebGLSupported(false)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !webGLSupported) return

    const width = Math.max(container.clientWidth, 1)
    const height = Math.max(container.clientHeight, 1)

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    const lowEnd = isMobile || (typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency <= 4)
    let effectiveQuality = quality
    if (lowEnd && quality === 'high') effectiveQuality = 'medium'
    if (isMobile) effectiveQuality = 'low'
    const pixelRatio = { low: 0.75, medium: 1.0, high: Math.min(window.devicePixelRatio, 2) }[effectiveQuality]

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'low-power', depth: false, stencil: false })
    } catch {
      setWebGLSupported(false)
      return
    }
    renderer.setPixelRatio(pixelRatio)
    renderer.setSize(width, height, false)
    const canvas = renderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    container.appendChild(canvas)

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    const p = propsRef.current
    const toVec3 = (hex: string) => {
      const c = new THREE.Color(hex)
      return new THREE.Vector3(c.r, c.g, c.b)
    }
    const uniforms = {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(width * pixelRatio, height * pixelRatio) },
      uPixelRatio: { value: pixelRatio },
      uBg: { value: toVec3(p.bgColor) },
      uInk: { value: toVec3(p.inkColor) },
      uScale: { value: p.scale },
      uDensity: { value: p.density },
      uContrast: { value: p.contrast },
      uDither: { value: p.ditherScale },
      uRibbon: { value: p.ribbon },
      uMaxCoverage: { value: p.maxCoverage },
      uFlowCos: { value: Math.cos((p.flowAngle * Math.PI) / 180) },
      uFlowSin: { value: Math.sin((p.flowAngle * Math.PI) / 180) },
    }

    const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, depthWrite: false, depthTest: false })
    const geometry = new THREE.PlaneGeometry(2, 2)
    scene.add(new THREE.Mesh(geometry, material))

    const draw = () => renderer.render(scene, camera)

    const reduced = prefersReducedMotion()
    let raf = 0
    let running = false
    let last = performance.now()
    let clock = 0
    const frameTime = 1000 / (effectiveQuality === 'low' ? 30 : 40)

    const animate = (now: number) => {
      if (!running) return
      const delta = now - last
      if (delta >= frameTime) {
        const cur = propsRef.current
        clock += Math.min(delta, 64) * 0.001 * cur.speed
        uniforms.uTime.value = clock
        uniforms.uScale.value = cur.scale
        uniforms.uDensity.value = cur.density
        uniforms.uContrast.value = cur.contrast
        uniforms.uDither.value = cur.ditherScale
        uniforms.uRibbon.value = cur.ribbon
        uniforms.uMaxCoverage.value = cur.maxCoverage
        uniforms.uFlowCos.value = Math.cos((cur.flowAngle * Math.PI) / 180)
        uniforms.uFlowSin.value = Math.sin((cur.flowAngle * Math.PI) / 180)
        draw()
        last = now - (delta % frameTime)
      }
      raf = requestAnimationFrame(animate)
    }

    const start = () => {
      if (running || reduced) return
      running = true
      last = performance.now()
      raf = requestAnimationFrame(animate)
    }
    const stop = () => {
      running = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }

    draw()
    let cleanupMotion: (() => void) | null = null
    if (!reduced) {
      let onscreen = true
      const sync = () => (onscreen && !document.hidden ? start() : stop())
      const io = new IntersectionObserver(([entry]) => {
        onscreen = entry.isIntersecting
        sync()
      }, { threshold: 0 })
      io.observe(container)
      const onVisibility = () => sync()
      document.addEventListener('visibilitychange', onVisibility)
      cleanupMotion = () => {
        io.disconnect()
        document.removeEventListener('visibilitychange', onVisibility)
        stop()
      }
    }

    const applySize = (w: number, h: number) => {
      const cw = Math.max(Math.round(w), 1)
      const ch = Math.max(Math.round(h), 1)
      renderer.setSize(cw, ch, false)
      uniforms.uResolution.value.set(cw * pixelRatio, ch * pixelRatio)
      if (!running) draw()
    }
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect
      applySize(rect.width, rect.height)
    })
    ro.observe(container)
    applySize(width, height)

    return () => {
      ro.disconnect()
      if (typeof cleanupMotion === 'function') cleanupMotion()
      else stop()
      renderer.dispose()
      renderer.forceContextLoss()
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement)
      material.dispose()
      geometry.dispose()
    }
  }, [webGLSupported, quality])

  if (!webGLSupported) {
    return <div className={className} style={{ background: bgColor, ...style }} />
  }

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%', ...style }} />
}

export default DitherFluid
