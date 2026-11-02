import { formatBytes, layoutTree } from "./treemap-layout.js";

const $ = id => document.getElementById(id);
const bridge = globalThis.chrome?.webview;
const canvas = $("treemap");
const context = canvas.getContext("2d");
let snapshot = null;
let rectangles = [];
let selectedPath = null;
let selectedNode = null;
let hoverPath = null;
let framePending = false;
let scanning = false;
let returningToPicker = false;
let contextPath = null;
let contextOrigin = null;
let contextIsDirectory = false;
let expandedPath = null;
let pendingExpansion;
let firstClickTarget = null;

function send(type, fields = {}) {
  if (bridge) bridge.postMessage({ type, ...fields });
  else showError("Open StorageFinder.exe to connect the interface to your disks.");
}

function showError(message) {
  $("error").querySelector("span").textContent = message;
  $("error").hidden = false;
}

function showDrives(drives) {
  $("drives").replaceChildren();
  for (const drive of drives) {
    const button = document.createElement("button");
    button.className = "drive-card";
    button.disabled = !drive.ready;
    button.title = drive.error || `Scan ${drive.path}`;
    const top = document.createElement("div");
    top.className = "drive-top";
    const icon = document.createElement("span");
    icon.className = "drive-icon";
    icon.textContent = "\u25b1";
    icon.setAttribute("aria-hidden", "true");
    const heading = document.createElement("div");
    const name = document.createElement("span");
    name.className = "drive-name";
    name.textContent = `${drive.name} (${drive.path.replace(/\\$/, "")})`;
    const kind = document.createElement("span");
    kind.className = "drive-kind";
    kind.textContent = `${drive.kind} drive`;
    heading.append(name, kind);
    const arrow = document.createElement("span");
    arrow.className = "drive-arrow";
    arrow.textContent = "\u2197";
    top.append(icon, heading, arrow);
    const track = document.createElement("div");
    track.className = "capacity-track";
    const fill = document.createElement("i");
    fill.style.width = `${drive.total ? Math.max(0, Math.min(100, (1 - drive.free / drive.total) * 100)) : 0}%`;
    track.append(fill);
    const label = document.createElement("div");
    label.className = "capacity-label";
    const free = document.createElement("strong");
    free.textContent = drive.ready ? `${formatBytes(drive.free)} free` : "Not available";
    const total = document.createElement("span");
    total.textContent = drive.ready ? `${formatBytes(drive.total)} total` : "";
    label.append(free, total);
    button.append(top, track, label);
    button.addEventListener("click", () => startScan(drive.path));
    $("drives").append(button);
  }
  if (!drives.length) $("drives").textContent = "No drives found. Connect a drive and refresh.";
  $("refresh-drives").disabled = false;
}

function startScan(path) {
  hideContextMenu();
  returningToPicker = false;
  snapshot = null;
  selectedPath = null;
  selectedNode = null;
  hoverPath = null;
  rectangles = [];
  expandedPath = null;
  pendingExpansion = undefined;
  firstClickTarget = null;
  updateDetailHint();
  $("picker").hidden = true;
  $("explorer").hidden = false;
  $("error").hidden = true;
  $("warning").hidden = true;
  $("selection").hidden = true;
  $("contents").replaceChildren();
  $("breadcrumbs").replaceChildren();
  $("folder-name").textContent = path;
  $("folder-path").textContent = path;
  $("folder-size").textContent = "0 B";
  $("folder-files").textContent = "0";
  $("folder-folders").textContent = "0";
  $("map-title").textContent = path;
  $("phase").textContent = "Preparing scan";
  $("scan-summary").textContent = "";
  $("current-path").textContent = "Estimating progress from the drive's used space.";
  renderProgress({ phase: "scanning", scanPercent: null, progressIsEstimated: true });
  $("cancel").hidden = false;
  $("rescan").disabled = true;
  $("up").disabled = true;
  updateEmpty();
  requestDraw();
  send("scan", { path });
}

function navigate(path) {
  if (!snapshot || path === snapshot.tree.path) return;
  hideContextMenu();
  selectedPath = null;
  hoverPath = null;
  expandedPath = null;
  pendingExpansion = undefined;
  updateDetailHint();
  $("tooltip").hidden = true;
  send("navigate", { path });
}

function parent() {
  if (snapshot?.breadcrumbs.length > 1) navigate(snapshot.breadcrumbs.at(-2).path);
}

