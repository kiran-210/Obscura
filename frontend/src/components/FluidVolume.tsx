import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import * as THREE from 'three'

/**
 * FluidVolume — a faithful port of the monopo.nyc hero background: a volumetric
 * raymarch through a warped, folded density field (their `world()` SDF and 64-step
 * accumulation), lit as soft warm smoke. The tonal crush is slightly relaxed from
 * monopo's 4th power so it reads a touch lighter, and the field composites over a
 * cream toward the bottom edge so the hero bleeds into the page. Autonomous (fixed
 * virtual pointer). Self-contained three.js.
 */

export interface FluidVolumeProps {
  /** Base tint of the field. */
  baseColor?: string
  /** Colour the field fades to along the bottom edge. */
  background?: string
  /** Time multiplier for the flow. */
  speed?: number
  /** Ray field of view. */
  fov?: number
  /** Fold scale of the density noise. */
  scaleNoise?: number
  /** Fold frequency. */
  waveFactor?: number
  /** Tonal crush exponent — lower is lighter (monopo uses 4). */
  crush?: number
  /** vUv.y at which the field becomes fully opaque above the bottom cream. */
  alphaBottom?: number
  className?: string
  style?: CSSProperties
  quality?: 'low' | 'medium' | 'high'
}

const vertexShader = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`

const fragmentShader = `
  precision highp float;

  uniform vec2 uResolution;
  uniform vec3 uBaseColor;
  uniform vec3 uBackground;
  uniform float uTime;
  uniform float uScaleNoise;
  uniform float uWaveFactor;
  uniform float uFOV;
  uniform float uCrush;
  uniform float uAlphaBottom;
  uniform vec2 uMouse;
  uniform sampler2D uNoise;

  varying vec2 vUv;

  float pn(in vec3 p) {
    vec3 i = floor(p); p -= i; p *= p * (3.0 - 2.0 * p);
    p.xy = texture2D(uNoise, (p.xy + i.xy + vec2(37.0, 17.0) * i.z + 0.5) / 256.0, -100.0).yx;
    return mix(p.x, p.y, p.z);
  }

  float trigNoise3D(in vec3 p) {
    return pn(p * uWaveFactor + uTime * 0.5) * uScaleNoise;
  }

  float world(vec3 p) {
    float n = trigNoise3D(p * 0.2);
    float t = sin(0.0001) * 0.5 + 0.5;
    float c = cos(uMouse.x * p.z * 0.2 * t + n);
    float s = sin(uMouse.y * p.z * 0.05 + n * 0.5);
    p.xy *= mat2(c, -s, s, c);
    p -= n * 1.5;
    p.y = mod(p.y, 4.0 + p.y * 0.5) - 2.0 - p.y * 0.25;
    return abs(p.y) - 0.1;
  }

  void main() {
    vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
    vec2 uv = (2.0 * gl_FragCoord.xy / uResolution.xy - 1.0) * aspect;

    float modtime = uTime * 0.1;
    vec3 lookAt = vec3(sin(modtime) * 2.0 + uMouse.x * 2.0, uMouse.y * 2.0, 2.0 + uTime * 2.0);
    vec3 camera_position = vec3(sin(modtime) * 3.0, 0.0, uTime * 2.0);

    float alpha = smoothstep(0.0, uAlphaBottom, vUv.y);

    vec3 forward = normalize(lookAt - camera_position);
    vec3 right = normalize(vec3(forward.z, 0.0, -forward.x));
    vec3 up = normalize(cross(forward, right));

    vec3 ro = camera_position;
    vec3 rd = normalize(forward + uFOV * uv.x * right + uFOV * uv.y * up);

    vec3 lp = vec3(-3.0, 2.0, -1.5);
    lp += ro;
    ro.x += uMouse.x;
    ro.y += uMouse.y;

    float density = 0.0;
    float weighting = 0.0;
    float dist = 1.0;
    float travelled = 0.0;
    const float distanceThreshold = 0.1;

    vec3 col = vec3(0.0);
    vec3 sp;

    for (int i = 0; i < STEPS; i++) {
      if ((density > 1.0) || travelled > 80.0) break;
      sp = ro + rd * travelled;
      dist = world(sp);
      if (dist < 0.4) dist = 0.35;

      float local_density = (distanceThreshold - dist) * step(dist, distanceThreshold);
      weighting = (1.0 - density) * local_density;
      density += weighting * (1.0 - distanceThreshold) * 1.0 / dist;

      vec3 ld = lp - sp;
      float lDist = max(length(ld), 0.001);
      ld /= lDist;
      float atten = 1.0 / (1.0 + lDist * 0.125 + lDist * lDist * 0.55);

      col += weighting * atten * 1.25;
      travelled += max(dist * 0.4, 0.02);
    }

    col = max(col, 0.0);
    col = mix(uBaseColor, vec3(0.0), col);
    col = mix(col, vec3(1.5), travelled * 0.01);
    col = pow(col, vec3(uCrush));

    vec3 rgb = sqrt(col);
    gl_FragColor = vec4(mix(uBackground, rgb, alpha), 1.0);
  }
