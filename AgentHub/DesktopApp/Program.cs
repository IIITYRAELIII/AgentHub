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

namespace AgentHubDesktop
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            var application = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            application.Run(new AgentHubWindow());
        }
    }

    internal sealed class AgentHubClient
    {
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
        private readonly string pipeName;
        private readonly string secretFile;

        public AgentHubClient()
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var runtimeRoot = Path.GetFullPath(Path.Combine(local, "Tyrael", "TelegramIntegration"));
            secretFile = Path.Combine(runtimeRoot, "desktop-control.secret");
            pipeName = "tyrael-integration-desktop-" + ControlId(runtimeRoot);
        }

        private static string ControlId(string value)
        {
            using (var sha = SHA256.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(value).ToLowerInvariant()));
                var result = new StringBuilder();
                for (var index = 0; index < 12; index++) result.Append(bytes[index].ToString("x2"));
                return result.ToString();
            }
        }

        public async Task<Dictionary<string, object>> CallAsync(string action, Dictionary<string, object> parameters)
        {
            if (!File.Exists(secretFile)) throw new InvalidOperationException("Agent Hub Server ещё не опубликовал Desktop API.");
            var request = json.Serialize(new Dictionary<string, object>
            {
                { "secret", File.ReadAllText(secretFile, Encoding.UTF8).Trim() },
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
                    if (String.IsNullOrWhiteSpace(line)) throw new IOException("Agent Hub Server закрыл соединение без ответа.");
                    var response = json.Deserialize<Dictionary<string, object>>(line);
                    if (!Bool(response, "ok")) throw new InvalidOperationException(Text(response, "error", "Неизвестная ошибка Agent Hub Server"));
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
        public long OrderingActivityAtMs;
        public Dictionary<string, object> Run;
    }
}
