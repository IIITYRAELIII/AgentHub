using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace AgentHubDesktop
{
    internal sealed class DesktopEndpointDescriptor
    {
        public int Protocol;
        public string EndpointId;
        public string PipeName;
    }

    internal sealed class DesktopTransportException : IOException
    {
        public bool Retryable { get; private set; }
        public bool RequestMayHaveReachedServer { get; private set; }

        public DesktopTransportException(
            string message,
            bool retryable,
            bool requestMayHaveReachedServer,
            Exception innerException)
            : base(message, innerException)
        {
            Retryable = retryable;
            RequestMayHaveReachedServer = requestMayHaveReachedServer;
        }
    }

    internal static class DesktopControlProtocol
    {
        public const int Version = 2;
        private static readonly Regex Hex64 = new Regex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
        private static readonly Regex PipeName = new Regex(
            "^agent-hub-desktop-[a-f0-9]{64}$",
            RegexOptions.CultureInvariant);

        public static DesktopEndpointDescriptor ParseEndpoint(IDictionary<string, object> value)
        {
            if (value == null) throw new InvalidDataException("Файл Desktop endpoint повреждён.");
            object rawProtocol;
            object rawEndpointId;
            object rawPipeName;
            var protocol = value.TryGetValue("protocol", out rawProtocol)
                ? Convert.ToInt32(rawProtocol)
                : 0;
            var endpointId = value.TryGetValue("endpointId", out rawEndpointId)
                ? Convert.ToString(rawEndpointId).Trim().ToLowerInvariant()
                : "";
            var pipeName = value.TryGetValue("pipeName", out rawPipeName)
                ? Convert.ToString(rawPipeName).Trim()
                : "";
            if (protocol != Version || !Hex64.IsMatch(endpointId)
                || !PipeName.IsMatch(pipeName)
                || !String.Equals(pipeName, "agent-hub-desktop-" + endpointId, StringComparison.Ordinal))
            {
                throw new InvalidDataException("Файл Desktop endpoint повреждён.");
            }
            return new DesktopEndpointDescriptor
            {
                Protocol = protocol,
                EndpointId = endpointId,
                PipeName = pipeName
            };
        }

        public static string RandomNonce()
        {
            var bytes = new byte[32];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            return Hex(bytes);
        }

        public static string ServerProof(
            string secret,
            string endpointId,
            string clientNonce,
            string challenge)
        {
            return Hmac(secret, String.Join("\n", new[]
            {
                "agent-hub-desktop/server/v2",
                endpointId,
                clientNonce,
                challenge
            }));
        }

        public static string ClientProof(
            string secret,
            string endpointId,
            string clientNonce,
            string challenge,
            byte[] payload)
        {
            return Hmac(secret, String.Join("\n", new[]
            {
                "agent-hub-desktop/client/v2",
                endpointId,
                clientNonce,
                challenge,
                Sha256Hex(payload)
            }));
        }

        public static bool VerifyProof(string actual, string expected)
        {
            var left = Encoding.UTF8.GetBytes((actual ?? "").Trim().ToLowerInvariant());
            var right = Encoding.UTF8.GetBytes((expected ?? "").Trim().ToLowerInvariant());
            if (left.Length != right.Length) return false;
            var difference = 0;
            for (var index = 0; index < left.Length; index++) difference |= left[index] ^ right[index];
            return difference == 0;
        }

        public static bool IsNonce(string value)
        {
            return Hex64.IsMatch((value ?? "").Trim().ToLowerInvariant());
        }

        public static async Task<T> WithTimeout<T>(Task<T> task, int timeoutMs, string message)
        {
            if (timeoutMs <= 0) throw new ArgumentOutOfRangeException("timeoutMs");
            var completed = await Task.WhenAny(task, Task.Delay(timeoutMs));
            if (completed != task) throw new TimeoutException(message);
            return await task;
        }

        private static string Hmac(string secret, string value)
        {
            using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret ?? "")))
            {
                return Hex(hmac.ComputeHash(Encoding.UTF8.GetBytes(value ?? "")));
            }
        }

        private static string Sha256Hex(byte[] value)
        {
            using (var sha = SHA256.Create()) return Hex(sha.ComputeHash(value ?? new byte[0]));
        }

        private static string Hex(byte[] value)
        {
            var result = new StringBuilder(value.Length * 2);
            foreach (var item in value) result.Append(item.ToString("x2"));
            return result.ToString();
        }
    }

    internal static class DesktopMessageIdentity
    {
        public static string PayloadFingerprint(string text, IEnumerable<string> attachments)
        {
            var value = new StringBuilder();
            Append(value, text ?? "");
            foreach (var file in attachments ?? new string[0])
            {
                var fullPath = Path.GetFullPath(file ?? "");
                Append(value, fullPath.ToLowerInvariant());
                using (var stream = File.OpenRead(fullPath))
                using (var sha = SHA256.Create())
                {
                    Append(value, Convert.ToBase64String(sha.ComputeHash(stream)));
                }
            }
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(value.ToString()));
                var result = new StringBuilder(hash.Length * 2);
                foreach (var item in hash) result.Append(item.ToString("x2"));
                return result.ToString();
            }
        }

        public static string Ensure(
            ref string clientUserMessageId,
            ref string previousFingerprint,
            string currentFingerprint)
        {
            if (String.IsNullOrWhiteSpace(clientUserMessageId)
                || !String.Equals(previousFingerprint, currentFingerprint, StringComparison.Ordinal))
            {
                clientUserMessageId = Guid.NewGuid().ToString("D");
                previousFingerprint = currentFingerprint;
            }
            return clientUserMessageId;
        }

        private static void Append(StringBuilder target, string value)
        {
            var text = value ?? "";
            target.Append(text.Length).Append(':').Append(text).Append('\n');
        }
    }
}
