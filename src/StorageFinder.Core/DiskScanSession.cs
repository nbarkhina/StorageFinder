using System.Diagnostics;

namespace StorageFinder.Core;

/// <summary>Owns the mutable index on one worker; publishes bounded, immutable views for the UI.</summary>
public sealed class DiskScanSession : IAsyncDisposable
{
    private const int MaximumSnapshotNodes = 5_000;
    private const int MaximumPreviewNodes = 5_000;
    private static readonly IReadOnlyDictionary<string, string> NoExpansion = new Dictionary<string, string>();
    private const int MaximumChildren = 180;
    private const int MaximumExpandedChildren = 1_000;
    private const int MaximumExpandedDepth = 12;
    // Each tree level adds an object and array to the WebView2 JSON payload.
    private const int MaximumProjectionDepth = 24;
    private readonly string _rootPath;
    private readonly Action<ScanSnapshot> _publish;
    private readonly Action<string>? _log;
    private readonly string? _excludedDirectory;
    private readonly CancellationTokenSource _cancellation = new();
    private readonly Dictionary<string, DiskNode> _directories = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _changesLock = new();
    private Dictionary<string, bool> _changes = new(StringComparer.OrdinalIgnoreCase);
    private readonly Stopwatch _publishClock = Stopwatch.StartNew();
    private readonly Stopwatch _diagnosticsClock = Stopwatch.StartNew();
    private readonly Task _worker;
    private FileSystemWatcher? _watcher;
    private DiskNode _root;
    private string _focusPath;
    private string? _expandedPath;
    private string _currentPath = "";
    private string _phase = "scanning";
    private string? _warning;
    private long _skipped;
    private long _revision;
    private long _receivedEvents;
    private long _expectedUsedBytes;
    private int _refreshRequested;
    private int _rebuildRequested;
    private Exception? _watcherError;
    private bool _monitoring;

    public string RootPath => _rootPath;

