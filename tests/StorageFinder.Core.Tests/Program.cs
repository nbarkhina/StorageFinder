using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using StorageFinder.Core;

var fixture = Directory.CreateTempSubdirectory("StorageFinder.Tests-");
try
{
    var root = fixture.FullName;
    var alpha = Directory.CreateDirectory(Path.Combine(root, "Alpha")).FullName;
    var nested = Directory.CreateDirectory(Path.Combine(alpha, "Nested")).FullName;
    Directory.CreateDirectory(Path.Combine(root, "Empty"));
    WriteSize(Path.Combine(root, "root.bin"), 100);
    WriteSize(Path.Combine(alpha, "alpha.bin"), 200);
    WriteSize(Path.Combine(nested, "nested.bin"), 300);
    WriteSize(Path.Combine(root, "zero.bin"), 0);
    var snapshots = new ConcurrentQueue<ScanSnapshot>();
    await using (var session = new DiskScanSession(root, snapshots.Enqueue))
    {
        var initial = await WaitFor(snapshots, state => state.Phase == "watching" && state.ScannedBytes == 600);
        Assert(initial.FileCount == 4 && initial.FolderCount == 3, "Initial recursive counts");
        Assert(initial.Monitoring, "Watcher active before initial enumeration");
        Assert(snapshots.Any(state => state.Phase == "scanning"), "Incremental scan publishes before completion");
        Assert(initial.Tree.Children.Single(node => node.Name == "Empty").Size == 0, "Empty folders remain navigable");
        CheckProjection(initial.Tree);

        session.Navigate(alpha);
        var focused = await WaitFor(snapshots, state => state.Tree.Path == alpha);
        Assert(focused.Tree.Size == 500 && focused.Breadcrumbs.Count == 2, "Zoomed folder size and breadcrumbs");

        WriteSize(Path.Combine(alpha, "new.bin"), 450);
        await WaitFor(snapshots, state => state.ScannedBytes == 1050 && state.FileCount == 5 && state.Phase == "watching");
        WriteSize(Path.Combine(alpha, "alpha.bin"), 750);
        await WaitFor(snapshots, state => state.ScannedBytes == 1600 && state.Phase == "watching");
        File.Move(Path.Combine(alpha, "new.bin"), Path.Combine(alpha, "renamed.bin"));
        await WaitFor(snapshots, state => state.Tree.Children.Any(node => node.Name == "renamed.bin") &&
            state.Tree.Children.All(node => node.Name != "new.bin") && state.Phase == "watching");
        File.Delete(Path.Combine(alpha, "renamed.bin"));
        await WaitFor(snapshots, state => state.ScannedBytes == 1150 && state.FileCount == 4 && state.Phase == "watching");

        session.Navigate(nested);
        await WaitFor(snapshots, state => state.Tree.Path == nested);
        Directory.Delete(nested, recursive: true);
        var deleted = await WaitFor(snapshots, state => state.ScannedBytes == 850 && state.Tree.Path == alpha && state.Phase == "watching");
        Assert(deleted.FolderCount == 2, "Deleting focused subtree falls back to surviving parent");

        var replacement = Directory.CreateDirectory(Path.Combine(alpha, "Replacement")).FullName;
        WriteSize(Path.Combine(replacement, "before.bin"), 123);
        await WaitFor(snapshots, state => state.ScannedBytes == 973 && state.Phase == "watching");
        Directory.Delete(replacement, recursive: true);
        Directory.CreateDirectory(replacement);
        WriteSize(Path.Combine(replacement, "after.bin"), 789);
        var replaced = await WaitFor(snapshots, state => state.ScannedBytes == 1639 && state.Phase == "watching");
        Assert(replaced.Tree.Children.Single(node => node.Name == "Replacement").Children.Single().Name == "after.bin",
            "A deleted and recreated directory does not retain stale children");

        var moved = Path.Combine(root, "Moved");
        Directory.Move(alpha, moved);
        var renamed = await WaitFor(snapshots, state => state.ScannedBytes == 1639 && state.Tree.Path == root &&
            state.Tree.Children.Any(node => node.Name == "Moved") && state.Phase == "watching");
        CheckProjection(renamed.Tree);
        Assert(initial.ScannedBytes == 600 && initial.Tree.Children.Single(node => node.Name == "Alpha").Size == 500,
            "Published snapshots remain immutable after updates");

        session.Navigate(Path.Combine(root, "does-not-exist", "child"));
        await WaitFor(snapshots, state => state.Revision > renamed.Revision && state.Tree.Path == root);
        session.Rescan();
        await WaitFor(snapshots, state => state.Revision > renamed.Revision + 1 && state.Phase == "scanning");
        await WaitFor(snapshots, state => state.Revision > renamed.Revision + 1 && state.Phase == "watching" && state.ScannedBytes == 1639);
        Console.WriteLine("PASS: scan, navigation, immutable snapshots, create, resize, rename, delete, directory replacement, rescan");
    }

    var wide = Directory.CreateDirectory(Path.Combine(root, "Wide")).FullName;
    for (var i = 0; i < 250; i++)
        WriteSize(Path.Combine(wide, $"file-{i:D4}.bin"), i + 1);
    var wideSnapshots = new ConcurrentQueue<ScanSnapshot>();
    await using (var session = new DiskScanSession(wide, wideSnapshots.Enqueue))
    {
        var state = await WaitFor(wideSnapshots, item => item.Phase == "watching");
        Assert(state.Tree.Children.Count == 181, "Large sibling sets use a bounded projection");
        Assert(state.Tree.Children.Single(node => node.IsAggregate).Size == 2485, "Grouped items preserve exact byte totals");
        Assert(state.Tree.FileCount == 250, "Grouped items preserve file counts");
        CheckProjection(state.Tree);
        session.Expand(wide);
        var expanded = await WaitFor(wideSnapshots, item => item.ExpandedPath == wide);
        Assert(expanded.Tree.Children.Count == 250 && expanded.Tree.Children.All(node => !node.IsAggregate),
            "Merging extra detail replaces the remainder group without double-counting its files");
        Assert(expanded.Tree.Size == state.Tree.Size && expanded.Tree.FileCount == state.Tree.FileCount,
            "Merging a previously grouped folder preserves its byte and file totals");
        CheckProjection(expanded.Tree);
        Console.WriteLine("PASS: large-folder projection and aggregation");
    }

    var missing = Path.Combine(root, "InitiallyMissing");
    var errorSnapshots = new ConcurrentQueue<ScanSnapshot>();
    await using (var session = new DiskScanSession(missing, errorSnapshots.Enqueue))
    {
        var error = await WaitFor(errorSnapshots, state => state.Phase == "error");
        Assert(!error.Monitoring && error.Warning is not null, "Root failures are reported rather than shown as successful scans");
        Directory.CreateDirectory(missing);
        WriteSize(Path.Combine(missing, "recovered.bin"), 999);
        session.Rescan();
        var recovered = await WaitFor(errorSnapshots, state => state.Phase == "watching" && state.ScannedBytes == 999);
        Assert(recovered.Monitoring && recovered.Warning is null, "Rescan recovers after an unavailable root becomes readable");
        Console.WriteLine("PASS: unavailable-root errors and recovery");
    }

    await CheckEventRecovery(root, watcherOverflow: false);
    await CheckEventRecovery(root, watcherOverflow: true);
    await CheckLoggingExclusion(root);
    await CheckScanProgress(root, expectedUsedBytes: 200, expectedPartialPercent: 50);
    await CheckScanProgress(root, expectedUsedBytes: 50, expectedPartialPercent: 99);
    await CheckDetailPreview(root);

    var cancelSnapshots = new ConcurrentQueue<ScanSnapshot>();
    var stopwatch = Stopwatch.StartNew();
    var cancelled = new DiskScanSession(root, cancelSnapshots.Enqueue);
    await WaitFor(cancelSnapshots, _ => true);
    await cancelled.DisposeAsync();
    Assert(stopwatch.Elapsed < TimeSpan.FromSeconds(5), "Cancellation completes without blocking the UI");
    var countAfterCancel = cancelSnapshots.Count;
    await Task.Delay(400);
    Assert(cancelSnapshots.Count == countAfterCancel, "No publications after disposal");
    Console.WriteLine("PASS: responsive cancellation and watcher disposal");
}
finally
{
    Directory.Delete(fixture.FullName, recursive: true);
}

