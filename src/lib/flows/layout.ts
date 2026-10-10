/**
 * Dagre-based auto-layout for the flow canvas.
 *
 * The canvas reads `flow_nodes.position_x` / `position_y` (added in
 * migration 010 as `INTEGER NOT NULL DEFAULT 0` — reserved precisely
 * for this view). Brand-new flows and every flow authored before the
 * canvas shipped have all-zero positions, which would render as a
 * single overlapping pile at the origin. This module computes
 * reasonable starting positions in those cases.
 *
 * Why dagre over a hand-rolled BFS layout: branches with multiple
 * outgoing edges (send_buttons, condition, send_list) need horizontal
 * spread to be readable, and dagre's `rank`+`order` pass handles edge
 * crossings far better than anything we'd write by hand. ~30 KB gz
 * for the standalone wrapper, but the canvas already pulls in
 * @xyflow/react so this is incremental.
 *
 * What we do NOT do here: re-layout on every edit. The canvas
 * persists the user's drag positions, and we only ever auto-layout
 * once when `shouldAutoLayout()` returns true. Otherwise a user who
 * carefully arranged a flow would have their work overwritten on
 * reload.
 */

import Dagre from "@dagrejs/dagre";

export interface LayoutNode {
  id: string;
  /** Optional measured size — falls back to defaults if not provided. */
  width?: number;
  height?: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface LayoutPosition {
  x: number;
  y: number;
}

export interface LayoutOptions {
  /** Top-to-bottom is the natural reading order for conversation flows. */
  direction?: "TB" | "LR";
  /** Gap between rows (TB) / columns (LR). */
  rankSep?: number;
  /** Gap between sibling nodes within the same rank. */
  nodeSep?: number;
  /** Default node width when a node's width isn't measured yet. */
  defaultWidth?: number;
  /** Default node height when a node's height isn't measured yet. */
  defaultHeight?: number;
  /** Node the conversation starts from; becomes the first root so the
   *  flow reads from it outward. Falls back to nodes with no incoming edge. */
  entryId?: string;
}

const DEFAULTS: Required<Omit<LayoutOptions, "entryId">> = {
  direction: "TB",
  rankSep: 80,
  nodeSep: 60,
  defaultWidth: 240,
  defaultHeight: 90,
};

/**
 * True iff every node sits at the origin — the signal that no human
 * has positioned this flow yet and auto-layout is safe to run.
 *
 * Why `every`, not `some`: a partially-laid-out flow (some nodes at
 * 0,0, others positioned) is almost certainly mid-edit. Re-running
 * dagre would shuffle the positioned ones the user already chose.
 * Better to leave the new nodes at 0,0 and let the user drag them.
 */
export function shouldAutoLayout(
  nodes: Array<{ position_x?: number | null; position_y?: number | null }>,
): boolean {
  if (nodes.length === 0) return false;
  return nodes.every(
    (n) => (n.position_x ?? 0) === 0 && (n.position_y ?? 0) === 0,
  );
}

/**
 * Reduce the flow graph to a spanning tree that follows the conversation.
 *
 * Why not hand dagre the raw graph: real flows are full of "hub" nodes
 * (a shared fallback / handoff / next-question that a dozen branches all
 * point at). Fed to dagre as-is, every hub drags its many parents toward
 * itself and the branches get interleaved, so related steps end up far
 * apart. Instead:
 *   1. DFS from the entry (slot order) to find back edges (loops), which
 *      must not influence placement.
 *   2. Longest-path rank on what remains, so a node always sits after
 *      everything that leads into it.
 *   3. Each node keeps ONE parent: the deepest one feeding it (ties go to
 *      the earliest in DFS order). That keeps every branch's subtree
 *      together under the step that actually leads into it; the other
 *      edges into a hub are still drawn, they just don't pull it around.
 * Children are emitted in outgoing-slot order, so buttons / list rows
 * keep their top-to-bottom order.
 */
function spanningTree(
  ids: string[],
  edges: LayoutEdge[],
  entryId?: string,
): { order: string[]; treeEdges: LayoutEdge[] } {
  const known = new Set(ids);
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of ids) out.set(id, []);
  const seen = new Set<string>();
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target)) continue;
    if (e.source === e.target) continue;
    const key = `${e.source}\u0000${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }

  const roots: string[] = [];
  if (entryId && known.has(entryId)) roots.push(entryId);
  for (const id of ids) if (!indeg.get(id) && id !== entryId) roots.push(id);
  // Nodes only reachable through a cycle, with no root of their own.
  for (const id of ids) if (!roots.includes(id)) roots.push(id);

  // 1. DFS: discovery order, finish order, back edges.
  const state = new Map<string, 1 | 2>();
  const disc = new Map<string, number>();
  const post: string[] = [];
  const back = new Set<string>();
  const visit = (u: string) => {
    state.set(u, 1);
    disc.set(u, disc.size);
    for (const v of out.get(u)!) {
      const st = state.get(v);
      if (st === 1) back.add(`${u}\u0000${v}`);
      else if (!st) visit(v);
    }
    state.set(u, 2);
    post.push(u);
  };
  for (const r of roots) if (!state.get(r)) visit(r);

  // 2. Longest-path rank in topological (reverse finish) order.
  const preds = new Map<string, string[]>();
  for (const id of ids) preds.set(id, []);
  for (const [u, vs] of out)
    for (const v of vs)
      if (!back.has(`${u}\u0000${v}`)) preds.get(v)!.push(u);
  const rank = new Map<string, number>();
  for (const v of [...post].reverse()) {
    let r = 0;
    for (const u of preds.get(v)!) r = Math.max(r, (rank.get(u) ?? 0) + 1);
    rank.set(v, r);
  }

  // 3. One parent per node: deepest feeder, earliest discovered on ties.
  const parent = new Map<string, string>();
  for (const v of ids) {
    let best: string | null = null;
    for (const u of preds.get(v)!) {
      if (
        best === null ||
        rank.get(u)! > rank.get(best)! ||
        (rank.get(u) === rank.get(best) && disc.get(u)! < disc.get(best)!)
      ) {
        best = u;
      }
    }
    if (best !== null) parent.set(v, best);
  }

  const children = new Map<string, string[]>();
  for (const id of ids) children.set(id, []);
  for (const [u, vs] of out)
    for (const v of vs) if (parent.get(v) === u) children.get(u)!.push(v);

  const order: string[] = [];
  const placed = new Set<string>();
  const emit = (u: string) => {
    if (placed.has(u)) return;
    placed.add(u);
    order.push(u);
    for (const c of children.get(u)!) emit(c);
  };
  for (const r of roots) if (!parent.has(r)) emit(r);
  for (const id of ids) emit(id);

  const treeEdges: LayoutEdge[] = [];
  for (const u of order)
    for (const c of children.get(u)!) treeEdges.push({ source: u, target: c });
  return { order, treeEdges };
}

/**
 * Compute positions for every node id. Returns a map keyed by node
 * id; consumers merge it into their React-Flow nodes array. The
 * returned coordinates are the TOP-LEFT corner (matches React-Flow's
 * coordinate space — dagre internally tracks centers, we translate).
 */
export function autoLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: LayoutOptions = {},
): Map<string, LayoutPosition> {
  const opts = { ...DEFAULTS, ...options };
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: opts.direction,
    ranksep: opts.rankSep,
    nodesep: opts.nodeSep,
  });

  // Insert nodes in flow order (dagre keeps insertion order as the
  // within-rank order) and only the spanning-tree edges. Dangling edges
  // are dropped inside spanningTree: dagre would otherwise insert them as
  // zero-size nodes and warp the layout.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { order, treeEdges } = spanningTree(
    nodes.map((n) => n.id),
    edges,
    options.entryId,
  );
  for (const id of order) {
    const n = byId.get(id)!;
    g.setNode(id, {
      width: n.width ?? opts.defaultWidth,
      height: n.height ?? opts.defaultHeight,
    });
  }
  for (const e of treeEdges) g.setEdge(e.source, e.target);

  Dagre.layout(g);

  const positions = new Map<string, LayoutPosition>();
  for (const n of nodes) {
    const laid = g.node(n.id);
    if (!laid) continue;
    // Dagre returns the center; React-Flow wants the top-left.
    positions.set(n.id, {
      x: laid.x - (n.width ?? opts.defaultWidth) / 2,
      y: laid.y - (n.height ?? opts.defaultHeight) / 2,
    });
  }
  return positions;
}
