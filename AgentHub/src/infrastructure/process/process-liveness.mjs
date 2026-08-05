export function processIsAlive(pid, killImpl = process.kill) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    killImpl(value, 0);
    return true;
  } catch (error) {
    // EPERM means that the process exists but belongs to another principal.
    return error?.code === "EPERM";
  }
}
