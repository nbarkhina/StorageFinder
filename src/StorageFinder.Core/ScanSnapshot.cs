namespace StorageFinder.Core;

public sealed record MapNode(
    string Path,
    string Name,
    bool IsDirectory,
    long Size,
    long FileCount,
    long FolderCount,
    bool HasChildren,
    bool IsAggregate,
    IReadOnlyList<MapNode> Children);

public sealed record Breadcrumb(string Path, string Name);

public sealed record ScanSnapshot(
    string RootPath,
    string Phase,
    bool Monitoring,
    long ScannedBytes,
    long FileCount,
    long FolderCount,
    long SkippedEntries,
    string CurrentPath,
    string? Warning,
    long Revision,
    MapNode Tree,
    IReadOnlyList<Breadcrumb> Breadcrumbs,
    double? ScanPercent,
    bool ProgressIsEstimated,
    string? ExpandedPath = null);
