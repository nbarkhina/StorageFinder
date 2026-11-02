import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const executable = process.env.STORAGEFINDER_EXE || path.join(project, "src", "StorageFinder.App", "bin", "Release", "net10.0-windows", "StorageFinder.exe");
const execFileAsync = promisify(execFile);

async function windowChrome(processId, close = false) {
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowChrome {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr window, int index);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    public static void CheckClientFrame(IntPtr window) {
        var memory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Rect)));
        try {
            var requested = new Rect { Left = 100, Top = 100, Right = 900, Bottom = 700 };
            Marshal.StructureToPtr(requested, memory, false);
            SendMessageW(window, 0x0083, IntPtr.Zero, memory);
            var actual = (Rect)Marshal.PtrToStructure(memory, typeof(Rect));
            if (actual.Left != requested.Left || actual.Top != requested.Top ||
                actual.Right != requested.Right || actual.Bottom != requested.Bottom)
                throw new InvalidOperationException("WM_NCCALCSIZE restored a native non-client frame");
        } finally {
            Marshal.FreeHGlobal(memory);
        }
        Rect outer, client;
        if (!GetWindowRect(window, out outer) || !GetClientRect(window, out client))
            throw new InvalidOperationException("Could not read window frame bounds");
        if (outer.Right - outer.Left != client.Right || outer.Bottom - outer.Top != client.Bottom)
            throw new InvalidOperationException("Native frame is taking space from the custom client area");
    }
}
'@
    $process = Get-Process -Id ${processId}
    $handle = $process.MainWindowHandle
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    function Invoke-Caption($name) {
      $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $name)
      $button = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
      if (!$button) { throw "Missing caption button: $name" }
      $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    }
    function Wait-State($state) {
      for ($attempt = 0; $attempt -lt 100; $attempt++) {
        $actual = if ([WindowChrome]::IsIconic($handle)) { 'minimized' } elseif ([WindowChrome]::IsZoomed($handle)) { 'maximized' } else { 'normal' }
        if ($actual -eq $state) { return }
        Start-Sleep -Milliseconds 50
      }
      throw "Window did not become $state"
    }
    if (${close ? "$true" : "$false"}) {
      Invoke-Caption 'Close'
      exit
    }
    if (([WindowChrome]::GetWindowLongW($handle, -16) -band 0x00C00000) -ne 0) { throw 'Native caption is still visible' }
    [WindowChrome]::CheckClientFrame($handle)
    foreach ($active in @(0, 1, 0, 1)) {
      $null = [WindowChrome]::SendMessageW($handle, 0x0086, [IntPtr]::new($active), [IntPtr]::Zero)
      $null = [WindowChrome]::SendMessageW($handle, 0x0085, [IntPtr]::new(1), [IntPtr]::Zero)
      if (![WindowChrome]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, 0, 0, 0x0037)) { throw 'Could not refresh the native frame' }
      [WindowChrome]::CheckClientFrame($handle)
    }
    $bounds = $window.Current.BoundingRectangle
    $corners = @(
      @(($bounds.Left + 2), ($bounds.Top + 2), 13),
      @(($bounds.Right - 2), ($bounds.Top + 2), 14),
      @(($bounds.Left + 2), ($bounds.Bottom - 2), 16),
      @(($bounds.Right - 2), ($bounds.Bottom - 2), 17)
    )
    foreach ($corner in $corners) {
      $position = ($corner[0] -band 0xffff) -bor (($corner[1] -band 0xffff) -shl 16)
      $hit = [WindowChrome]::SendMessageW($handle, 0x0084, [IntPtr]::Zero, [IntPtr]::new([long]$position))
      if ($hit.ToInt32() -ne $corner[2]) { throw "Resize hit test failed: $hit" }
    }
    Invoke-Caption 'Maximize'
    Wait-State 'maximized'
    $work = [System.Windows.Forms.Screen]::FromHandle($handle).WorkingArea
    $maximized = $window.Current.BoundingRectangle
    if ($maximized.Left -ne $work.Left -or $maximized.Top -ne $work.Top -or $maximized.Width -ne $work.Width -or $maximized.Height -ne $work.Height) {
      throw "Maximized window does not fit the working area: $maximized versus $work"
    }
    Invoke-Caption 'Restore'
    Wait-State 'normal'
    $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'StorageFinder - Disk space, made visible')
    $title = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if (!$title) { throw 'Missing draggable title' }
    $titleHandle = [IntPtr]::new($title.Current.NativeWindowHandle)
    $null = [WindowChrome]::SendMessageW($titleHandle, 0x0203, [IntPtr]::new(1), [IntPtr]::new(0x000a000a))
    Wait-State 'maximized'
    $null = [WindowChrome]::SendMessageW($titleHandle, 0x0203, [IntPtr]::new(1), [IntPtr]::new(0x000a000a))
    Wait-State 'normal'
    Invoke-Caption 'Minimize'
    Wait-State 'minimized'
    $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
    Wait-State 'normal'
    [WindowChrome]::CheckClientFrame($handle)
    Write-Output 'PASS: dark native chrome, resize corners, maximize working area, restore, double-click, minimize'
  `;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
  if (stdout.trim()) console.log(stdout.trim());
}

const explorerFixture = await mkdtemp(path.join(tmpdir(), "StorageFinder.Explorer-"));
const explorerFolder = path.join(explorerFixture, "Folder,comma");
const containingFolder = path.join(explorerFixture, "Files with spaces");
const explorerFile = path.join(containingFolder, "zzz selected, file.txt");
await mkdir(explorerFolder);
await mkdir(containingFolder);
await writeFile(explorerFile, "Select this item without opening the file.");
for (let index = 0; index < 200; index++) {
  await writeFile(path.join(containingFolder, `item-${index.toString().padStart(3, "0")}.txt`), "");
  await writeFile(path.join(explorerFixture, `item-${index.toString().padStart(3, "0")}.txt`), "");
}

async function explorerWindows(target, close = false, selectedItem = null) {
  const script = `
    $ErrorActionPreference = 'Stop'
    $shell = New-Object -ComObject Shell.Application
    $handles = @()
    foreach ($window in @($shell.Windows())) {
      $url = $window.LocationURL
      if ($url -and $url.StartsWith('file:', [StringComparison]::OrdinalIgnoreCase)) {
        $folder = ([Uri]$url).LocalPath.TrimEnd('\\')
        if ($folder -eq $env:STORAGEFINDER_EXPLORER_TARGET.TrimEnd('\\')) {
          if ($env:STORAGEFINDER_SELECTED_ITEM) {
            $selected = @($window.Document.SelectedItems() | ForEach-Object { $_.Path })
            $focused = $window.Document.FocusedItem
            if ($selected -notcontains $env:STORAGEFINDER_SELECTED_ITEM -or $focused.Path -ne $env:STORAGEFINDER_SELECTED_ITEM) { continue }
          }
          $handles += [long]$window.HWND
          if ($env:STORAGEFINDER_CLOSE_EXPLORER -eq '1') { $window.Quit() }
        }
      }
    }
    ConvertTo-Json -InputObject @($handles) -Compress
  `;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    env: {
      ...process.env,
      STORAGEFINDER_EXPLORER_TARGET: target,
      STORAGEFINDER_CLOSE_EXPLORER: close ? "1" : "0",
      STORAGEFINDER_SELECTED_ITEM: selectedItem || ""
    }
  });
  return JSON.parse(stdout);
}

async function waitForExplorer(target, selectedItem = null) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if ((await explorerWindows(target, false, selectedItem)).length) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Explorer did not open ${target}${selectedItem ? ` with ${selectedItem} selected and focused` : ""}`);
}

