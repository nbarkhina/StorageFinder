using System.Drawing.Drawing2D;

namespace StorageFinder.App;

internal sealed partial class MainForm
{
    private sealed class StartupSplash : Control
    {
        private readonly System.Windows.Forms.Timer _animation = new() { Interval = 30 };
        private readonly Font _headingFont = new("Segoe UI", 22, FontStyle.Bold);
        private readonly Font _messageFont = new("Segoe UI", 10);
        private int _angle;
        private string? _error;

        public StartupSplash()
        {
            DoubleBuffered = true;
            ResizeRedraw = true;
            BackColor = Color.FromArgb(16, 21, 31);
            AccessibleRole = AccessibleRole.StatusBar;
            AccessibleName = "Starting StorageFinder";
            _animation.Tick += (_, _) =>
            {
                _angle = (_angle + 9) % 360;
                Invalidate();
            };
        }

        protected override void OnVisibleChanged(EventArgs args)
        {
            base.OnVisibleChanged(args);
            _animation.Enabled = Visible && _error is null;
        }

        public void StopAnimation() => _animation.Stop();

        public void ShowError(string message)
        {
            _error = message;
            AccessibleName = message;
            StopAnimation();
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs args)
        {
            base.OnPaint(args);
            var scale = DeviceDpi / 96f;
            var centerX = ClientSize.Width / 2;
            var centerY = ClientSize.Height / 2;
            var diameter = 42 * scale;
            var ring = new RectangleF(centerX - diameter / 2, centerY - 80 * scale, diameter, diameter);
            args.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using var track = new Pen(Color.FromArgb(41, 51, 69), 4 * scale);
            using var accent = new Pen(Color.FromArgb(105, 189, 149), 4 * scale)
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round
            };
            args.Graphics.DrawEllipse(track, ring);
            args.Graphics.DrawArc(accent, ring, _error is null ? _angle : -90, _error is null ? 100 : 360);
            var flags = TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.WordBreak;
            TextRenderer.DrawText(args.Graphics, "StorageFinder", _headingFont,
                new Rectangle(0, centerY - (int)(22 * scale), ClientSize.Width, (int)(48 * scale)),
                Color.FromArgb(229, 235, 245), flags);
            TextRenderer.DrawText(args.Graphics, _error ?? "Starting up. Loading your storage explorer...", _messageFont,
                new Rectangle((int)(24 * scale), centerY + (int)(32 * scale), ClientSize.Width - (int)(48 * scale), (int)(70 * scale)),
                Color.FromArgb(139, 154, 178), flags);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _animation.Dispose();
                _headingFont.Dispose();
                _messageFont.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
