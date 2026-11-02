using System.Runtime.InteropServices;

namespace StorageFinder.App;

internal sealed partial class MainForm
{
    private Button? _maximizeButton;

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            // Retain native resizing, taskbar commands, and Windows snapping without a caption.
            parameters.Style |= 0x00040000 | 0x00020000 | 0x00010000 | 0x00080000;
            parameters.Style &= ~0x00C00000; // WS_CAPTION
            return parameters;
        }
    }

    private void InitializeWindowChrome()
    {
        FormBorderStyle = FormBorderStyle.None;
        Padding = new Padding(6);
        var titleBar = new Panel
        {
            Dock = DockStyle.Top,
            Height = 34,
            BackColor = Color.FromArgb(19, 26, 38)
        };
        var title = new Label
        {
            Dock = DockStyle.Fill,
            Text = Text,
            ForeColor = Color.FromArgb(139, 154, 178),
            TextAlign = ContentAlignment.MiddleLeft,
            Padding = new Padding(12, 0, 0, 0),
            AutoEllipsis = true
        };
        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Right,
            AutoSize = true,
            WrapContents = false,
            Margin = Padding.Empty
        };
        var minimize = CreateCaptionButton("Minimize", "\uE921");
        _maximizeButton = CreateCaptionButton("Maximize", "\uE922");
        var close = CreateCaptionButton("Close", "\uE8BB");
        close.FlatAppearance.MouseOverBackColor = Color.FromArgb(196, 43, 58);
        close.FlatAppearance.MouseDownBackColor = Color.FromArgb(160, 30, 43);
        minimize.Click += (_, _) => WindowState = FormWindowState.Minimized;
        _maximizeButton.Click += (_, _) => ToggleMaximize();
        close.Click += (_, _) => Close();
        title.MouseDown += DragWindow;
        titleBar.MouseDown += DragWindow;
        buttons.Controls.AddRange([minimize, _maximizeButton, close]);
        titleBar.Controls.Add(title);
        titleBar.Controls.Add(buttons);
        Controls.Add(titleBar);
    }

    private static Button CreateCaptionButton(string name, string glyph)
    {
        var button = new Button
        {
            AccessibleName = name,
            Text = glyph,
            Font = new Font("Segoe MDL2 Assets", 10),
            ForeColor = Color.FromArgb(229, 235, 245),
            BackColor = Color.FromArgb(19, 26, 38),
            FlatStyle = FlatStyle.Flat,
            Size = new Size(46, 34),
            Margin = Padding.Empty,
            UseVisualStyleBackColor = false
        };
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(42, 58, 76);
        button.FlatAppearance.MouseDownBackColor = Color.FromArgb(53, 75, 96);
        return button;
    }

    private void ToggleMaximize() =>
        WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;

    private void DragWindow(object? sender, MouseEventArgs args)
    {
        if (args.Button != MouseButtons.Left)
            return;
        if (args.Clicks == 2)
        {
            ToggleMaximize();
            return;
        }
        ReleaseCapture();
        SendMessage(Handle, 0x00A1, 2, 0); // WM_NCLBUTTONDOWN, HTCAPTION
    }

    protected override void OnResize(EventArgs args)
    {
        base.OnResize(args);
        if (_maximizeButton is null)
            return;
        var maximized = WindowState == FormWindowState.Maximized;
        Padding = maximized ? Padding.Empty : new Padding(6);
        _maximizeButton.Text = maximized ? "\uE923" : "\uE922";
        _maximizeButton.AccessibleName = maximized ? "Restore" : "Maximize";
    }

    protected override void WndProc(ref Message message)
    {
        // Both client-area calculations and activation redraws must bypass the native frame.
        if (message.Msg is 0x0083 or 0x0085) // WM_NCCALCSIZE, WM_NCPAINT
        {
            message.Result = 0;
            return;
        }
        if (message.Msg == 0x0086) // WM_NCACTIVATE
        {
            message.Result = 1;
            return;
        }
        base.WndProc(ref message);
        if (message.Msg == 0x0024) // WM_GETMINMAXINFO
        {
            var limits = Marshal.PtrToStructure<MinMaxInfo>(message.LParam);
            var screen = Screen.FromHandle(Handle);
            limits.MaxPosition = new Point(screen.WorkingArea.Left - screen.Bounds.Left, screen.WorkingArea.Top - screen.Bounds.Top);
            limits.MaxSize = screen.WorkingArea.Size;
            Marshal.StructureToPtr(limits, message.LParam, false);
        }
        else if (message.Msg == 0x0084 && WindowState == FormWindowState.Normal) // WM_NCHITTEST
        {
            var position = message.LParam.ToInt64();
            var point = PointToClient(new Point(unchecked((short)position), unchecked((short)(position >> 16))));
            var grip = Padding.Left;
            var left = point.X < grip;
            var right = point.X >= ClientSize.Width - grip;
            var top = point.Y < grip;
            var bottom = point.Y >= ClientSize.Height - grip;
            message.Result = (left, right, top, bottom) switch
            {
                (true, _, true, _) => 13,
                (_, true, true, _) => 14,
                (true, _, _, true) => 16,
                (_, true, _, true) => 17,
                (true, _, _, _) => 10,
                (_, true, _, _) => 11,
                (_, _, true, _) => 12,
                (_, _, _, true) => 15,
                _ => message.Result
            };
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo
    {
        public Point Reserved;
        public Size MaxSize;
        public Point MaxPosition;
        public Size MinTrackSize;
        public Size MaxTrackSize;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern nint SendMessage(nint window, int message, nint wParam, nint lParam);
}
