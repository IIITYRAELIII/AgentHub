using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Ellipse = System.Windows.Shapes.Ellipse;

namespace AgentHubDesktop
{
    internal sealed class AgentHubWindow : Window
    {
        private readonly AgentHubClient client = new AgentHubClient();
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
        private readonly DispatcherTimer refreshTimer = new DispatcherTimer();
        private readonly DispatcherTimer draftTimer = new DispatcherTimer();
        private readonly Dictionary<string, TaskItem> tasks = new Dictionary<string, TaskItem>();
        private readonly Dictionary<string, DesktopDraft> drafts = new Dictionary<string, DesktopDraft>();
        private readonly List<Dictionary<string, object>> history = new List<Dictionary<string, object>>();
        private readonly List<AnnotationDraft> annotations = new List<AnnotationDraft>();
        private readonly List<string> attachments = new List<string>();
        private readonly HashSet<string> expandedUserMessageIds = new HashSet<string>();

        private readonly StackPanel taskCards = new StackPanel();
        private readonly StackPanel conversation = new StackPanel();
        private readonly StackPanel annotationPanel = new StackPanel();
        private readonly StackPanel attachmentPanel = new StackPanel();
        private readonly StackPanel inspector = new StackPanel();
        private readonly ScrollViewer conversationScroll = new ScrollViewer();
        private readonly TextBox search = new TextBox();
        private readonly TextBox composer = new TextBox();
        private readonly TextBlock connection = new TextBlock();
        private readonly TextBlock pageTitle = new TextBlock();
        private readonly TextBlock pageMeta = new TextBlock();
        private readonly TextBlock footer = new TextBlock();
        private readonly Button sendButton;
        private readonly Button olderButton;
        private readonly string desktopRoot;
        private readonly string draftFile;
        private readonly string attachmentRoot;

        private bool refreshing;
        private bool switching;
        private bool historyLoading;
        private bool restoringDraft;
        private int desktopApiVersion;
        private string serverInstanceId;
        private string serverReleaseId;
        private long selectionEpoch;
        private string selectedKey;
        private string historyKey;
        private int? historyBefore;
        private string lastRenderSignature;
        private string currentClientUserMessageId;
        private string currentClientUserMessageFingerprint;

        public AgentHubWindow()
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            desktopRoot = Path.Combine(local, "AgentHub", "DesktopApp");
            draftFile = Path.Combine(desktopRoot, "drafts-v2.json");
            attachmentRoot = Path.Combine(desktopRoot, "attachments");

            Title = "Agent Hub";
            Width = 1480;
            Height = 900;
            MinWidth = 1060;
            MinHeight = 680;
            Background = Theme.Solid(Theme.Ink);
            Foreground = Theme.Solid(Theme.Text);
            FontFamily = new FontFamily("Segoe UI Variable Text, Segoe UI");
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.CanResize;

            sendButton = Theme.Button("Отправить", "\uE724", true);
            olderButton = Theme.Button("Ранние сообщения", "\uE823", false);
            Content = BuildShell();
            LoadDrafts();

            refreshTimer.Interval = TimeSpan.FromMilliseconds(900);
            refreshTimer.Tick += async delegate { await RefreshAsync(false); };
            draftTimer.Interval = TimeSpan.FromMilliseconds(500);
            draftTimer.Tick += delegate { draftTimer.Stop(); SaveDraft(); };

            Loaded += async delegate
            {
                refreshTimer.Start();
                await RefreshAsync(true);
            };
            Closed += delegate
            {
                refreshTimer.Stop();
                draftTimer.Stop();
                SaveDraft();
            };
            sendButton.Click += async delegate { await SendAsync(); };
            olderButton.Click += async delegate { await LoadHistoryAsync(true); };
            search.TextChanged += delegate { RenderTaskList(); };
            composer.TextChanged += delegate { ScheduleDraftSave(); };
            composer.PreviewKeyDown += ComposerPreviewKeyDown;
            composer.AllowDrop = true;
            composer.Drop += ComposerDrop;
        }

