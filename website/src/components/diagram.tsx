/**
 * Wireframe diagram primitives. Everything on the page that looks like an
 * architecture drawing is built from these, so the visual language stays
 * consistent: hairline strokes, bracketed nodes, and light that travels
 * along wires (a slow dash flow plus a bright "comet").
 */

import type { CSSProperties, ReactNode, SVGProps } from "react";

export type Tone = "cyan" | "amber" | "red" | "green" | "dim";

export const TONE: Record<Tone, string> = {
  cyan: "var(--cyan)",
  amber: "var(--amber)",
  red: "var(--red)",
  green: "var(--green)",
  dim: "var(--line-3)",
};

/** Filters and gradients one SVG needs; ids are prefixed per diagram. */
export function Defs({ id }: { id: string }) {
  return (
    <defs>
      <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <filter id={`${id}-soft`} x="-100%" y="-100%" width="300%" height="300%">
        <feGaussianBlur stdDeviation="8" />
      </filter>
      <pattern id={`${id}-grid`} width="12" height="12" patternUnits="userSpaceOnUse">
        <path d="M 12 0 L 0 0 0 12" fill="none" stroke="rgba(148,163,184,0.07)" strokeWidth="0.6" />
      </pattern>
    </defs>
  );
}

/**
 * A wire: a dim base stroke, an optional slow dash flow, and an optional
 * comet that runs from start to end. `speed` is seconds per lap.
 */
export function Wire({
  d,
  tone = "cyan",
  flow = true,
  comet = true,
  speed = 2.6,
  delay = 0,
  broken = false,
  glow,
  className,
  style,
  reverse = false,
}: {
  d: string;
  tone?: Tone;
  flow?: boolean;
  comet?: boolean;
  speed?: number;
  delay?: number;
  broken?: boolean;
  glow?: string;
  className?: string;
  style?: CSSProperties;
  reverse?: boolean;
}) {
  const color = TONE[broken ? "red" : tone];
  const timing: CSSProperties = {
    animationDuration: `${speed}s`,
    animationDelay: `${delay}s`,
    animationDirection: reverse ? "reverse" : "normal",
  };
  return (
    <g className={`wire ${broken ? "is-broken" : ""} ${className ?? ""}`} style={style}>
      <path d={d} className="wire-base" stroke={color} />
      {flow && !broken ? <path d={d} className="wire-flow" stroke={color} style={timing} /> : null}
      {comet && !broken ? (
        <path
          d={d}
          pathLength={1000}
          className="wire-comet"
          stroke={color}
          filter={glow ? `url(#${glow}-glow)` : undefined}
          style={timing}
        />
      ) : null}
    </g>
  );
}

/** A bracketed wireframe node with a pulsing core. */
export function Node({
  x,
  y,
  label,
  sub,
  tone = "cyan",
  size = 56,
  leader = false,
  dim = false,
  glow,
  children,
  ...rest
}: {
  x: number;
  y: number;
  label?: string;
  sub?: string;
  tone?: Tone;
  size?: number;
  leader?: boolean;
  dim?: boolean;
  glow?: string;
  children?: ReactNode;
} & Omit<SVGProps<SVGGElement>, "x" | "y">) {
  const h = size / 2;
  const c = size * 0.22;
  const color = TONE[tone];
  return (
    <g className={`node ${dim ? "is-dim" : ""} ${leader ? "is-leader" : ""}`} transform={`translate(${x} ${y})`} {...rest}>
      {leader ? <circle r={size * 0.9} className="node-halo" fill={color} filter={glow ? `url(#${glow}-soft)` : undefined} /> : null}
      <rect x={-h} y={-h} width={size} height={size} rx={size * 0.16} className="node-body" />
      <path
        className="node-corners"
        stroke={color}
        d={`M ${-h} ${-h + c} V ${-h} H ${-h + c} M ${h - c} ${-h} H ${h} V ${-h + c} M ${h} ${h - c} V ${h} H ${h - c} M ${-h + c} ${h} H ${-h} V ${h - c}`}
      />
      <circle r={size * 0.32} className="node-ring" stroke={color} />
      <circle r={size * 0.09} fill={color} className="node-core" />
      <circle r={size * 0.09} fill="none" stroke={color} className="node-ping" />
      {children}
      {label ? (
        <text y={h + 18} textAnchor="middle" className="d-label">
          {label}
        </text>
      ) : null}
      {sub ? (
        <text y={h + 32} textAnchor="middle" className={`d-sub tone-${tone}`}>
          {sub}
        </text>
      ) : null}
    </g>
  );
}

/** A small pill label inside a diagram. */
export function Badge({
  x,
  y,
  text,
  tone = "cyan",
  className,
  style,
}: {
  x: number;
  y: number;
  text: string;
  tone?: Tone;
  className?: string;
  style?: CSSProperties;
}) {
  const w = text.length * 6.7 + 22;
  return (
    <g className={`badge ${className ?? ""}`} transform={`translate(${x - w / 2} ${y - 11})`} style={style}>
      <rect width={w} height={22} rx={11} stroke={TONE[tone]} />
      <circle cx={11} cy={11} r={2.4} fill={TONE[tone]} className="badge-dot" />
      <text x={w / 2 + 5} y={15} textAnchor="middle" fill={TONE[tone]}>
        {text}
      </text>
    </g>
  );
}

/** An expanding ring, e.g. an acknowledgement arriving. */
export function Ping({ x, y, tone = "cyan", delay = 0, r = 26 }: { x: number; y: number; tone?: Tone; delay?: number; r?: number }) {
  return (
    <circle
      cx={x}
      cy={y}
      r={r}
      className="ping"
      stroke={TONE[tone]}
      style={{ animationDelay: `${delay}s` }}
    />
  );
}

/** A curved path between two points (gentle S-curve). */
export function curve(a: [number, number], b: [number, number], bend = 0.5): string {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const mx = x1 + (x2 - x1) * bend;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

/** A straight path. */
export function line(a: [number, number], b: [number, number]): string {
  return `M ${a[0]} ${a[1]} L ${b[0]} ${b[1]}`;
}