function updateSnapshot(next) {
  if (returningToPicker) return;
  const changedFolder = snapshot?.tree.path !== next.tree.path;
  snapshot = next;
  const confirmedExpansion = next.expandedPath ?? null;
  if (changedFolder || pendingExpansion === undefined || confirmedExpansion === pendingExpansion ||
      (pendingExpansion !== null && !findNode(next.tree, pendingExpansion))) {
    expandedPath = confirmedExpansion;
    pendingExpansion = undefined;
  }
  updateDetailHint();
  if (changedFolder || (contextPath && !findNode(next.tree, contextPath))) hideContextMenu();
  if (changedFolder) selectedPath = null;
  scanning = next.phase === "scanning";
  $("picker").hidden = true;
  $("explorer").hidden = false;
  $("phase").textContent = next.phase === "error" ? "Scan interrupted" : next.phase === "scanning" ? "Scanning drive" :
    next.phase === "updating" ? "Updating map" : next.monitoring ? "Live \u00b7 watching for changes" : "Scan complete \u00b7 monitoring unavailable";
  $("status-dot").classList.toggle("live", !scanning && next.monitoring);
  $("status-dot").classList.toggle("failed", next.phase === "error");
  $("scan-summary").textContent = `${formatBytes(next.scannedBytes)} discovered \u00b7 ${next.fileCount.toLocaleString()} files \u00b7 ${next.folderCount.toLocaleString()} folders`;
  renderProgress(next);
  $("current-path").textContent = next.phase === "error" ? "Scan could not finish. Check the drive connection or permissions, then rescan." :
    next.currentPath || (scanning ? "Discovering files and updating the estimate..." : next.phase === "updating" ? "Applying filesystem changes..." :
      "Map is up to date. Double-click a folder to explore, or use the breadcrumbs to go back.");
  $("current-path").title = next.currentPath;
  $("rescan").disabled = scanning;
  $("cancel").hidden = !scanning;
  $("up").disabled = next.breadcrumbs.length < 2;
  $("breadcrumbs").replaceChildren();
  for (const [index, crumb] of next.breadcrumbs.entries()) {
    if (index) {
      const separator = document.createElement("span");
      separator.className = "crumb-separator";
      separator.textContent = "\u203a";
      $("breadcrumbs").append(separator);
    }
    const button = document.createElement("button");
    button.textContent = crumb.name;
    button.title = crumb.path;
    if (index === next.breadcrumbs.length - 1) button.setAttribute("aria-current", "location");
    button.addEventListener("click", () => navigate(crumb.path));
    $("breadcrumbs").append(button);
  }
  const tree = next.tree;
  $("map-title").textContent = tree.name;
  $("folder-name").textContent = tree.name;
  $("folder-path").textContent = tree.path;
  $("folder-size").textContent = formatBytes(tree.size);
  $("folder-files").textContent = tree.fileCount.toLocaleString();
  $("folder-folders").textContent = tree.folderCount.toLocaleString();
  $("monitor-status").textContent = next.monitoring ? "Live monitoring on \u00b7 changes are detected automatically" : "Live monitoring off \u00b7 rescan to refresh";
  $("skipped").textContent = `${next.skippedEntries.toLocaleString()} skipped / unreadable \u00b7 reparse points not followed`;
  $("warning").hidden = !next.warning;
  $("warning").textContent = next.warning || "";
  $("warning").title = next.warning || "";
  renderContents(tree.children);
  selectedNode = findNode(tree, selectedPath);
  showSelection();
  $("tooltip").hidden = true;
  updateEmpty();
  requestDraw();
}

function renderProgress(next) {
  const percent = Number.isFinite(next.scanPercent) ? Math.max(0, Math.min(100, next.scanPercent)) : null;
  const label = percent === null ? "Calculating progress" :
    `${next.progressIsEstimated ? "Estimated " : ""}${percent.toLocaleString("en-US", { maximumFractionDigits: 1 })}% scanned`;
  $("scan-percentage").textContent = label;
  $("scan-percentage").title = next.progressIsEstimated ?
    "Estimate: discovered logical file sizes divided by the drive's used space at scan start. Compression, hard links, and unreadable files can affect this estimate. It stays below 100% until discovery finishes." :
    percent === 100 ? "Scan complete. Unreadable and excluded entries are reported below." : "Waiting for disk usage information.";
  $("progress").classList.toggle("determinate", percent !== null);
  $("progress").classList.toggle("complete", next.phase === "watching" || next.phase === "updating");
  $("progress").classList.toggle("failed", next.phase === "error");
  $("progress").firstElementChild.style.width = percent === null ? "" : `${percent}%`;
  $("progress").setAttribute("aria-valuetext", next.phase === "error" ? `Scan interrupted. ${label}` : label);
  if (percent === null) $("progress").removeAttribute("aria-valuenow");
  else $("progress").setAttribute("aria-valuenow", String(percent));
}