static void WriteSize(string path, int length)
{
    using var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
    stream.SetLength(length);
}

static async Task CheckDetailPreview(string fixture)
{
    var root = Directory.CreateDirectory(Path.Combine(fixture, "DetailPreview")).FullName;
    var busy = Directory.CreateDirectory(Path.Combine(root, "Largest")).FullName;
    for (var index = 0; index < 35; index++)
    {
        var directory = Directory.CreateDirectory(Path.Combine(busy, $"Group-{index:D2}")).FullName;
        for (var file = 0; file < 160; file++)
            WriteSize(Path.Combine(directory, $"{file:D3}.bin"), 1_000);
    }
    var target = Directory.CreateDirectory(Path.Combine(root, "Target")).FullName;
    for (var index = 0; index < 220; index++)
        WriteSize(Path.Combine(target, $"{index:D3}.bin"), index + 1);
    var deep = target;
    string? deeperTarget = null;
    for (var level = 0; level < 30; level++)
    {
        deep = Directory.CreateDirectory(Path.Combine(deep, $"Level-{level}")).FullName;
        if (level == 10)
            deeperTarget = deep;
    }
    WriteSize(Path.Combine(deep, "large.bin"), 1_000_000);

    var snapshots = new ConcurrentQueue<ScanSnapshot>();
    await using var session = new DiskScanSession(root, snapshots.Enqueue);
    var initial = await WaitFor(snapshots, state => state.Phase == "watching");
    Assert(CountNodes(initial.Tree) <= 5_000, "The normal projection obeys its node budget");
    var originalBusyDetail = JsonSerializer.Serialize(initial.Tree.Children.Single(node => node.Path == busy));
    Assert(FindMapNode(initial.Tree, deeperTarget!) is null, "Deep descendants are initially collapsed");
    session.Expand(target);
    var preview = await WaitFor(snapshots, state => state.ExpandedPath == target);
    var targetNode = FindMapNode(preview.Tree, target) ?? throw new InvalidOperationException("Preview target is missing.");
    Assert(preview.Tree.Path == root && preview.ScannedBytes == initial.ScannedBytes && preview.Breadcrumbs.Count == 1,
        "An in-place preview does not change focus, breadcrumbs, or disk totals");
    Assert(JsonSerializer.Serialize(preview.Tree.Children.Single(node => node.Path == busy)) == originalBusyDetail,
        "Revealing one folder must preserve every already-projected detail in an unrelated folder");
    Assert(targetNode.Children.Count == 221 && FindMapNode(preview.Tree, deeperTarget!) is not null,
        "The selected branch receives extra child and depth detail without pruning existing siblings");
    Assert(CountNodes(preview.Tree) > CountNodes(initial.Tree) && CountNodes(preview.Tree) <= 10_000,
        "The preview adds detail within its independent allowance rather than stealing normal nodes");
    CheckProjection(preview.Tree);

    session.Expand(deeperTarget);
    var deeper = await WaitFor(snapshots, state => state.ExpandedPath == deeperTarget);
    Assert(JsonSerializer.Serialize(deeper.Tree.Children.Single(node => node.Path == busy)) == originalBusyDetail,
        "Deeper previews must not take detail away from unrelated folders");
    Assert(MapDepth(deeper.Tree) == 24, "Repeated expansion respects the overall JSON-safe depth limit");
    JsonSerializer.Serialize(deeper);
    Assert(CountNodes(deeper.Tree) <= 10_000, "Nested previews stay within the combined normal and preview allowances");
    CheckProjection(deeper.Tree);

    session.Expand(null);
    await WaitFor(snapshots, state => state.Revision > deeper.Revision && state.ExpandedPath is null &&
        FindMapNode(state.Tree, deeperTarget!) is null);
    session.Expand(target);
    var beforeZoom = await WaitFor(snapshots, state => state.Revision > deeper.Revision && state.ExpandedPath == target);
    session.Navigate(target);
    var zoomed = await WaitFor(snapshots, state => state.Revision > beforeZoom.Revision && state.Tree.Path == target);
    Assert(zoomed.ExpandedPath is null, "Zooming clears the in-place override");
    session.Expand(target);
    await WaitFor(snapshots, state => state.Revision > zoomed.Revision && state.ExpandedPath == target);
    WriteSize(Path.Combine(target, "new.bin"), 200);
    await WaitFor(snapshots, state => state.ExpandedPath == target && state.Tree.Children.Any(node => node.Name == "new.bin"));
    Directory.Delete(target, recursive: true);
    await WaitFor(snapshots, state => state.Tree.Path == root && state.ExpandedPath is null && state.FileCount == 5_600);
    Console.WriteLine("PASS: independent preview budget, preserved sibling detail, exact totals, depth limits, reset, zoom, and live changes");
}

