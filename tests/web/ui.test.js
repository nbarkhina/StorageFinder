import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const web = path.join(project, "src", "StorageFinder.App", "Web");
const artifacts = path.join(project, "artifacts", "screenshots");
const server = createServer(async (request, response) => {
  const filename = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
  const asset = ["StorageFinder.png", "StorageFinder.ico"].includes(filename);
  if (!asset && !["index.html", "styles.css", "app.js", "treemap-layout.js"].includes(filename)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(path.join(asset ? path.join(web, "..", "Assets") : web, filename));
    response.setHeader("Content-Type", filename.endsWith(".png") ? "image/png" : filename.endsWith(".ico") ? "image/x-icon" : filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : "text/html");
    response.end(content);
  } catch (error) {
    response.writeHead(500).end(error.message);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await mkdir(artifacts, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: false });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const GiB = 1024 ** 3;
    function file(parent, name, size) {
      return { path: `${parent}\\${name}`, name, size: Math.round(size * GiB), fileCount: 1, folderCount: 0, isDirectory: false, isAggregate: false, hasChildren: false, children: [] };
    }
    function folder(parent, name, children) {
      const node = { path: parent ? `${parent}\\${name}` : "C:\\", name, isDirectory: true, isAggregate: false, children };
      node.size = children.reduce((sum, child) => sum + child.size, 0);
      node.fileCount = children.reduce((sum, child) => sum + child.fileCount, 0);
      node.folderCount = children.reduce((sum, child) => sum + child.folderCount + Number(child.isDirectory), 0);
      node.hasChildren = children.length > 0;
      return node;
    }
    const games = folder("C:", "Games", [
      folder("C:\\Games", "Starfield", [file("C:\\Games\\Starfield", "Textures.ba2", 44), file("C:\\Games\\Starfield", "Worlds.ba2", 32), file("C:\\Games\\Starfield", "Audio.ba2", 17)]),
      folder("C:\\Games", "Baldur's Gate 3", [file("C:\\Games\\Baldur's Gate 3", "Assets.pak", 38), file("C:\\Games\\Baldur's Gate 3", "Gustav.pak", 23), file("C:\\Games\\Baldur's Gate 3", "Models.pak", 16)]),
      file("C:\\Games", "installer.iso", 9)
    ]);
    const users = folder("C:", "Users", [
      folder("C:\\Users", "Videos", [file("C:\\Users\\Videos", "Summer trip.mp4", 18), file("C:\\Users\\Videos", "Project archive.mov", 14), file("C:\\Users\\Videos", "Recording.mp4", 8)]),
      folder("C:\\Users", "Downloads", [file("C:\\Users\\Downloads", "backup.zip", 12), file("C:\\Users\\Downloads", "dataset.tar", 8), file("C:\\Users\\Downloads", "photos.zip", 4)]),
      folder("C:\\Users", "Documents", [file("C:\\Users\\Documents", "Projects.zip", 6), file("C:\\Users\\Documents", "Research.pdf", 2), file("C:\\Users\\Documents", "<b>not markup</b>.txt", .1)])
    ]);
    const windows = folder("C:", "Windows", ["System32", "WinSxS", "Installer", "SoftwareDistribution"].map((name, index) =>
      folder("C:\\Windows", name, Array.from({ length: 15 }, (_, i) => file(`C:\\Windows\\${name}`, `component-${i + 1}.dll`, (15 - i) * (index + 1) / 60)))));
    const programs = folder("C:", "Program Files", ["Adobe", "Microsoft", "Development", "Common Files"].map((name, index) =>
      folder("C:\\Program Files", name, Array.from({ length: 7 }, (_, i) => file(`C:\\Program Files\\${name}`, `package-${i + 1}.bin`, (7 - i) * (index + 1) / 10)))));
    const root = folder("", "C:\\", [games, users, programs, windows, file("C:", "pagefile.sys", 12), file("C:", "hiberfil.sys", 6), folder("C:", "Empty", [])]);
    const drives = [
      { path: "C:\\", name: "Windows", kind: "Fixed", ready: true, total: 512 * GiB, free: 117 * GiB },
      { path: "D:\\", name: "Projects", kind: "Fixed", ready: true, total: 1024 * GiB, free: 648 * GiB },
      { path: "F:\\", name: "Backup", kind: "Removable", ready: false, total: 0, free: 0, error: "Drive is not ready" }
    ];
    let listeners = [], revision = 0, expandedPath = null, focused = root, lastPhase = "watching";
    const messages = [];
    function emit(data) { listeners.forEach(listener => listener({ data })); }
    function publish(tree = root, phase = "watching", scanPercent = phase === "watching" || phase === "updating" ? 100 : 37.5) {
      focused = tree;
      lastPhase = phase;
      const breadcrumbs = [{ path: root.path, name: root.name }];
      if (tree !== root) breadcrumbs.push({ path: tree.path, name: tree.name });
      emit({ type: "snapshot", snapshot: { rootPath: root.path, phase, monitoring: true, scannedBytes: root.size, fileCount: root.fileCount, folderCount: root.folderCount, skippedEntries: 4, currentPath: "", warning: null, revision: ++revision, tree, breadcrumbs, scanPercent, progressIsEstimated: scanPercent !== null && phase !== "watching" && phase !== "updating", expandedPath } });
    }
    function find(node, target) {
      if (node.path === target) return node;
      for (const child of node.children) { const found = find(child, target); if (found) return found; }
    }
    window.chrome ??= {};
    window.chrome.webview = {
      addEventListener: (_, listener) => listeners.push(listener),
      postMessage: message => {
        messages.push(message);
        setTimeout(() => {
          if (message.type === "ready" || message.type === "drives") emit({ type: "drives", drives });
          if (message.type === "scan") publish(root, "scanning");
          if (message.type === "navigate") { expandedPath = null; publish(find(root, message.path)); }
          if (message.type === "expand") { expandedPath = message.path; publish(focused, lastPhase); }
          if (message.type === "rescan") publish(root, "scanning");
          if (message.type === "stop") emit({ type: "stopped" });
        }, 0);
      }
    };
    function detailFixture() {
      root.children = Array.from({ length: 100 }, (_, index) => {
        const parent = `C:\\Detail ${index}`;
        return folder("C:", `Detail ${index}`, [
          folder(parent, "Large folder", [file(`${parent}\\Large folder`, "data.bin", 1)]),
          file(parent, "medium.bin", .2),
          file(parent, "tiny.bin", .000001)
        ]);
      });
      root.size = root.children.reduce((sum, child) => sum + child.size, 0);
      root.fileCount = root.children.reduce((sum, child) => sum + child.fileCount, 0);
      root.folderCount = root.children.reduce((sum, child) => sum + child.folderCount + 1, 0);
      expandedPath = null;
      publish();
    }
    window.testHarness = { root, messages, publish, emit, detailFixture };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator(".drive-card").first().waitFor();
  assert.equal(await page.title(), "StorageFinder");
  assert.match(await page.locator(".brand").textContent(), /StorageFinder/);
  assert.equal(await page.locator(".brand-mark").evaluate(image => image.complete && image.naturalWidth > 0), true);
  assert.equal(await page.locator(".drive-card").count(), 3);
  assert.equal(await page.locator(".drive-card").last().isDisabled(), true);
  await page.screenshot({ path: path.join(artifacts, "drive-picker.png") });
  await page.locator(".drive-card").first().click();
  await page.waitForFunction(() => document.getElementById("folder-size").textContent !== "0 B");
  assert.equal(await page.locator("#progress").getAttribute("aria-valuenow"), "37.5");
  assert.equal(await page.locator("#scan-percentage").textContent(), "Estimated 37.5% scanned");
  assert.equal(await page.locator("#progress > div").evaluate(element => element.style.width), "37.5%");
  await page.screenshot({ path: path.join(artifacts, "scan-progress.png") });
  await page.evaluate(() => window.testHarness.publish(window.testHarness.root, "scanning", null));
  assert.equal(await page.locator("#progress").getAttribute("aria-valuenow"), null);
  assert.equal(await page.locator("#scan-percentage").textContent(), "Calculating progress");
  await page.evaluate(() => window.testHarness.publish());
  await page.waitForFunction(() => document.getElementById("progress").getAttribute("aria-valuenow") === "100");
  await page.evaluate(() => window.testHarness.publish(window.testHarness.root, "updating"));
  await page.waitForFunction(() => document.getElementById("phase").textContent === "Updating map");
  assert.equal(await page.locator("#progress").getAttribute("aria-valuenow"), "100");
  assert.equal(await page.locator("#cancel").isVisible(), false);
  assert.equal(await page.locator("#rescan").isDisabled(), false);
  await page.evaluate(() => window.testHarness.publish());
  await page.locator("#treemap").focus();
  await page.screenshot({ path: path.join(artifacts, "treemap.png") });

  await page.locator("#treemap").click({ button: "right", position: { x: 12, y: 11 } });
  assert.equal(await page.locator("#open-explorer").textContent(), "Open folder in Explorer");
  assert.equal(await page.locator('#context-menu [role="menuitem"]:visible').count(), 1);
  await page.screenshot({ path: path.join(artifacts, "explorer-context-menu.png") });
  await page.locator("#open-explorer").click();
  assert.deepEqual(await page.evaluate(() => window.testHarness.messages.at(-1)), { type: "openInExplorer", path: "C:\\Games" });
  await page.locator('.content-item[data-path="C:\\\\Games"]').focus();
  await page.keyboard.press("Shift+F10");
  assert.equal(await page.locator("#open-explorer").textContent(), "Open folder in Explorer");
  assert.equal(await page.locator('#context-menu [role="menuitem"]:visible').count(), 1);
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.locator("#open-explorer").evaluate(element => element === document.activeElement), true);
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.testHarness.messages.at(-1)), { type: "openInExplorer", path: "C:\\Games" });
  await page.locator("#treemap").click({ button: "right", position: { x: 14, y: 65 } });
  assert.equal(await page.locator("#open-explorer").textContent(), "Open containing folder in Explorer");
  assert.equal(await page.locator('#context-menu [role="menuitem"]:visible').count(), 1);
  await page.evaluate(() => window.testHarness.publish());
  assert.equal(await page.locator("#context-menu").isVisible(), true);
  await page.locator("#open-explorer").click();
  assert.deepEqual(await page.evaluate(() => window.testHarness.messages.at(-1)), { type: "revealInExplorer", path: "C:\\Games\\Starfield\\Textures.ba2" });
  await page.locator(".content-item").filter({ hasText: "pagefile.sys" }).focus();
  await page.keyboard.press("Shift+F10");
  assert.equal(await page.locator("#open-explorer").textContent(), "Open containing folder in Explorer");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#context-menu").isVisible(), false);
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.testHarness.messages.at(-1)), { type: "revealInExplorer", path: "C:\\pagefile.sys" });

  // Double-click an actual green folder header on the canvas, not just the list.
  await page.locator("#treemap").dblclick({ position: { x: 12, y: 11 } });
  await page.waitForFunction(() => document.getElementById("folder-name").textContent === "Games");
  assert.equal(await page.locator("#breadcrumbs button").count(), 2);
  await page.keyboard.press("Alt+ArrowUp");
  await page.waitForFunction(() => document.getElementById("folder-name").textContent === "C:\\");
  await page.locator('.content-item[data-path="C:\\\\Empty"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("map-empty").hidden === false);
  assert.equal(await page.locator("#folder-name").textContent(), "Empty");
  await page.locator("#treemap").click({ button: "right", position: { x: 20, y: 20 } });
  await page.locator("#open-explorer").click();
  assert.deepEqual(await page.evaluate(() => window.testHarness.messages.at(-1)), { type: "openInExplorer", path: "C:\\Empty" });
  await page.locator("#up").click();
  await page.waitForFunction(() => document.getElementById("folder-name").textContent === "C:\\");

  const before = await page.locator("#folder-size").textContent();
  await page.evaluate(() => {
    const { root, publish } = window.testHarness;
    const removed = root.children.shift();
    root.size -= removed.size;
    root.fileCount -= removed.fileCount;
    root.folderCount -= removed.folderCount + 1;
    publish();
  });
  await page.waitForFunction(() => !Array.from(document.querySelectorAll(".item-name")).some(element => element.textContent === "Games"));
  assert.notEqual(await page.locator("#folder-size").textContent(), before);
  await page.setViewportSize({ width: 960, height: 640 });
  await page.screenshot({ path: path.join(artifacts, "treemap-small.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  await page.evaluate(() => window.testHarness.detailFixture());
  const collapsed = await page.evaluate(async () => {
    const { layoutTree } = await import("./treemap-layout.js");
    const canvas = document.getElementById("treemap");
    return layoutTree(window.testHarness.root, canvas.clientWidth, canvas.clientHeight).find(item => item.node.path === "C:\\Detail 0");
  });
  assert.equal(collapsed.expanded, false);
  const position = { x: collapsed.x + collapsed.width / 2, y: collapsed.y + collapsed.height / 2 };
  await page.locator("#treemap").click({ position });
  await page.locator("#reset-detail").waitFor({ state: "visible" });
  assert.equal(await page.locator("#folder-name").textContent(), "C:\\");
  const revealed = await page.evaluate(async () => {
    const { layoutTree } = await import("./treemap-layout.js");
    const canvas = document.getElementById("treemap");
    const tiles = layoutTree(window.testHarness.root, canvas.clientWidth, canvas.clientHeight, "C:\\Detail 0");
    return { large: tiles.find(item => item.node.path === "C:\\Detail 0\\Large folder"), tiny: tiles.some(item => item.node.path === "C:\\Detail 0\\tiny.bin") };
  });
  assert.ok(revealed.large);
  assert.equal(revealed.tiny, false);
  const bounds = await page.locator("#treemap").boundingBox();
  await page.mouse.move(bounds.x + revealed.large.x + revealed.large.width / 2, bounds.y + revealed.large.y + Math.max(2, revealed.large.headerHeight / 2));
  await page.waitForFunction(() => document.querySelector("#tooltip strong").textContent === "Large folder");
  await page.screenshot({ path: path.join(artifacts, "detail-preview.png") });
  await page.locator("#reset-detail").click();
  await page.locator("#reset-detail").waitFor({ state: "hidden" });
  await page.locator("#treemap").dblclick({ position, delay: 120 });
  await page.waitForFunction(() => document.getElementById("folder-name").textContent === "Detail 0");
  assert.equal(await page.locator("#reset-detail").isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.testHarness.messages.at(-1)), { type: "navigate", path: "C:\\Detail 0" });
  await page.locator("#up").click();
  await page.waitForFunction(() => document.getElementById("folder-name").textContent === "C:\\");
  await page.evaluate(() => window.testHarness.emit({ type: "error", message: "<b>Drive disconnected</b>" }));
  assert.equal(await page.locator("#error span").textContent(), "<b>Drive disconnected</b>");
  assert.equal(await page.locator("#error b").count(), 0);
  await page.locator("#dismiss-error").click();
  await page.evaluate(() => window.testHarness.publish(window.testHarness.root, "error"));
  await page.waitForFunction(() => document.getElementById("phase").textContent === "Scan interrupted");
  assert.equal(await page.locator("#progress").getAttribute("aria-valuenow"), "37.5");
  assert.match(await page.locator("#progress").getAttribute("aria-valuetext"), /Scan interrupted/);
  assert.equal(await page.locator("#rescan").isDisabled(), false);
  await page.locator("#change-drive").click();
  await page.locator("#picker").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
  console.log("PASS: single-click detail, tiny-tile omission, reset, stable double-click zoom, percentages, context menus, keyboard actions, live updates, resize");
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