    public DiskScanSession(string rootPath, Action<ScanSnapshot> publish, Action<string>? log = null, string? excludedDirectory = null,
        long expectedUsedBytes = 0)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(expectedUsedBytes);
        _rootPath = Normalize(rootPath);
        _focusPath = _rootPath;
        _root = new DiskNode(_rootPath, true, null);
        _publish = publish;
        _log = log;
        _excludedDirectory = excludedDirectory is null ? null : Normalize(excludedDirectory);
        _expectedUsedBytes = expectedUsedBytes;
        _worker = Task.Run(RunAsync);
    }

    public void Navigate(string path)
    {
        Volatile.Write(ref _focusPath, Normalize(path));
        Volatile.Write(ref _expandedPath, null);
        Interlocked.Exchange(ref _refreshRequested, 1);
    }

    public void Expand(string? path)
    {
        Volatile.Write(ref _expandedPath, path is null ? null : Normalize(path));
        Interlocked.Exchange(ref _refreshRequested, 1);
    }

    public void Rescan(long? expectedUsedBytes = null)
    {
        if (expectedUsedBytes.HasValue)
        {
            ArgumentOutOfRangeException.ThrowIfNegative(expectedUsedBytes.Value);
            Interlocked.Exchange(ref _expectedUsedBytes, expectedUsedBytes.Value);
        }
        Interlocked.Exchange(ref _rebuildRequested, 1);
    }

    public async ValueTask DisposeAsync()
    {
        await _cancellation.CancelAsync().ConfigureAwait(false);
        await _worker.ConfigureAwait(false);
        _cancellation.Dispose();
    }

    private async Task RunAsync()
    {
        try
        {
            LogState("Initial scan starting");
            StartWatcher();
            Rebuild();
            while (true)
            {
                await Task.Delay(150, _cancellation.Token).ConfigureAwait(false);
                if (Interlocked.Exchange(ref _rebuildRequested, 0) != 0)
                {
                    LogState("Manual rescan requested");
                    StartWatcher();
                    Rebuild();
                    continue;
                }

                var watcherError = Interlocked.Exchange(ref _watcherError, null);
                if (_phase != "error" && watcherError is not null)
                {
                    RecoverWatcher(watcherError);
                    continue;
                }

                if (_phase != "error" && HasPendingChanges())
                {
                    await Task.Delay(500, _cancellation.Token).ConfigureAwait(false);
                    var paths = TakeChanges();

                    _phase = "updating";
                    LogState($"Applying {paths.Count} changed paths; sample: {string.Join(", ", paths.Keys.Take(3))}");
                    Publish(force: true);
                    foreach (var path in paths.OrderBy(path => path.Key.Length))
                    {
                        _cancellation.Token.ThrowIfCancellationRequested();
                        Reconcile(path.Key, path.Value);
                        Publish();
                    }
                    _phase = "watching";
                    _currentPath = "";
                    LogState("Changes applied");
                    Publish(force: true);
                }
                else if (Interlocked.Exchange(ref _refreshRequested, 0) != 0)
                {
                    Publish(force: true);
                }
            }
        }
        catch (OperationCanceledException) when (_cancellation.IsCancellationRequested)
        {
        }
        catch (Exception exception) when (IsFileSystemError(exception))
        {
            _phase = "error";
            _warning = exception.Message;
            _monitoring = false;
            _log?.Invoke($"Scanner error: {exception}");
            Publish(force: true);
        }
        finally
        {
            _watcher?.Dispose();
            LogState("Session stopped");
        }
    }

    private void StartWatcher()
    {
        _watcher?.Dispose();
        _watcher = null;
        _monitoring = false;
        Interlocked.Exchange(ref _watcherError, null);
        try
        {
            var watcher = new FileSystemWatcher(_rootPath)
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.Size | NotifyFilters.LastWrite,
                InternalBufferSize = 64 * 1024
            };
            watcher.Created += (_, args) => QueueChange(args.FullPath, replaced: true);
            watcher.Deleted += (_, args) => QueueChange(args.FullPath);
            watcher.Changed += (_, args) => QueueChange(args.FullPath);
            watcher.Renamed += (_, args) =>
            {
                QueueChange(args.OldFullPath);
                QueueChange(args.FullPath, replaced: true);
            };
            watcher.Error += (_, args) => HandleWatcherError(args.GetException());
            _watcher = watcher;
            watcher.EnableRaisingEvents = true;
            _monitoring = true;
            _log?.Invoke($"Watcher started: root={_rootPath}; buffer={watcher.InternalBufferSize}");
        }
        catch (Exception exception) when (IsFileSystemError(exception) || exception is ArgumentException)
        {
            _watcher?.Dispose();
            _watcher = null;
            _warning = $"Live monitoring unavailable: {exception.Message}";
            _log?.Invoke($"Watcher startup failed: {exception}");
        }
    }

    internal void HandleWatcherError(Exception exception) => Interlocked.Exchange(ref _watcherError, exception);

    internal void QueueChange(string path, bool replaced = false)
    {
        if (IsExcluded(path))
            return;
        Interlocked.Increment(ref _receivedEvents);
        lock (_changesLock)
            _changes[path] = replaced || _changes.GetValueOrDefault(path);
    }

    private bool HasPendingChanges()
    {
        lock (_changesLock)
            return _changes.Count > 0;
    }

    private Dictionary<string, bool> TakeChanges()
    {
        lock (_changesLock)
        {
            var changes = _changes;
            _changes = new(StringComparer.OrdinalIgnoreCase);
            return changes;
        }
    }

    private void RecoverWatcher(Exception exception)
    {
        _log?.Invoke($"Watcher error; preserving the index and reconciling in place: {exception}");
        if (exception is not InternalBufferOverflowException)
            StartWatcher();
        _phase = "updating";
        var recoveryWarning = $"Disk notifications were interrupted ({exception.Message}). Checking changes without resetting the map.";
        if (_monitoring)
            _warning = recoveryWarning;
        // Notifications received before this pass are covered by the directory comparison.
        // Keep collecting newer events while it runs, without restarting the watcher on an overflow.
        TakeChanges();
        Publish(force: true);
        try
        {
            ScanDirectoryTree(_root);
            _phase = "watching";
            _currentPath = "";
            if (_warning == recoveryWarning)
                _warning = "Disk notifications were interrupted; the existing map has been reconciled.";
            LogState("Watcher recovery completed without resetting the index");
        }
        catch (Exception error) when (IsFileSystemError(error))
        {
            ReportScanFailure(error);
        }
        Publish(force: true);
    }

    private void Rebuild()
    {
        TakeChanges();
        Volatile.Write(ref _expandedPath, null);
        _phase = "scanning";
        _skipped = 0;
        if (_monitoring)
            _warning = null;
        _directories.Clear();
        _root = new DiskNode(_rootPath, true, null);
        _directories.Add(_rootPath, _root);
        Publish(force: true);
        try
        {
            ScanDirectoryTree(_root);
            _phase = "watching";
            _currentPath = "";
            LogState("Full scan completed");
        }
        catch (Exception exception) when (IsFileSystemError(exception))
        {
            ReportScanFailure(exception);
        }
        Publish(force: true);
    }

    private void ReportScanFailure(Exception exception)
    {
        _phase = "error";
        _warning = $"Could not scan {_rootPath}: {exception.Message}";
        _monitoring = false;
        _watcher?.Dispose();
        _watcher = null;
        _log?.Invoke($"Scan failed: {exception}");
    }

    private void ScanDirectoryTree(DiskNode start)
    {
        var pending = new Stack<DiskNode>();
        pending.Push(start);
        var options = new EnumerationOptions
        {
            IgnoreInaccessible = false,
            AttributesToSkip = 0,
            RecurseSubdirectories = false,
            ReturnSpecialDirectories = false
        };

        while (pending.TryPop(out var directory))
        {
            _cancellation.Token.ThrowIfCancellationRequested();
            _currentPath = directory.Path;
            var missing = new HashSet<string>(directory.Children!.Keys, StringComparer.OrdinalIgnoreCase);
            try
            {
                foreach (var entry in new DirectoryInfo(directory.Path).EnumerateFileSystemInfos("*", options))
                {
                    _cancellation.Token.ThrowIfCancellationRequested();
                    var path = Normalize(entry.FullName);
                    missing.Remove(path);
                    try
                    {
                        if (IsExcluded(path))
                        {
                            _skipped++;
                            continue;
                        }
                        var attributes = entry.Attributes;
                        var size = (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0 ? ((FileInfo)entry).Length : 0;
                        var child = ApplyEntry(directory, path, attributes, size);
                        if (child is not null)
                            pending.Push(child);
                    }
                    catch (Exception exception) when (IsFileSystemError(exception))
                    {
                        ReportSkip(entry.FullName, exception);
                    }
                    Publish();
                }
                // Only remove absent entries after a successful enumeration; access failures
                // must not make previously indexed files disappear from the map.
                foreach (var path in missing)
                    Remove(directory.Children[path]);
            }
            catch (Exception exception) when (IsFileSystemError(exception))
            {
                if (ReferenceEquals(directory, _root))
                    throw;
                ReportSkip(directory.Path, exception);
            }
            Publish();
        }
    }

    private DiskNode? ApplyEntry(DiskNode parent, string path, FileAttributes attributes, long size)
    {
        parent.Children!.TryGetValue(path, out var existing);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            if (existing is not null)
                Remove(existing);
            _skipped++;
            return null;
        }
        var isDirectory = (attributes & FileAttributes.Directory) != 0;
        if (existing is not null && existing.IsDirectory != isDirectory)
        {
            Remove(existing);
            existing = null;
        }
        if (isDirectory)
        {
            if (existing is null)
            {
                existing = new DiskNode(path, true, parent);
                parent.Children.Add(path, existing);
                _directories.Add(path, existing);
                AdjustAncestors(parent, 0, 0, 1);
            }
            return existing;
        }
        if (existing is null)
        {
            parent.Children.Add(path, new DiskNode(path, false, parent) { Size = size, FileCount = 1 });
            AdjustAncestors(parent, size, 1, 0);
        }
        else
        {
            AdjustAncestors(parent, size - existing.Size, 0, 0);
            existing.Size = size;
        }
        return null;
    }

    private void Reconcile(string changedPath, bool replaced)
    {
        var path = Normalize(changedPath);
        var parentPath = Path.GetDirectoryName(path);
        while (parentPath is not null && !_directories.ContainsKey(parentPath))
        {
            path = parentPath;
            parentPath = Path.GetDirectoryName(path);
        }
        if (parentPath is null || !_directories.TryGetValue(parentPath, out var parent))
            return;

        parent.Children!.TryGetValue(path, out var existing);
        _currentPath = path;
        try
        {
            var attributes = File.GetAttributes(path);
            var size = (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0 ? new FileInfo(path).Length : 0;
            var directory = ApplyEntry(parent, path, attributes, size);
            if (directory is not null && (existing is null || !existing.IsDirectory || replaced))
                ScanDirectoryTree(directory);
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            if (existing is not null)
                Remove(existing);
        }
        catch (Exception exception) when (IsFileSystemError(exception))
        {
            ReportSkip(path, exception);
        }
    }

    private void Remove(DiskNode node)
    {
        node.Parent!.Children!.Remove(node.Path);
        AdjustAncestors(node.Parent, -node.Size, -node.FileCount, -node.FolderCount - (node.IsDirectory ? 1 : 0));
        if (!node.IsDirectory)
            return;
        var pending = new Stack<DiskNode>();
        pending.Push(node);
        while (pending.TryPop(out var directory))
        {
            _directories.Remove(directory.Path);
            foreach (var child in directory.Children!.Values)
                if (child.IsDirectory)
                    pending.Push(child);
        }
    }

    private static void AdjustAncestors(DiskNode? node, long bytes, long files, long folders)
    {
        while (node is not null)
        {
            node.Size += bytes;
            node.FileCount += files;
            node.FolderCount += folders;
            node = node.Parent;
        }
    }

    private void Publish(bool force = false)
    {
        if (!force && _publishClock.ElapsedMilliseconds < 300 && Volatile.Read(ref _refreshRequested) == 0)
            return;
        Interlocked.Exchange(ref _refreshRequested, 0);
        var focusPath = Volatile.Read(ref _focusPath);
        while (!_directories.ContainsKey(focusPath))
        {
            focusPath = Path.GetDirectoryName(focusPath) ?? _rootPath;
            if (focusPath == _rootPath)
                break;
        }
        var focus = _directories.GetValueOrDefault(focusPath, _root);
        var breadcrumbs = new List<Breadcrumb>();
        for (var node = focus; node is not null; node = node.Parent)
            breadcrumbs.Add(new Breadcrumb(node.Path, node.Name));
        breadcrumbs.Reverse();
        var requestedExpansion = Volatile.Read(ref _expandedPath);
        var expanded = requestedExpansion is null ? null : _directories.GetValueOrDefault(requestedExpansion);
        var expansionBranch = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var node = expanded; node?.Parent is not null; node = node.Parent)
            expansionBranch[node.Parent.Path] = node.Path;
        if (expanded != focus && !expansionBranch.ContainsKey(focus.Path))
        {
            expanded = null;
            expansionBranch.Clear();
        }
        if (expanded is null)
            Interlocked.CompareExchange(ref _expandedPath, null, requestedExpansion);
        var budget = MaximumSnapshotNodes;
        var tree = Project(focus, 0, ref budget, null, NoExpansion);
        if (expanded is not null)
        {
            // The normal projection keeps its entire allowance. Preview detail is
            // additive, so selecting one branch cannot prune already-visible siblings.
            var previewBudget = MaximumPreviewNodes;
            var preview = Project(focus, 0, ref previewBudget, expanded.Path, expansionBranch);
            tree = MergePreview(tree, preview, expanded.Path, expansionBranch);
        }
        var complete = _phase is "watching" or "updating";
        var expectedUsedBytes = Interlocked.Read(ref _expectedUsedBytes);
        // Logical file lengths and allocated used space can differ. Only a finished
        // enumeration may report 100%; during discovery this is a byte-based estimate.
        double? percent = complete ? 100 : expectedUsedBytes > 0 ? Math.Min(99, Math.Round(100.0 * _root.Size / expectedUsedBytes, 1)) : null;
        _publish(new ScanSnapshot(_rootPath, _phase, _monitoring, _root.Size, _root.FileCount,
            _root.FolderCount, _skipped, _currentPath, _warning, ++_revision, tree, breadcrumbs, percent, !complete && percent.HasValue, expanded?.Path));
        _publishClock.Restart();
        if (_diagnosticsClock.Elapsed >= TimeSpan.FromSeconds(5))
            LogState("Progress");
    }

    private MapNode MergePreview(MapNode normal, MapNode preview, string expandedPath,
        IReadOnlyDictionary<string, string> expansionBranch, bool insidePreview = false)
    {
        insidePreview |= normal.Path == expandedPath;
        if ((!insidePreview && !expansionBranch.ContainsKey(normal.Path)) || preview.Children.Count == 0)
            return normal;
        if (normal.Children.Count == 0)
            return preview;

        var childrenByPath = normal.Children.Where(child => !child.IsAggregate)
            .ToDictionary(child => child.Path, StringComparer.OrdinalIgnoreCase);
        foreach (var child in preview.Children)
        {
            if (child.IsAggregate)
                continue;
            childrenByPath[child.Path] = childrenByPath.TryGetValue(child.Path, out var existing)
                ? MergePreview(existing, child, expandedPath, expansionBranch, insidePreview)
                : child;
        }
        var children = childrenByPath.Values.OrderByDescending(child => child.Size)
            .ThenBy(child => child.Name, StringComparer.OrdinalIgnoreCase).ToList();
        var directory = _directories[normal.Path];
        if (children.Count < directory.Children!.Count)
            children.Add(CreateRemainder(directory, children));
        return normal with { Children = children };
    }

    private static MapNode Project(DiskNode node, int depth, ref int budget, string? expandedPath,
        IReadOnlyDictionary<string, string> expansionBranch, int expandedDepth = -1)
    {
        budget--;
        if (node.Path == expandedPath)
            expandedDepth = 0;
        var priorityPath = expansionBranch.GetValueOrDefault(node.Path);
        var canDescend = expandedDepth >= 0 ? expandedDepth < MaximumExpandedDepth : depth < 5 || priorityPath is not null;
        var children = new List<MapNode>();
        if (node.Children is { Count: > 0 } && canDescend && depth < MaximumProjectionDepth && budget > 1)
        {
            var limit = expandedDepth >= 0 ? MaximumExpandedChildren : MaximumChildren;
            var count = Math.Min(node.Children.Count, Math.Min(limit, budget - 1));
            var ordered = node.Children.Values.OrderByDescending(child => child.Size)
                .ThenBy(child => child.Name, StringComparer.OrdinalIgnoreCase).Take(count).ToArray();
            var priorityIndex = Array.FindIndex(ordered, child => child.Path == priorityPath);
            if (priorityPath is not null && priorityIndex < 0)
            {
                priorityIndex = ordered.Length - 1;
                ordered[priorityIndex] = node.Children[priorityPath];
            }
            var aggregate = count < node.Children.Count;
            // Reserve siblings first, so a deep subtree cannot consume the entire view budget.
            budget -= count + (aggregate ? 1 : 0);
            var projected = new MapNode[count];
            var childExpandedDepth = expandedDepth >= 0 ? expandedDepth + 1 : -1;
            // Spend the remaining detail budget on the clicked branch before its siblings,
            // but retain their original display order and exact byte weights.
            if (priorityIndex >= 0)
            {
                budget++;
                projected[priorityIndex] = Project(ordered[priorityIndex], depth + 1, ref budget, expandedPath, expansionBranch, childExpandedDepth);
            }
            for (var index = 0; index < count; index++)
            {
                if (index == priorityIndex)
                    continue;
                budget++;
                projected[index] = Project(ordered[index], depth + 1, ref budget, expandedPath, expansionBranch, childExpandedDepth);
            }
            children.AddRange(projected);
            if (aggregate)
                children.Add(CreateRemainder(node, children));
        }
        return new MapNode(node.Path, node.Name, node.IsDirectory, node.Size, node.FileCount,
            node.FolderCount, node.Children is { Count: > 0 }, false, children);
    }

    private static MapNode CreateRemainder(DiskNode node, IReadOnlyCollection<MapNode> children)
    {
        var size = node.Size;
        var files = node.FileCount;
        var folders = node.FolderCount;
        foreach (var child in children)
        {
            size -= child.Size;
            files -= child.FileCount;
            folders -= child.FolderCount + (child.IsDirectory ? 1 : 0);
        }
        return new MapNode(node.Path + "|other", $"{node.Children!.Count - children.Count:N0} smaller items",
            false, size, files, folders, false, true, []);
    }

    private void ReportSkip(string path, Exception exception)
    {
        _skipped++;
        _warning = $"Could not read {path}: {exception.Message}";
    }

    private bool IsExcluded(string path) => _excludedDirectory is not null &&
        (string.Equals(path, _excludedDirectory, StringComparison.OrdinalIgnoreCase) ||
         path.StartsWith(_excludedDirectory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));

    private void LogState(string message)
    {
        if (_log is null)
            return;
        int pending;
        lock (_changesLock)
            pending = _changes.Count;
        _log($"{message}: root={_rootPath}; phase={_phase}; bytes={_root.Size}; files={_root.FileCount}; folders={_root.FolderCount}; " +
            $"skipped={_skipped}; expectedUsedBytes={Interlocked.Read(ref _expectedUsedBytes)}; receivedEvents={Interlocked.Read(ref _receivedEvents)}; pendingPaths={pending}; current={_currentPath}; warning={_warning}");
        _diagnosticsClock.Restart();
    }

    private static bool IsFileSystemError(Exception exception) =>
        exception is IOException or UnauthorizedAccessException or System.Security.SecurityException;

    private static string Normalize(string path) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
}