static MapNode? FindMapNode(MapNode node, string path)
{
    if (node.Path == path)
        return node;
    foreach (var child in node.Children)
        if (FindMapNode(child, path) is { } found)
            return found;
    return null;
}

static int CountNodes(MapNode node) => 1 + node.Children.Sum(CountNodes);

static int MapDepth(MapNode node) => node.Children.Count == 0 ? 0 : 1 + node.Children.Max(MapDepth);

static async Task CheckEventRecovery(string fixture, bool watcherOverflow)
{
    var root = Directory.CreateDirectory(Path.Combine(fixture, watcherOverflow ? "WatcherOverflow" : "EventBurst")).FullName;
    var stable = Directory.CreateDirectory(Path.Combine(root, "Stable")).FullName;
    WriteSize(Path.Combine(stable, "keep.bin"), 5_000_000);
    var changed = Path.Combine(root, "changed.bin");
    var deleted = Path.Combine(root, "deleted.bin");
    WriteSize(changed, 100);
    WriteSize(deleted, 100);
    var snapshots = new ConcurrentQueue<ScanSnapshot>();
    using var resume = new ManualResetEventSlim();
    var paused = 0;
    var session = new DiskScanSession(root, snapshot =>
    {
        snapshots.Enqueue(snapshot);
        if (snapshot.Phase == "watching" && Interlocked.CompareExchange(ref paused, 1, 0) == 0)
            resume.Wait();
    });
    try
    {
        var initial = await WaitFor(snapshots, state => state.Phase == "watching");
        session.Navigate(stable);
        WriteSize(changed, 900);
        WriteSize(Path.Combine(root, "added.bin"), 400);
        File.Delete(deleted);
        if (watcherOverflow)
            session.HandleWatcherError(new InternalBufferOverflowException("Simulated missed filesystem notifications"));
        else
            for (var i = 0; i < 9_000; i++)
                session.QueueChange(changed);
        resume.Set();
        var updated = await WaitFor(snapshots, state => state.Phase == "watching" && state.ScannedBytes == 5_001_300 && state.Tree.Path == stable);
        var updates = snapshots.Where(state => state.Revision > initial.Revision && state.Revision <= updated.Revision).ToArray();
        Assert(updates.All(state => state.Phase != "scanning"), "Watcher activity must not restart the initial scan");
        Assert(updates.All(state => state.ScannedBytes >= 5_000_000), "Existing bytes must never disappear during automatic reconciliation");
        Assert(updates.All(state => state.Tree.Path == stable), "Automatic updates must preserve the zoomed folder");
        Assert(updated.FileCount == 3, "Recovery applies missed creates, writes, and deletes exactly once");
        Console.WriteLine($"PASS: {(watcherOverflow ? "watcher overflow" : "9,000 repeated notifications")} updates the existing map without restarting");
    }
    finally
    {
        resume.Set();
        await session.DisposeAsync();
    }
}

