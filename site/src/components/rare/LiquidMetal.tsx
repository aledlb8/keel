"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/*
 * Adapted from RareUI's LiquidMetal (MIT, see ./LICENSE), itself after the
 * Framer/paper.design liquid logo. The shader is RareUI's with the colour taken
 * out — grey metal, no chromatic fringe, as the rest of the page is — and its
 * pattern kept in unit space so it holds up on a wide wordmark. Around it:
 *
 * - The shape is the text drawn straight onto a 2D canvas in the page's own
 *   (already loaded) face, rather than an SVG rendered through an <img>, which
 *   cannot see web fonts and fell back to Arial Black.
 * - The Poisson solve that turns the shape into a height field runs once,
 *   when the canvas first nears the viewport, and during idle time.
 * - The loop stops while the canvas is off screen, and with reduced motion it
 *   paints a single still frame.
 * - Until the first frame is up — or for good, without WebGL 2 — `fallback`
 *   shows instead.
 */

const VERT = `#version 300 es
precision mediump float;
in vec2 a_position;
out vec2 vUv;
void main() {
    vUv = .5 * (a_position + 1.);
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
# ifdef GL_ES
precision highp float;
# else
precision mediump float;
# endif

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D u_image_texture;
uniform float u_time;
uniform float u_ratio;
uniform float u_img_ratio;
uniform float u_patternScale;
uniform float u_edge;
uniform float u_patternBlur;
uniform float u_liquid;

#define PI 3.14159265358979323846

vec3 mod289(vec3 x) { return x - floor(x * (1. / 289.)) * 289.; }
vec2 mod289(vec2 x) { return x - floor(x * (1. / 289.)) * 289.; }
vec3 permute(vec3 x) { return mod289(((x*34.)+1.)*x); }
float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1;
    i1 = (x0.x > x0.y) ? vec2(1., 0.) : vec2(0., 1.);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0., i1.y, 1.)) + i.x + vec3(0., i1.x, 1.));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.);
    m = m*m;
    m = m*m;
    vec3 x = 2. * fract(p * C.www) - 1.;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130. * dot(m, g);
}

vec2 get_img_uv() {
    vec2 img_uv = vUv;
    img_uv -= .5;
    if (u_ratio > u_img_ratio) {
        img_uv.x = img_uv.x * u_ratio / u_img_ratio;
    } else {
        img_uv.y = img_uv.y * u_img_ratio / u_ratio;
    }
    float scale_factor = 1.;
    img_uv *= scale_factor;
    img_uv += .5;
    img_uv.y = 1. - img_uv.y;
    return img_uv;
}

vec2 rotate(vec2 uv, float th) {
    return mat2(cos(th), sin(th), -sin(th), cos(th)) * uv;
}

float get_color_channel(float c1, float c2, float stripe_p, vec3 w, float extra_blur, float b) {
    float ch = c2;
    float border = 0.;
    float blur = u_patternBlur + extra_blur;

    ch = mix(ch, c1, smoothstep(.0, blur, stripe_p));

    border = w[0];
    ch = mix(ch, c2, smoothstep(border - blur, border + blur, stripe_p));

    b = smoothstep(.2, .8, b);
    border = w[0] + .4 * (1. - b) * w[1];
    ch = mix(ch, c1, smoothstep(border - blur, border + blur, stripe_p));

    border = w[0] + .5 * (1. - b) * w[1];
    ch = mix(ch, c2, smoothstep(border - blur, border + blur, stripe_p));

    border = w[0] + w[1];
    ch = mix(ch, c1, smoothstep(border - blur, border + blur, stripe_p));

    float gradient_t = (stripe_p - w[0] - w[1]) / w[2];
    float gradient = mix(c1, c2, smoothstep(0., 1., gradient_t));
    ch = mix(ch, gradient, smoothstep(border - blur, border + blur, stripe_p));

    return ch;
}

float get_img_frame_alpha(vec2 uv, float img_frame_width) {
    float img_frame_alpha = smoothstep(0., img_frame_width, uv.x) * smoothstep(1., 1. - img_frame_width, uv.x);
    img_frame_alpha *= smoothstep(0., img_frame_width, uv.y) * smoothstep(1., 1. - img_frame_width, uv.y);
    return img_frame_alpha;
}

void main() {
    vec2 uv = vUv;
    uv.y = 1. - uv.y;
    // RareUI scaled x by the aspect ratio, which suits a square logo; on a
    // wide wordmark it drove the diagonal term past 1 and broke the pattern
    // into dense banding. The pattern stays in unit space instead.

    float diagonal = uv.x - uv.y;

    float t = .001 * mod(u_time, 10000.0);

    vec2 img_uv = get_img_uv();
    vec4 img = texture(u_image_texture, img_uv);

    vec3 color = vec3(0.);
    float opacity = 1.;

    vec3 color1 = vec3(.9);
    vec3 color2 = vec3(.07 + .05 * smoothstep(.7, 1.3, uv.x + uv.y));

    float edge = img.r;

    vec2 grad_uv = uv;
    grad_uv -= .5;

    float dist = length(grad_uv + vec2(0., .2 * diagonal));
    grad_uv = rotate(grad_uv, (.25 - .2 * diagonal) * PI);

    float bulge = pow(1.8 * dist, 1.2);
    bulge = 1. - bulge;
    bulge *= pow(uv.y, .3);

    float cycle_width = u_patternScale;
    float thin_strip_1_ratio = .12 / cycle_width * (1. - .4 * bulge);
    float thin_strip_2_ratio = .07 / cycle_width * (1. + .4 * bulge);
    float wide_strip_ratio = (1. - thin_strip_1_ratio - thin_strip_2_ratio);

    float thin_strip_1_width = cycle_width * thin_strip_1_ratio;
    float thin_strip_2_width = cycle_width * thin_strip_2_ratio;

    opacity = 1. - smoothstep(.9 - .5 * u_edge, 1. - .5 * u_edge, edge);
    opacity *= get_img_frame_alpha(img_uv, 0.01);

    float noise = snoise(uv - t);
    edge += (1. - edge) * u_liquid * noise;

    float dir = grad_uv.x;
    dir += diagonal;
    dir -= 2. * noise * diagonal * (smoothstep(0., 1., edge) * smoothstep(1., 0., edge));

    bulge *= clamp(pow(uv.y, .1), .3, 1.);
    dir *= (.1 + (1.1 - edge) * bulge);
    dir *= smoothstep(1., .7, edge);
    dir += .18 * (smoothstep(.1, .2, uv.y) * smoothstep(.4, .2, uv.y));

    dir += .03 * (smoothstep(.1, .2, 1. - uv.y) * smoothstep(.4, .2, 1. - uv.y));
    dir *= (.5 + .5 * pow(uv.y, 2.));
    dir *= cycle_width;
    dir -= t;

    vec3 w = vec3(thin_strip_1_width, thin_strip_2_width, wide_strip_ratio);
    w[1] -= .02 * smoothstep(.0, 1., edge + bulge);
    float stripe_g = mod(dir, 1.);
    // RareUI ran three channels, each refracted and blurred a little
    // differently — a chromatic fringe. This metal has no hue, so one channel
    // does for all three. The blur is clamped: at the top-right corner
    // (1 - diagonal) reaches zero.
    float g = get_color_channel(color1.g, color2.g, stripe_g, w, 0.01 / max(1. - diagonal, .1), bulge);
    color = vec3(g);
    color *= opacity;

    fragColor = vec4(color, opacity);
}
`;

