using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace AgentHubDesktop
{
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
