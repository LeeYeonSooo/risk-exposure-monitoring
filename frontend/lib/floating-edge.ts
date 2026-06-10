/**
 * Floating-edge geometry — connects two nodes boundary-to-boundary.
 * Adapted from the React Flow official "Floating Edges" example.
 */
import { type InternalNode, type Node, Position } from "@xyflow/react";

function getNodeIntersection(
  intersectionNode: InternalNode<Node>,
  targetNode: InternalNode<Node>,
): { x: number; y: number } {
  const w = (intersectionNode.measured.width ?? 0) / 2;
  const h = (intersectionNode.measured.height ?? 0) / 2;
  const pos = intersectionNode.internals.positionAbsolute;
  const targetPos = targetNode.internals.positionAbsolute;

  const x2 = pos.x + w;
  const y2 = pos.y + h;
  const x1 = targetPos.x + (targetNode.measured.width ?? 0) / 2;
  const y1 = targetPos.y + (targetNode.measured.height ?? 0) / 2;

  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const xx3 = a * xx1;
  const yy3 = a * yy1;

  return { x: w * (xx3 + yy3) + x2, y: h * (-xx3 + yy3) + y2 };
}

function getEdgePosition(
  node: InternalNode<Node>,
  point: { x: number; y: number },
): Position {
  const n = node.internals.positionAbsolute;
  const nx = Math.round(n.x);
  const ny = Math.round(n.y);
  const px = Math.round(point.x);
  const py = Math.round(point.y);

  if (px <= nx + 1) return Position.Left;
  if (px >= nx + (node.measured.width ?? 0) - 1) return Position.Right;
  if (py <= ny + 1) return Position.Top;
  if (py >= ny + (node.measured.height ?? 0) - 1) return Position.Bottom;
  return Position.Top;
}

export function getEdgeParams(
  source: InternalNode<Node>,
  target: InternalNode<Node>,
) {
  const sourcePoint = getNodeIntersection(source, target);
  const targetPoint = getNodeIntersection(target, source);
  return {
    sx: sourcePoint.x,
    sy: sourcePoint.y,
    tx: targetPoint.x,
    ty: targetPoint.y,
    sourcePos: getEdgePosition(source, sourcePoint),
    targetPos: getEdgePosition(target, targetPoint),
  };
}
