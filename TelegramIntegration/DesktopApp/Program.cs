using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace TyraelIntegrationDesktop
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            var application = new Application();
            application.ShutdownMode = ShutdownMode.OnMainWindowClose;
            application.Run(new MainWindow());
        }
    }

    internal sealed class IntegrationClient
    {
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
        private readonly string runtimeRoot;
        private readonly string pipeName;
        private readonly string secretFile;

        public IntegrationClient()
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            runtimeRoot = Path.GetFullPath(Path.Combine(local, "Tyrael", "TelegramIntegration"));
            secretFile = Path.Combine(runtimeRoot, "desktop-control.secret");
            pipeName = "tyrael-integration-desktop-" + ControlId(runtimeRoot);
        }

        private static string ControlId(string value)
        {
            using (var sha = SHA256.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(value).ToLowerInvariant()));
                var result = new StringBuilder();
                for (var i = 0; i < 12; i++) result.Append(bytes[i].ToString("x2"));
                return result.ToString();
            }
        }

        public async Task<Dictionary<string, object>> CallAsync(string action, Dictionary<string, object> parameters)
        {
            if (!File.Exists(secretFile)) throw new InvalidOperationException("Integration Server ещё не опубликовал desktop-интерфейс.");
            var secret = File.ReadAllText(secretFile, Encoding.UTF8).Trim();
            var request = json.Serialize(new Dictionary<string, object>
            {
                { "secret", secret },
                { "action", action },
                { "params", parameters ?? new Dictionary<string, object>() }
            });
            using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
            {
                await Task.Run(delegate { pipe.Connect(3000); });
                using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true })
                using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, true))
                {
                    await writer.WriteLineAsync(request);
                    var line = await reader.ReadLineAsync();
                    if (String.IsNullOrWhiteSpace(line)) throw new IOException("Integration Server закрыл соединение без ответа.");
                    var response = json.Deserialize<Dictionary<string, object>>(line);
                    if (!Bool(response, "ok")) throw new InvalidOperationException(Text(response, "error", "Неизвестная ошибка Integration Server"));
                    return Object(response, "result");
                }
            }
        }

        public static string Text(IDictionary<string, object> value, string key, string fallback = "")
        {
            object item;
            return value != null && value.TryGetValue(key, out item) && item != null ? Convert.ToString(item) : fallback;
        }

        public static bool Bool(IDictionary<string, object> value, string key)
        {
            object item;
            return value != null && value.TryGetValue(key, out item) && item != null && Convert.ToBoolean(item);
        }

        public static Dictionary<string, object> Object(IDictionary<string, object> value, string key)
        {
            object item;
            if (value != null && value.TryGetValue(key, out item))
            {
                var dictionary = item as Dictionary<string, object>;
                if (dictionary != null) return dictionary;
            }
            return new Dictionary<string, object>();
        }

        public static object[] Array(IDictionary<string, object> value, string key)
        {
            object item;
            if (value != null && value.TryGetValue(key, out item))
            {
                var array = item as object[];
                if (array != null) return array;
                var list = item as ArrayList;
                if (list != null) return list.ToArray();
            }
            return new object[0];
        }
    }

    internal sealed class TaskItem
    {
        public string Provider;
        public string ThreadId;
        public string ProjectRoot;
        public string Title;
        public string ProjectName;
        public bool Selected;
        public bool Running;
        public string Runtime;
        public string LastAnswer;
        public Dictionary<string, object> Run;

        public override string ToString()
        {
            var state = Running ? "●" : "○";
            var provider = Provider == "claude" ? "Claude" : "Codex";
            var runtime = String.IsNullOrWhiteSpace(Runtime) ? "" : " · " + Runtime;
            return state + "  " + Title + Environment.NewLine + "     " + provider + runtime;
        }
    }

    internal sealed class MainWindow : Window
    {
        private static readonly Brush BackgroundBrush = Brush("#0A111B");
        private static readonly Brush PanelBrush = Brush("#111D2A");
        private static readonly Brush PanelAltBrush = Brush("#172637");
        private static readonly Brush TextBrush = Brush("#E7F0FA");
        private static readonly Brush MutedBrush = Brush("#8EA4BA");
        private static readonly Brush AccentBrush = Brush("#39D7C2");
        private static readonly Brush RunningBrush = Brush("#42E58D");
        private static readonly Brush BorderLineBrush = Brush("#26394C");

        private readonly IntegrationClient client = new IntegrationClient();
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly DispatcherTimer timer;
        private readonly DispatcherTimer draftTimer;
        private readonly ListBox taskList = new ListBox();
        private readonly TextBlock connectionText = new TextBlock();
        private readonly TextBlock taskTitle = new TextBlock();
        private readonly TextBlock taskMeta = new TextBlock();
        private readonly TextBox output = new TextBox();
        private readonly TextBox input = new TextBox();
        private readonly Button sendButton = new Button();
        private readonly Button historyButton = new Button();
        private readonly TextBlock footer = new TextBlock();
        private readonly Dictionary<string, TaskItem> tasks = new Dictionary<string, TaskItem>();
        private readonly Dictionary<string, string> drafts = new Dictionary<string, string>();
        private readonly List<Dictionary<string, object>> historyItems = new List<Dictionary<string, object>>();
        private readonly string draftFile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Tyrael", "TelegramIntegration", "DesktopApp", "drafts.json");
        private bool refreshRunning;
        private bool historyLoading;
        private bool selectionInternal;
        private bool restoringDraft;
        private string selectedKey;
        private string historyKey;
        private int? historyBefore;
        private bool? selectedWasRunning;

        public MainWindow()
        {
            Title = "Tyrael Integration";
            Width = 1180;
            Height = 760;
            MinWidth = 900;
            MinHeight = 580;
            Background = BackgroundBrush;
            Foreground = TextBrush;
            FontFamily = new FontFamily("Segoe UI");
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Content = BuildLayout();
            LoadDrafts();

            timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            timer.Tick += async delegate { await RefreshAsync(false); };
            draftTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(600) };
            draftTimer.Tick += delegate
            {
                draftTimer.Stop();
                SaveCurrentDraft();
            };
            Loaded += async delegate
            {
                timer.Start();
                await RefreshAsync(true);
            };
            Closed += delegate
            {
                timer.Stop();
                draftTimer.Stop();
                SaveCurrentDraft();
            };
            taskList.SelectionChanged += async delegate { await SelectTaskAsync(); };
            sendButton.Click += async delegate { await SendAsync(); };
            historyButton.Click += async delegate { await LoadHistoryAsync(true); };
            input.TextChanged += delegate
            {
                if (restoringDraft) return;
                draftTimer.Stop();
                draftTimer.Start();
            };
            input.PreviewKeyDown += async delegate(object sender, KeyEventArgs args)
            {
                if (args.Key == System.Windows.Input.Key.Enter && Keyboard.Modifiers.HasFlag(ModifierKeys.Control))
                {
                    args.Handled = true;
                    await SendAsync();
                }
            };
        }

        private UIElement BuildLayout()
        {
            var root = new Grid();
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(70) });
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(340) });
            root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var header = new Border { Background = PanelBrush, BorderBrush = BorderLineBrush, BorderThickness = new Thickness(0, 0, 0, 1) };
            Grid.SetColumnSpan(header, 2);
            var headerGrid = new Grid { Margin = new Thickness(22, 10, 22, 10) };
            headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            headerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var brand = new StackPanel();
            brand.Children.Add(new TextBlock { Text = "TYRAEL INTEGRATION", FontSize = 19, FontWeight = FontWeights.SemiBold, Foreground = TextBrush });
            brand.Children.Add(new TextBlock { Text = "Telegram и Windows · один Integration Server", FontSize = 12, Foreground = MutedBrush, Margin = new Thickness(0, 3, 0, 0) });
            connectionText.Text = "Подключение…";
            connectionText.Foreground = MutedBrush;
            connectionText.VerticalAlignment = VerticalAlignment.Center;
            connectionText.FontSize = 13;
            Grid.SetColumn(connectionText, 1);
            headerGrid.Children.Add(brand);
            headerGrid.Children.Add(connectionText);
            header.Child = headerGrid;
            root.Children.Add(header);

            var sidebar = new Grid { Background = PanelBrush };
            sidebar.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            sidebar.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            sidebar.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            sidebar.Children.Add(new TextBlock { Text = "ЗАДАЧИ", FontWeight = FontWeights.SemiBold, Foreground = MutedBrush, Margin = new Thickness(18, 18, 18, 10) });
            taskList.Background = Brushes.Transparent;
            taskList.Foreground = TextBrush;
            taskList.BorderThickness = new Thickness(0);
            taskList.Padding = new Thickness(8, 0, 8, 0);
            taskList.FontSize = 13;
            Grid.SetRow(taskList, 1);
            sidebar.Children.Add(taskList);
            var newButtons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(12) };
            var newCodex = ActionButton("＋ Codex", AccentBrush);
            var newClaude = ActionButton("＋ Claude", MutedBrush);
            newCodex.Click += async delegate { await NewTaskAsync("codex"); };
            newClaude.Click += async delegate { await NewTaskAsync("claude"); };
            newButtons.Children.Add(newCodex);
            newButtons.Children.Add(newClaude);
            Grid.SetRow(newButtons, 2);
            sidebar.Children.Add(newButtons);
            Grid.SetRow(sidebar, 1);
            root.Children.Add(sidebar);

            var main = new Grid { Margin = new Thickness(24, 18, 24, 18) };
            main.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            main.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            main.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            main.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            taskTitle.Text = "Выберите задачу";
            taskTitle.FontSize = 23;
            taskTitle.FontWeight = FontWeights.SemiBold;
            taskTitle.TextWrapping = TextWrapping.Wrap;
            taskMeta.Foreground = MutedBrush;
            taskMeta.Margin = new Thickness(0, 5, 0, 14);
            var titleStack = new StackPanel();
            titleStack.Children.Add(taskTitle);
            titleStack.Children.Add(taskMeta);
            historyButton.Content = "Показать ранние сообщения";
            historyButton.Foreground = AccentBrush;
            historyButton.Background = PanelAltBrush;
            historyButton.BorderBrush = BorderLineBrush;
            historyButton.BorderThickness = new Thickness(1);
            historyButton.Padding = new Thickness(10, 6, 10, 6);
            historyButton.Margin = new Thickness(0, 0, 0, 10);
            historyButton.HorizontalAlignment = HorizontalAlignment.Left;
            historyButton.Cursor = Cursors.Hand;
            historyButton.Visibility = Visibility.Collapsed;
            titleStack.Children.Add(historyButton);
            main.Children.Add(titleStack);

            output.IsReadOnly = true;
            output.AcceptsReturn = true;
            output.TextWrapping = TextWrapping.Wrap;
            output.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            output.Background = PanelBrush;
            output.Foreground = TextBrush;
            output.BorderBrush = BorderLineBrush;
            output.BorderThickness = new Thickness(1);
            output.Padding = new Thickness(16);
            output.FontSize = 14;
            output.FontFamily = new FontFamily("Segoe UI");
            Grid.SetRow(output, 1);
            main.Children.Add(output);

            input.AcceptsReturn = true;
            input.TextWrapping = TextWrapping.Wrap;
            input.MinHeight = 78;
            input.MaxHeight = 150;
            input.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            input.Background = PanelAltBrush;
            input.Foreground = TextBrush;
            input.CaretBrush = AccentBrush;
            input.BorderBrush = BorderLineBrush;
            input.BorderThickness = new Thickness(1);
            input.Padding = new Thickness(12);
            input.Margin = new Thickness(0, 14, 0, 10);
            Grid.SetRow(input, 2);
            main.Children.Add(input);

            var actions = new Grid();
            actions.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            actions.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            footer.Text = "Ctrl+Enter — отправить";
            footer.Foreground = MutedBrush;
            footer.VerticalAlignment = VerticalAlignment.Center;
            sendButton.Content = "Отправить";
            sendButton.Foreground = AccentBrush;
            sendButton.Background = PanelAltBrush;
            sendButton.BorderBrush = BorderLineBrush;
            sendButton.BorderThickness = new Thickness(1);
            sendButton.Cursor = Cursors.Hand;
            sendButton.MinWidth = 130;
            sendButton.Padding = new Thickness(18, 9, 18, 9);
            Grid.SetColumn(sendButton, 1);
            actions.Children.Add(footer);
            actions.Children.Add(sendButton);
            Grid.SetRow(actions, 3);
            main.Children.Add(actions);
            Grid.SetRow(main, 1);
            Grid.SetColumn(main, 1);
            root.Children.Add(main);
            return root;
        }

        private static Brush Brush(string color)
        {
            return new SolidColorBrush((Color)ColorConverter.ConvertFromString(color));
        }

        private static Button ActionButton(string text, Brush foreground)
        {
            var button = new Button
            {
                Content = text,
                Foreground = foreground,
                Background = PanelAltBrush,
                BorderBrush = BorderLineBrush,
                BorderThickness = new Thickness(1),
                Padding = new Thickness(13, 8, 13, 8),
                Margin = new Thickness(3),
                Cursor = Cursors.Hand
            };
            return button;
        }

        private async Task RefreshAsync(bool force)
        {
            if (refreshRunning) return;
            refreshRunning = true;
            try
            {
                var snapshot = await client.CallAsync("snapshot", new Dictionary<string, object> { { "refresh", force } });
                ApplySnapshot(snapshot);
                TaskItem selected;
                if (!String.IsNullOrWhiteSpace(selectedKey) && tasks.TryGetValue(selectedKey, out selected))
                {
                    var completedNow = selectedWasRunning == true && !selected.Running;
                    selectedWasRunning = selected.Running;
                    if (historyKey != selectedKey || completedNow) await LoadHistoryAsync(false);
                }
                connectionText.Text = "● Подключено · активных: " + Convert.ToString(snapshot.ContainsKey("activeCount") ? snapshot["activeCount"] : 0);
                connectionText.Foreground = RunningBrush;
            }
            catch (Exception error)
            {
                connectionText.Text = "○ Нет связи";
                connectionText.Foreground = MutedBrush;
                footer.Text = error.Message;
            }
            finally
            {
                refreshRunning = false;
            }
        }

        private void ApplySnapshot(Dictionary<string, object> snapshot)
        {
            var previousKey = selectedKey;
            tasks.Clear();
            selectionInternal = true;
            taskList.Items.Clear();
            TaskItem selected = null;
            TaskItem previous = null;
            foreach (var raw in IntegrationClient.Array(snapshot, "tasks"))
            {
                var value = raw as Dictionary<string, object>;
                if (value == null) continue;
                var item = new TaskItem
                {
                    Provider = IntegrationClient.Text(value, "provider"),
                    ThreadId = IntegrationClient.Text(value, "threadId"),
                    ProjectRoot = IntegrationClient.Text(value, "projectRoot"),
                    ProjectName = IntegrationClient.Text(value, "projectName"),
                    Title = IntegrationClient.Text(value, "title", "Без названия"),
                    Selected = IntegrationClient.Bool(value, "selected"),
                    Running = IntegrationClient.Bool(value, "running"),
                    Runtime = IntegrationClient.Text(value, "runtime"),
                    LastAnswer = IntegrationClient.Text(value, "lastAnswer"),
                    Run = IntegrationClient.Object(value, "run")
                };
                var key = Key(item.Provider, item.ThreadId);
                tasks[key] = item;
                var row = new ListBoxItem
                {
                    Content = item,
                    Tag = key,
                    Padding = new Thickness(10, 9, 10, 9),
                    Margin = new Thickness(2, 2, 2, 2),
                    Background = item.Selected ? Brush("#204356") : Brushes.Transparent,
                    Foreground = item.Running ? RunningBrush : TextBrush,
                    BorderBrush = item.Selected ? AccentBrush : Brushes.Transparent,
                    BorderThickness = new Thickness(item.Selected ? 1 : 0)
                };
                taskList.Items.Add(row);
                if (item.Selected) selected = item;
                else if (key == previousKey) previous = item;
                if (item.Selected) taskList.SelectedItem = row;
            }
            selectionInternal = false;
            if (selected == null) selected = previous;
            if (selected != null)
            {
                var nextKey = Key(selected.Provider, selected.ThreadId);
                if (nextKey != selectedKey)
                {
                    SaveCurrentDraft();
                    selectedKey = nextKey;
                    RestoreCurrentDraft();
                }
                RenderTask(selected);
            }
        }

        private void LoadDrafts()
        {
            try
            {
                if (!File.Exists(draftFile)) return;
                var loaded = json.Deserialize<Dictionary<string, string>>(File.ReadAllText(draftFile, Encoding.UTF8));
                if (loaded == null) return;
                foreach (var item in loaded) drafts[item.Key] = item.Value ?? "";
            }
            catch
            {
                // A damaged optional draft file must never prevent the client from starting.
            }
        }

        private void SaveCurrentDraft()
        {
            if (String.IsNullOrWhiteSpace(selectedKey)) return;
            var value = input.Text ?? "";
            if (String.IsNullOrEmpty(value)) drafts.Remove(selectedKey);
            else drafts[selectedKey] = value;
            try
            {
                var directory = Path.GetDirectoryName(draftFile);
                Directory.CreateDirectory(directory);
                var temporary = draftFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
                File.WriteAllText(temporary, json.Serialize(drafts), new UTF8Encoding(false));
                if (File.Exists(draftFile))
                {
                    try { File.Replace(temporary, draftFile, null); }
                    catch
                    {
                        File.Copy(temporary, draftFile, true);
                        File.Delete(temporary);
                    }
                }
                else File.Move(temporary, draftFile);
            }
            catch (Exception error)
            {
                footer.Text = "Не удалось сохранить черновик: " + error.Message;
            }
        }

        private void RestoreCurrentDraft()
        {
            string value;
            restoringDraft = true;
            try
            {
                input.Text = drafts.TryGetValue(selectedKey, out value) ? value : "";
                input.CaretIndex = input.Text.Length;
            }
            finally
            {
                restoringDraft = false;
            }
        }

        private void RenderTask(TaskItem item)
        {
            taskTitle.Text = item.Title;
            taskMeta.Text = (item.Provider == "claude" ? "Claude" : "Codex")
                + (String.IsNullOrWhiteSpace(item.Runtime) ? "" : " · " + item.Runtime)
                + (item.Running ? " · выполняется" : " · готова");
            var sections = new List<string>();
            foreach (var exchange in historyItems)
            {
                if (IntegrationClient.Bool(exchange, "active") && item.Run.Count > 0) continue;
                var prompt = IntegrationClient.Text(exchange, "prompt");
                var answer = IntegrationClient.Text(exchange, "answer");
                if (!String.IsNullOrWhiteSpace(prompt)) sections.Add("ВЫ\r\n" + prompt);
                if (!String.IsNullOrWhiteSpace(answer)) sections.Add((item.Provider == "claude" ? "CLAUDE" : "CODEX") + "\r\n" + answer);
            }
            var run = item.Run;
            if (run.Count > 0)
            {
                var prompt = IntegrationClient.Text(run, "prompt");
                var stage = IntegrationClient.Text(run, "stage");
                var progress = IntegrationClient.Text(run, "progress");
                var response = IntegrationClient.Text(run, "response");
                if (!String.IsNullOrWhiteSpace(prompt)) sections.Add("ВЫ\r\n" + prompt);
                var live = new List<string>();
                if (!String.IsNullOrWhiteSpace(stage)) live.Add(stage);
                if (!String.IsNullOrWhiteSpace(progress)) live.Add("Ход работы\r\n" + progress);
                if (!String.IsNullOrWhiteSpace(response)) live.Add("Ответ формируется\r\n" + response);
                if (live.Count > 0) sections.Add((item.Provider == "claude" ? "CLAUDE · СЕЙЧАС" : "CODEX · СЕЙЧАС") + "\r\n" + String.Join("\r\n\r\n", live.ToArray()));
            }
            if (sections.Count == 0 && !String.IsNullOrWhiteSpace(item.LastAnswer)) sections.Add((item.Provider == "claude" ? "CLAUDE" : "CODEX") + "\r\n" + item.LastAnswer);
            var rendered = sections.Count == 0
                ? "У задачи пока нет сохранённой истории."
                : String.Join("\r\n\r\n────────────────────────\r\n\r\n", sections.ToArray());
            if (output.Text != rendered)
            {
                output.Text = rendered;
                output.ScrollToEnd();
            }
        }

        private async Task LoadHistoryAsync(bool older)
        {
            if (historyLoading || String.IsNullOrWhiteSpace(selectedKey)) return;
            TaskItem item;
            if (!tasks.TryGetValue(selectedKey, out item)) return;
            historyLoading = true;
            historyButton.IsEnabled = false;
            try
            {
                var parameters = new Dictionary<string, object>
                {
                    { "provider", item.Provider },
                    { "threadId", item.ThreadId },
                    { "limit", 10 }
                };
                if (older && historyBefore.HasValue) parameters["before"] = historyBefore.Value;
                var page = await client.CallAsync("task-history", parameters);
                var loaded = new List<Dictionary<string, object>>();
                foreach (var raw in IntegrationClient.Array(page, "items"))
                {
                    var exchange = raw as Dictionary<string, object>;
                    if (exchange != null) loaded.Add(exchange);
                }
                if (older) historyItems.InsertRange(0, loaded);
                else
                {
                    historyItems.Clear();
                    historyItems.AddRange(loaded);
                    historyKey = selectedKey;
                }
                object before;
                historyBefore = page.TryGetValue("nextBefore", out before) && before != null
                    ? (int?)Convert.ToInt32(before)
                    : null;
                historyButton.Visibility = historyBefore.HasValue ? Visibility.Visible : Visibility.Collapsed;
                historyButton.Content = historyBefore.HasValue
                    ? "Показать ещё ранние сообщения"
                    : "Вся история загружена";
                RenderTask(item);
                footer.Text = "Показано сообщений: " + historyItems.Count + " из " + IntegrationClient.Text(page, "total", Convert.ToString(historyItems.Count));
            }
            catch (Exception error)
            {
                footer.Text = "Не удалось загрузить историю: " + error.Message;
            }
            finally
            {
                historyButton.IsEnabled = true;
                historyLoading = false;
            }
        }

        private async Task SelectTaskAsync()
        {
            if (selectionInternal) return;
            var row = taskList.SelectedItem as ListBoxItem;
            var key = row == null ? null : row.Tag as string;
            TaskItem item;
            if (String.IsNullOrWhiteSpace(key) || !tasks.TryGetValue(key, out item) || key == selectedKey) return;
            try
            {
                SaveCurrentDraft();
                footer.Text = "Переключаю задачу…";
                var snapshot = await client.CallAsync("select-task", new Dictionary<string, object>
                {
                    { "provider", item.Provider },
                    { "threadId", item.ThreadId }
                });
                historyKey = null;
                historyBefore = null;
                historyItems.Clear();
                selectedWasRunning = null;
                ApplySnapshot(snapshot);
                await LoadHistoryAsync(false);
                footer.Text = "Задача выбрана";
            }
            catch (Exception error)
            {
                footer.Text = error.Message;
            }
        }

        private async Task SendAsync()
        {
            var text = input.Text.Trim();
            if (text.Length == 0) return;
            sendButton.IsEnabled = false;
            try
            {
                footer.Text = "Отправляю…";
                var result = await client.CallAsync("send-message", new Dictionary<string, object> { { "text", text } });
                if (!IntegrationClient.Bool(result, "accepted"))
                {
                    footer.Text = IntegrationClient.Text(result, "message", "Сообщение не отправлено");
                    return;
                }
                input.Clear();
                SaveCurrentDraft();
                historyKey = null;
                footer.Text = "Сообщение принято Integration Server";
                await RefreshAsync(false);
            }
            catch (Exception error)
            {
                footer.Text = error.Message;
            }
            finally
            {
                sendButton.IsEnabled = true;
            }
        }

        private async Task NewTaskAsync(string provider)
        {
            try
            {
                SaveCurrentDraft();
                footer.Text = "Создаю задачу " + provider + "…";
                var snapshot = await client.CallAsync("new-task", new Dictionary<string, object> { { "provider", provider } });
                historyKey = null;
                historyBefore = null;
                historyItems.Clear();
                selectedWasRunning = null;
                ApplySnapshot(snapshot);
                await LoadHistoryAsync(false);
                footer.Text = "Новая задача создана";
            }
            catch (Exception error)
            {
                footer.Text = error.Message;
            }
        }

        private static string Key(string provider, string threadId)
        {
            return provider + "\0" + threadId;
        }
    }
}