function findNode(node, path) {
  if (!path) return null;
  if (node.path === path) return node;
  for (const child of node.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}

function renderContents(children) {
  const focusedPath = document.activeElement?.dataset.path;
  const scroll = $("contents").scrollTop;
  $("contents").replaceChildren();
  $("items-count").textContent = `${children.filter(child => !child.isAggregate).length} shown`;
  for (const node of children) {
    const button = document.createElement("button");
    button.className = "content-item";
    button.classList.toggle("selected", node.path === selectedPath);
    button.dataset.path = node.path;
    button.title = `${node.name} \u00b7 ${formatBytes(node.size)}${node.isDirectory ? " \u00b7 Double-click or press Enter to explore" : ""}`;
    const swatch = document.createElement("i");
    swatch.className = node.isDirectory ? "folder-swatch" : "file-swatch";
    const name = document.createElement("span");
    name.className = "item-name";
    name.textContent = node.name;
    const size = document.createElement("span");
    size.className = "item-size";
    size.textContent = formatBytes(node.size);
    button.append(swatch, name, size);
    button.addEventListener("click", () => select(node));
    button.addEventListener("dblclick", () => { if (node.isDirectory) navigate(node.path); });
    button.addEventListener("contextmenu", event => showContextMenu(event, node));
    button.addEventListener("keydown", event => {
      if (event.key === "Enter" && node.isDirectory) { event.preventDefault(); navigate(node.path); }
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) showContextMenu(event, node);
    });
    $("contents").append(button);
    if (focusedPath === node.path) button.focus({ preventScroll: true });
  }
  $("contents").scrollTop = scroll;
}

function showContextMenu(event, node) {
  event.preventDefault();
  hideContextMenu();
  if (!node || node.isAggregate) return;
  select(node);
  contextPath = node.path;
  contextIsDirectory = node.isDirectory;
  contextOrigin = event.currentTarget;
  $("tooltip").hidden = true;
  $("context-name").textContent = node.name;
  $("context-name").title = node.path;
  $("open-explorer").textContent = node.isDirectory ? "Open folder in Explorer" : "Open containing folder in Explorer";
  $("open-explorer").title = node.isDirectory ? "Open this folder" : "Select this file in its containing folder";
  const menu = $("context-menu");
  menu.hidden = false;
  const anchor = contextOrigin.getBoundingClientRect();
  const x = event.clientX || anchor.left + 15;
  const y = event.clientY || anchor.top + 20;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  $("open-explorer").focus({ preventScroll: true });
}

function hideContextMenu(restoreFocus = false) {
  $("context-menu").hidden = true;
  contextPath = null;
  contextIsDirectory = false;
  if (restoreFocus) (contextOrigin?.isConnected ? contextOrigin : canvas).focus({ preventScroll: true });
  contextOrigin = null;
}

function select(node) {
  selectedPath = node.path;
  selectedNode = node;
  for (const button of $("contents").children) button.classList.toggle("selected", button.dataset.path === selectedPath);
  showSelection();
  requestDraw();
}

function revealFolder(path) {
  expandedPath = path;
  pendingExpansion = path;
  hideContextMenu();
  $("tooltip").hidden = true;
  updateDetailHint();
  requestDraw();
  send("expand", { path });
}

function updateDetailHint() {
  $("reset-detail").hidden = !expandedPath;
  $("detail-hint").textContent = expandedPath ? "Detail preview \u00b7 tiny items hidden" : "Single-click for detail \u00b7 double-click to zoom";
  $("detail-hint").title = expandedPath ?
    "Normal detail keeps its 5,000-node allowance. The selected branch has a separate allowance of up to 5,000 additional nodes, with up to 1,000 children per folder and 12 deeper levels. Tiles under 4 px on either side or 64 px squared are hidden." :
    "Normal detail: 62 x 58 px folder boxes, 5 levels, 180 children per folder, and 5,000 nodes per update.";
}

function showSelection() {
  $("selection").hidden = !selectedNode;
  if (!selectedNode) return;
  $("selected-name").textContent = selectedNode.name;
  $("selected-size").textContent = `${formatBytes(selectedNode.size)} \u00b7 ${selectedNode.size.toLocaleString()} bytes`;
  $("open-selected").hidden = !selectedNode.isDirectory;
}

