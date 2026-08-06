using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace AgentHubDesktop
{
    internal static class DesktopUserMessageDisclosure
    {
        internal const double CollapseHeight = 264;

        internal static bool HasOverflow(double desiredHeight)
        {
            return desiredHeight > CollapseHeight;
        }
    }

    internal static class WorkspaceFileLink
    {
        public static bool TryParse(string target, out string file, out int line)
        {
            file = null;
            line = 0;
            var normalized = (target ?? "").Trim();
            if (Regex.IsMatch(normalized, @"^/[A-Za-z]:[\\/]", RegexOptions.CultureInvariant))
            {
                normalized = normalized.Substring(1);
            }
            var match = Regex.Match(
                normalized,
                @"^(?<file>[A-Za-z]:[\\/].*?)(?::(?<line>[1-9][0-9]*))?$",
                RegexOptions.CultureInvariant);
            if (!match.Success) return false;
            file = match.Groups["file"].Value;
            Int32.TryParse(match.Groups["line"].Value, out line);
            return true;
        }
    }

    internal sealed class AnnotationDraft
    {
        public string Text { get; set; }
        public string Annotation { get; set; }
    }

    internal sealed class DesktopDraft
    {
        public string Text { get; set; }
        public List<AnnotationDraft> Annotations { get; set; }
        public List<string> Attachments { get; set; }
        public string ClientUserMessageId { get; set; }
        public string ClientUserMessageFingerprint { get; set; }

        public DesktopDraft()
        {
            Text = "";
            Annotations = new List<AnnotationDraft>();
            Attachments = new List<string>();
            ClientUserMessageId = "";
            ClientUserMessageFingerprint = "";
        }
    }

    internal sealed class ChoiceItem
    {
        public string Value { get; set; }
        public string Label { get; set; }
    }

    internal sealed class DesktopStreamGroup
    {
        public string WorkspaceId { get; set; }
        public string WorkspaceName { get; set; }
        public string StreamId { get; set; }
        public string StreamLabel { get; set; }
        public int StreamOrdinal { get; set; }
        public long LatestActivityAtMs { get; set; }
        public bool Running { get; set; }
        public List<TaskItem> Threads { get; set; }

        public DesktopStreamGroup()
        {
            Threads = new List<TaskItem>();
        }
    }

    internal sealed class DesktopWorkspaceGroup
    {
        public string WorkspaceId { get; set; }
        public string WorkspaceName { get; set; }
        public long LatestActivityAtMs { get; set; }
        public bool Running { get; set; }
        public List<DesktopStreamGroup> Streams { get; set; }

        public DesktopWorkspaceGroup()
        {
            Streams = new List<DesktopStreamGroup>();
        }
    }

    internal static class DesktopWorkspacePresentation
    {
        internal const int MaximumOpenStreams = 4;

        internal static string WorkspaceKey(TaskItem item)
        {
            var id = (item == null ? "" : item.WorkspaceId ?? "").Trim();
            if (id.Length > 0) return id;
            return "legacy\0" + ((item == null ? "" : item.ProjectRoot ?? "").Trim().ToLowerInvariant());
        }

        internal static string WorkspaceLabel(TaskItem item)
        {
            var name = (item == null ? "" : item.WorkspaceName ?? "").Trim();
            if (name.Length > 0) return name;
            var project = (item == null ? "" : item.ProjectName ?? "").Trim();
            return project.Length > 0 ? project : "Без Workspace";
        }

        internal static string StreamKey(TaskItem item)
        {
            var id = (item == null ? "" : item.StreamId ?? "").Trim();
            if (id.Length > 0) return id;
            return "legacy\0" + ((item == null ? "" : item.Provider ?? "").Trim())
                + "\0" + ((item == null ? "" : item.ThreadId ?? "").Trim());
        }

        internal static string StreamLabel(TaskItem item, int streamCount)
        {
            var display = (item == null ? "" : item.StreamDisplayName ?? "").Trim();
            if (display.Length > 0) return display;
            var name = (item == null ? "" : item.StreamName ?? "").Trim();
            if (name.Length > 0) return name;
            if (streamCount <= 1) return "";
            var ordinal = item == null || item.StreamOrdinal < 1 ? 1 : item.StreamOrdinal;
            return "Stream " + ordinal;
        }

        internal static List<DesktopWorkspaceGroup> Group(IEnumerable<TaskItem> items)
        {
            var source = new List<TaskItem>();
            foreach (var item in items ?? new TaskItem[0]) if (item != null) source.Add(item);
            var workspaceCounts = new Dictionary<string, int>();
            foreach (var item in source)
            {
                var key = WorkspaceKey(item);
                if (!workspaceCounts.ContainsKey(key)) workspaceCounts[key] = 0;
                var streamKey = StreamKey(item);
                var seenKey = key + "\0" + streamKey;
                if (!workspaceCounts.ContainsKey(seenKey))
                {
                    workspaceCounts[seenKey] = 1;
                    workspaceCounts[key] += 1;
                }
            }
            var workspaces = new Dictionary<string, DesktopWorkspaceGroup>();
            foreach (var item in source)
            {
                var workspaceKey = WorkspaceKey(item);
                DesktopWorkspaceGroup workspace;
                if (!workspaces.TryGetValue(workspaceKey, out workspace))
                {
                    workspace = new DesktopWorkspaceGroup
                    {
                        WorkspaceId = (item.WorkspaceId ?? "").Trim(),
                        WorkspaceName = WorkspaceLabel(item)
                    };
                    workspaces[workspaceKey] = workspace;
                }
                var streamKey = StreamKey(item);
                var stream = workspace.Streams.Find(value => String.Equals(value.StreamId, streamKey, StringComparison.Ordinal));
                if (stream == null)
                {
                    stream = new DesktopStreamGroup
                    {
                        WorkspaceId = workspace.WorkspaceId,
                        WorkspaceName = workspace.WorkspaceName,
                        StreamId = streamKey,
                        StreamLabel = StreamLabel(item, workspaceCounts[workspaceKey]),
                        StreamOrdinal = item.StreamOrdinal < 1 ? 1 : item.StreamOrdinal
                    };
                    workspace.Streams.Add(stream);
                }
                stream.Threads.Add(item);
                stream.Running = stream.Running || item.Running;
                stream.LatestActivityAtMs = Math.Max(stream.LatestActivityAtMs, item.OrderingActivityAtMs);
                workspace.Running = workspace.Running || item.Running;
                workspace.LatestActivityAtMs = Math.Max(workspace.LatestActivityAtMs, item.OrderingActivityAtMs);
            }
            foreach (var workspace in workspaces.Values)
            {
                foreach (var stream in workspace.Streams)
                {
                    stream.Threads.Sort((left, right) =>
                    {
                        var running = right.Running.CompareTo(left.Running);
                        if (running != 0) return running;
                        var activity = right.OrderingActivityAtMs.CompareTo(left.OrderingActivityAtMs);
                        return activity != 0 ? activity : String.Compare(left.Title, right.Title, StringComparison.CurrentCulture);
                    });
                }
                workspace.Streams.Sort((left, right) =>
                {
                    var running = right.Running.CompareTo(left.Running);
                    if (running != 0) return running;
                    var activity = right.LatestActivityAtMs.CompareTo(left.LatestActivityAtMs);
                    return activity != 0 ? activity : left.StreamOrdinal.CompareTo(right.StreamOrdinal);
                });
            }
            var result = new List<DesktopWorkspaceGroup>(workspaces.Values);
            result.Sort((left, right) =>
            {
                var running = right.Running.CompareTo(left.Running);
                if (running != 0) return running;
                var activity = right.LatestActivityAtMs.CompareTo(left.LatestActivityAtMs);
                return activity != 0 ? activity : String.Compare(left.WorkspaceName, right.WorkspaceName, StringComparison.CurrentCulture);
            });
            return result;
        }

        internal static bool EnsureOpenStream(IList<string> streamIds, string streamId)
        {
            if (streamIds == null || String.IsNullOrWhiteSpace(streamId)) return false;
            for (var index = streamIds.Count - 1; index >= 0; index--)
            {
                if (String.Equals(streamIds[index], streamId, StringComparison.Ordinal)) streamIds.RemoveAt(index);
            }
            streamIds.Add(streamId);
            while (streamIds.Count > MaximumOpenStreams) streamIds.RemoveAt(0);
            return true;
        }

        internal static bool TryAddOpenStream(IList<string> streamIds, string streamId)
        {
            if (streamIds == null || String.IsNullOrWhiteSpace(streamId)) return false;
            if (streamIds.Contains(streamId)) return true;
            if (streamIds.Count >= MaximumOpenStreams) return false;
            streamIds.Add(streamId);
            return true;
        }
    }

    internal sealed class PromptDialog : Window
    {
        private readonly TextBox input;
        private string result;

        private PromptDialog(Window owner, string title, string hint, string value)
        {
            Owner = owner;
            Title = title;
            Width = 500;
            Height = 210;
            ResizeMode = ResizeMode.NoResize;
            WindowStartupLocation = WindowStartupLocation.CenterOwner;
            Background = Theme.Solid(Theme.Ink);
            Foreground = Theme.Solid(Theme.Text);
            FontFamily = new FontFamily("Segoe UI Variable Text, Segoe UI");
            var panel = new StackPanel { Margin = new Thickness(20) };
            panel.Children.Add(Theme.Label(hint, 12, Theme.Solid(Theme.Muted), FontWeights.Normal));
            input = new TextBox
            {
                Text = value ?? "",
                Background = Theme.Solid(Theme.PanelRaised),
                Foreground = Theme.Solid(Theme.Text),
                CaretBrush = Theme.Solid(Theme.Codex),
                BorderBrush = Theme.Solid(Theme.Border),
                Padding = new Thickness(10, 8, 10, 8),
                Margin = new Thickness(0, 8, 0, 14),
                FontSize = 13
            };
            panel.Children.Add(input);
            var actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            var cancel = Theme.Button("Отмена", "", false);
            var save = Theme.Button("Сохранить", "", true);
            cancel.Margin = new Thickness(0, 0, 8, 0);
            cancel.Click += delegate { DialogResult = false; };
            save.Click += delegate
            {
                if (String.IsNullOrWhiteSpace(input.Text)) return;
                result = input.Text.Trim();
                DialogResult = true;
            };
            actions.Children.Add(cancel);
            actions.Children.Add(save);
            panel.Children.Add(actions);
            Content = panel;
            Loaded += delegate { input.Focus(); input.SelectAll(); };
        }

        public static string Show(Window owner, string title, string hint, string value)
        {
            var dialog = new PromptDialog(owner, title, hint, value);
            return dialog.ShowDialog() == true ? dialog.result : null;
        }
    }
}
