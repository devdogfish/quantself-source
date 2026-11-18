import type { CSSProperties } from "react";

export const paperAges = ["Fresh", "Handled", "Aged"] as const;
export type PaperAge = typeof paperAges[number];

const sides = ["top", "right", "bottom", "left"] as const;
type Side = typeof sides[number];
const borderColor = "#dedede";
const connectionPosition = 300;
const appearance = {
  Fresh: { wear: 0.18, cuts: 2 },
  Handled: { wear: 0.65, cuts: 4 },
  Aged: { wear: 1.2, cuts: 6 },
};

function receiptRandom(id: string) {
  let state = 2166136261;
  for (const char of id) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

type Cut = { center: number; width: number; depth: number; tilt: number; connection?: boolean };

function contour(cuts: Cut[]) {
  const segments = cuts.sort((a, b) => a.center - b.center).map(({ center, width, depth, tilt, connection }) => {
    const start = center - width / 2;
    const end = center + width / 2;
    const tip = center + width * tilt;
    if (connection) {
      const shoulder = width * (0.17 + tilt * 0.2);
      return `H${start}L${start + shoulder} ${depth}L${end - width * 0.16} ${depth * (0.92 + tilt * 0.3)}L${end} 0`;
    }
    return `H${start}L${tip - width * 0.13} ${depth * 0.77}Q${tip} ${depth * 1.12} ${tip + width * 0.12} ${depth * 0.85}L${end} 0`;
  });
  return "M0 0" + segments.join("") + "H600";
}

function edgeImage(side: Side, path: string, color: string) {
  const vertical = side === "left" || side === "right";
  const transform = {
    top: "translate(0 5.5)",
    right: "matrix(0 1 -1 0 4.5 0)",
    bottom: "matrix(1 0 0 -1 0 7.5)",
    left: "matrix(0 1 1 0 0.5 0)",
  }[side];
  const viewBox = vertical ? "0 0 5 600" : `0 0 600 ${side === "top" ? 10 : 8}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" preserveAspectRatio="none">
    <g transform="${transform}">
      <path fill="${color}" d="${path}V8H0Z"/>
      <path fill="none" stroke="${borderColor}" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linejoin="round" d="${path}"/>
    </g>
  </svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function receiptPaperStyle(id: string, age: PaperAge, copied = false): CSSProperties {
  const random = receiptRandom(id);
  const { wear, cuts } = appearance[age];
  const color = copied ? borderColor : "#ffffff";
  const connection = {
    center: connectionPosition,
    width: 6 + random() * 1.5,
    depth: (4.4 + random() * 0.5) * (2 / 3),
    tilt: (random() - 0.5) * 0.35,
    connection: true,
  };
  const notch = {
    ...connection,
    width: connection.width + 1,
    depth: connection.depth * 0.92,
    tilt: -connection.tilt - 0.1,
  };
  const nickSide = random() < 0.65 ? sides[Math.floor(random() * sides.length)] : null;
  const nickIndex = Math.floor(random() * cuts);
  const edges = sides.map(side => {
    const marks = Array.from({ length: cuts }, (_, index): Cut => {
      const large = age === "Aged" && side === nickSide && index === nickIndex;
      return {
        center: 30 + (540 / cuts) * (index + 0.15 + random() * 0.7),
        width: large ? 12 + random() * 12 : 3 + random() * 8,
        depth: large ? 2.65 + random() * 0.4 : wear * (0.35 + random()),
        tilt: (random() - 0.5) * 0.45,
      };
    });
    if (side === "left" || side === "right") return edgeImage(side, contour(marks), color);
    const separated = marks.filter(mark => Math.abs(mark.center - connection.center) > 35);
    separated.push(side === "top" ? { ...connection, depth: -connection.depth } : notch);
    return edgeImage(side, contour(separated), color);
  });

  return {
    "--paper": color,
    "--paper-border": borderColor,
    "--paper-top": edges[0],
    "--paper-right": edges[1],
    "--paper-bottom": edges[2],
    "--paper-left": edges[3],
  } as CSSProperties;
}
