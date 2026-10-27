// Intentionally never registers the capture protocol. The parent's unchanged
// real deadline must terminate this live IPC child even before capture starts.
process.on("message", () => {});