static async Task CheckLoggingExclusion(string fixture)
{
    var root = Directory.CreateDirectory(Path.Combine(fixture, "LoggingExclusion")).FullName;
    var logs = Directory.CreateDirectory(Path.Combine(root, "Logs")).FullName;
    var logPath = Path.Combine(logs, "session.log");
    var file = Path.Combine(root, "data.bin");
    WriteSize(file, 100);
    var snapshots = new ConcurrentQueue<ScanSnapshot>();
    await using var session = new DiskScanSession(root, snapshots.Enqueue,
        message => File.AppendAllText(logPath, message + Environment.NewLine), logs);
    var initial = await WaitFor(snapshots, state => state.Phase == "watching");
    Assert(initial.ScannedBytes == 100 && initial.FileCount == 1 && initial.FolderCount == 0,
        "Diagnostic logs are excluded from size totals");
    WriteSize(file, 200);
    await WaitFor(snapshots, state => state.Phase == "watching" && state.ScannedBytes == 200);
    await Task.Delay(1_000);
    var revision = snapshots.Last().Revision;
    File.AppendAllText(logPath, "Additional diagnostic output");
    session.QueueChange(logPath);
    await Task.Delay(1_000);
    Assert(snapshots.Last().Revision == revision, "Writing logs must not trigger a monitoring feedback loop");
    Assert(File.ReadAllText(logPath).Contains("Full scan completed"), "Diagnostics record lifecycle and update details");
    Console.WriteLine("PASS: diagnostic logging does not trigger filesystem update loops");
}

