import type { DesktopTaskProjectSummary } from "../shared.js";

type TaskProjectOrderItem = Pick<
  DesktopTaskProjectSummary,
  "id" | "name" | "updatedAt"
>;

function projectUpdatedTime(project: TaskProjectOrderItem): number {
  const value = Date.parse(project.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

export function compareTaskProjectFallback(
  left: TaskProjectOrderItem,
  right: TaskProjectOrderItem,
): number {
  const updatedDifference =
    projectUpdatedTime(right) - projectUpdatedTime(left);
  if (updatedDifference !== 0) return updatedDifference;
  const nameDifference = left.name.localeCompare(right.name);
  if (nameDifference !== 0) return nameDifference;
  return left.id.localeCompare(right.id);
}
