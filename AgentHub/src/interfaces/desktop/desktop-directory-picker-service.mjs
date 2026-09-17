import { pickWindowsDirectory } from "../../infrastructure/process/windows-directory-picker.mjs";

const LOCAL_PICKER_SOURCES = new Set([
  "desktop-control",
  "local-mini-app",
  "local-vscode-webview",
  "vscode",
]);

export class DesktopDirectoryPickerService {
  #pickDirectory;

  constructor({ pickDirectory = pickWindowsDirectory } = {}) {
    if (typeof pickDirectory !== "function") throw new TypeError("pickDirectory is required");
    this.#pickDirectory = pickDirectory;
  }

  async browse(params = {}, context = {}) {
    const source = String(context?.source ?? "desktop-control").trim();
    if (!LOCAL_PICKER_SOURCES.has(source)) {
      const error = new Error("Выбор каталога через Проводник доступен только в локальном Agent Hub");
      error.code = "directory-picker-unavailable";
      throw error;
    }
    const initialPath = String(params?.initialPath ?? "").trim();
    if (initialPath.length > 1_000) throw new Error("Путь к каталогу слишком длинный");
    return this.#pickDirectory({ initialPath });
  }
}
