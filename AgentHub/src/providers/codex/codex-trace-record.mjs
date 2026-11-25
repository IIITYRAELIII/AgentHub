// Compaction snapshots, user input and tool results are not agent trace items. Validate their
// complete JSON structure without materializing large input/history strings.
// No projected record may supply trace content, lifecycle state or identity.
export class IgnoredTraceRecord {
  #output;
  #length = 0;
  #stringStart = null;
  #elided = false;
  #lastElided = false;
  #escape = false;
  #unicode = 0;

  constructor(maximumBytes) {
    this.#output = Buffer.allocUnsafe(maximumBytes);
  }

  #append(byte) {
    if (this.#length >= this.#output.length) throw new Error("Trace record exceeds read budget");
    this.#output[this.#length++] = byte;
  }

  push(chunk) {
    let text;
    const stringSyntax = /["\\\x00-\x1f]/g;
    for (let offset = 0; offset < chunk.length; offset += 1) {
      if (this.#stringStart !== null && this.#elided && !this.#escape && !this.#unicode) {
        // Only ordinary bytes of an already elided value can be skipped.
        text ??= chunk.toString("latin1");
        stringSyntax.lastIndex = offset;
        const syntax = stringSyntax.exec(text);
        if (!syntax) break;
        offset = syntax.index;
      }
      const byte = chunk[offset];
      if (this.#stringStart !== null) {
        let closes = false;
        if (this.#unicode) {
          if (!(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102)) {
            throw new Error("Trace source contains an invalid record");
          }
          this.#unicode -= 1;
        } else if (this.#escape) {
          if (![34, 47, 92, 98, 102, 110, 114, 116, 117].includes(byte)) {
            throw new Error("Trace source contains an invalid record");
          }
          this.#unicode = byte === 117 ? 4 : 0;
          this.#escape = false;
        } else if (byte === 34) {
          closes = true;
        } else if (byte === 92) {
          this.#escape = true;
        } else if (byte < 32) {
          throw new Error("Trace source contains an invalid record");
        }
        if (closes) {
          this.#append(byte);
          this.#lastElided = this.#elided;
          this.#stringStart = null;
        } else if (!this.#elided) {
          if (this.#length - this.#stringStart > 4096) {
            this.#length = this.#stringStart + 1;
            this.#elided = true;
          } else {
            this.#append(byte);
          }
        }
        continue;
      }
      if (byte === 58 && this.#lastElided) throw new Error("Trace record exceeds read budget");
      if (![9, 10, 13, 32].includes(byte)) this.#lastElided = false;
      if (byte === 34) {
        this.#stringStart = this.#length;
        this.#elided = false;
      }
      this.#append(byte);
    }
  }

  finish() {
    if (this.#stringStart !== null) throw new Error("Trace source contains an invalid record");
    let entry;
    try { entry = JSON.parse(this.#output.subarray(0, this.#length).toString("utf8")); }
    catch { throw new Error("Trace source contains an invalid record"); }
    const ignored = entry?.type === "compacted"
      || entry?.type === "response_item" && (entry.payload?.type === "message" && entry.payload.role === "user"
        || ["custom_tool_call_output", "customToolCallOutput", "function_call_output", "functionCallOutput"]
          .includes(entry.payload?.type));
    if (!ignored) throw new Error("Trace record exceeds read budget");
  }
}
