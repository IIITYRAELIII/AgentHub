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
            WorkspaceFileLinkAcceptsCanonicalTarget();
            WorkspaceFileLinkRejectsWebTarget();
            UserMessageDisclosureRequiresRealOverflow();
            AssistantAttachmentsAreCollectedAndDeduplicated();
            AssistantAttachmentPathIsConfinedToPrivateRoot();
            AttachmentHistorySignatureChangesAfterHydration();
            WorkspacePresentationGroupsThreadsByWorkspaceAndStream();
            WorkspacePresentationKeepsAtMostFourOpenStreams();
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

        private static void WorkspaceFileLinkAcceptsCanonicalTarget()
        {
            string file;
            int line;
            Require(
                WorkspaceFileLink.TryParse("/D:/VSC_Tyrael/Utilities/AgentHub/package.json:36", out file, out line),
                "canonical workspace link was rejected");
            Require(file == "D:/VSC_Tyrael/Utilities/AgentHub/package.json", "workspace link path was not normalized");
            Require(line == 36, "workspace link line was lost");
        }

        private static void WorkspaceFileLinkRejectsWebTarget()
        {
            string file;
            int line;
            Require(!WorkspaceFileLink.TryParse("https://example.test/file:12", out file, out line), "web link was accepted as a file");
        }

        private static void UserMessageDisclosureRequiresRealOverflow()
        {
            Require(
                !DesktopUserMessageDisclosure.HasOverflow(DesktopUserMessageDisclosure.CollapseHeight),
                "message disclosure appeared without overflow");
            Require(
                DesktopUserMessageDisclosure.HasOverflow(DesktopUserMessageDisclosure.CollapseHeight + 0.1),
                "message disclosure missed real overflow");
        }

        private static void AssistantAttachmentsAreCollectedAndDeduplicated()
        {
            var shared = new Dictionary<string, object> { { "id", "abc.png" } };
            var exchange = new Dictionary<string, object>
            {
                { "messages", new object[]
                    {
                        new Dictionary<string, object>
                        {
                            { "role", "user" },
                            { "attachments", new object[] { new Dictionary<string, object> { { "id", "user.png" } } } }
                        },
                        new Dictionary<string, object>
                        {
                            { "role", "agent" },
                            { "attachments", new object[] { shared, shared, new Dictionary<string, object> { { "id", "second.jpg" } } } }
                        }
                    }
                }
            };
            var values = DesktopAttachmentPresentation.AssistantAttachments(exchange);
            Require(values.Count == 2, "assistant image attachments were not deduplicated");
            Require(AgentHubClient.Text(values[0], "id") == "abc.png", "assistant image order changed");
        }

        private static void AssistantAttachmentPathIsConfinedToPrivateRoot()
        {
            var root = Path.Combine(Path.GetTempPath(), "agent-hub-attachment-self-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                var file = Path.Combine(root, "safe.png");
                File.WriteAllBytes(file, new byte[] { 1, 2, 3 });
                Require(
                    DesktopAttachmentPresentation.ResolvePath(root, new Dictionary<string, object> { { "id", "safe.png" } }) == file,
                    "private attachment path was rejected");
                Require(
                    DesktopAttachmentPresentation.ResolvePath(root, new Dictionary<string, object> { { "id", "../outside.png" } }) == null,
                    "attachment path escaped the private root");
                Require(
                    DesktopAttachmentPresentation.ResolvePath(root, new Dictionary<string, object> { { "id", "missing.png" } }) == null,
                    "missing attachment path was accepted");
            }
            finally
            {
                Directory.Delete(root, true);
            }
        }

        private static void AttachmentHistorySignatureChangesAfterHydration()
        {
            var exchange = new Dictionary<string, object>
            {
                { "id", "turn-1" },
                { "answer", "done" },
                { "messages", new object[] { new Dictionary<string, object> { { "role", "agent" } } } }
            };
            var history = new[] { exchange };
            var before = DesktopAttachmentPresentation.HistorySignature(history);
            ((Dictionary<string, object>)((object[])exchange["messages"])[0])["attachments"] = new object[]
            {
                new Dictionary<string, object> { { "id", "image.png" } }
            };
            var after = DesktopAttachmentPresentation.HistorySignature(history);
            Require(before != after, "attachment hydration did not invalidate the render signature");
        }

        private static void WorkspacePresentationGroupsThreadsByWorkspaceAndStream()
        {
            var first = new TaskItem
            {
                WorkspaceId = "workspace-a", WorkspaceName = "Agent HUB",
                StreamId = "stream-1", StreamName = "Main", StreamOrdinal = 1,
                Provider = "codex", ThreadId = "thread-1", Title = "Первый", OrderingActivityAtMs = 5
            };
            var secondThread = new TaskItem
            {
                WorkspaceId = "workspace-a", WorkspaceName = "Agent HUB",
                StreamId = "stream-1", StreamName = "Main", StreamOrdinal = 1,
                Provider = "claude", ThreadId = "thread-2", Title = "Второй", OrderingActivityAtMs = 8
            };
            var secondStream = new TaskItem
            {
                WorkspaceId = "workspace-a", WorkspaceName = "Agent HUB",
                StreamId = "stream-2", StreamOrdinal = 2,
                Provider = "codex", ThreadId = "thread-3", Title = "Themes", OrderingActivityAtMs = 9
            };
            var otherWorkspace = new TaskItem
            {
                WorkspaceId = "workspace-b", WorkspaceName = "Experiments",
                StreamId = "stream-3", Provider = "codex", ThreadId = "thread-4", Title = "Probe", OrderingActivityAtMs = 1
            };
            var groups = DesktopWorkspacePresentation.Group(new[] { first, secondThread, secondStream, otherWorkspace });
            Require(groups.Count == 2, "workspace groups were not created");
            var agentHub = groups.Find(value => value.WorkspaceId == "workspace-a");
            Require(agentHub != null && agentHub.Streams.Count == 2, "streams were not grouped under workspace");
            var main = agentHub.Streams.Find(value => value.StreamId == "stream-1");
            Require(main != null && main.Threads.Count == 2, "threads were not retained under their stream");
            var numbered = agentHub.Streams.Find(value => value.StreamId == "stream-2");
            Require(numbered != null && numbered.StreamLabel == "Stream 2", "unnamed second stream did not receive its ordinal label");
        }

        private static void WorkspacePresentationKeepsAtMostFourOpenStreams()
        {
            var streams = new List<string> { "one", "two", "three", "four" };
            Require(!DesktopWorkspacePresentation.TryAddOpenStream(streams, "five"), "fifth stream bypassed the visible cap");
            DesktopWorkspacePresentation.EnsureOpenStream(streams, "five");
            Require(streams.Count == 4, "stream selector exceeded four entries");
            Require(!streams.Contains("one") && streams[3] == "five", "least-recent stream was not replaced");
            DesktopWorkspacePresentation.EnsureOpenStream(streams, "three");
            Require(streams.Count == 4 && streams[3] == "three", "reselected stream was not promoted");
        }

        private static void Require(bool value, string message)
        {
            if (!value) throw new InvalidOperationException(message);
        }
    }
}
