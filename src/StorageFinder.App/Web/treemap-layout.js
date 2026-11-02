export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toLocaleString("en-US", { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
}

// Squarified layout: preserve area while avoiding long, thin strips.
export function squarify(nodes, bounds) {
  const items = nodes.filter(node => Number.isFinite(node.size) && node.size > 0).sort((a, b) => b.size - a.size);
  const total = items.reduce((sum, node) => sum + node.size, 0);
  if (!total || bounds.width <= 0 || bounds.height <= 0) return [];
  let { x, y, width, height } = bounds;
  const scale = width * height / total;
  const output = [];
  let row = [];
  let rowArea = 0;

  function worst(area, smallest, largest, side) {
    if (!area || !smallest || !side) return Infinity;
    return Math.max(side * side * largest / (area * area), area * area / (side * side * smallest));
  }

  function placeRow() {
    if (width >= height) {
      const strip = Math.min(width, rowArea / height);
      let top = y;
      row.forEach((item, index) => {
        const itemHeight = index === row.length - 1 ? y + height - top : item.area / strip;
        output.push({ node: item.node, x, y: top, width: strip, height: itemHeight });
        top += itemHeight;
      });
      x += strip;
      width = Math.max(0, width - strip);
    } else {
      const strip = Math.min(height, rowArea / width);
      let left = x;
      row.forEach((item, index) => {
        const itemWidth = index === row.length - 1 ? x + width - left : item.area / strip;
        output.push({ node: item.node, x: left, y, width: itemWidth, height: strip });
        left += itemWidth;
      });
      y += strip;
      height = Math.max(0, height - strip);
    }
    row = [];
    rowArea = 0;
  }

  for (const node of items) {
    const area = node.size * scale;
    const side = Math.min(width, height);
    if (row.length && worst(rowArea + area, area, row[0].area, side) > worst(rowArea, row.at(-1).area, row[0].area, side))
      placeRow();
    row.push({ node, area });
    rowArea += area;
  }
  if (row.length) placeRow();
  return output;
}

export function layoutTree(root, width, height, expandedPath = null) {
  const rectangles = [];
  const expansionBranch = new Set();
  function findExpansion(node) {
    if (node.path === expandedPath || node.children.some(findExpansion)) {
      expansionBranch.add(node.path);
      return true;
    }
    return false;
  }
  if (expandedPath) findExpansion(root);

  function visit(node, bounds, depth, parentPath, insideDetail) {
    if (bounds.width < 1 || bounds.height < 1) return;
    const selected = node.path === expandedPath;
    // Keep every item's original allocation; omit tiny tiles rather than redistributing
    // their area to the remaining children and exaggerating their sizes.
    if (insideDetail && !selected && (bounds.width < 4 || bounds.height < 4 || bounds.width * bounds.height < 64)) return;
    const detail = insideDetail || selected;
    const forced = detail || expansionBranch.has(node.path);
    const normalSize = bounds.width >= 62 && bounds.height >= 58;
    const expanded = node.isDirectory && node.children.some(child => child.size > 0) &&
      (normalSize || (forced && bounds.width >= 12 && bounds.height >= 12));
    const headerHeight = expanded ? normalSize ? 23 : bounds.width >= 28 && bounds.height >= 28 ? 14 : 0 : 0;
    const padding = normalSize ? 3 : 1;
    const rectangle = { ...bounds, node, depth, parentPath, expanded, headerHeight };
    rectangles.push(rectangle);
    if (!expanded) return;
    const inner = { x: bounds.x + padding, y: bounds.y + headerHeight, width: bounds.width - 2 * padding, height: bounds.height - headerHeight - padding };
    for (const child of squarify(node.children, inner))
      visit(child.node, child, depth + 1, node.path, detail);
  }
  for (const rectangle of squarify(root.children, { x: 0, y: 0, width, height }))
    visit(rectangle.node, rectangle, 0, root.path, root.path === expandedPath);
  return rectangles;
}