/** Draw `text` and solve for a smooth height field inside its outline. */
function heightField(text: string, font: string, tracking: string): ImageData {
  const setFont = (c: CanvasRenderingContext2D) => {
    c.font = font;
    // Not every engine takes the stretch or the tracking through the shorthand.
    const ext = c as CanvasRenderingContext2D & { fontStretch?: string; letterSpacing?: string };
    if (font.includes("expanded") && "fontStretch" in ext) ext.fontStretch = "expanded";
    if ("letterSpacing" in ext) ext.letterSpacing = tracking;
  };
  const probe = document.createElement("canvas").getContext("2d")!;
  setFont(probe);
  const m = probe.measureText(text);
  const ascent = Math.ceil(m.actualBoundingBoxAscent);
  const descent = Math.ceil(m.actualBoundingBoxDescent);
  const pad = 24;
  const width = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight) + pad * 2;
  const height = ascent + descent + pad * 2;

  const shape = document.createElement("canvas");
  shape.width = width;
  shape.height = height;
  const ctx = shape.getContext("2d", { willReadFrequently: true })!;
  setFont(ctx);
  ctx.fillStyle = "#000";
  ctx.fillText(text, pad + m.actualBoundingBoxLeft, pad + ascent);
  const px = ctx.getImageData(0, 0, width, height).data;

  const n = width * height;
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = px[i * 4 + 3]! > 127 ? 1 : 0;
  const at = (x: number, y: number) =>
    x >= 0 && x < width && y >= 0 && y < height && inside[y * width + x] === 1;

  const edge = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside[y * width + x]) continue;
      if (!at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1)) edge[y * width + x] = 1;
    }
  }

  // Jacobi iterations of ∇²u = -C with u = 0 on the outline, as in RareUI.
  let u = new Float32Array(n);
  let next = new Float32Array(n);
  for (let iter = 0; iter < 300; iter++) {
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        if (!inside[i] || edge[i]) continue;
        next[i] = (0.01 + u[i - 1]! + u[i + 1]! + u[i - width]! + u[i + width]!) / 4;
      }
    }
    [u, next] = [next, u];
  }

  let max = 0;
  for (let i = 0; i < n; i++) if (u[i]! > max) max = u[i]!;
  const out = new ImageData(width, height);
  for (let i = 0; i < n; i++) {
    const g = inside[i] ? 255 * (1 - Math.pow(u[i]! / (max || 1), 2)) : 255;
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = g;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

export function LiquidMetal({
  text,
  font,
  tracking = "0px",
  fallback,
  className = "",
  speed = 0.3,
  patternScale = 2,
  edge = 0.5,
  patternBlur = 0.005,
  liquid = 0.08,
}: {
  text: string;
  /**
   * A CSS font shorthand, or one worked out from the element (to read a
   * generated family name off the page). Keep it stable between renders. The
   * face must already be loaded on the page.
   */
  font: string | ((el: HTMLElement) => string);
  /** Letter spacing, as CSS `letter-spacing`. */
  tracking?: string;
  fallback: ReactNode;
  className?: string;
  speed?: number;
  patternScale?: number;
  edge?: number;
  patternBlur?: number;
  liquid?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [field, setField] = useState<ImageData | null>(null);
  const [live, setLive] = useState(false);

  // Solve the shape once, the first time the canvas comes within reach.
  useEffect(() => {
    const el = wrap.current;
    if (!el || field) return;
    let cancelled = false;
    let pending = 0;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e?.isIntersecting) return;
        io.disconnect();
        document.fonts.ready.then(() => {
          if (cancelled) return;
          const run = () => {
            if (!cancelled) setField(heightField(text, typeof font === "function" ? font(el) : font, tracking));
          };
          // Safari has no idle callbacks; a plain timeout still yields first.
          pending =
            typeof requestIdleCallback === "function"
              ? requestIdleCallback(run, { timeout: 1200 })
              : setTimeout(run, 0) as unknown as number;
        });
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(pending);
      else clearTimeout(pending);
    };
  }, [text, font, tracking, field]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !field) return;
    const gl = cv.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) return;

    let program: WebGLProgram;
    try {
      program = gl.createProgram()!;
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    } catch {
      return;
    }
    gl.useProgram(program);
    const loc = (name: string) => gl.getUniformLocation(program, name);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniform1f(loc("u_patternScale"), patternScale);
    gl.uniform1f(loc("u_edge"), edge);
    gl.uniform1f(loc("u_patternBlur"), patternBlur);
    gl.uniform1f(loc("u_liquid"), liquid);
    gl.uniform1f(loc("u_img_ratio"), field.width / field.height);

    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, field.width, field.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, field.data);
    gl.uniform1i(loc("u_image_texture"), 0);

    const uTime = loc("u_time");
    const uRatio = loc("u_ratio");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let time = 2400; // Start mid-flow, not on the shader's first blank instant.
    let last = performance.now();
    let raf = 0;

    const size = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      gl.viewport(0, 0, cv.width, cv.height);
      gl.uniform1f(uRatio, cv.width / cv.height);
    };
    const draw = () => {
      gl.uniform1f(uTime, time % 10000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const frame = (now: number) => {
      time += (now - last) * speed;
      last = now;
      draw();
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (still || raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    size();
    draw();
    setLive(true);

    const ro = new ResizeObserver(() => {
      size();
      draw();
    });
    ro.observe(cv);
    const io = new IntersectionObserver(([e]) => (e?.isIntersecting ? start() : stop()));
    io.observe(cv);

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(program);
    };
  }, [field, speed, patternScale, edge, patternBlur, liquid]);

  return (
    <div ref={wrap} className={`relative ${className}`}>
      <div className="transition-opacity duration-1000 ease-keel" style={{ opacity: live ? 0 : 1 }}>
        {fallback}
      </div>
      <canvas
        ref={canvas}
        aria-hidden
        className="absolute inset-0 h-full w-full transition-opacity duration-1000 ease-keel"
        style={{ opacity: live ? 1 : 0 }}
      />
    </div>
  );
}
