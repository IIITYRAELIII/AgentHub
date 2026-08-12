import {
  commandTaskTarget,
  createApplicationCommandService,
} from "../application/application-command-service.mjs";
import { RestartRequestService } from "../application/restart-request-service.mjs";
import { TaskCommandService } from "../application/task-command-service.mjs";
import { TaskNavigationService } from "../application/task-navigation-service.mjs";
import { DesktopSettingsService } from "../interfaces/desktop/desktop-settings-service.mjs";
import { DesktopTaskService } from "../interfaces/desktop/desktop-task-service.mjs";
import { TelegramTaskActionService } from "../interfaces/telegram/telegram-task-action-service.mjs";

export function createDesktopCommandComposition({
  taskService,
  taskCommands,
  restart,
  navigation,
  settings,
  application,
  telegramActions,
  workspaceActions,
}) {
  let desktopSettingsService;

  function dispatchApplicationCommand(type, params, context, { target = null } = {}) {
    return applicationCommands.dispatch(type, params, context, { target });
  }

  const desktopTaskService = new DesktopTaskService({
    ...taskService,
    dispatchCommand: dispatchApplicationCommand,
    commandTaskTarget,
  });
  const desktopSelectTask = (...args) => desktopTaskService.select(...args);
  const desktopOpenTask = (...args) => desktopTaskService.openTask(...args);
  const desktopOpenTurn = (...args) => desktopTaskService.openTurn(...args);
  const desktopMessageTarget = (...args) => desktopTaskService.resolveTarget(...args);

  const taskCommandService = new TaskCommandService({
    ...taskCommands,
    resolveTarget: desktopMessageTarget,
  });
  const desktopRenameTask = (...args) => taskCommandService.rename(...args);
  const desktopArchiveTask = (...args) => taskCommandService.archive(...args);
  const desktopTaskDiff = (...args) => taskCommandService.diff(...args);
  const desktopCancelRun = (...args) => taskCommandService.cancel(...args);
  const desktopNewTask = (...args) => taskCommandService.create(...args);
  const desktopRotateStream = (...args) => taskCommandService.rotate(...args);

  const restartRequestService = new RestartRequestService(restart);
  const desktopRestartServer = () => restartRequestService.fromDesktop();

  const taskNavigationService = new TaskNavigationService(navigation);
  desktopSettingsService = new DesktopSettingsService(settings);
  const desktopUpdateSetting = (...args) => desktopSettingsService.update(...args);

  const applicationCommands = createApplicationCommandService({
    handlers: {
      selectTask: desktopSelectTask,
      createTask: desktopNewTask,
      rotateStream: desktopRotateStream,
      renameTask: desktopRenameTask,
      archiveTask: desktopArchiveTask,
      updateSetting: desktopUpdateSetting,
      cancelRun: desktopCancelRun,
      resolveApproval: application.resolveApproval,
      renameWorkspace: workspaceActions.renameWorkspace,
      updateWorkspaceSettings: workspaceActions.updateWorkspaceSettings,
      updateWorkspaceDeveloperRules: workspaceActions.updateWorkspaceDeveloperRules,
      createWorkspace: workspaceActions.createWorkspace,
      createWorkspaceFromStream: workspaceActions.createWorkspaceFromStream,
      mergeWorkspaces: workspaceActions.mergeWorkspaces,
      createStream: workspaceActions.createStream,
      renameStream: workspaceActions.renameStream,
      updateStreamSettings: workspaceActions.updateStreamSettings,
      updateStreamDeveloperRules: workspaceActions.updateStreamDeveloperRules,
      moveStream: workspaceActions.moveStream,
    },
  });

  const telegramTaskActions = new TelegramTaskActionService({
    ...telegramActions,
    selectTaskFromBinding: telegramActions.selectTaskFromBinding ?? selectTaskFromBinding,
    dispatchCommand: dispatchApplicationCommand,
    commandTaskTarget,
  });

  function settingCommandTarget(params) {
    return applicationCommands.settingTarget(params);
  }

  function selectTaskFromBinding(binding, context = {}) {
    return applicationCommands.selectTaskFromBinding(binding, context);
  }

  return {
    applicationCommands,
    restartRequestService,
    taskNavigationService,
    telegramTaskActions,
    desktopSnapshotActions: {
      selectTask: desktopSelectTask,
      openTask: desktopOpenTask,
      openTurn: desktopOpenTurn,
      messageTarget: desktopMessageTarget,
      renameTask: desktopRenameTask,
      archiveTask: desktopArchiveTask,
      taskDiff: desktopTaskDiff,
      cancelRun: desktopCancelRun,
      newTask: desktopNewTask,
      rotateStream: desktopRotateStream,
      updateSetting: desktopUpdateSetting,
      restartServer: desktopRestartServer,
    },
    dispatchApplicationCommand,
    settingCommandTarget,
    selectTaskFromBinding,
  };
}
