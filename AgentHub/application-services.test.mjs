// Contract suite for application/provider modules extracted from the Agent Hub
// composition root. Keeping the imports here makes the npm suite explicit
// without coupling one production boundary test to every other service test.
import "./provider-adapters.test.mjs";
import "./provider-task-service.test.mjs";
import "./run-activity.test.mjs";
import "./application-command-service.test.mjs";
import "./desktop-attachment-service.test.mjs";
import "./telegram-settings-callbacks.test.mjs";
import "./telegram-task-callbacks.test.mjs";
import "./telegram-input-callbacks.test.mjs";
import "./desktop-application-router.test.mjs";
import "./bug-report-repository.test.mjs";
import "./provider-completion-services.test.mjs";
import "./provider-recovery-services.test.mjs";
import "./claude-task-snapshot-service.test.mjs";
import "./provider-turn-services.test.mjs";
import "./telegram-command-service.test.mjs";
import "./codex-event-service.test.mjs";
import "./codex-task-snapshot-service.test.mjs";
import "./claude-event-service.test.mjs";
import "./provider-catalog-services.test.mjs";
import "./desktop-deferred-input-service.test.mjs";
import "./desktop-settings-service.test.mjs";
import "./run-progress-presentation.test.mjs";
import "./agent-hub-startup-coordinator.test.mjs";
import "./task-metadata-store.test.mjs";