function updateEmpty() {
  const empty = !snapshot || snapshot.tree.size <= 0;
  $("map-empty").hidden = !empty;
  $("map-empty").querySelector("h3").textContent = scanning || !snapshot ? "Discovering your files" : "No file data in this folder";
  $("map-empty").querySelector("p").textContent = scanning || !snapshot ? "The map will build here as the scan runs." : "Empty folders and zero-byte files appear in the list, but have no area.";
  if (snapshot?.phase === "error") {
    $("map-empty").querySelector("h3").textContent = "Scan interrupted";
    $("map-empty").querySelector("p").textContent = "Check the drive connection or permissions, then rescan.";
  }
}

function requestDraw() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => { framePending = false; draw(); });
}

function hash(text) {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (Math.imul(value, 31) + text.charCodeAt(i)) | 0;
  return value >>> 0;
}

function clipText(text, maxWidth) {
  if (context.measureText(text).width <= maxWidth) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (context.measureText(text.slice(0, middle) + "\u2026").width <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return low ? text.slice(0, low) + "\u2026" : "";
}

function draw() {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  rectangles = snapshot ? layoutTree(snapshot.tree, width, height, expandedPath) : [];
  for (const rectangle of rectangles) {
    const { node, x, y, width: w, height: h, depth, expanded, headerHeight } = rectangle;
    const seed = hash(node.isDirectory ? node.path : node.name.split(".").at(-1));
    const hue = node.isDirectory ? 145 + seed % 16 : node.isAggregate ? 197 : 194 + seed % 17;
    const saturation = node.isDirectory ? 34 : node.isAggregate ? 23 : 46 + seed % 13;
    const lightness = node.isDirectory ? 59 + seed % 9 - Math.min(depth, 8) * 1.2 : 53 + seed % 12;
    const gradient = context.createLinearGradient(x, y, x + w * .4, y + h);
    gradient.addColorStop(0, `hsl(${hue} ${saturation}% ${lightness + 7}%)`);
    gradient.addColorStop(.55, `hsl(${hue} ${saturation}% ${lightness}%)`);
    gradient.addColorStop(1, `hsl(${hue} ${saturation}% ${lightness - 6}%)`);
    context.fillStyle = gradient;
    context.fillRect(x, y, w, h);
    context.strokeStyle = "#152231a0";
    context.lineWidth = 1;
    context.strokeRect(x + .5, y + .5, Math.max(0, w - 1), Math.max(0, h - 1));
    if (w < 28 || h < 17 || (expanded && headerHeight === 0)) continue;
    context.save();
    context.beginPath();
    context.rect(x + 4, y + 2, w - 8, h - 4);
    context.clip();
    context.fillStyle = "#14202c";
    context.textBaseline = "middle";
    if (expanded) {
      context.font = "600 11px 'Segoe UI', sans-serif";
      context.fillText(clipText(`${node.name} \u00b7 ${formatBytes(node.size)}`, w - 12), x + 6, y + headerHeight / 2 + .5);
    } else {
      context.textAlign = "center";
      context.font = `${node.isDirectory ? "600" : "500"} ${w > 130 ? 12 : 11}px 'Segoe UI', sans-serif`;
      context.fillText(clipText(node.name, w - 12), x + w / 2, y + h / 2 - (h >= 35 ? 7 : 0));
      if (h >= 35) {
        context.font = "10px 'Segoe UI', sans-serif";
        context.fillStyle = "#203545";
        context.fillText(clipText(formatBytes(node.size), w - 10), x + w / 2, y + h / 2 + 9);
      }
    }
    context.restore();
  }
  for (const path of [hoverPath, selectedPath]) {
    const rectangle = rectangles.find(item => item.node.path === path);
    if (!rectangle) continue;
    context.strokeStyle = path === selectedPath ? "#c7ffe1" : "#effbff";
    context.lineWidth = 2;
    context.strokeRect(rectangle.x + 1.5, rectangle.y + 1.5, Math.max(0, rectangle.width - 3), Math.max(0, rectangle.height - 3));
  }
}

function hit(event) {
  const bounds = canvas.getBoundingClientRect();
  const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
  return { rectangle: rectangles.findLast(item => x >= item.x && x < item.x + item.width && y >= item.y && y < item.y + item.height), x, y };
}

canvas.addEventListener("mousemove", event => {
  if (!$("context-menu").hidden) return;
  const { rectangle, x, y } = hit(event);
  if (hoverPath !== rectangle?.node.path) { hoverPath = rectangle?.node.path; requestDraw(); }
  canvas.style.cursor = rectangle ? "pointer" : "default";
  $("tooltip").hidden = !rectangle;
  if (!rectangle) return;
  const node = rectangle.node;
  $("tooltip").querySelector("strong").textContent = node.name;
  $("tooltip").querySelector("span").textContent = `${formatBytes(node.size)} \u00b7 ${node.size.toLocaleString()} bytes`;
  $("tooltip").querySelector("small").textContent = node.isAggregate ? "Small items are grouped to keep the map responsive." :
    node.isDirectory ? `${node.fileCount.toLocaleString()} files \u00b7 click for detail, double-click to zoom` : "Double-click to explore the containing folder";
  $("tooltip").style.left = `${Math.max(4, Math.min(x + 16, canvas.clientWidth - $("tooltip").offsetWidth - 8))}px`;
  $("tooltip").style.top = `${Math.max(4, Math.min(y + 16, canvas.clientHeight - $("tooltip").offsetHeight - 8))}px`;
});
canvas.addEventListener("mouseleave", () => { hoverPath = null; $("tooltip").hidden = true; requestDraw(); });
canvas.addEventListener("click", event => {
  if (event.detail > 1) return;
  const item = hit(event).rectangle;
  firstClickTarget = item;
  if (item) {
    select(item.node);
    if (item.node.isDirectory) revealFolder(item.node.path);
  }
});
canvas.addEventListener("dblclick", event => {
  // The first click may reveal new rectangles underneath the pointer.
  const item = firstClickTarget ?? hit(event).rectangle;
  firstClickTarget = null;
  if (item && !item.node.isAggregate) navigate(item.node.isDirectory ? item.node.path : item.parentPath);
});
canvas.addEventListener("contextmenu", event => showContextMenu(event, hit(event).rectangle?.node ?? snapshot?.tree));
canvas.addEventListener("keydown", event => {
  if (event.key === "Enter" && selectedNode?.isDirectory) navigate(selectedNode.path);
  if (event.code === "Space" && selectedNode?.isDirectory) { event.preventDefault(); revealFolder(selectedNode.path); }
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) showContextMenu(event, selectedNode ?? snapshot?.tree);
});
document.addEventListener("keydown", event => {
  if (!$("context-menu").hidden && event.key === "Escape") { event.preventDefault(); hideContextMenu(true); return; }
  if (!$("context-menu").hidden && event.key === "Tab") hideContextMenu(true);
  if ((event.altKey && event.key === "ArrowUp") || (event.key === "Backspace" && event.target === canvas)) { event.preventDefault(); parent(); }
});
document.addEventListener("pointerdown", event => {
  if (!$("context-menu").hidden && !$("context-menu").contains(event.target)) hideContextMenu();
});
window.addEventListener("resize", () => hideContextMenu());
$("contents").addEventListener("scroll", () => hideContextMenu());
$("context-menu").addEventListener("contextmenu", event => event.preventDefault());
$("context-menu").addEventListener("keydown", event => {
  if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const items = [...$("context-menu").querySelectorAll("button")].filter(button => !button.hidden);
  const current = items.indexOf(document.activeElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
    (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next].focus();
});
$("open-explorer").addEventListener("click", () => {
  const path = contextPath;
  const type = contextIsDirectory ? "openInExplorer" : "revealInExplorer";
  hideContextMenu(true);
  if (path) send(type, { path });
});
$("up").addEventListener("click", parent);
$("open-selected").addEventListener("click", () => { if (selectedNode?.isDirectory) navigate(selectedNode.path); });
$("reset-detail").addEventListener("click", () => revealFolder(null));
$("rescan").addEventListener("click", () => { $("rescan").disabled = true; send("rescan"); });
$("refresh-drives").addEventListener("click", () => { $("refresh-drives").disabled = true; send("drives"); });
function changeDrive() { hideContextMenu(); returningToPicker = true; send("stop"); }
$("change-drive").addEventListener("click", changeDrive);
$("cancel").addEventListener("click", changeDrive);
$("dismiss-error").addEventListener("click", () => { $("error").hidden = true; });
new ResizeObserver(requestDraw).observe($("map-container"));

bridge?.addEventListener("message", ({ data }) => {
  if (data.type === "drives") showDrives(data.drives);
  else if (data.type === "snapshot") updateSnapshot(data.snapshot);
  else if (data.type === "error") {
    $("refresh-drives").disabled = false;
    $("rescan").disabled = false;
    if (!snapshot) {
      $("explorer").hidden = true;
      $("picker").hidden = false;
    }
    showError(data.message);
  } else if (data.type === "stopped") {
    snapshot = null;
    $("explorer").hidden = true;
    $("picker").hidden = false;
    send("drives");
  }
});
send("ready");
