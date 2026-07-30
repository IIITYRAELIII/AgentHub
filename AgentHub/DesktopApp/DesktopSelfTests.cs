using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace AgentHubDesktop
{
    internal static class DesktopSelfTests
    {
        public static void Run()
        {
            StableMessageIdentitySurvivesRetry();
            StableMessageIdentityChangesWithDraft();
            AttachmentChangeCreatesNewFingerprint();
            EndpointValidationRejectsPipeInjection();
            ServerProofRejectsImpostor();
            ResponseWaitIsBounded();
        }

        private static void StableMessageIdentitySurvivesRetry()
        {
            string messageId = null;
            string fingerprint = null;
            var first = DesktopMessageIdentity.Ensure(ref messageId, ref fingerprint, "draft-a");
            var retry = DesktopMessageIdentity.Ensure(ref messageId, ref fingerprint, "draft-a");
            Require(first == retry, "retry changed clientUserMessageId");
        }

        private static void StableMessageIdentityChangesWithDraft()
        {
            string messageId = null;
            string fingerprint = null;
            var first = DesktopMessageIdentity.Ensure(ref messageId, ref fingerprint, "draft-a");
            var changed = DesktopMessageIdentity.Ensure(ref messageId, ref fingerprint, "draft-b");
            Require(first != changed, "changed draft reused clientUserMessageId");
        }

        private static void AttachmentChangeCreatesNewFingerprint()
        {
            var file = Path.Combine(Path.GetTempPath(), "agent-hub-desktop-self-test-" + Guid.NewGuid().ToString("N"));
            try
            {
                File.WriteAllText(file, "first", new UTF8Encoding(false));
                var first = DesktopMessageIdentity.PayloadFingerprint("draft", new[] { file });
                File.WriteAllText(file, "second", new UTF8Encoding(false));
                var second = DesktopMessageIdentity.PayloadFingerprint("draft", new[] { file });
                Require(first != second, "changed attachment reused payload fingerprint");
            }
            finally
            {
                if (File.Exists(file)) File.Delete(file);
            }
        }

        private static void EndpointValidationRejectsPipeInjection()
        {
            var endpointId = new String('a', 64);
            try
            {
                DesktopControlProtocol.ParseEndpoint(new Dictionary<string, object>
                {
                    { "protocol", 2 },
                    { "endpointId", endpointId },
                    { "pipeName", "..\\attacker" }
                });
                throw new InvalidOperationException("invalid endpoint was accepted");
            }
            catch (System.IO.InvalidDataException)
            {
            }
        }

        private static void ServerProofRejectsImpostor()
        {
            var secret = new String('s', 64);
            var endpoint = new String('a', 64);
            var nonce = new String('b', 64);
            var challenge = new String('c', 64);
            var proof = DesktopControlProtocol.ServerProof(secret, endpoint, nonce, challenge);
            Require(DesktopControlProtocol.VerifyProof(proof, proof), "valid server proof was rejected");
            Require(
                !DesktopControlProtocol.VerifyProof(new String('0', 64), proof),
                "impostor server proof was accepted");
        }

        private static void ResponseWaitIsBounded()
        {
            var never = new TaskCompletionSource<string>();
            try
            {
                DesktopControlProtocol.WithTimeout(
                    never.Task,
                    40,
                    "timeout expected").GetAwaiter().GetResult();
                throw new InvalidOperationException("unbounded response wait was accepted");
            }
            catch (TimeoutException)
            {
            }
        }

        private static void Require(bool value, string message)
        {
            if (!value) throw new InvalidOperationException(message);
        }
    }
}
