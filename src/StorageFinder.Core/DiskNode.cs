namespace StorageFinder.Core;

internal sealed class DiskNode(string path, bool isDirectory, DiskNode? parent)
{
    public string Path { get; } = path;
    public string Name { get; } = System.IO.Path.GetFileName(path.TrimEnd(System.IO.Path.DirectorySeparatorChar)) is { Length: > 0 } name ? name : path;
    public bool IsDirectory { get; } = isDirectory;
    public DiskNode? Parent { get; } = parent;
    public long Size { get; set; }
    public long FileCount { get; set; }
    public long FolderCount { get; set; }
    public Dictionary<string, DiskNode>? Children { get; } = isDirectory ? new(StringComparer.OrdinalIgnoreCase) : null;
}
