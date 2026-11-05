using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using StorageFinder.Core;

namespace StorageFinder.App;

internal sealed partial class MainForm : Form
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(16, 21, 31) };
    private readonly StartupSplash _splash = new() { Dock = DockStyle.Fill };
    private readonly SemaphoreSlim _commands = new(1, 1);
    private readonly DiagnosticLog _log;
    private DiskScanSession? _session;
    private int _generation;
    private string? _pendingSnapshot;
    private int _postPending;
    private bool _closing;
    private bool _canClose;

    public MainForm()
    {
        Text = "StorageFinder - Disk space, made visible";
        Icon = new Icon(typeof(MainForm), "Assets.StorageFinder.ico");
        ClientSize = new Size(1440, 900);
        MinimumSize = new Size(960, 640);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(16, 21, 31);
        _webView.Visible = false;
        Controls.Add(_webView);
        Controls.Add(_splash);
        InitializeWindowChrome();
        _log = new DiagnosticLog(ReportLoggingError);
        _splash.Paint += SplashPainted;
        _log.Write($"App starting: executable={Environment.ProcessPath}; .NET={Environment.Version}; OS={Environment.OSVersion}");
        Shown += InitializeAsync;
        FormClosing += CloseAsync;
        FormClosed += (_, _) => _log.Write("App closed");
    }

    private void SplashPainted(object? sender, PaintEventArgs args)
    {
        _splash.Paint -= SplashPainted;
        _log.Write("Startup splash rendered");
    }

    private async void InitializeAsync(object? sender, EventArgs args)
    {
        try
        {
            Refresh();
            var cache = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StorageFinder", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: cache);
            if (_closing)
                return;
            await _webView.EnsureCoreWebView2Async(environment);
            if (_closing)
                return;
            _log.Write($"WebView2 initialized: version={environment.BrowserVersionString}; logs={_log.FilePath}");
            _webView.CoreWebView2.SetVirtualHostNameToFolderMapping("storagefinder.local",
                Path.Combine(AppContext.BaseDirectory, "Web"), CoreWebView2HostResourceAccessKind.DenyCors);
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _webView.CoreWebView2.NavigationStarting += (_, navigation) =>
            {
                if (!Uri.TryCreate(navigation.Uri, UriKind.Absolute, out var uri) || uri.Host != "storagefinder.local")
                    navigation.Cancel = true;
            };
            _webView.CoreWebView2.NewWindowRequested += (_, request) => request.Handled = true;
            _webView.CoreWebView2.PermissionRequested += (_, request) => request.State = CoreWebView2PermissionState.Deny;
            _webView.CoreWebView2.WebMessageReceived += HandleMessageAsync;
            _webView.CoreWebView2.NavigationCompleted += (_, navigation) =>
            {
                if (!navigation.IsSuccess)
                {
                    _log.Write($"Interface navigation failed: {navigation.WebErrorStatus}");
                    _splash.ShowError($"The interface could not load ({navigation.WebErrorStatus}). Close StorageFinder and try again.");
                }
            };
            _webView.Source = new Uri("https://storagefinder.local/index.html");
        }
        catch (Exception exception) when (exception is WebView2RuntimeNotFoundException or System.Runtime.InteropServices.COMException or IOException or UnauthorizedAccessException)
        {
            _log.Write($"WebView2 startup failed: {exception}");
            _splash.ShowError("The interface could not start. Check that the Microsoft Edge WebView2 Runtime is installed.");
            MessageBox.Show(this, $"The interface could not start. StorageFinder requires the Microsoft Edge WebView2 Runtime.\n\n{exception.Message}",
                "StorageFinder startup error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async void HandleMessageAsync(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        await _commands.WaitAsync();
        try
        {
            if (_closing)
                return;
            _log.Write($"UI command: {args.WebMessageAsJson}");
            using var message = JsonDocument.Parse(args.WebMessageAsJson);
            var type = message.RootElement.GetProperty("type").GetString();
            switch (type)
            {
                case "ready":
                    _webView.Visible = true;
                    _splash.Visible = false;
                    _splash.StopAnimation();
                    await _webView.CoreWebView2.ExecuteScriptAsync("document.getElementById('picker').focus({ preventScroll: true });");
                    _log.Write("Interface ready; startup splash hidden");
                    Post(new { type = "drives", drives = await Task.Run(GetDrives) });
                    break;
                case "drives":
                    Post(new { type = "drives", drives = await Task.Run(GetDrives) });
                    break;
                case "scan":
                    var path = message.RootElement.GetProperty("path").GetString() ?? "";
                    var drive = new DriveInfo(path);
                    if (!drive.IsReady || !string.Equals(Path.GetFullPath(path), drive.RootDirectory.FullName, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("Select an available drive to scan.");
                    var usedBytes = await Task.Run(() => drive.TotalSize - drive.TotalFreeSpace);
                    await StopSessionAsync();
                    var generation = _generation;
                    _session = new DiskScanSession(path, snapshot => QueueSnapshot(snapshot, generation), _log.Write, _log.DirectoryPath, usedBytes);
                    break;
                case "navigate":
                    _session?.Navigate(message.RootElement.GetProperty("path").GetString() ?? "");
                    break;
                case "expand":
                    _session?.Expand(message.RootElement.GetProperty("path").GetString());
                    break;
                case "rescan":
                    if (_session is not null)
                    {
                        var currentDrive = new DriveInfo(_session.RootPath);
                        _session.Rescan(await Task.Run(() => currentDrive.TotalSize - currentDrive.TotalFreeSpace));
                    }
                    break;
                case "openInExplorer":
                case "revealInExplorer":
                    var rootPath = _session?.RootPath ?? throw new InvalidOperationException("Select a drive before opening an item.");
                    var itemPath = message.RootElement.GetProperty("path").GetString() ?? "";
                    await Task.Run(() => OpenInExplorer(rootPath, itemPath, type == "revealInExplorer"));
                    break;
                case "stop":
                    await StopSessionAsync();
                    Post(new { type = "stopped" });
                    break;
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or JsonException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            _log.Write($"Command failed: {exception}");
            Post(new { type = "error", message = exception.Message });
        }
        finally
        {
            _commands.Release();
        }
    }

    private void OpenInExplorer(string rootPath, string itemPath, bool selectItem)
    {
        if (!Path.IsPathFullyQualified(itemPath))
            throw new ArgumentException("The selected item must have an absolute filesystem path.");
        var path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(itemPath));
        var rootPrefix = Path.EndsInDirectorySeparator(rootPath) ? rootPath : rootPath + Path.DirectorySeparatorChar;
        if (!string.Equals(Path.TrimEndingDirectorySeparator(path), Path.TrimEndingDirectorySeparator(rootPath), StringComparison.OrdinalIgnoreCase) &&
            !path.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Select an item from the drive currently being scanned.");

        var attributes = File.GetAttributes(path);
        var parent = Path.GetDirectoryName(path);
        var folder = (attributes & FileAttributes.Directory) != 0 ? path :
            parent ?? throw new DirectoryNotFoundException("The containing folder is unavailable.");
        var selecting = false;
        if (selectItem && parent is not null)
        {
            folder = parent;
            selecting = true;
        }
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"))
        {
            UseShellExecute = true,
            // Explorer parses unquoted commas as separators, even in paths without spaces.
            Arguments = selecting ? $"/select,\"{path}\"" : $"\"{folder}\""
        };
        using var process = Process.Start(start);
        _log.Write($"Explorer open requested: item={path}; folder={folder}; selected={selecting}");
    }

    private void ReportLoggingError(string message)
    {
        if (_closing)
            return;
        if (InvokeRequired)
            BeginInvoke(() => ReportLoggingError(message));
        else
            MessageBox.Show(this, message, "StorageFinder diagnostics", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private static object[] GetDrives() => DriveInfo.GetDrives().Select(drive =>
    {
        try
        {
            if (!drive.IsReady)
                return (object)new { path = drive.Name, name = drive.Name, kind = drive.DriveType.ToString(), ready = false, total = 0L, free = 0L, error = "Drive is not ready" };
            return new
            {
                path = drive.Name,
                name = string.IsNullOrWhiteSpace(drive.VolumeLabel) ? "Local disk" : drive.VolumeLabel,
                kind = drive.DriveType.ToString(),
                ready = true,
                total = drive.TotalSize,
                free = drive.TotalFreeSpace,
                error = (string?)null
            };
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            return new { path = drive.Name, name = drive.Name, kind = drive.DriveType.ToString(), ready = false, total = 0L, free = 0L, error = exception.Message };
        }
    }).ToArray();

    private void QueueSnapshot(ScanSnapshot snapshot, int generation)
    {
        if (_closing || generation != Volatile.Read(ref _generation))
            return;
        var json = JsonSerializer.Serialize(new { type = "snapshot", snapshot }, JsonOptions);
        Interlocked.Exchange(ref _pendingSnapshot, json);
        if (Interlocked.Exchange(ref _postPending, 1) == 0)
            BeginInvoke(FlushSnapshot);
    }

    private void FlushSnapshot()
    {
        Interlocked.Exchange(ref _postPending, 0);
        var json = Interlocked.Exchange(ref _pendingSnapshot, null);
        if (!_closing && json is not null)
            _webView.CoreWebView2.PostWebMessageAsJson(json);
    }

    private void Post(object message)
    {
        if (!_closing)
            _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message, JsonOptions));
    }

    private async Task StopSessionAsync()
    {
        Interlocked.Increment(ref _generation);
        if (_session is not null)
        {
            _log.Write("Stopping active scan session");
            await _session.DisposeAsync();
            _session = null;
        }
        Interlocked.Exchange(ref _pendingSnapshot, null);
    }

    private async void CloseAsync(object? sender, FormClosingEventArgs args)
    {
        if (_canClose)
            return;
        args.Cancel = true;
        if (_closing)
            return;
        _closing = true;
        _log.Write("App closing");
        await _commands.WaitAsync();
        try
        {
            await StopSessionAsync();
            _canClose = true;
            Close();
        }
        finally
        {
            _commands.Release();
        }
    }
}