`

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function toVec3(hex: string): THREE.Vector3 {
  const n = parseInt(hex.replace('#', ''), 16)
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

/** Smooth, seamlessly tiling value noise — the low-frequency field monopo's
 *  `pn()` sampler expects (per-texel white noise leaves world() flat). */
function makeNoiseTexture(): THREE.DataTexture {
  const size = 256
  const period = 32
  const grid = (): Float32Array => {
    const g = new Float32Array(period * period)
    for (let i = 0; i < g.length; i++) g[i] = Math.random()
    return g
  }
  const sample = (g: Float32Array, x: number, y: number): number => {
    const s = period / size
    const fx = x * s
    const fy = y * s
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    let tx = fx - ix
    let ty = fy - iy
    tx = tx * tx * (3 - 2 * tx)
    ty = ty * ty * (3 - 2 * ty)
    const at = (cx: number, cy: number) => g[(((cy % period) + period) % period) * period + (((cx % period) + period) % period)]
    const a = at(ix, iy)
    const b = at(ix + 1, iy)
    const c = at(ix, iy + 1)
    const d = at(ix + 1, iy + 1)
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
  }
  const gr = grid()
  const gg = grid()
  const gb = grid()
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      data[i] = Math.floor(sample(gr, x, y) * 255)
      data[i + 1] = Math.floor(sample(gg, x, y) * 255)
      data[i + 2] = Math.floor(sample(gb, x, y) * 255)
      data[i + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.minFilter = tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

const FluidVolume = ({
  baseColor = '#4f3e22',
  background = '#f4efe4',
  speed = 1.0,
  fov = 1.1,
  scaleNoise = 0.256,
  waveFactor = 1.0,
  crush = 3.2,
  alphaBottom = 0.42,
  className = '',
  style,
  quality = 'high',
}: FluidVolumeProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [webGLSupported, setWebGLSupported] = useState(true)

  const propsRef = useRef({ baseColor, background, speed, fov, scaleNoise, waveFactor, crush, alphaBottom })
  propsRef.current = { baseColor, background, speed, fov, scaleNoise, waveFactor, crush, alphaBottom }

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
    const pixelRatio = { low: 0.6, medium: 0.85, high: Math.min(window.devicePixelRatio, 1.5) }[effectiveQuality]
    const steps = effectiveQuality === 'low' ? 44 : 64

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'low-power', depth: false, stencil: false })
    } catch {
      setWebGLSupported(false)
      return
    }
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    renderer.setPixelRatio(pixelRatio)
    renderer.setSize(width, height, false)
    const canvas = renderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    container.appendChild(canvas)

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    const noiseTex = makeNoiseTexture()
    const p = propsRef.current
    const uniforms = {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(width * pixelRatio, height * pixelRatio) },
      uBaseColor: { value: toVec3(p.baseColor) },
      uBackground: { value: toVec3(p.background) },
      uScaleNoise: { value: p.scaleNoise },
      uWaveFactor: { value: p.waveFactor },
      uFOV: { value: p.fov },
      uCrush: { value: p.crush },
      uAlphaBottom: { value: p.alphaBottom },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
      uNoise: { value: noiseTex },
    }

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: `#define STEPS ${steps}\n${fragmentShader}`,
      uniforms,
      depthWrite: false,
      depthTest: false,
    })
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
        clock += Math.min(delta, 64) * 0.001 * 0.6 * cur.speed
        uniforms.uTime.value = clock
        uniforms.uFOV.value = cur.fov
        uniforms.uScaleNoise.value = cur.scaleNoise
        uniforms.uWaveFactor.value = cur.waveFactor
        uniforms.uCrush.value = cur.crush
        uniforms.uAlphaBottom.value = cur.alphaBottom
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
      noiseTex.dispose()
    }
  }, [webGLSupported, quality])

  if (!webGLSupported) {
    return <div className={className} style={{ background: baseColor, ...style }} />
  }
  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%', ...style }} />
}

export default FluidVolume
