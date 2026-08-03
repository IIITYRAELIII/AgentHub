export async function recycleCodexCompactionTransport({
  stop,
  sanitize,
  start,
  initialize,
}) {
  let result = null;
  let error = null;
  try {
    await stop();
    result = await sanitize();
  } catch (caught) {
    error = caught;
  }
  try {
    await start();
    await initialize();
  } catch (caught) {
    error ??= caught;
  }
  return { result, error };
}