        private UIElement BuildShell()
        {
            var root = new Grid { Background = Theme.Solid(Theme.Ink) };
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(48) });
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            root.Children.Add(BuildTitleBar());

            var body = new Grid();
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(60) });
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(310) });
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(286) });
            Grid.SetRow(body, 1);
            body.Children.Add(BuildRail());
            var sidebar = BuildSidebar();
            Grid.SetColumn(sidebar, 1);
            body.Children.Add(sidebar);
            var center = BuildConversationArea();
            Grid.SetColumn(center, 2);
            body.Children.Add(center);
            var details = BuildInspector();
            Grid.SetColumn(details, 3);
            body.Children.Add(details);
            root.Children.Add(body);

            return root;
        }

        private UIElement BuildTitleBar()
        {
            var bar = new Grid
            {
                Background = Theme.Solid(Theme.Rail),
                Margin = new Thickness(0),
            };
            bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            bar.MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs args)
            {
                if (args.ClickCount == 2) ToggleMaximize();
                else DragMove();
            };

            var brand = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(18, 0, 0, 0) };
            brand.Children.Add(new Ellipse
            {
                Width = 10,
                Height = 10,
                Fill = Theme.ProviderGradient("codex"),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 10, 0)
            });
            brand.Children.Add(Theme.Label("AGENT", 12, Theme.Solid(Theme.Text), FontWeights.Bold));
            brand.Children.Add(Theme.Label("  HUB", 12, Theme.Solid(Theme.Muted), FontWeights.SemiBold));
            brand.VerticalAlignment = VerticalAlignment.Center;
            bar.Children.Add(brand);

            var controls = new StackPanel { Orientation = Orientation.Horizontal };
            controls.Children.Add(WindowButton("\uE921", delegate { WindowState = WindowState.Minimized; }));
            controls.Children.Add(WindowButton("\uE922", ToggleMaximize));
            controls.Children.Add(WindowButton("\uE8BB", Close));
            Grid.SetColumn(controls, 1);
            bar.Children.Add(controls);
            return bar;
        }

        private Button WindowButton(string glyph, Action action)
        {
            var button = new Button
            {
                Content = glyph,
                FontFamily = new FontFamily("Segoe Fluent Icons"),
                FontSize = 11,
                Foreground = Theme.Solid(Theme.Muted),
                Background = Brushes.Transparent,
                BorderThickness = new Thickness(0),
                Width = 46,
                Height = 48,
                Cursor = Cursors.Hand
            };
            button.Click += delegate { action(); };
            return button;
        }

        private void ToggleMaximize()
        {
            WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        }

        private UIElement BuildRail()
        {
            var rail = new Grid { Background = Theme.Solid(Theme.Rail) };
            rail.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            rail.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            rail.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var mark = new Border
            {
                Width = 38,
                Height = 38,
                Margin = new Thickness(11, 14, 11, 20),
                CornerRadius = Theme.Radius(12),
                Background = Theme.ProviderGradient("codex"),
                Child = Theme.Label("T", 17, Theme.Solid(Theme.Ink), FontWeights.Bold)
            };
            ((TextBlock)mark.Child).HorizontalAlignment = HorizontalAlignment.Center;
            ((TextBlock)mark.Child).VerticalAlignment = VerticalAlignment.Center;
            rail.Children.Add(mark);

            var nav = new StackPanel { Margin = new Thickness(8, 4, 8, 4) };
            nav.Children.Add(RailButton("\uE8F1", "Задачи", true));
            nav.Children.Add(RailButton("\uE9D9", "Активность", false));
            nav.Children.Add(RailButton("\uE8A7", "Изменения", false));
            Grid.SetRow(nav, 1);
            rail.Children.Add(nav);

            var bottom = new StackPanel { Margin = new Thickness(8, 4, 8, 12) };
            bottom.Children.Add(RailButton("\uE713", "Настройки", false));
            Grid.SetRow(bottom, 2);
            rail.Children.Add(bottom);
            return rail;
        }

        private Button RailButton(string glyph, string tip, bool selected)
        {
            var button = new Button
            {
                Content = glyph,
                ToolTip = tip,
                FontFamily = new FontFamily("Segoe Fluent Icons"),
                FontSize = 18,
                Foreground = selected ? Theme.Solid(Theme.Codex) : Theme.Solid(Theme.Muted),
                Background = selected ? Theme.Solid("#122A38") : Brushes.Transparent,
                BorderBrush = selected ? Theme.Solid("#245066") : Brushes.Transparent,
                BorderThickness = new Thickness(1),
                Width = 42,
                Height = 42,
                Margin = new Thickness(0, 4, 0, 4),
                Cursor = Cursors.Hand
            };
            Theme.Polish(button, 11);
            if (tip == "Активность") button.Click += async delegate { await ShowStatusAsync(); };
            else if (tip == "Изменения") button.Click += async delegate { await ShowDiffAsync(); };
            else if (tip == "Настройки") button.Click += delegate { footer.Text = "Настройки выбранной задачи находятся справа"; };
            return button;
        }

        private UIElement BuildSidebar()
        {
            var sidebar = new Grid
            {
                Background = Theme.Solid(Theme.Panel),
                Margin = new Thickness(0, 0, 1, 0)
            };
            sidebar.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            sidebar.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            sidebar.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            sidebar.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var heading = new Grid { Margin = new Thickness(18, 18, 14, 12) };
            heading.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            heading.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            heading.Children.Add(Theme.Label("Задачи", 19, Theme.Solid(Theme.Text), FontWeights.SemiBold));
            var add = IconButton("\uE710", "Новая задача");
            add.Click += delegate { ShowNewTaskMenu(add); };
            Grid.SetColumn(add, 1);
            heading.Children.Add(add);
            sidebar.Children.Add(heading);

            var searchBorder = new Border
            {
                Background = Theme.Solid(Theme.PanelRaised),
                BorderBrush = Theme.Solid(Theme.Border),
                BorderThickness = new Thickness(1),
                CornerRadius = Theme.Radius(10),
                Margin = new Thickness(14, 0, 14, 12),
                Padding = new Thickness(10, 7, 10, 7)
            };
            var searchGrid = new Grid();
            searchGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            searchGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            searchGrid.Children.Add(new TextBlock
            {
                Text = "\uE721",
                FontFamily = new FontFamily("Segoe Fluent Icons"),
                Foreground = Theme.Solid(Theme.Dim),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 8, 0)
            });
            search.Background = Brushes.Transparent;
            search.BorderThickness = new Thickness(0);
            search.Foreground = Theme.Solid(Theme.Text);
            search.CaretBrush = Theme.Solid(Theme.Codex);
            search.FontSize = 13;
            search.ToolTip = "Поиск по задачам";
            Grid.SetColumn(search, 1);
            searchGrid.Children.Add(search);
            searchBorder.Child = searchGrid;
            Grid.SetRow(searchBorder, 1);
            sidebar.Children.Add(searchBorder);

            var scroller = new ScrollViewer
            {
                Content = taskCards,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Padding = new Thickness(8, 0, 8, 8)
            };
            Grid.SetRow(scroller, 2);
            sidebar.Children.Add(scroller);

            connection.Text = "● Подключение…";
            connection.Foreground = Theme.Solid(Theme.Muted);
            connection.FontSize = 11;
            connection.Margin = new Thickness(18, 11, 18, 14);
            Grid.SetRow(connection, 3);
            sidebar.Children.Add(connection);
            return sidebar;
        }

        private UIElement BuildConversationArea()
        {
            var area = new Grid { Background = Theme.Solid(Theme.Ink) };
            area.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            area.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            area.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var header = new Grid { Margin = new Thickness(28, 18, 28, 14) };
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var titles = new StackPanel();
            pageTitle.Text = "Выберите задачу";
            pageTitle.FontSize = 22;
            pageTitle.FontWeight = FontWeights.SemiBold;
            pageTitle.Foreground = Theme.Solid(Theme.Text);
            pageTitle.TextTrimming = TextTrimming.CharacterEllipsis;
            pageMeta.FontSize = 12;
            pageMeta.Foreground = Theme.Solid(Theme.Muted);
            pageMeta.Margin = new Thickness(0, 5, 0, 0);
            titles.Children.Add(pageTitle);
            titles.Children.Add(pageMeta);
            header.Children.Add(titles);
            var headerActions = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            var diff = IconButton("\uE8A7", "Изменения задачи");
            diff.Click += async delegate { await ShowDiffAsync(); };
            var stop = IconButton("\uE71A", "Остановить ход");
            stop.Click += async delegate { await CancelAsync(); };
            headerActions.Children.Add(diff);
            headerActions.Children.Add(stop);
            Grid.SetColumn(headerActions, 1);
            header.Children.Add(headerActions);
            area.Children.Add(header);

            conversation.Margin = new Thickness(0, 8, 0, 18);
            conversationScroll.Content = conversation;
            conversationScroll.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            conversationScroll.HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled;
            conversationScroll.Padding = new Thickness(28, 0, 28, 0);
            Grid.SetRow(conversationScroll, 1);
            area.Children.Add(conversationScroll);

            var composerShell = new Border
            {
                Background = Theme.Solid(Theme.Panel),
                BorderBrush = Theme.Solid(Theme.Border),
                BorderThickness = new Thickness(1, 1, 1, 0),
                CornerRadius = new CornerRadius(16, 16, 0, 0),
                Margin = new Thickness(20, 0, 20, 0),
                Padding = new Thickness(14, 12, 14, 12)
            };
            var composerGrid = new Grid();
            composerGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            composerGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            composerGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            composerGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            annotationPanel.Margin = new Thickness(0, 0, 0, 7);
            attachmentPanel.Orientation = Orientation.Horizontal;
            attachmentPanel.Margin = new Thickness(0, 0, 0, 7);
            composerGrid.Children.Add(annotationPanel);
            Grid.SetRow(attachmentPanel, 1);
            composerGrid.Children.Add(attachmentPanel);

            composer.AcceptsReturn = true;
            composer.TextWrapping = TextWrapping.Wrap;
            composer.MinHeight = 74;
            composer.MaxHeight = 180;
            composer.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            composer.Background = Brushes.Transparent;
            composer.Foreground = Theme.Solid(Theme.Text);
            composer.CaretBrush = Theme.Solid(Theme.Codex);
            composer.BorderThickness = new Thickness(0);
            composer.FontSize = 14;
            composer.Padding = new Thickness(2, 5, 2, 5);
            composer.ToolTip = "Сообщение · Ctrl+Enter — отправить · Ctrl+V — вставить скриншот";
            Grid.SetRow(composer, 2);
            composerGrid.Children.Add(composer);

            var actions = new Grid { Margin = new Thickness(0, 8, 0, 0) };
            actions.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            actions.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var left = new StackPanel { Orientation = Orientation.Horizontal };
            var attach = IconButton("\uE723", "Добавить изображение");
            attach.Click += delegate { AddImageFromFileDialog(); };
            left.Children.Add(attach);
            footer.Text = "Ctrl+Enter — отправить";
            footer.Foreground = Theme.Solid(Theme.Dim);
            footer.FontSize = 11;
            footer.VerticalAlignment = VerticalAlignment.Center;
            footer.Margin = new Thickness(8, 0, 0, 0);
            left.Children.Add(footer);
            actions.Children.Add(left);
            Grid.SetColumn(sendButton, 1);
            actions.Children.Add(sendButton);
            Grid.SetRow(actions, 3);
            composerGrid.Children.Add(actions);
            composerShell.Child = composerGrid;
            Grid.SetRow(composerShell, 2);
            area.Children.Add(composerShell);
            return area;
        }

        private UIElement BuildInspector()
        {
            var shell = new Border
            {
                Background = Theme.Solid(Theme.Panel),
                BorderBrush = Theme.Solid(Theme.Border),
                BorderThickness = new Thickness(1, 0, 0, 0)
            };
            var grid = new Grid();
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            var title = Theme.Label("КОНТЕКСТ", 11, Theme.Solid(Theme.Muted), FontWeights.Bold);
            title.Margin = new Thickness(18, 20, 18, 12);
            grid.Children.Add(title);
            var scroll = new ScrollViewer
            {
                Content = inspector,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Padding = new Thickness(14, 0, 14, 18)
            };
            Grid.SetRow(scroll, 1);
            grid.Children.Add(scroll);
            shell.Child = grid;
            return shell;
        }

        private Button IconButton(string glyph, string tip)
        {
            var button = new Button
            {
                Content = glyph,
                ToolTip = tip,
                FontFamily = new FontFamily("Segoe Fluent Icons"),
                FontSize = 15,
                Foreground = Theme.Solid(Theme.Muted),
                Background = Theme.Solid(Theme.PanelRaised),
                BorderBrush = Theme.Solid(Theme.Border),
                BorderThickness = new Thickness(1),
                Width = 36,
                Height = 34,
                Margin = new Thickness(3, 0, 3, 0),
                Cursor = Cursors.Hand
            };
            Theme.Polish(button, 8);
            return button;
        }

        private async Task RefreshAsync(bool force)
        {
            if (refreshing || switching) return;
            var requestEpoch = selectionEpoch;
            refreshing = true;
            try
            {
                var snapshot = await client.CallAsync("snapshot", new Dictionary<string, object> { { "refresh", force } });
                if (switching || requestEpoch != selectionEpoch) return;
                ApplySnapshot(snapshot);
                connection.Text = "●  Agent Hub Server";
                connection.Foreground = Theme.Solid(Theme.Good);
            }
            catch (Exception error)
            {
                connection.Text = "○  Нет связи";
                connection.Foreground = Theme.Solid(Theme.Danger);
                footer.Text = error.Message;
            }
            finally
            {
                refreshing = false;
            }
        }

        private void ApplySnapshot(Dictionary<string, object> snapshot)
        {
            object apiVersion;
            int parsedApiVersion;
            if (snapshot.TryGetValue("apiVersion", out apiVersion)
                && Int32.TryParse(Convert.ToString(apiVersion), out parsedApiVersion))
            {
                desktopApiVersion = parsedApiVersion;
            }
            var server = AgentHubClient.Object(snapshot, "server");
            var process = AgentHubClient.Object(server, "process");
            var nextInstanceId = AgentHubClient.Text(process, "instanceId");
            var nextReleaseId = AgentHubClient.Text(process, "releaseId");
            var instanceChanged = !String.IsNullOrWhiteSpace(serverInstanceId)
                && !String.IsNullOrWhiteSpace(nextInstanceId)
                && !String.Equals(serverInstanceId, nextInstanceId, StringComparison.Ordinal);
            var releaseChanged = !String.IsNullOrWhiteSpace(serverReleaseId)
                && !String.IsNullOrWhiteSpace(nextReleaseId)
                && !String.Equals(serverReleaseId, nextReleaseId, StringComparison.Ordinal);
            if (!String.IsNullOrWhiteSpace(nextInstanceId)) serverInstanceId = nextInstanceId;
            if (!String.IsNullOrWhiteSpace(nextReleaseId)) serverReleaseId = nextReleaseId;
            if (instanceChanged)
            {
                lastRenderSignature = null;
                if (releaseChanged)
                {
                    historyKey = null;
                    historyBefore = null;
                    history.Clear();
                    footer.Text = "Agent Hub обновлён";
                }
            }
            var previous = selectedKey;
            tasks.Clear();
            TaskItem selected = null;
            foreach (var raw in AgentHubClient.Array(snapshot, "tasks"))
            {
                var value = raw as Dictionary<string, object>;
                if (value == null) continue;
                var item = new TaskItem
                {
                    Provider = AgentHubClient.Text(value, "provider"),
                    ThreadId = AgentHubClient.Text(value, "threadId"),
                    ProjectRoot = AgentHubClient.Text(value, "projectRoot"),
                    ProjectName = AgentHubClient.Text(value, "projectName"),
                    Title = AgentHubClient.Text(value, "title", "Без названия"),
                    Selected = AgentHubClient.Bool(value, "selected"),
                    Running = AgentHubClient.Bool(value, "running"),
                    Runtime = AgentHubClient.Text(value, "runtime"),
                    LastAnswer = AgentHubClient.Text(value, "lastAnswer"),
                    OrderingActivityAtMs = value.ContainsKey("orderingActivityAtMs")
                        ? Convert.ToInt64(value["orderingActivityAtMs"])
                        : 0L,
                    Run = AgentHubClient.Object(value, "run"),
                    Context = AgentHubClient.Object(value, "context")
                };
                var key = Key(item.Provider, item.ThreadId);
                tasks[key] = item;
                if (item.Selected) selected = item;
            }
            if (selected == null && previous != null) tasks.TryGetValue(previous, out selected);
            if (selected != null)
            {
                var next = Key(selected.Provider, selected.ThreadId);
                if (next != selectedKey)
                {
                    SaveDraft();
                    selectionEpoch += 1;
                    selectedKey = next;
                    historyKey = null;
                    historyBefore = null;
                    history.Clear();
                    RestoreDraft();
                    lastRenderSignature = null;
                }
                pageTitle.Text = selected.Title;
                pageMeta.Text = ProviderName(selected.Provider) + "  ·  "
                    + (String.IsNullOrWhiteSpace(selected.Runtime) ? "Ожидание" : selected.Runtime)
                    + (selected.Running ? "  ·  ход активен" : "  ·  готов");
                RenderInspector(selected, snapshot);
                if (historyKey != selectedKey) BeginLoadHistory();
                else RenderConversation(selected);
            }
            RenderTaskList();
        }

        private void RenderTaskList()
        {
            var query = (search.Text ?? "").Trim();
            taskCards.Children.Clear();
            var visible = tasks
                .Where(delegate(KeyValuePair<string, TaskItem> pair)
                {
                    return query.Length == 0
                        || pair.Value.Title.IndexOf(query, StringComparison.CurrentCultureIgnoreCase) >= 0
                        || pair.Value.Provider.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;
                })
                .OrderByDescending(delegate(KeyValuePair<string, TaskItem> pair) { return pair.Value.Running; })
                .ThenByDescending(delegate(KeyValuePair<string, TaskItem> pair) { return pair.Value.OrderingActivityAtMs; })
                .ThenBy(delegate(KeyValuePair<string, TaskItem> pair) { return pair.Value.Title; })
                .ToList();

            AddTaskSection("АКТИВНЫЕ", visible.Where(delegate(KeyValuePair<string, TaskItem> pair) { return pair.Value.Running; }).ToList());
            AddTaskSection("НЕДАВНИЕ", visible.Where(delegate(KeyValuePair<string, TaskItem> pair) { return !pair.Value.Running; }).ToList());
            if (visible.Count == 0)
            {
                var empty = Theme.Label("Ничего не найдено", 12, Theme.Solid(Theme.Dim), FontWeights.Normal);
                empty.Margin = new Thickness(12, 18, 12, 18);
                taskCards.Children.Add(empty);
            }
        }

        private void AddTaskSection(string title, List<KeyValuePair<string, TaskItem>> items)
        {
            if (items.Count == 0) return;
            var heading = Theme.Label(title + "  " + items.Count, 10, Theme.Solid(Theme.Dim), FontWeights.Bold);
            heading.Margin = new Thickness(10, 12, 10, 6);
            taskCards.Children.Add(heading);
            foreach (var pair in items) taskCards.Children.Add(TaskCard(pair.Key, pair.Value));
        }

        private UIElement TaskCard(string key, TaskItem item)
        {
            var selected = key == selectedKey;
            var border = new Border
            {
                Background = selected ? Theme.Solid("#152638") : Brushes.Transparent,
                BorderBrush = selected ? Theme.Provider(item.Provider) : Brushes.Transparent,
                BorderThickness = new Thickness(selected ? 1 : 0),
                CornerRadius = Theme.Radius(11),
                Padding = new Thickness(11, 10, 9, 10),
                Margin = new Thickness(2, 2, 2, 2),
                Cursor = Cursors.Hand,
                Tag = key
            };
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            if (item.Running && ShortRuntime(item.Runtime) == "HUB")
            {
                var marker = Theme.Label("⚡", 13, Theme.Solid(Theme.Good), FontWeights.Normal);
                marker.Margin = new Thickness(0, 0, 8, 0);
                marker.VerticalAlignment = VerticalAlignment.Top;
                grid.Children.Add(marker);
            }
            else
            {
                var dot = new Ellipse
                {
                    Width = item.Running ? 9 : 7,
                    Height = item.Running ? 9 : 7,
                    Fill = item.Running ? Theme.Solid(Theme.Good) : Theme.Provider(item.Provider),
                    Opacity = item.Running ? 1 : .55,
                    Margin = new Thickness(0, 4, 10, 0),
                    VerticalAlignment = VerticalAlignment.Top
                };
                grid.Children.Add(dot);
            }
            var text = new StackPanel();
            var title = Theme.Label(item.Title, 13, Theme.Solid(Theme.Text), selected ? FontWeights.SemiBold : FontWeights.Normal);
            title.TextTrimming = TextTrimming.CharacterEllipsis;
            title.MaxHeight = 40;
            text.Children.Add(title);
            var runtime = String.IsNullOrWhiteSpace(item.Runtime) ? "ожидание" : ShortRuntime(item.Runtime);
            var meta = Theme.Label(ProviderName(item.Provider) + "  ·  " + runtime, 10.5, Theme.Solid(Theme.Muted), FontWeights.Normal);
            meta.Margin = new Thickness(0, 4, 0, 0);
            text.Children.Add(meta);
            Grid.SetColumn(text, 1);
            grid.Children.Add(text);
            border.Child = grid;
            border.MouseLeftButtonUp += async delegate { await SelectTaskAsync(key); };
            return border;
        }

        private async Task SelectTaskAsync(string key)
        {
            if (switching || key == selectedKey) return;
            TaskItem item;
            if (!tasks.TryGetValue(key, out item)) return;
            var requestEpoch = selectionEpoch + 1;
            selectionEpoch = requestEpoch;
            switching = true;
            SaveDraft();
            try
            {
                footer.Text = "Переключаю задачу…";
                var snapshot = await client.CallAsync("select-task", new Dictionary<string, object>
                {
                    { "provider", item.Provider },
                    { "threadId", item.ThreadId }
                });
                if (requestEpoch != selectionEpoch) return;
                ApplySnapshot(snapshot);
                footer.Text = "Задача выбрана";
            }
            catch (Exception error) { footer.Text = error.Message; }
            finally { switching = false; }
        }

        private async Task LoadHistoryAsync(bool older)
        {
            TaskItem item;
            if (historyLoading || String.IsNullOrWhiteSpace(selectedKey) || !tasks.TryGetValue(selectedKey, out item)) return;
            var requestKey = selectedKey;
            var requestEpoch = selectionEpoch;
            var requestBefore = historyBefore;
            historyLoading = true;
            olderButton.IsEnabled = false;
            try
            {
                var parameters = new Dictionary<string, object>
                {
                    { "provider", item.Provider },
                    { "threadId", item.ThreadId },
                    { "limit", 10 }
                };
                if (older && requestBefore.HasValue) parameters["before"] = requestBefore.Value;
                var page = await client.CallAsync("task-history", parameters);
                if (requestEpoch != selectionEpoch || requestKey != selectedKey) return;
                if (older && requestBefore != historyBefore) return;
                var loaded = new List<Dictionary<string, object>>();
                foreach (var raw in AgentHubClient.Array(page, "items"))
                {
                    var value = raw as Dictionary<string, object>;
                    if (value != null) loaded.Add(value);
                }
                if (older) history.InsertRange(0, loaded);
                else
                {
                    history.Clear();
                    history.AddRange(loaded);
                    historyKey = requestKey;
                }
                object before;
                historyBefore = page.TryGetValue("nextBefore", out before) && before != null
                    ? (int?)Convert.ToInt32(before)
                    : null;
                lastRenderSignature = null;
                RenderConversation(item);
            }
            catch (Exception error) { footer.Text = "История: " + error.Message; }
            finally
            {
                historyLoading = false;
                olderButton.IsEnabled = true;
            }
        }

        private async void BeginLoadHistory() { await LoadHistoryAsync(false); }

        private void RenderConversation(TaskItem item)
        {
            var run = item.Run ?? new Dictionary<string, object>();
            var signature = selectedKey + "|" + history.Count + "|" + historyBefore + "|"
                + DesktopAttachmentPresentation.HistorySignature(history) + "|"
                + item.Running + "|"
                + AgentHubClient.Text(run, "turnId") + "|"
                + AgentHubClient.Text(run, "stage") + "|"
                + AgentHubClient.Text(run, "progress") + "|"
                + AgentHubClient.Text(run, "response");
            if (signature == lastRenderSignature) return;
            lastRenderSignature = signature;
            var wasNearBottom = conversationScroll.VerticalOffset >= conversationScroll.ScrollableHeight - 80;
            conversation.Children.Clear();
            if (historyBefore.HasValue)
            {
                olderButton.HorizontalAlignment = HorizontalAlignment.Center;
                olderButton.Margin = new Thickness(0, 2, 0, 16);
                conversation.Children.Add(olderButton);
            }
            foreach (var exchange in history)
            {
                var prompt = AgentHubClient.Text(exchange, "prompt");
                var answer = AgentHubClient.Text(exchange, "answer");
                var assistantAttachments = DesktopAttachmentPresentation.AssistantAttachments(exchange);
                if (!String.IsNullOrWhiteSpace(prompt)) conversation.Children.Add(UserMessage(exchange));
                if ((!String.IsNullOrWhiteSpace(answer) || assistantAttachments.Count > 0)
                    && !HistoryAnswerIsCoveredByLiveRun(exchange, run, item.Running))
                {
                    conversation.Children.Add(AssistantMessage(answer, item.Provider, false, assistantAttachments));
                }
            }
            if (item.Running)
            {
                conversation.Children.Add(LiveRunCard(item));
            }
            else if (history.Count == 0)
            {
                var empty = Theme.Label("Новая задача\nНапишите сообщение, чтобы начать.", 14, Theme.Solid(Theme.Dim), FontWeights.Normal);
                empty.TextAlignment = TextAlignment.Center;
                empty.HorizontalAlignment = HorizontalAlignment.Center;
                empty.Margin = new Thickness(20, 100, 20, 100);
                conversation.Children.Add(empty);
            }
            if (wasNearBottom || item.Running)
            {
                Dispatcher.BeginInvoke(new Action(delegate { conversationScroll.ScrollToEnd(); }), DispatcherPriority.Background);
            }
        }

        private static bool HistoryAnswerIsCoveredByLiveRun(
            Dictionary<string, object> exchange,
            Dictionary<string, object> run,
            bool running)
        {
            if (!running) return false;
            if (AgentHubClient.Bool(exchange, "active")) return true;
            var exchangeTurnId = AgentHubClient.Text(exchange, "id");
            var runTurnId = AgentHubClient.Text(run, "turnId");
            return !String.IsNullOrWhiteSpace(exchangeTurnId)
                && !String.IsNullOrWhiteSpace(runTurnId)
                && String.Equals(exchangeTurnId, runTurnId, StringComparison.Ordinal);
        }

        private UIElement UserMessage(Dictionary<string, object> exchange)
        {
            var text = AgentHubClient.Text(exchange, "prompt");
            var content = new StackPanel();
            var annotationIndex = 0;
            foreach (var raw in AgentHubClient.Array(exchange, "promptAnnotations"))
            {
                var annotation = raw as Dictionary<string, object>;
                if (annotation == null) continue;
                var selectedText = AgentHubClient.Text(annotation, "text").Trim();
                var comment = AgentHubClient.Text(annotation, "annotation").Trim();
                if (selectedText.Length == 0 && comment.Length == 0) continue;
                annotationIndex += 1;
                var quoteContent = new StackPanel();
                var heading = Theme.Label("ЦИТАТА " + annotationIndex, 9.5, Theme.Solid(Theme.CodexMint), FontWeights.Bold);
                heading.Margin = new Thickness(0, 0, 0, 5);
                quoteContent.Children.Add(heading);
                if (selectedText.Length > 0)
                {
                    quoteContent.Children.Add(Theme.Label(selectedText, 12.5, Theme.Solid(Theme.Text), FontWeights.Normal));
                }
                if (comment.Length > 0)
                {
                    var commentText = Theme.Label(comment, 12.5, Theme.Solid(Theme.Text), FontWeights.SemiBold);
                    commentText.Margin = new Thickness(0, selectedText.Length > 0 ? 7 : 0, 0, 0);
                    quoteContent.Children.Add(commentText);
                }
                content.Children.Add(new Border
                {
                    Background = Theme.Solid("#102638"),
                    BorderBrush = Theme.Solid(Theme.Codex),
                    BorderThickness = new Thickness(3, 0, 0, 0),
                    Padding = new Thickness(11, 8, 10, 8),
                    Margin = new Thickness(0, 0, 0, 8),
                    Child = quoteContent
                });
            }
            var request = annotationIndex > 0 ? AgentHubClient.Text(exchange, "promptRequest").Trim() : text;
            if (!String.IsNullOrWhiteSpace(request))
            {
                var requestText = Theme.Label(request, 13.5, Theme.Solid(Theme.Text), FontWeights.Normal);
                requestText.Margin = new Thickness(0, annotationIndex > 0 ? 2 : 0, 0, 0);
                content.Children.Add(requestText);
            }
            var border = new Border
            {
                Background = Theme.Solid("#173145"),
                BorderBrush = Theme.Solid("#23506A"),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(14, 14, 4, 14),
                Padding = new Thickness(14, 10, 14, 10),
                Margin = new Thickness(100, 5, 0, 10),
                HorizontalAlignment = HorizontalAlignment.Right,
                MaxWidth = 760,
                Child = CollapsibleUserMessageContent(AgentHubClient.Text(exchange, "id"), content)
            };
            return border;
        }

        private UIElement CollapsibleUserMessageContent(string messageId, StackPanel content)
        {
            var contentShell = new Border
            {
                ClipToBounds = true,
                Child = content
            };
            var disclosure = Theme.Button("Показать ещё", "", false);
            disclosure.HorizontalAlignment = HorizontalAlignment.Left;
            disclosure.Margin = new Thickness(0, 7, 0, 0);
            disclosure.Padding = new Thickness(8, 4, 8, 4);
            disclosure.Visibility = Visibility.Collapsed;
            var shell = new StackPanel();
            shell.Children.Add(contentShell);
            shell.Children.Add(disclosure);
            var expandedWithoutId = false;

            Action sync = null;
            sync = delegate
            {
                var hasOverflow = DesktopUserMessageDisclosure.HasOverflow(content.DesiredSize.Height);
                if (!hasOverflow)
                {
                    contentShell.MaxHeight = Double.PositiveInfinity;
                    disclosure.Visibility = Visibility.Collapsed;
                    if (!String.IsNullOrWhiteSpace(messageId)) expandedUserMessageIds.Remove(messageId);
                    return;
                }
                var expanded = String.IsNullOrWhiteSpace(messageId)
                    ? expandedWithoutId
                    : expandedUserMessageIds.Contains(messageId);
                contentShell.MaxHeight = expanded ? Double.PositiveInfinity : DesktopUserMessageDisclosure.CollapseHeight;
                disclosure.Content = expanded ? "Свернуть" : "Показать ещё";
                disclosure.Visibility = Visibility.Visible;
            };
            disclosure.Click += delegate
            {
                if (String.IsNullOrWhiteSpace(messageId)) expandedWithoutId = !expandedWithoutId;
                else if (expandedUserMessageIds.Contains(messageId)) expandedUserMessageIds.Remove(messageId);
                else expandedUserMessageIds.Add(messageId);
                sync();
            };
            Action scheduleSync = delegate
            {
                Dispatcher.BeginInvoke(sync, DispatcherPriority.Loaded);
            };
            shell.Loaded += delegate { scheduleSync(); };
            contentShell.SizeChanged += delegate { scheduleSync(); };
            return shell;
        }

        private UIElement AssistantMessage(
            string text,
            string provider,
            bool live,
            IList<Dictionary<string, object>> assistantAttachments)
        {
            var body = new StackPanel();
            if (!String.IsNullOrWhiteSpace(text)) body.Children.Add(SelectableMessage(text, provider));
            var attachmentStrip = AssistantAttachmentStrip(assistantAttachments);
            if (attachmentStrip != null) body.Children.Add(attachmentStrip);
            var card = new Border
            {
                Background = Theme.Solid(Theme.Panel),
                BorderBrush = Theme.Solid(Theme.Border),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(4, 14, 14, 14),
                Padding = new Thickness(16, 13, 16, 13),
                Margin = new Thickness(0, 5, 60, 10),
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Child = body
            };
            return AccentCard(card, provider, live);
        }

        private UIElement LiveRunCard(TaskItem item)
        {
            var run = item.Run ?? new Dictionary<string, object>();
            var panel = new StackPanel();
            var top = new StackPanel { Orientation = Orientation.Horizontal };
            top.Children.Add(new Ellipse
            {
                Width = 9,
                Height = 9,
                Fill = Theme.Solid(Theme.Good),
                Margin = new Thickness(0, 4, 9, 0),
                VerticalAlignment = VerticalAlignment.Top
            });
            top.Children.Add(Theme.Label(AgentHubClient.Text(run, "stage", "Ход выполняется"), 13, Theme.Solid(Theme.Text), FontWeights.SemiBold));
            panel.Children.Add(top);
            var progress = AgentHubClient.Text(run, "progress");
            var response = AgentHubClient.Text(run, "response");
            if (!String.IsNullOrWhiteSpace(progress))
            {
                var progressText = Theme.Label(progress, 12.5, Theme.Solid(Theme.Muted), FontWeights.Normal);
                progressText.Margin = new Thickness(18, 10, 0, 0);
                panel.Children.Add(progressText);
            }
            if (!String.IsNullOrWhiteSpace(response))
            {
                var responseBlock = SelectableMessage(response, item.Provider);
                responseBlock.Margin = new Thickness(18, 12, 0, 0);
                panel.Children.Add(responseBlock);
            }
            var liveExchange = LiveRunExchange(run);
            var liveAttachments = liveExchange == null
                ? new List<Dictionary<string, object>>()
                : DesktopAttachmentPresentation.AssistantAttachments(liveExchange);
            var attachmentStrip = AssistantAttachmentStrip(liveAttachments);
            if (attachmentStrip != null)
            {
                attachmentStrip.Margin = new Thickness(18, 12, 0, 0);
                panel.Children.Add(attachmentStrip);
            }
            var card = new Border
            {
                Background = Theme.Solid("#101B28"),
                BorderBrush = Theme.Solid(Theme.Border),
                BorderThickness = new Thickness(1),
                CornerRadius = Theme.Radius(14),
                Padding = new Thickness(16, 14, 16, 14),
                Margin = new Thickness(0, 5, 30, 10),
                Child = panel
            };
            return AccentCard(card, item.Provider, true);
        }

        private Dictionary<string, object> LiveRunExchange(Dictionary<string, object> run)
        {
            var runTurnId = AgentHubClient.Text(run, "turnId");
            for (var index = history.Count - 1; index >= 0; index--)
            {
                var exchange = history[index];
                if (AgentHubClient.Bool(exchange, "active")) return exchange;
                if (!String.IsNullOrWhiteSpace(runTurnId)
                    && String.Equals(AgentHubClient.Text(exchange, "id"), runTurnId, StringComparison.Ordinal))
                {
                    return exchange;
                }
            }
            return null;
        }

        private FrameworkElement AssistantAttachmentStrip(IList<Dictionary<string, object>> values)
        {
            if (values == null || values.Count == 0) return null;
            var panel = new WrapPanel { Margin = new Thickness(0, 12, 0, 0) };
            foreach (var attachment in values)
            {
                var path = DesktopAttachmentPresentation.ResolvePath(attachmentRoot, attachment);
                panel.Children.Add(AssistantAttachmentTile(path));
            }
            return panel;
        }

        private UIElement AssistantAttachmentTile(string path)
        {
            var image = new Image { Stretch = Stretch.UniformToFill };
            var bitmap = LoadAttachmentBitmap(path, 360);
            if (bitmap != null) image.Source = bitmap;
            FrameworkElement content = bitmap == null
                ? (FrameworkElement)Theme.Label("Изображение недоступно", 12, Theme.Solid(Theme.Muted), FontWeights.Normal)
                : image;
            if (content is TextBlock) ((TextBlock)content).TextAlignment = TextAlignment.Center;

            var tile = new Button
            {
                Width = 176,
                Height = 116,
                Margin = new Thickness(0, 0, 9, 9),
                Padding = new Thickness(0),
                Background = Theme.Solid(Theme.PanelRaised),
                BorderBrush = Theme.Solid(Theme.Border),
                BorderThickness = new Thickness(1),
                Cursor = bitmap == null ? Cursors.Arrow : Cursors.Hand,
                IsEnabled = bitmap != null,
                ToolTip = bitmap == null ? "Изображение недоступно" : "Открыть изображение",
                Content = content
            };
            if (bitmap != null) tile.Click += delegate { ShowAttachmentViewer(path); };
            return tile;
        }

        private static BitmapImage LoadAttachmentBitmap(string path, int decodePixelWidth)
        {
            if (String.IsNullOrWhiteSpace(path)) return null;
            try
            {
                var bitmap = new BitmapImage();
                bitmap.BeginInit();
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.UriSource = new Uri(path, UriKind.Absolute);
                if (decodePixelWidth > 0) bitmap.DecodePixelWidth = decodePixelWidth;
                bitmap.EndInit();
                bitmap.Freeze();
                return bitmap;
            }
            catch { return null; }
        }

        private void ShowAttachmentViewer(string path)
        {
            var bitmap = LoadAttachmentBitmap(path, 0);
            if (bitmap == null)
            {
                footer.Text = "Изображение недоступно";
                return;
            }
            var image = new Image
            {
                Source = bitmap,
                Stretch = Stretch.Uniform,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            var window = new Window
            {
                Title = "Изображение",
                Owner = this,
                Width = Math.Min(1280, Math.Max(720, bitmap.PixelWidth + 48)),
                Height = Math.Min(900, Math.Max(520, bitmap.PixelHeight + 72)),
                MinWidth = 560,
                MinHeight = 420,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Background = Theme.Solid(Theme.Ink),
                Content = new ScrollViewer
                {
                    Content = image,
                    HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
                    VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                    Padding = new Thickness(18)
                }
            };
            window.ShowDialog();
        }

        private UIElement AccentCard(Border card, string provider, bool glow)
        {
            var grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(3) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var accent = new Border
            {
                Background = Theme.ProviderGradient(provider),
                CornerRadius = new CornerRadius(3),
                Opacity = glow ? 1 : .8,
                Margin = new Thickness(0, 8, 0, 8)
            };
            grid.Children.Add(accent);
            Grid.SetColumn(card, 1);
            card.Margin = new Thickness(8, card.Margin.Top, card.Margin.Right, card.Margin.Bottom);
            grid.Children.Add(card);
            return grid;
        }

        private FrameworkElement SelectableMessage(string text, string provider)
        {
            var document = BuildDocument(text);
            var box = new RichTextBox(document)
            {
                IsReadOnly = true,
                IsDocumentEnabled = true,
                Background = Brushes.Transparent,
                Foreground = Theme.Solid(Theme.Text),
                BorderThickness = new Thickness(0),
                Padding = new Thickness(0),
                FontFamily = new FontFamily("Segoe UI Variable Text, Segoe UI"),
                FontSize = 13.2,
                VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Tag = provider
            };
            Action addSelection = delegate
            {
                var selected = box.Selection == null ? "" : box.Selection.Text.Trim();
                if (selected.Length == 0)
                {
                    footer.Text = "Сначала выделите фрагмент ответа";
                    return;
                }
                AddAnnotation(selected);
                box.Selection.Select(box.CaretPosition, box.CaretPosition);
            };
            var menu = new ContextMenu { Background = Theme.Solid(Theme.PanelRaised), Foreground = Theme.Solid(Theme.Text) };
            var annotate = new MenuItem { Header = "Добавить цитату", Foreground = Theme.Solid(Theme.Text) };
            annotate.Click += delegate { addSelection(); };
            var copy = new MenuItem { Header = "Копировать", Foreground = Theme.Solid(Theme.Text) };
            copy.Click += delegate
            {
                var selected = box.Selection == null ? "" : box.Selection.Text;
                if (!String.IsNullOrEmpty(selected)) Clipboard.SetText(selected);
            };
            menu.Items.Add(annotate);
            menu.Items.Add(copy);
            box.ContextMenu = menu;
            var quoteButton = Theme.Button("Цитировать выделение", "\uE8B0", false);
            quoteButton.HorizontalAlignment = HorizontalAlignment.Left;
            quoteButton.Margin = new Thickness(0, 7, 0, 0);
            quoteButton.Padding = new Thickness(9, 5, 9, 5);
            quoteButton.Visibility = Visibility.Collapsed;
            quoteButton.Click += delegate { addSelection(); };
            box.SelectionChanged += delegate
            {
                quoteButton.Visibility = box.Selection != null && !String.IsNullOrWhiteSpace(box.Selection.Text)
                    ? Visibility.Visible
                    : Visibility.Collapsed;
            };
            var shell = new StackPanel();
            shell.Children.Add(box);
            shell.Children.Add(quoteButton);
            return shell;
        }

        private FlowDocument BuildDocument(string text)
        {
            var document = new FlowDocument
            {
                PagePadding = new Thickness(0),
                LineHeight = Double.NaN,
                TextAlignment = TextAlignment.Left
            };
            var lines = (text ?? "").Replace("\r\n", "\n").Split('\n');
            var code = false;
            Paragraph codeBlock = null;
            foreach (var raw in lines)
            {
                if (raw.TrimStart().StartsWith("```", StringComparison.Ordinal))
                {
                    if (!code)
                    {
                        code = true;
                        codeBlock = new Paragraph
                        {
                            Background = Theme.Solid("#080D14"),
                            BorderBrush = Theme.Solid(Theme.Border),
                            BorderThickness = new Thickness(1),
                            Padding = new Thickness(10, 8, 10, 8),
                            Margin = new Thickness(0, 6, 0, 8),
                            FontFamily = new FontFamily("Cascadia Mono, Consolas"),
                            FontSize = 12.2
                        };
                        document.Blocks.Add(codeBlock);
                    }
                    else code = false;
                    continue;
                }
                if (code && codeBlock != null)
                {
                    codeBlock.Inlines.Add(new Run(raw));
                    codeBlock.Inlines.Add(new LineBreak());
                    continue;
                }
                var paragraph = new Paragraph { Margin = new Thickness(0, 0, 0, 6) };
                var value = raw;
                if (value.StartsWith("### "))
                {
                    value = value.Substring(4);
                    paragraph.FontWeight = FontWeights.SemiBold;
                    paragraph.FontSize = 14;
                }
                else if (value.StartsWith("## "))
                {
                    value = value.Substring(3);
                    paragraph.FontWeight = FontWeights.SemiBold;
                    paragraph.FontSize = 15;
                }
                else if (value.StartsWith("# "))
                {
                    value = value.Substring(2);
                    paragraph.FontWeight = FontWeights.Bold;
                    paragraph.FontSize = 16;
                }
                else if (value.StartsWith("- ") || value.StartsWith("* "))
                {
                    value = "•  " + value.Substring(2);
                    paragraph.Margin = new Thickness(10, 0, 0, 4);
                }
                AppendInlineMarkdown(paragraph, value);
                document.Blocks.Add(paragraph);
            }
            return document;
        }

        private void AppendInlineMarkdown(Paragraph paragraph, string text)
        {
            var matches = Regex.Matches(text ?? "", @"\[([^\]]+)\]\((?:<)?([^\)>]+)(?:>)?\)");
            var index = 0;
            foreach (Match match in matches)
            {
                if (match.Index > index) AppendInlineTokens(paragraph, text.Substring(index, match.Index - index));
                var target = match.Groups[2].Value.Trim();
                string localFile;
                int localLine;
                if (TryResolveWorkspaceFileLink(target, out localFile, out localLine))
                {
                    var localLink = new Hyperlink(new Run(match.Groups[1].Value))
                    {
                        Foreground = Theme.Solid(Theme.Codex),
                        TextDecorations = null,
                        ToolTip = localFile + (localLine > 0 ? ":" + localLine : "")
                    };
                    localLink.Click += delegate { OpenWorkspaceFile(localFile, localLine); };
                    paragraph.Inlines.Add(localLink);
                    index = match.Index + match.Length;
                    continue;
                }
                Uri safeTarget;
                if (!Uri.TryCreate(target, UriKind.Absolute, out safeTarget)
                    || (safeTarget.Scheme != Uri.UriSchemeHttp && safeTarget.Scheme != Uri.UriSchemeHttps))
                {
                    paragraph.Inlines.Add(new Run(match.Value));
                    index = match.Index + match.Length;
                    continue;
                }
                var link = new Hyperlink(new Run(match.Groups[1].Value))
                {
                    Foreground = Theme.Solid(Theme.Codex),
                    TextDecorations = null,
                    ToolTip = target
                };
                link.Click += delegate
                {
                    try { Process.Start(new ProcessStartInfo(safeTarget.AbsoluteUri) { UseShellExecute = true }); }
                    catch (Exception error) { footer.Text = "Не удалось открыть ссылку: " + error.Message; }
                };
                paragraph.Inlines.Add(link);
                index = match.Index + match.Length;
            }
            if (index < (text ?? "").Length) AppendInlineTokens(paragraph, text.Substring(index));
            if ((text ?? "").Length == 0) paragraph.Inlines.Add(new Run(" "));
        }

        private bool TryResolveWorkspaceFileLink(string target, out string file, out int line)
        {
            file = null;
            line = 0;
            string parsedFile;
            TaskItem selected;
            if (!WorkspaceFileLink.TryParse(target, out parsedFile, out line)
                || !tasks.TryGetValue(selectedKey ?? "", out selected)
                || String.IsNullOrWhiteSpace(selected.ProjectRoot)) return false;
            try
            {
                var candidate = Path.GetFullPath(parsedFile);
                var root = Path.GetFullPath(selected.ProjectRoot)
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                    + Path.DirectorySeparatorChar;
                if (!candidate.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(candidate)) return false;
                file = candidate;
                return true;
            }
            catch
            {
                return false;
            }
        }

        private void OpenWorkspaceFile(string file, int line)
        {
            var target = file + (line > 0 ? ":" + line : "");
            try
            {
                Process.Start(new ProcessStartInfo("code", "--goto \"" + target + "\"") { UseShellExecute = true });
            }
            catch
            {
                try
                {
                    Process.Start(new ProcessStartInfo("explorer.exe", "/select,\"" + file + "\"") { UseShellExecute = true });
                }
                catch (Exception error)
                {
                    footer.Text = "Не удалось открыть файл: " + error.Message;
                }
            }
        }

        private void AppendInlineTokens(Paragraph paragraph, string text)
        {
            var index = 0;
            while (index < text.Length)
            {
                var tick = text.IndexOf('`', index);
                var bold = text.IndexOf("**", index, StringComparison.Ordinal);
                var next = tick < 0 ? bold : bold < 0 ? tick : Math.Min(tick, bold);
                if (next < 0)
                {
                    paragraph.Inlines.Add(new Run(text.Substring(index)));
                    break;
                }
                if (next > index) paragraph.Inlines.Add(new Run(text.Substring(index, next - index)));
                if (next == tick)
                {
                    var end = text.IndexOf('`', tick + 1);
                    if (end < 0) { paragraph.Inlines.Add(new Run(text.Substring(tick))); break; }
                    paragraph.Inlines.Add(new Run(text.Substring(tick + 1, end - tick - 1))
                    {
                        FontFamily = new FontFamily("Cascadia Mono, Consolas"),
                        Background = Theme.Solid("#172332"),
                        Foreground = Theme.Solid(Theme.CodexMint)
                    });
                    index = end + 1;
                }
                else
                {
                    var end = text.IndexOf("**", bold + 2, StringComparison.Ordinal);
                    if (end < 0) { paragraph.Inlines.Add(new Run(text.Substring(bold))); break; }
                    paragraph.Inlines.Add(new Run(text.Substring(bold + 2, end - bold - 2)) { FontWeight = FontWeights.Bold });
                    index = end + 2;
                }
            }
        }

        private void RenderInspector(TaskItem item, Dictionary<string, object> snapshot)
        {
            inspector.Children.Clear();
            inspector.Children.Add(InspectorHero(item));
            var settings = AgentHubClient.Object(snapshot, "settings");
            var contextCompacting = AgentHubClient.Bool(item.Context, "compacting");
            inspector.Children.Add(InspectorSection("ИСПОЛНИТЕЛЬ",
                SettingChoice("Агент", "provider", AgentHubClient.Text(settings, "provider"), new[]
                {
                    Choice("codex", "Codex"),
                    Choice("claude", "Claude")
                }),
                SettingRow("Среда", String.IsNullOrWhiteSpace(item.Runtime) ? "Не запущен" : item.Runtime, Theme.Solid(Theme.Muted)),
                SettingRow("Состояние", item.Running ? "Выполняется" : "Готов", item.Running ? Theme.Solid(Theme.Good) : Theme.Solid(Theme.Muted))));

            inspector.Children.Add(InspectorSection("ПАРАМЕТРЫ",
                SettingChoice("Модель", "model", AgentHubClient.Text(settings, "model"), Choices(settings, "models"), !contextCompacting),
                SettingChoice("Мощь дум", "reasoning", AgentHubClient.Text(settings, "reasoning"), Choices(settings, "reasoningOptions"), !contextCompacting),
                SettingChoice("Режим", "mode", AgentHubClient.Text(settings, "mode"), Choices(settings, "modeOptions")),
                SettingChoice("Доступ", "approvalMode", AgentHubClient.Text(settings, "approvalMode"), new[]
                {
                    Choice("manual", "Ручной"),
                    Choice("auto", "Авто")
                })));

            if (String.Equals(item.Provider, "codex", StringComparison.OrdinalIgnoreCase))
            {
                inspector.Children.Add(ContextInspector(item));
            }

            var projects = Choices(settings, "projects", "path", "name");
            if (projects.Length > 1)
            {
                var selectedProject = projects.FirstOrDefault(delegate(ChoiceItem choice) { return samePath(choice.Value, item.ProjectRoot); });
                inspector.Children.Add(InspectorSection("ПРОЕКТ",
                    SettingChoice("Папка", "project", selectedProject == null ? item.ProjectRoot : selectedProject.Value, projects)));
            }

            var approvalCards = new List<UIElement>();
            foreach (var raw in AgentHubClient.Array(snapshot, "pendingApprovals"))
            {
                var approval = raw as Dictionary<string, object>;
                if (approval != null) approvalCards.Add(ApprovalCard(approval));
            }
            if (approvalCards.Count > 0) inspector.Children.Add(InspectorSection("ТРЕБУЕТСЯ РЕШЕНИЕ", approvalCards.ToArray()));

            var deferredCards = new List<UIElement>();
            foreach (var raw in AgentHubClient.Array(snapshot, "deferredInputs"))
            {
                var deferred = raw as Dictionary<string, object>;
                if (deferred != null) deferredCards.Add(DeferredInputCard(deferred));
            }
            if (deferredCards.Count > 0) inspector.Children.Add(InspectorSection("СОХРАНЁННЫЕ СООБЩЕНИЯ", deferredCards.ToArray()));

            var taskActions = new StackPanel();
            var rename = Theme.Button("Переименовать", "\uE70F", false);
            rename.HorizontalAlignment = HorizontalAlignment.Stretch;
            rename.Margin = new Thickness(0, 0, 0, 7);
            rename.Click += async delegate { await RenameAsync(); };
            var archive = Theme.Button("Архивировать", "\uE74D", false);
            archive.HorizontalAlignment = HorizontalAlignment.Stretch;
            archive.Click += async delegate { await ArchiveAsync(); };
            taskActions.Children.Add(rename);
            taskActions.Children.Add(archive);
            inspector.Children.Add(InspectorSection("ЗАДАЧА", taskActions));

            var utilities = new StackPanel();
            var status = Theme.Button("Статус и лимиты", "\uE9D9", false);
            var speak = Theme.Button("Озвучить ответ", "\uE767", false);
            var restart = Theme.Button("Перезапустить сервер", "\uE777", false);
            status.HorizontalAlignment = speak.HorizontalAlignment = restart.HorizontalAlignment = HorizontalAlignment.Stretch;
            status.Margin = speak.Margin = new Thickness(0, 0, 0, 7);
            status.Click += async delegate { await ShowStatusAsync(); };
            speak.Click += async delegate { await SpeakAsync(); };
            restart.Click += async delegate { await RestartServerAsync(); };
            utilities.Children.Add(status);
            utilities.Children.Add(speak);
            utilities.Children.Add(restart);
            inspector.Children.Add(InspectorSection("СЕРВЕР", utilities));
        }

        private UIElement ContextInspector(TaskItem item)
        {
            var context = item.Context ?? new Dictionary<string, object>();
            var compacting = AgentHubClient.Bool(context, "compacting");
            var cleaningImages = AgentHubClient.Text(
                AgentHubClient.Object(context, "compaction"),
                "stage",
                "") == "cleaning-images";
            var usagePending = AgentHubClient.Bool(context, "usagePending");
            var usedTokens = AgentHubClient.Text(context, "usedTokens", "0");
            var contextWindow = AgentHubClient.Text(context, "modelContextWindow", "");
            var percent = AgentHubClient.Text(context, "percent", "");
            double numericPercent;
            var hasPercent = Double.TryParse(percent, out numericPercent);
            var usage = String.IsNullOrWhiteSpace(contextWindow)
                ? "Данные ещё не получены"
                : usedTokens + " из " + contextWindow
                    + (hasPercent ? " (" + Math.Round(numericPercent) + "%)" : "");
            var state = compacting
                ? cleaningImages
                    ? "Свёртка создана. Удаляются дубликаты изображений…"
                    : "Выполняется свёртка…"
                : usagePending
                    ? "Ожидается обновлённый объём…"
                    : usage;
            var compact = Theme.Button(
                compacting ? cleaningImages ? "Очищается…" : "Сворачивается…" : "Свернуть контекст",
                "\uE72C",
                false);
            compact.HorizontalAlignment = HorizontalAlignment.Stretch;
            compact.IsEnabled = !item.Running && !compacting && !usagePending;
            compact.ToolTip = item.Running
                ? "Сначала завершите или остановите текущий ход"
                : compacting
                    ? "Свёртка контекста уже выполняется"
                    : usagePending
                        ? "Ожидается обновление объёма контекста"
                        : "Создать компактное резюме контекста Codex";
            compact.Click += async delegate { await CompactContextAsync(); };
            return InspectorSection("КОНТЕКСТ",
                SettingRow("Объём", state, compacting ? Theme.Solid(Theme.CodexMint) : Theme.Solid(Theme.Muted)),
                compact);
        }

        private UIElement ApprovalCard(Dictionary<string, object> approval)
        {
            var panel = new StackPanel();
            var text = Theme.Label(AgentHubClient.Text(approval, "text", "Требуется подтверждение"), 11, Theme.Solid(Theme.Text), FontWeights.Normal);
            text.MaxHeight = 120;
            panel.Children.Add(text);
            var actions = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 9, 0, 0) };
            var allow = Theme.Button("Разрешить", "", true);
            var deny = Theme.Button("Отклонить", "", false);
            allow.Padding = deny.Padding = new Thickness(8, 5, 8, 5);
            allow.FontSize = deny.FontSize = 10.5;
            allow.Margin = new Thickness(0, 0, 5, 0);
            var key = AgentHubClient.Text(approval, "key");
            allow.Click += async delegate { await ResolveApprovalAsync(key, "once"); };
            deny.Click += async delegate { await ResolveApprovalAsync(key, "decline"); };
            actions.Children.Add(allow);
            actions.Children.Add(deny);
            panel.Children.Add(actions);
            return new Border
            {
                Background = Theme.Solid("#2A2018"),
                BorderBrush = Theme.Solid(Theme.Claude),
                BorderThickness = new Thickness(1),
                CornerRadius = Theme.Radius(10),
                Padding = new Thickness(10),
                Margin = new Thickness(0, 0, 0, 8),
                Child = panel
            };
        }

        private UIElement DeferredInputCard(Dictionary<string, object> item)
        {
            var panel = new StackPanel();
            var state = AgentHubClient.Text(item, "state");
            panel.Children.Add(Theme.Label(state == "queued" ? "В очереди" : "Ожидает решения", 10, Theme.Solid(Theme.Claude), FontWeights.Bold));
            var preview = Theme.Label(TrimPreview(AgentHubClient.Text(item, "preview"), 220), 11, Theme.Solid(Theme.Text), FontWeights.Normal);
            preview.Margin = new Thickness(0, 5, 0, 8);
            panel.Children.Add(preview);
            var id = AgentHubClient.Text(item, "id");
            var buttons = new WrapPanel();
            if (state != "queued")
            {
                buttons.Children.Add(SmallAction("Новая", async delegate { await ResolveDeferredAsync(id, "new"); }));
                buttons.Children.Add(SmallAction("В очередь", async delegate { await ResolveDeferredAsync(id, "queue"); }));
                if (AgentHubClient.Bool(item, "allowForce"))
                    buttons.Children.Add(SmallAction("Всё равно", async delegate { await ResolveDeferredAsync(id, "force"); }));
            }
            buttons.Children.Add(SmallAction("Отменить", async delegate { await ResolveDeferredAsync(id, "cancel"); }));
            panel.Children.Add(buttons);
            return new Border
            {
                Background = Theme.Solid("#201B18"),
                BorderBrush = Theme.Solid("#59412D"),
                BorderThickness = new Thickness(1),
                CornerRadius = Theme.Radius(10),
                Padding = new Thickness(10),
                Margin = new Thickness(0, 0, 0, 8),
                Child = panel
            };
        }

        private Button SmallAction(string text, Func<Task> action)
        {
            var button = Theme.Button(text, "", false);
            button.Padding = new Thickness(7, 4, 7, 4);
            button.FontSize = 10;
            button.Margin = new Thickness(0, 0, 4, 4);
            button.Click += async delegate { await action(); };
            return button;
        }

        private async Task ResolveApprovalAsync(string key, string decision)
        {
            try
            {
                await client.CallAsync("resolve-approval", new Dictionary<string, object>
                {
                    { "key", key },
                    { "decision", decision }
                });
                footer.Text = decision == "decline" ? "Запрос отклонён" : "Запрос разрешён";
                await RefreshAsync(false);
            }
            catch (Exception error) { footer.Text = error.Message; }
        }

        private async Task ResolveDeferredAsync(string id, string action)
        {
            try
            {
                var result = await client.CallAsync("deferred-input", new Dictionary<string, object>
                {
                    { "id", id },
                    { "action", action }
                });
                footer.Text = AgentHubClient.Text(result, "message", "Сообщение обработано");
                await RefreshAsync(true);
            }
            catch (Exception error) { footer.Text = error.Message; }
        }

        private UIElement InspectorHero(TaskItem item)
        {
            var panel = new StackPanel();
            var badge = new Border
            {
                Background = Theme.ProviderGradient(item.Provider),
                CornerRadius = Theme.Radius(9),
                Padding = new Thickness(9, 5, 9, 5),
                HorizontalAlignment = HorizontalAlignment.Left,
                Child = Theme.Label(ProviderName(item.Provider).ToUpperInvariant(), 10, Theme.Solid(Theme.Ink), FontWeights.Bold)
            };
            panel.Children.Add(badge);
            var title = Theme.Label(item.Title, 15, Theme.Solid(Theme.Text), FontWeights.SemiBold);
            title.Margin = new Thickness(0, 10, 0, 4);
            panel.Children.Add(title);
            var project = Theme.Label(item.ProjectName, 11, Theme.Solid(Theme.Muted), FontWeights.Normal);
            panel.Children.Add(project);
            var shell = new Border
            {
                Background = Theme.Solid(Theme.PanelRaised),
                BorderBrush = Theme.Solid(Theme.Border),
                BorderThickness = new Thickness(1),
                CornerRadius = Theme.Radius(12),
                Padding = new Thickness(13),
                Margin = new Thickness(0, 0, 0, 14),
                Child = panel
            };
            return shell;
        }

        private UIElement InspectorSection(string title, params UIElement[] children)
        {
            var panel = new StackPanel { Margin = new Thickness(2, 4, 2, 16) };
            var heading = Theme.Label(title, 10, Theme.Solid(Theme.Dim), FontWeights.Bold);
            heading.Margin = new Thickness(2, 0, 2, 7);
            panel.Children.Add(heading);
            foreach (var child in children) panel.Children.Add(child);
            return panel;
        }

        private UIElement SettingRow(string label, string value, Brush valueBrush)
        {
            var grid = new Grid { Margin = new Thickness(2, 5, 2, 5) };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(82) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.Children.Add(Theme.Label(label, 11, Theme.Solid(Theme.Muted), FontWeights.Normal));
            var text = Theme.Label(value, 11, valueBrush, FontWeights.SemiBold);
            text.TextAlignment = TextAlignment.Right;
            Grid.SetColumn(text, 1);
            grid.Children.Add(text);
            return grid;
        }

        private UIElement SettingChoice(string label, string setting, string current, ChoiceItem[] choices, bool enabled = true)
        {
            var panel = new StackPanel { Margin = new Thickness(2, 5, 2, 7) };
            var title = Theme.Label(label, 10.5, Theme.Solid(Theme.Muted), FontWeights.Normal);
            title.Margin = new Thickness(2, 0, 2, 4);
            panel.Children.Add(title);
            var selected = choices.FirstOrDefault(delegate(ChoiceItem choice) { return choice.Value == current; });
            var button = Theme.Button("", "", false);
            var buttonGrid = new Grid();
            buttonGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            buttonGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var value = Theme.Label(selected == null ? current : selected.Label, 11.5, Theme.Solid(Theme.Text), FontWeights.SemiBold);
            value.TextTrimming = TextTrimming.CharacterEllipsis;
            buttonGrid.Children.Add(value);
            var chevron = new TextBlock
            {
                Text = "\uE70D",
                FontFamily = new FontFamily("Segoe Fluent Icons"),
                Foreground = Theme.Solid(Theme.Muted),
                FontSize = 10,
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(chevron, 1);
            buttonGrid.Children.Add(chevron);
            button.Content = buttonGrid;
            button.IsEnabled = enabled;
            if (!enabled) button.ToolTip = "Недоступно во время свёртки контекста";
            button.HorizontalContentAlignment = HorizontalAlignment.Stretch;
            button.HorizontalAlignment = HorizontalAlignment.Stretch;
            button.Click += delegate
            {
                var menu = new ContextMenu
                {
                    Background = Theme.Solid(Theme.PanelRaised),
                    Foreground = Theme.Solid(Theme.Text),
                    PlacementTarget = button
                };
                foreach (var choice in choices)
                {
                    var captured = choice;
                    var menuItem = new MenuItem
                    {
                        Header = (captured.Value == current ? "✓  " : "    ") + captured.Label,
                        Foreground = Theme.Solid(Theme.Text),
                        Background = Theme.Solid(Theme.PanelRaised)
                    };
                    menuItem.Click += async delegate { await UpdateSettingAsync(setting, captured.Value); };
                    menu.Items.Add(menuItem);
                }
                menu.IsOpen = true;
            };
            panel.Children.Add(button);
            return panel;
        }

        private async Task UpdateSettingAsync(string name, string value)
        {
            try
            {
                footer.Text = "Обновляю настройку…";
                var snapshot = await client.CallAsync("update-setting", new Dictionary<string, object>
                {
                    { "name", name },
                    { "value", value }
                });
                ApplySnapshot(snapshot);
                footer.Text = "Настройка применена";
            }
            catch (Exception error) { footer.Text = error.Message; }
        }

        private static ChoiceItem Choice(string value, string label) { return new ChoiceItem { Value = value, Label = label }; }

        private static ChoiceItem[] Choices(Dictionary<string, object> source, string key, string valueKey = "value", string labelKey = "label")
        {
            var result = new List<ChoiceItem>();
            foreach (var raw in AgentHubClient.Array(source, key))
            {
                var item = raw as Dictionary<string, object>;
                if (item == null) continue;
                result.Add(Choice(AgentHubClient.Text(item, valueKey), AgentHubClient.Text(item, labelKey)));
            }
            return result.ToArray();
        }

        private static bool samePath(string left, string right)
        {
            return String.Equals(Path.GetFullPath(left ?? "").TrimEnd('\\', '/'), Path.GetFullPath(right ?? "").TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase);
        }

        private void AddAnnotation(string selectedText)
        {
            if (String.IsNullOrWhiteSpace(selectedText)) return;
            var item = new AnnotationDraft { Text = selectedText, Annotation = "" };
            annotations.Add(item);
            RenderAnnotations();
            ScheduleDraftSave();
            composer.Focus();
            footer.Text = "Цитата добавлена · всего " + annotations.Count;
        }

        private void RenderAnnotations()
        {
            annotationPanel.Children.Clear();
            if (annotations.Count > 0)
            {
                var heading = Theme.Label("ЦИТАТЫ К СООБЩЕНИЮ · " + annotations.Count, 10, Theme.Solid(Theme.CodexMint), FontWeights.Bold);
                heading.Margin = new Thickness(2, 0, 0, 6);
                annotationPanel.Children.Add(heading);
            }
            var annotationIndex = 0;
            foreach (var item in annotations.ToArray())
            {
                annotationIndex += 1;
                var shell = new Border
                {
                    Background = Theme.Solid("#192331"),
                    BorderBrush = Theme.Solid("#35465A"),
                    BorderThickness = new Thickness(1),
                    CornerRadius = Theme.Radius(9),
                    Margin = new Thickness(0, 0, 0, 5),
                    Padding = new Thickness(9, 7, 7, 7)
                };
                var grid = new Grid();
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                var annotationBody = new StackPanel();
                var number = Theme.Label("ЦИТАТА " + annotationIndex, 9.5, Theme.Solid(Theme.CodexMint), FontWeights.Bold);
                number.Margin = new Thickness(0, 0, 0, 4);
                annotationBody.Children.Add(number);
                var quote = Theme.Label("“" + TrimPreview(item.Text, 360) + "”", 11.5, Theme.Solid(Theme.Muted), FontWeights.Normal);
                quote.Margin = new Thickness(0, 0, 8, 6);
                annotationBody.Children.Add(quote);
                annotationBody.Children.Add(Theme.Label("Комментарий (необязательно)", 9.5, Theme.Solid(Theme.Dim), FontWeights.Normal));
                var remove = IconButton("\uE711", "Удалить аннотацию");
                remove.Width = 28;
                remove.Height = 26;
                remove.Click += delegate { annotations.Remove(item); RenderAnnotations(); ScheduleDraftSave(); };
                Grid.SetColumn(remove, 1);
                grid.Children.Add(remove);
                var comment = new TextBox
                {
                    Text = item.Annotation ?? "",
                    ToolTip = "Комментарий к выделенному фрагменту",
                    Background = Brushes.Transparent,
                    Foreground = Theme.Solid(Theme.Text),
                    CaretBrush = Theme.Solid(Theme.Codex),
                    BorderThickness = new Thickness(0),
                    FontSize = 12,
                    Padding = new Thickness(0, 3, 0, 2),
                    MinHeight = 27
                };
                comment.TextChanged += delegate { item.Annotation = comment.Text; ScheduleDraftSave(); };
                annotationBody.Children.Add(comment);
                grid.Children.Add(annotationBody);
                shell.Child = grid;
                annotationPanel.Children.Add(shell);
            }
        }

        private void ComposerPreviewKeyDown(object sender, KeyEventArgs args)
        {
            if (args.Key == System.Windows.Input.Key.Enter && Keyboard.Modifiers.HasFlag(ModifierKeys.Control))
            {
                args.Handled = true;
                BeginSend();
                return;
            }
            if (args.Key == System.Windows.Input.Key.V && Keyboard.Modifiers.HasFlag(ModifierKeys.Control) && Clipboard.ContainsImage())
            {
                args.Handled = true;
                try
                {
                    Directory.CreateDirectory(attachmentRoot);
                    var path = Path.Combine(attachmentRoot, Guid.NewGuid().ToString("N") + ".png");
                    var encoder = new PngBitmapEncoder();
                    encoder.Frames.Add(BitmapFrame.Create(Clipboard.GetImage()));
                    using (var stream = File.Create(path)) encoder.Save(stream);
                    AddAttachment(path);
                }
                catch (Exception error) { footer.Text = "Скриншот: " + error.Message; }
            }
        }

        private void ComposerDrop(object sender, DragEventArgs args)
        {
            if (!args.Data.GetDataPresent(DataFormats.FileDrop)) return;
            var files = args.Data.GetData(DataFormats.FileDrop) as string[];
            if (files == null) return;
            foreach (var file in files.Where(IsImageFile).Take(8 - attachments.Count)) AddAttachment(file);
            args.Handled = true;
        }

        private void AddImageFromFileDialog()
        {
            var dialog = new Microsoft.Win32.OpenFileDialog
            {
                Multiselect = true,
                Filter = "Изображения|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp"
            };
            if (dialog.ShowDialog(this) != true) return;
            foreach (var file in dialog.FileNames.Take(8 - attachments.Count)) AddAttachment(file);
        }

        private void AddAttachment(string source)
        {
            try
            {
                if (!File.Exists(source) || !IsImageFile(source)) return;
                Directory.CreateDirectory(attachmentRoot);
                var fullSource = Path.GetFullPath(source);
                var fullRoot = Path.GetFullPath(attachmentRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                var target = fullSource.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase)
                    ? fullSource
                    : Path.Combine(attachmentRoot, Guid.NewGuid().ToString("N") + Path.GetExtension(source).ToLowerInvariant());
                if (!String.Equals(fullSource, target, StringComparison.OrdinalIgnoreCase)) File.Copy(fullSource, target, false);
                if (!attachments.Contains(target, StringComparer.OrdinalIgnoreCase)) attachments.Add(target);
                RenderAttachments();
                ScheduleDraftSave();
                footer.Text = "Изображение добавлено";
            }
            catch (Exception error) { footer.Text = "Изображение: " + error.Message; }
        }

        private void RenderAttachments()
        {
            attachmentPanel.Children.Clear();
            foreach (var path in attachments.ToArray())
            {
                if (!File.Exists(path)) { attachments.Remove(path); continue; }
                var grid = new Grid { Width = 86, Height = 58, Margin = new Thickness(0, 0, 7, 0) };
                var image = new Image { Stretch = Stretch.UniformToFill };
                try
                {
                    var bitmap = new BitmapImage();
                    bitmap.BeginInit();
                    bitmap.CacheOption = BitmapCacheOption.OnLoad;
                    bitmap.UriSource = new Uri(path);
                    bitmap.DecodePixelWidth = 180;
                    bitmap.EndInit();
                    bitmap.Freeze();
                    image.Source = bitmap;
                }
                catch { }
                var shell = new Border
                {
                    Background = Theme.Solid(Theme.PanelRaised),
                    BorderBrush = Theme.Solid(Theme.Border),
                    BorderThickness = new Thickness(1),
                    CornerRadius = Theme.Radius(8),
                    ClipToBounds = true,
                    Child = image
                };
                grid.Children.Add(shell);
                var remove = new Button
                {
                    Content = "×",
                    Width = 20,
                    Height = 20,
                    HorizontalAlignment = HorizontalAlignment.Right,
                    VerticalAlignment = VerticalAlignment.Top,
                    Margin = new Thickness(0, 3, 3, 0),
                    Background = Theme.Solid("#CC111820"),
                    Foreground = Theme.Solid(Theme.Text),
                    BorderThickness = new Thickness(0),
                    Cursor = Cursors.Hand
                };
                remove.Click += delegate { attachments.Remove(path); RenderAttachments(); ScheduleDraftSave(); };
                grid.Children.Add(remove);
                attachmentPanel.Children.Add(grid);
            }
        }

        private async Task SendAsync()
        {
            var text = (composer.Text ?? "").Trim();
            if (text.Length == 0 && attachments.Count == 0 && annotations.Count == 0) return;
            if (attachments.Count > 0 && desktopApiVersion < 2)
            {
                footer.Text = "Agent Hub Server устарел: изображения сохранены, дождитесь его обновления.";
                return;
            }
            if (annotations.Count > 0) text = AnnotatedPrompt(text);
            var sendingAttachments = attachments.ToArray();
            var sendingFingerprint = DesktopMessageIdentity.PayloadFingerprint(text, sendingAttachments);
            var sendingMessageId = DesktopMessageIdentity.Ensure(
                ref currentClientUserMessageId,
                ref currentClientUserMessageFingerprint,
                sendingFingerprint);
            SaveDraft();
            sendButton.IsEnabled = false;
            try
            {
                footer.Text = "Отправляю…";
                var parameters = SelectedTaskParameters();
                parameters["text"] = text;
                parameters["clientUserMessageId"] = sendingMessageId;
                if (sendingAttachments.Length > 0) parameters["attachments"] = sendingAttachments;
                var result = await client.CallAsync("send-message", parameters, true);
                var accepted = AgentHubClient.Bool(result, "accepted");
                var deferred = AgentHubClient.Bool(result, "deferred");
                if (!accepted && !deferred)
                {
                    footer.Text = AgentHubClient.Text(result, "message", "Сообщение сохранено");
                    var deferredSnapshot = AgentHubClient.Object(result, "snapshot");
                    if (deferredSnapshot.Count > 0) ApplySnapshot(deferredSnapshot);
                    return;
                }
                var snapshot = AgentHubClient.Object(result, "snapshot");
                if (snapshot.Count > 0) ApplySnapshot(snapshot);
                if (String.Equals(currentClientUserMessageId, sendingMessageId, StringComparison.Ordinal)
                    && String.Equals(
                        currentClientUserMessageFingerprint,
                        sendingFingerprint,
                        StringComparison.Ordinal))
                {
                    ClearAcknowledgedDraft();
                }
                historyKey = null;
                footer.Text = AgentHubClient.Text(
                    result,
                    "message",
                    accepted ? "Ход запущен" : "Сообщение сохранено");
                await RefreshAsync(false);
            }
            catch (Exception error) { footer.Text = error.Message; }
            finally { sendButton.IsEnabled = true; }
        }

        private Dictionary<string, object> SelectedTaskParameters()
        {
            TaskItem item;
            if (String.IsNullOrWhiteSpace(selectedKey) || !tasks.TryGetValue(selectedKey, out item))
            {
                throw new InvalidOperationException("Сначала выберите задачу");
            }
            return new Dictionary<string, object>
            {
                { "provider", item.Provider },
                { "threadId", item.ThreadId }
            };
        }

        private async void BeginSend() { await SendAsync(); }

        private void ClearAcknowledgedDraft()
        {
            restoringDraft = true;
            try
            {
                composer.Clear();
                annotations.Clear();
                attachments.Clear();
                currentClientUserMessageId = null;
                currentClientUserMessageFingerprint = null;
                RenderAnnotations();
                RenderAttachments();
            }
            finally { restoringDraft = false; }
            SaveDraft();
        }

        private string AnnotatedPrompt(string request)
        {
            var payload = annotations.Select(delegate(AnnotationDraft item)
            {
                return new Dictionary<string, string>
                {
                    { "text", item.Text ?? "" },
                    { "annotation", item.Annotation ?? "" }
                };
            }).ToArray();
            return "# Response annotations:\nEach item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. When addressing multiple comments, label each answer with its annotation number (for example, `Annotation 1`) so the user can match it to the numbered annotation.\n<response-annotations>\n"
                + json.Serialize(payload)
                + "\n</response-annotations>\n\n## My request for Codex:\n"
                + request;
        }

        private void ScheduleDraftSave()
        {
            if (restoringDraft) return;
            currentClientUserMessageId = null;
            currentClientUserMessageFingerprint = null;
            draftTimer.Stop();
            draftTimer.Start();
        }

        private void LoadDrafts()
        {
            try
            {
                if (File.Exists(draftFile))
                {
                    var values = json.Deserialize<Dictionary<string, DesktopDraft>>(File.ReadAllText(draftFile, Encoding.UTF8));
                    if (values != null) foreach (var item in values) drafts[item.Key] = item.Value ?? new DesktopDraft();
                    return;
                }
                var legacy = Path.Combine(desktopRoot, "drafts.json");
                if (!File.Exists(legacy)) return;
                var oldValues = json.Deserialize<Dictionary<string, string>>(File.ReadAllText(legacy, Encoding.UTF8));
                if (oldValues == null) return;
                foreach (var item in oldValues) drafts[item.Key] = new DesktopDraft { Text = item.Value ?? "" };
            }
            catch { }
        }

        private void SaveDraft()
        {
            if (String.IsNullOrWhiteSpace(selectedKey)) return;
            var draft = new DesktopDraft
            {
                Text = composer.Text ?? "",
                Annotations = annotations.Select(delegate(AnnotationDraft item)
                {
                    return new AnnotationDraft { Text = item.Text, Annotation = item.Annotation };
                }).ToList(),
                Attachments = attachments.Where(File.Exists).ToList(),
                ClientUserMessageId = currentClientUserMessageId ?? "",
                ClientUserMessageFingerprint = currentClientUserMessageFingerprint ?? ""
            };
            if (draft.Text.Length == 0 && draft.Annotations.Count == 0 && draft.Attachments.Count == 0) drafts.Remove(selectedKey);
            else drafts[selectedKey] = draft;
            try
            {
                Directory.CreateDirectory(desktopRoot);
                var temporary = draftFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
                File.WriteAllText(temporary, json.Serialize(drafts), new UTF8Encoding(false));
                if (File.Exists(draftFile))
                {
                    try { File.Replace(temporary, draftFile, null); }
                    catch { File.Copy(temporary, draftFile, true); File.Delete(temporary); }
                }
                else File.Move(temporary, draftFile);
            }
            catch (Exception error) { footer.Text = "Черновик: " + error.Message; }
        }

        private void RestoreDraft()
        {
            DesktopDraft draft;
            restoringDraft = true;
            try
            {
                annotations.Clear();
                attachments.Clear();
                if (!drafts.TryGetValue(selectedKey, out draft)) draft = new DesktopDraft();
                composer.Text = draft.Text ?? "";
                annotations.AddRange(draft.Annotations ?? new List<AnnotationDraft>());
                attachments.AddRange((draft.Attachments ?? new List<string>()).Where(File.Exists));
                currentClientUserMessageId = draft.ClientUserMessageId;
                currentClientUserMessageFingerprint = draft.ClientUserMessageFingerprint;
                composer.CaretIndex = composer.Text.Length;
                RenderAnnotations();
                RenderAttachments();
            }
            finally { restoringDraft = false; }
        }

        private void ShowNewTaskMenu(Button anchor)
        {
            var menu = new ContextMenu { Background = Theme.Solid(Theme.PanelRaised), Foreground = Theme.Solid(Theme.Text) };
            var codex = new MenuItem { Header = "Новая задача Codex" };
            var claude = new MenuItem { Header = "Новая задача Claude" };
            codex.Click += async delegate { await NewTaskAsync("codex"); };
            claude.Click += async delegate { await NewTaskAsync("claude"); };
            menu.Items.Add(codex);
            menu.Items.Add(claude);
            menu.PlacementTarget = anchor;
            menu.IsOpen = true;
        }

        private async Task NewTaskAsync(string provider)
        {
            SaveDraft();
            try
            {
                footer.Text = "Создаю задачу…";
                var snapshot = await client.CallAsync("new-task", new Dictionary<string, object> { { "provider", provider } });
                ApplySnapshot(snapshot);
                footer.Text = "Новая задача создана";
            }
            catch (Exception error) { footer.Text = error.Message; }
        }

        private async Task ShowDiffAsync()
        {
            try
            {
                var result = await client.CallAsync("task-diff", SelectedTaskParameters());
                var text = AgentHubClient.Text(result, "text", "В выбранной задаче изменений файлов нет.");
                ShowTextDialog("Изменения задачи", String.IsNullOrWhiteSpace(text) ? "В выбранной задаче изменений файлов нет." : text);
            }
            catch (Exception error) { footer.Text = error.Message; }
        }

        private async Task CancelAsync()
        {
            try
            {
                var result = await client.CallAsync("cancel-run", SelectedTaskParameters());
                footer.Text = AgentHubClient.Text(result, "message", "Остановка запрошена");
            }
            catch (Exception error) { footer.Text = error.Message; }
        }

        private async Task CompactContextAsync()
        {
            try
            {
                footer.Text = "Сворачиваю контекст…";
                var result = await client.CallAsync("compact-context", SelectedTaskParameters());
                footer.Text = AgentHubClient.Text(result, "message", "Свёртка контекста запущена");
                await RefreshAsync(false);
            }
            catch (Exception error) { footer.Text = error.Message; }
        }

        private async Task RenameAsync()
        {
            TaskItem item;
            if (!tasks.TryGetValue(selectedKey ?? "", out item)) return;
            var title = PromptDialog.Show(this, "Название задачи", "Новое постоянное название", item.Title);
            if (title == null) return;
            try
            {
                var parameters = SelectedTaskParameters();
                parameters["title"] = title;
                var snapshot = await client.CallAsync("rename-task", parameters);
                ApplySnapshot(snapshot);
                footer.Text = "Название закреплено";
            }
            catch (Exception error) { footer.Text = error.Message; }
        }

        private async Task ArchiveAsync()
        {
            TaskItem item;
            if (!tasks.TryGetValue(selectedKey ?? "", out item)) return;
            if (MessageBox.Show(this, "Архивировать задачу «" + item.Title + "»?", "Agent Hub",
                MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
            try
            {
                var snapshot = await client.CallAsync("archive-task", SelectedTaskParameters());
                ApplySnapshot(snapshot);
                footer.Text = "Задача архивирована";
            }
            catch (Exception error) { footer.Text = error.Message; }
        }

        private async Task ShowStatusAsync()
        {
            try
            {
                footer.Text = "Получаю лимиты…";
                var status = await client.CallAsync("status-details", new Dictionary<string, object>());
                var text = AgentHubClient.Text(status, "provider").ToUpperInvariant()
                    + "\nМодель: " + AgentHubClient.Text(status, "model")
                    + "\nМощь дум: " + AgentHubClient.Text(status, "reasoning")
                    + "\nРежим: " + AgentHubClient.Text(status, "mode")
                    + "\nАктивных ходов: " + AgentHubClient.Text(status, "activeCount", "0")
                    + "\nФоновых заданий: " + AgentHubClient.Text(status, "backgroundJobs", "0")
                    + "\n\nЛимиты:\n" + AgentHubClient.Text(status, "limits", "Нет данных");
                ShowTextDialog("Статус Agent Hub Server", text);
                footer.Text = "Статус обновлён";
            }
            catch (Exception error) { footer.Text = error.Message; }
        }

        private async Task SpeakAsync()
        {
            try
            {
                var result = await client.CallAsync("speak-last-answer", SelectedTaskParameters());
                footer.Text = AgentHubClient.Text(result, "message", "Озвучивание запущено");
            }
            catch (Exception error) { footer.Text = error.Message; }
        }

        private async Task RestartServerAsync()
        {
            if (MessageBox.Show(this, "Перезапустить Agent Hub Server после безопасного завершения активных ходов?",
                "Agent Hub", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
            try
            {
                var result = await client.CallAsync("restart-server", new Dictionary<string, object>());
                footer.Text = AgentHubClient.Text(result, "message", "Перезапуск запрошен");
            }
            catch (Exception error)
            {
                footer.Text = error.Message.IndexOf("закрыл соединение", StringComparison.OrdinalIgnoreCase) >= 0
                    ? "Agent Hub Server перезапускается…"
                    : error.Message;
            }
        }

        private void ShowTextDialog(string title, string text)
        {
            var window = new Window
            {
                Title = title,
                Owner = this,
                Width = 980,
                Height = 720,
                MinWidth = 680,
                MinHeight = 460,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Background = Theme.Solid(Theme.Ink),
                Foreground = Theme.Solid(Theme.Text),
                FontFamily = FontFamily
            };
            var box = new TextBox
            {
                Text = text,
                IsReadOnly = true,
                AcceptsReturn = true,
                AcceptsTab = true,
                TextWrapping = TextWrapping.NoWrap,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
                Background = Theme.Solid(Theme.Panel),
                Foreground = Theme.Solid(Theme.Text),
                BorderBrush = Theme.Solid(Theme.Border),
                Padding = new Thickness(16),
                FontFamily = new FontFamily("Cascadia Mono, Consolas"),
                FontSize = 12.5,
                Margin = new Thickness(16)
            };
            window.Content = box;
            window.ShowDialog();
        }

        private static string Key(string provider, string threadId) { return provider + "\0" + threadId; }
        private static string ProviderName(string provider) { return provider == "claude" ? "Claude" : "Codex"; }
        private static string ShortRuntime(string value)
        {
            if (value.StartsWith("VSCode", StringComparison.OrdinalIgnoreCase)) return "VSC";
            if (value.StartsWith("Agent Hub", StringComparison.OrdinalIgnoreCase)) return "HUB";
            if (value.StartsWith("Codex Desktop", StringComparison.OrdinalIgnoreCase)) return "APP";
            return value;
        }
        private static bool IsImageFile(string path)
        {
            var extension = Path.GetExtension(path ?? "").ToLowerInvariant();
            return extension == ".png" || extension == ".jpg" || extension == ".jpeg"
                || extension == ".webp" || extension == ".gif" || extension == ".bmp";
        }
        private static string TrimPreview(string value, int limit)
        {
            value = (value ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
            return value.Length <= limit ? value : value.Substring(0, limit - 1) + "…";
        }
    }
}
