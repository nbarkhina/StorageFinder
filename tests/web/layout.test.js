import test from "node:test";
import assert from "node:assert/strict";
import { squarify, layoutTree, formatBytes } from "../../src/StorageFinder.App/Web/treemap-layout.js";

test("squarified rectangles preserve exact relative areas and do not overlap", () => {
  for (const [width, height] of [[1000, 600], [50, 900], [1300, 30], [1, 1]]) {
    const nodes = Array.from({ length: 100 }, (_, index) => ({ size: (index + 1) ** 2 }));
    const total = nodes.reduce((sum, node) => sum + node.size, 0);
    const rectangles = squarify(nodes, { x: 3, y: 7, width, height });
    assert.equal(rectangles.length, nodes.length);
    for (const rectangle of rectangles) {
      assert.ok(Math.abs(rectangle.width * rectangle.height / (width * height) - rectangle.node.size / total) < 1e-9);
      assert.ok(rectangle.x >= 3 - 1e-8 && rectangle.y >= 7 - 1e-8);
      assert.ok(rectangle.x + rectangle.width <= width + 3 + 1e-8);
      assert.ok(rectangle.y + rectangle.height <= height + 7 + 1e-8);
    }
    for (let i = 0; i < rectangles.length; i++) {
      for (let j = i + 1; j < rectangles.length; j++) {
        const a = rectangles[i], b = rectangles[j];
        const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        assert.ok(overlapWidth < 1e-8 || overlapHeight < 1e-8);
      }
    }
  }
});

test("empty folders and zero-byte files never acquire artificial area", () => {
  assert.deepEqual(squarify([{ size: 0 }], { x: 0, y: 0, width: 100, height: 100 }), []);
  assert.deepEqual(squarify([{ size: 1 }], { x: 0, y: 0, width: 0, height: 100 }), []);
  const rectangles = squarify([{ size: 0 }, { size: 5 }], { x: 0, y: 0, width: 100, height: 100 });
  assert.equal(rectangles.length, 1);
  assert.equal(rectangles[0].width * rectangles[0].height, 10000);
});

test("nested folders reserve headers and retain the containing path for zoom", () => {
  const file = { path: "C:\\Folder\\file.bin", size: 100, isDirectory: false, children: [] };
  const folder = { path: "C:\\Folder", size: 100, isDirectory: true, children: [file] };
  const layout = layoutTree({ path: "C:\\", children: [folder] }, 600, 400);
  assert.equal(layout.length, 2);
  assert.equal(layout[1].parentPath, folder.path);
  assert.ok(layout[1].y >= layout[0].y + 23);
  assert.ok(layout[1].width < layout[0].width);
  assert.equal(layoutTree({ path: "C:\\", children: [folder] }, 30, 30).length, 1);
});

test("logical bytes use binary units with sensible boundaries", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1,023 B");
  assert.equal(formatBytes(1024), "1 KiB");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(1024 ** 4), "1 TiB");
});

test("detail mode reveals a collapsed folder in place and omits tiny tiles without inflating other items", () => {
  const data = { path: "C:\\Folder\\Large\\data.bin", size: 900, isDirectory: false, children: [] };
  const large = { path: "C:\\Folder\\Large", size: 900, isDirectory: true, children: [data] };
  const medium = { path: "C:\\Folder\\medium.bin", size: 99, isDirectory: false, children: [] };
  const tiny = { path: "C:\\Folder\\tiny.bin", size: 1, isDirectory: false, children: [] };
  const folder = { path: "C:\\Folder", size: 1000, isDirectory: true, children: [large, medium, tiny] };
  const root = { path: "C:\\", children: [folder] };
  const normal = layoutTree(root, 50, 40);
  assert.equal(normal.length, 1);
  const detail = layoutTree(root, 50, 40, folder.path);
  assert.deepEqual(detail.map(item => item.node.path), [folder.path, large.path, data.path, medium.path]);
  for (const dimension of ["x", "y", "width", "height"]) assert.equal(detail[0][dimension], normal[0][dimension]);
  const innerArea = 48 * 25;
  assert.ok(Math.abs(detail[1].width * detail[1].height / innerArea - .9) < 1e-10);
  assert.ok(detail.slice(1).every(item => item.width >= 4 && item.height >= 4 && item.width * item.height >= 64));

  const nested = layoutTree(root, 50, 40, large.path);
  assert.ok(nested.some(item => item.node.path === data.path), "The ancestor remains open when selecting a deeper folder");
  assert.equal(layoutTree(root, 10, 10, folder.path).length, 1, "A physically tiny box is not expanded beyond useful resolution");
});

test("detail mode does not expand or reposition unrelated sibling folders", () => {
  const folders = ["A", "B"].map(name => ({
    path: `C:\\${name}`, size: 100, isDirectory: true,
    children: [{ path: `C:\\${name}\\data.bin`, size: 100, isDirectory: false, children: [] }]
  }));
  const root = { path: "C:\\", children: folders };
  const normal = layoutTree(root, 80, 40);
  const detail = layoutTree(root, 80, 40, folders[0].path);
  assert.equal(normal.length, 2);
  assert.ok(detail.some(item => item.node.path === folders[0].children[0].path));
  assert.ok(!detail.some(item => item.node.path === folders[1].children[0].path));
  assert.deepEqual(detail.find(item => item.node.path === folders[1].path), normal[1]);

  const detailedNormal = layoutTree(root, 800, 600);
  const detailedOverride = layoutTree(root, 800, 600, folders[0].path);
  const unaffectedPaths = new Set([folders[1].path, folders[1].children[0].path]);
  assert.deepEqual(detailedOverride.filter(item => unaffectedPaths.has(item.node.path)),
    detailedNormal.filter(item => unaffectedPaths.has(item.node.path)),
    "Already-expanded sibling folders retain their child rectangles and exact geometry");
});
