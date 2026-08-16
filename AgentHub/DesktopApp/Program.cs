using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;

namespace AgentHubDesktop
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length > 0 && String.Equals(args[0], "--self-test", StringComparison.Ordinal))
            {
                try
                {
                    DesktopSelfTests.Run();
                    return 0;
                }
                catch
                {
                    return 1;
                }
            }
            if (args.Length > 1 && String.Equals(args[0], "--rpc-smoke", StringComparison.Ordinal))
            {
                try
                {
                    return RunRpcSmoke(args[1]).GetAwaiter().GetResult();
                }
                catch
                {
                    return 1;
                }
            }
            var application = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            application.Run(new AgentHubWindow());
            return 0;
        }

        private static async Task<int> RunRpcSmoke(string runtimeRoot)
        {
            var client = new AgentHubClient(runtimeRoot, 1000, 180);
            var response = await client.CallAsync("desktop-smoke", new Dictionary<string, object>
            {
                { "value", 42 },
                { "text", "проверка" }
            });
            if (AgentHubClient.Text(response, "text") != "проверка") return 2;
            var messageId = Guid.NewGuid().ToString("D");
            var sent = await client.CallAsync("send-message", new Dictionary<string, object>
            {
                { "text", "retry smoke" },
                { "clientUserMessageId", messageId }
            }, true);
            return AgentHubClient.Bool(sent, "accepted") ? 0 : 3;
        }
    }

    internal sealed class AgentHubClient
    {
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
        private readonly string endpointFile;
        private readonly string secretFile;
        private readonly int connectTimeoutMs;
        private readonly int responseTimeoutMs;

        public AgentHubClient()
            : this(null, 3000, 15000)
        {
        }

        internal AgentHubClient(string runtimeRoot, int connectTimeoutMs, int responseTimeoutMs)
        {
            if (String.IsNullOrWhiteSpace(runtimeRoot))
            {
                var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                runtimeRoot = Path.Combine(local, "AgentHub");
            }
            runtimeRoot = Path.GetFullPath(runtimeRoot);
            secretFile = Path.Combine(runtimeRoot, "desktop-control.secret");
            endpointFile = Path.Combine(runtimeRoot, "desktop-control.endpoint.json");
            this.connectTimeoutMs = connectTimeoutMs;
            this.responseTimeoutMs = responseTimeoutMs;
        }

        public async Task<Dictionary<string, object>> CallAsync(
            string action,
            Dictionary<string, object> parameters,
            bool retryTransportFailure = false)
        {
            if (retryTransportFailure
                && String.Equals(action, "send-message", StringComparison.Ordinal)
                && String.IsNullOrWhiteSpace(Text(parameters, "clientUserMessageId")))
            {
                throw new InvalidOperationException(
                    "Безопасный повтор send-message требует clientUserMessageId.");
            }
            DesktopTransportException firstFailure = null;
            const int maximumAttempts = 3;
            for (var attempt = 0; attempt < maximumAttempts; attempt++)
            {
                DesktopTransportException retryFailure = null;
                try
                {
                    return await CallOnceAsync(action, parameters);
                }
                catch (DesktopTransportException error)
                {
                    var safeToRetry = error.Retryable
                        && (!error.RequestMayHaveReachedServer || retryTransportFailure);
                    if (!safeToRetry) throw;
                    if (attempt + 1 >= maximumAttempts)
                    {
                        throw new DesktopTransportException(
                            error.RequestMayHaveReachedServer
                                ? "Agent Hub Server не подтвердил приём сообщения после безопасного повтора."
                                : "Нет связи с Agent Hub Server после повторного подключения.",
                            false,
                            error.RequestMayHaveReachedServer
                                || (firstFailure != null && firstFailure.RequestMayHaveReachedServer),
                            error);
                    }
                    firstFailure = retryFailure = error;
                }
                if (retryFailure != null) await Task.Delay(attempt == 0 ? 180 : 420);
            }
            throw new InvalidOperationException("Повтор Desktop-запроса не завершился.");
        }

        private async Task<Dictionary<string, object>> CallOnceAsync(
            string action,
            Dictionary<string, object> parameters)
        {
            var requestMayHaveReachedServer = false;
            var commandResponseTimeoutMs = ResponseTimeoutForAction(action, responseTimeoutMs);
            try
            {
                if (!File.Exists(secretFile) || !File.Exists(endpointFile))
                {
                    throw new DesktopTransportException(
                        "Agent Hub Server ещё не опубликовал Desktop API.",
                        true,
                        false,
                        null);
                }
                var endpointValue = json.Deserialize<Dictionary<string, object>>(
                    File.ReadAllText(endpointFile, Encoding.UTF8));
                var endpoint = DesktopControlProtocol.ParseEndpoint(endpointValue);
                var secret = File.ReadAllText(secretFile, Encoding.UTF8).Trim();
                if (secret.Length < 32) throw new InvalidDataException("Desktop secret повреждён.");

                var requestPayload = Encoding.UTF8.GetBytes(json.Serialize(new Dictionary<string, object>
                {
                    { "action", action },
                    { "params", parameters ?? new Dictionary<string, object>() }
                }));
                var clientNonce = DesktopControlProtocol.RandomNonce();
                using (var pipe = new NamedPipeClientStream(
                    ".",
                    endpoint.PipeName,
                    PipeDirection.InOut,
                    PipeOptions.Asynchronous))
                {
                    await Task.Run(delegate { pipe.Connect(connectTimeoutMs); });
                using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true })
                using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, true))
                {
                        await writer.WriteLineAsync(json.Serialize(new Dictionary<string, object>
                        {
                            { "type", "hello" },
                            { "protocol", DesktopControlProtocol.Version },
                            { "clientNonce", clientNonce }
                        }));
                        var challengeLine = await DesktopControlProtocol.WithTimeout(
                            reader.ReadLineAsync(),
                            responseTimeoutMs,
                            "Agent Hub Server не прислал challenge вовремя.");
                        if (String.IsNullOrWhiteSpace(challengeLine))
                        {
                            throw new IOException("Agent Hub Server закрыл соединение до проверки подлинности.");
                        }
                        var challenge = json.Deserialize<Dictionary<string, object>>(challengeLine);
                        var challengeValue = Text(challenge, "challenge").Trim().ToLowerInvariant();
                        var serverProof = Text(challenge, "serverProof").Trim().ToLowerInvariant();
                        if (!String.Equals(Text(challenge, "type"), "challenge", StringComparison.Ordinal)
                            || !String.Equals(Text(challenge, "endpointId"), endpoint.EndpointId, StringComparison.Ordinal)
                            || !DesktopControlProtocol.IsNonce(challengeValue)
                            || !DesktopControlProtocol.VerifyProof(
                                serverProof,
                                DesktopControlProtocol.ServerProof(
                                    secret,
                                    endpoint.EndpointId,
                                    clientNonce,
                                    challengeValue)))
                        {
                            throw new InvalidDataException(
                                "Не удалось подтвердить подлинность Agent Hub Server. Запрос не отправлен.");
                        }
                        var request = new Dictionary<string, object>
                        {
                            { "type", "request" },
                            { "clientNonce", clientNonce },
                            { "challenge", challengeValue },
                            { "payload", Convert.ToBase64String(requestPayload) },
                            {
                                "proof",
                                DesktopControlProtocol.ClientProof(
                                    secret,
                                    endpoint.EndpointId,
                                    clientNonce,
                                    challengeValue,
                                    requestPayload)
                            }
                        };
                        requestMayHaveReachedServer = true;
                        await writer.WriteLineAsync(json.Serialize(request));
                        var line = await DesktopControlProtocol.WithTimeout(
                            reader.ReadLineAsync(),
                            commandResponseTimeoutMs,
                            "Agent Hub Server не подтвердил запрос вовремя.");
                        if (String.IsNullOrWhiteSpace(line))
                        {
                            throw new IOException("Agent Hub Server закрыл соединение без ответа.");
                        }
                        var response = json.Deserialize<Dictionary<string, object>>(line);
                        if (!Bool(response, "ok"))
                        {
                            throw new InvalidOperationException(
                                Text(response, "error", "Неизвестная ошибка Agent Hub Server"));
                        }
                        return Object(response, "result");
                    }
                }
            }
            catch (DesktopTransportException)
            {
                throw;
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (InvalidOperationException)
            {
                throw;
            }
            catch (TimeoutException error)
            {
                throw new DesktopTransportException(
                    requestMayHaveReachedServer
                        ? "Agent Hub Server не подтвердил приём запроса вовремя."
                        : "Agent Hub Server не ответил вовремя.",
                    true,
                    requestMayHaveReachedServer,
                    error);
            }
            catch (IOException error)
            {
                throw new DesktopTransportException(
                    "Соединение с Agent Hub Server было прервано.",
                    true,
                    requestMayHaveReachedServer,
                    error);
            }
            catch (UnauthorizedAccessException error)
            {
                throw new DesktopTransportException(
                    "Нет доступа к защищённому Desktop endpoint Agent Hub Server.",
                    false,
                    false,
                    error);
            }
        }

        internal static int ResponseTimeoutForAction(string action, int defaultTimeoutMs)
        {
            return String.Equals(action, "rotate-stream", StringComparison.Ordinal)
                || String.Equals(action, "submit-bug-report", StringComparison.Ordinal)
                ? Math.Max(defaultTimeoutMs, 180000)
                : defaultTimeoutMs;
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
        public string WorkspaceId;
        public string WorkspaceName;
        public string StreamId;
        public string StreamName;
        public string StreamDisplayName;
        public int StreamOrdinal;
        public string ProjectRoot;
        public string Title;
        public string ProjectName;
        public bool Selected;
        public bool Running;
        public bool ActivityUnknown;
        public bool Unread;
        public string Runtime;
        public string LastAnswer;
        public string LastAnswerAt;
        public string LastAnswerTurnId;
        public long OrderingActivityAtMs;
        public Dictionary<string, object> Run;
        public Dictionary<string, object> Context;
    }

    internal static class DesktopHistoryRefreshPolicy
    {
        internal static bool ShouldReload(TaskItem previous, TaskItem current)
        {
            if (previous == null || current == null) return false;
            if (previous.Running && !current.Running) return true;
            if (!String.Equals(previous.LastAnswerTurnId, current.LastAnswerTurnId, StringComparison.Ordinal)) return true;
            return !String.Equals(previous.LastAnswerAt, current.LastAnswerAt, StringComparison.Ordinal);
        }
    }
}