static async Task CheckScanProgress(string fixture, long expectedUsedBytes, double expectedPartialPercent)
{
    var root = Directory.CreateDirectory(Path.Combine(fixture, $"Progress-{expectedUsedBytes}")).FullName;
    WriteSize(Path.Combine(root, "first.bin"), 100);
    WriteSize(Path.Combine(root, "second.bin"), 100);
    var snapshots = new ConcurrentQueue<ScanSnapshot>();
    using var resume = new ManualResetEventSlim();
    var paused = 0;
    var session = new DiskScanSession(root, snapshot =>
    {
        snapshots.Enqueue(snapshot);
        if (snapshot.Phase == "scanning" && Interlocked.CompareExchange(ref paused, 1, 0) == 0)
            resume.Wait();
    }, expectedUsedBytes: expectedUsedBytes);
    try
    {
        var initial = await WaitFor(snapshots, state => state.Phase == "scanning");
        Assert(initial.ScanPercent == 0 && initial.ProgressIsEstimated, "Scanning starts at an explicitly estimated zero percent");
        session.Navigate(root);
        resume.Set();
        var partial = await WaitFor(snapshots, state => state.Phase == "scanning" && state.FileCount == 1);
        Assert(partial.ScanPercent == expectedPartialPercent && partial.ProgressIsEstimated,
            "Partial progress uses discovered bytes and never reaches 100 before enumeration finishes");
        var complete = await WaitFor(snapshots, state => state.Phase == "watching");
        Assert(complete.ScanPercent == 100 && !complete.ProgressIsEstimated, "Only completed scans show exact 100 percent");
        WriteSize(Path.Combine(root, "new.bin"), 100);
        var updated = await WaitFor(snapshots, state => state.Phase == "watching" && state.FileCount == 3);
        Assert(updated.ScanPercent == 100 && !updated.ProgressIsEstimated, "Live changes do not restart scan progress");
        Console.WriteLine($"PASS: estimated progress ({expectedPartialPercent}% partial), completion, and stable live updates");
    }
    finally
    {
        resume.Set();
        await session.DisposeAsync();
    }
}

static void Assert(bool condition, string description)
{
    if (!condition)
        throw new InvalidOperationException($"FAIL: {description}");
}

static void CheckProjection(MapNode node)
{
    if (node.Children.Count > 0)
        Assert(node.Children.Sum(child => child.Size) == node.Size, $"Area totals for {node.Name}");
    foreach (var child in node.Children)
        CheckProjection(child);
}

static async Task<ScanSnapshot> WaitFor(ConcurrentQueue<ScanSnapshot> snapshots, Func<ScanSnapshot, bool> predicate)
{
    var stopwatch = Stopwatch.StartNew();
    while (stopwatch.Elapsed < TimeSpan.FromSeconds(15))
    {
        var found = snapshots.LastOrDefault(predicate);
        if (found is not null)
            return found;
        await Task.Delay(40);
    }
    var last = snapshots.LastOrDefault();
    throw new TimeoutException($"Expected snapshot not received. Latest: {last?.Phase}, {last?.ScannedBytes} bytes, {last?.Tree.Path}. {last?.Warning}");
}