const portProbe = createServer();
await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const app = spawn(executable, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: path.join(explorerFixture, "WebView2")
  },
  stdio: "ignore"
});
const exited = new Promise(resolve => app.once("exit", resolve));
let browser;
try {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch (error) {
      if (error.cause?.code !== "ECONNREFUSED") throw error;
    }
    if (app.exitCode !== null) throw new Error(`App exited during startup: ${app.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  let page = context.pages()[0];
  if (!page) page = await context.waitForEvent("page");
  await page.waitForURL("https://storagefinder.local/index.html");
  await page.locator(".drive-card:not(:disabled)").first().waitFor();
  await windowChrome(app.pid);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => {
    window.receivedSnapshots = [];
    window.chrome.webview.addEventListener("message", event => {
      if (event.data.type === "snapshot") window.receivedSnapshots.push(event.data.snapshot);
    });
  });
  await page.getByTitle(`Scan ${path.parse(explorerFixture).root}`, { exact: true }).click();
  await page.waitForFunction(() => window.receivedSnapshots.some(state => state.scannedBytes > 0), null, { timeout: 20000 });
  const scanState = await page.evaluate(() => window.receivedSnapshots.find(state => state.phase === "scanning" && state.scannedBytes > 0));
  assert.ok(scanState.scanPercent >= 0 && scanState.scanPercent < 100);
  assert.equal(scanState.progressIsEstimated, true);
  assert.match(await page.locator("#scan-percentage").textContent(), /% scanned$/);
  await page.waitForFunction(() => window.receivedSnapshots.at(-1).tree.children.some(node => node.isDirectory && node.size > 0));
  const folderPath = await page.evaluate(() => window.receivedSnapshots.at(-1).tree.children.find(node => node.isDirectory && node.size > 0).path);
  const folder = page.locator(".content-item").filter({ has: page.locator(".folder-swatch") });
  await folder.first().click();
  await page.locator("#treemap").focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => window.receivedSnapshots.at(-1).expandedPath !== null);
  assert.equal(await page.evaluate(() => window.receivedSnapshots.at(-1).tree.path === window.receivedSnapshots.at(-1).rootPath), true);
  await page.locator("#reset-detail").click();
  await page.waitForFunction(() => window.receivedSnapshots.at(-1).expandedPath === null);
  await folder.first().focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.receivedSnapshots.at(-1).breadcrumbs.length > 1);
  assert.ok(folderPath.length > 0);
  await page.locator("#up").click();
  await page.waitForFunction(() => window.receivedSnapshots.at(-1).breadcrumbs.length === 1);
  for (const [item, folderPath, reveal] of [[explorerFolder, explorerFolder, false], [explorerFolder, explorerFixture, true], [explorerFile, containingFolder, true]]) {
    await page.evaluate(({ itemPath, reveal }) => window.chrome.webview.postMessage({
      type: reveal ? "revealInExplorer" : "openInExplorer", path: itemPath
    }), { itemPath: item, reveal });
    await waitForExplorer(folderPath, reveal ? item : null);
    assert.equal(await page.locator("#error").isVisible(), false);
  }
  await page.evaluate(itemPath => window.chrome.webview.postMessage({ type: "revealInExplorer", path: itemPath }), path.join(explorerFixture, "missing.txt"));
  await page.locator("#error").waitFor({ state: "visible" });
  assert.ok((await page.locator("#error span").textContent()).length > 0);
  await page.locator("#dismiss-error").click();
  await page.locator("#change-drive").click();
  await page.locator("#picker").waitFor({ state: "visible" });
  assert.equal(await page.locator("#error").isVisible(), false);
  assert.deepEqual(errors, []);
  await windowChrome(app.pid, true);
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("Custom close button did not exit the app")), 10000))]);
  console.log("PASS: native WebView2, Explorer selection/focus in crowded folders, direct folder opening, detail/reset, percentages, zoom, cancellation");
} finally {
  // Close the actual WinForms window gracefully so it can dispose its scanner and watcher.
  const close = spawn("powershell.exe", ["-NoProfile", "-Command", `$p = Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue; if ($p) { $null = $p.CloseMainWindow() }`], { stdio: "ignore" });
  await new Promise(resolve => close.once("exit", resolve));
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (app.exitCode === null) app.kill();
  if (browser) await browser.close();
  // These unique fixture folders did not exist before this check; never close unrelated Explorer windows.
  await explorerWindows(explorerFolder, true);
  await explorerWindows(containingFolder, true);
  await explorerWindows(explorerFixture, true);
  await rm(explorerFixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

const logDirectory = path.join(process.env.LOCALAPPDATA, "StorageFinder", "Logs");
const logName = (await readdir(logDirectory)).filter(name => name.endsWith(`-${app.pid}.log`)).sort().at(-1);
assert.ok(logName, "The native app must persist a per-run diagnostic log");
const log = await readFile(path.join(logDirectory, logName), "utf8");
assert.match(log, /App starting:/);
assert.match(log, /Startup splash rendered/);
assert.ok(log.indexOf("Startup splash rendered") < log.indexOf("WebView2 initialized:"));
assert.match(log, /Interface ready; startup splash hidden/);
assert.match(log, /WebView2 initialized:/);
assert.match(log, /Initial scan starting:/);
assert.match(log, /Session stopped:/);
assert.match(log, /App closed/);
assert.match(log, /Explorer open requested:/);
assert.match(log, /selected=True/);
console.log("PASS: per-run logs persist startup, scanner activity, and graceful shutdown");
