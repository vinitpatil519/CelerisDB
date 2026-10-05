/**
 * Reusable SVG primitives for every architecture diagram on the page, so no
 * diagram is one giant hand-drawn SVG. All take plain coordinates in the
 * parent's viewBox.
 */

import type { ReactNode, SVGProps } from "react";

export type Tone = "accent" | "warn" | "fail" | "muted" | "ok";

const STROKE: Record<Tone, string> = {
  accent: "var(--accent)",
  warn: "var(--warn)",
  fail: "var(--fail)",
  muted: "var(--line-strong)",
  ok: "var(--ok)",
};

/** A database node: a rounded square with a pulsing core and a label. */
export function Node({
  x,
  y,
  label,
  sub,
  tone = "accent",
  size = 64,
  dim = false,
  ...rest
}: { x: number; y: number; label: string; sub?: string; tone?: Tone; size?: number; dim?: boolean } & Omit<
  SVGProps<SVGGElement>,
  "x" | "y"
>) {
  const h = size / 2;
  return (
    <g className={`d-node ${dim ? "is-dim" : ""}`} transform={`translate(${x} ${y})`} {...rest}>
      <rect x={-h} y={-h} width={size} height={size} rx={size * 0.18} className="d-node-body" stroke={STROKE[tone]} />
      <rect x={-h + 8} y={-h + 8} width={size - 16} height={size - 16} rx={size * 0.12} className="d-node-inner" />
      <circle r={size * 0.09} className="d-node-core" fill={STROKE[tone]} />
      <text y={h + 20} className="d-label" textAnchor="middle">
        {label}
      </text>
      {sub ? (
        <text y={h + 36} className="d-sublabel" textAnchor="middle">
          {sub}
        </text>
      ) : null}
    </g>
  );
}

/** A network link between two points. Broken links render dashed. */
export function Link({
  from,
  to,
  tone = "muted",
  broken = false,
  id,
  opacity = 1,
}: {
  from: [number, number];
  to: [number, number];
  tone?: Tone;
  broken?: boolean;
  id?: string;
  opacity?: number;
}) {
  return (
    <path
      id={id}
      d={`M ${from[0]} ${from[1]} L ${to[0]} ${to[1]}`}
      className={`d-link ${broken ? "is-broken" : ""}`}
      stroke={STROKE[broken ? "fail" : tone]}
      opacity={opacity}
    />
  );
}

/** A data packet travelling along an SVG path (CSS offset-path). */
export function Packet({ path, duration = 3, delay = 0, tone = "accent" }: { path: string; duration?: number; delay?: number; tone?: Tone }) {
  return (
    <circle
      r={5}
      className="d-packet"
      fill={STROKE[tone]}
      style={{
        offsetPath: `path("${path}")`,
        animationDuration: `${duration}s`,
        animationDelay: `${delay}s`,
      }}
    />
  );
}

/** One logical partition: a tiny dot. */
export function Partition({ x, y, color, r = 1.6 }: { x: number; y: number; color: string; r?: number }) {
  return <circle cx={x} cy={y} r={r} fill={color} />;
}

/** A storage-engine layer: a flat isometric slab with a label. */
export function StorageLayer({
  y,
  label,
  detail,
  width = 360,
  tone = "accent",
}: {
  y: number;
  label: string;
  detail: string;
  width?: number;
  tone?: Tone;
}) {
  const w = width / 2;
  const d = 26;
  return (
    <g className="d-layer" transform={`translate(0 ${y})`}>
      <path
        d={`M ${-w} 0 L 0 ${-d} L ${w} 0 L 0 ${d} Z`}
        className="d-layer-top"
        stroke={STROKE[tone]}
      />
      <path d={`M ${-w} 0 L ${-w} 10 L 0 ${d + 10} L 0 ${d} Z`} className="d-layer-side" />
      <path d={`M ${w} 0 L ${w} 10 L 0 ${d + 10} L 0 ${d} Z`} className="d-layer-side dark" />
      <text x={w + 24} y={4} className="d-label">
        {label}
      </text>
      <text x={w + 24} y={22} className="d-sublabel">
        {detail}
      </text>
    </g>
  );
}

/** A jagged line marking a network partition. */
export function FailureLine({ x, top, bottom, opacity = 1 }: { x: number; top: number; bottom: number; opacity?: number }) {
  const points: string[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const y = top + ((bottom - top) * i) / steps;
    points.push(`${x + (i % 2 === 0 ? -6 : 6)},${y}`);
  }
  return <polyline points={points.join(" ")} className="d-failure" opacity={opacity} />;
}

/** A status pill inside a diagram. */
export function StateBadge({ x, y, text, tone = "accent", opacity = 1 }: { x: number; y: number; text: string; tone?: Tone; opacity?: number }) {
  const width = text.length * 8.2 + 24;
  return (
    <g transform={`translate(${x - width / 2} ${y - 14})`} opacity={opacity} className="d-badge">
      <rect width={width} height={28} rx={14} stroke={STROKE[tone]} />
      <text x={width / 2} y={18.5} textAnchor="middle" fill={STROKE[tone]}>
        {text}
      </text>
    </g>
  );
}

/** An availability zone: a dashed region with a corner label. */
export function Zone({ x, y, w, h, label, children }: { x: number; y: number; w: number; h: number; label: string; children?: ReactNode }) {
  return (
    <g className="d-zone">
      <rect x={x} y={y} width={w} height={h} rx={14} />
      <text x={x + 14} y={y + 22} className="d-sublabel">
        {label}
      </text>
      {children}
    </g>
  );
}

/** A rack: a tall box with slots. */
export function Rack({ x, y, slots = 4, label }: { x: number; y: number; slots?: number; label?: string }) {
  return (
    <g className="d-rack" transform={`translate(${x} ${y})`}>
      <rect x={-28} y={0} width={56} height={slots * 18 + 12} rx={6} />
      {Array.from({ length: slots }, (_, i) => (
        <g key={i}>
          <rect x={-20} y={8 + i * 18} width={40} height={12} rx={2} className="d-rack-slot" />
          <circle cx={14} cy={14 + i * 18} r={2} className="d-node-core" fill="var(--accent)" />
        </g>
      ))}
      {label ? (
        <text y={slots * 18 + 32} textAnchor="middle" className="d-sublabel">
          {label}
        </text>
      ) : null}
    </g>
  );
}
