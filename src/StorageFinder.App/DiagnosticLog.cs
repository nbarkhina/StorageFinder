using System.Diagnostics;

namespace StorageFinder.App;

internal sealed class DiagnosticLog
{
    private bool loggingEnabled = false;
    private readonly object _gate = new();
    private readonly Action<string> _reportError;
    private bool _failed;

    public string DirectoryPath { get; } = "Logs";
    public string FilePath { get; }

    public DiagnosticLog(Action<string> reportError)
    {
        _reportError = reportError;
        FilePath = Path.Combine(DirectoryPath, DateTime.Now.ToShortDateString().Replace('/', '_') +".txt");

        try
        {
            Directory.CreateDirectory(DirectoryPath);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            ReportFailure(exception);
        }
    }

    public void Write(string message)
    {
        if (!loggingEnabled)
            return;

        lock (_gate)
        {
            if (_failed)
                return;
            try
            {
                File.AppendAllText(FilePath, $"{DateTime.UtcNow:O} [thread {Environment.CurrentManagedThreadId}] {message}{Environment.NewLine}");
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                ReportFailure(exception);
            }
        }
    }

    private void ReportFailure(Exception exception)
    {
        _failed = true;
        var message = $"Diagnostic logging is unavailable. The app will continue without logs.\n\n{FilePath}\n{exception.Message}";
        Trace.TraceError(message);
        _reportError(message);
    }
}
