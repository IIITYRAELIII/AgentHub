(() => {
  const PREFIX = "\uE200visualize\uE202";
  const END = "\uE201";
  const UNAVAILABLE = "Визуализация недоступна";
  const STATIC_SOURCES = [
    "https://cdnjs.cloudflare.com", "https://esm.sh", "https://cdn.jsdelivr.net",
    "https://unpkg.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com",
    "https://fonts.bunny.net", "https://persistent.oaistatic.com/plugins/visualize/",
  ].join(" ");
  const POLICY = [
    "default-src 'none'", "base-uri 'none'", "connect-src 'none'", "object-src 'none'",
    "form-action 'none'", "frame-src 'none'", "worker-src 'none'",
    "img-src data: blob:", "media-src data: blob:",
    "script-src 'unsafe-inline' " + STATIC_SOURCES,
    "style-src 'unsafe-inline' " + STATIC_SOURCES,
    "font-src data: https://fonts.gstatic.com https://fonts.bunny.net",
  ].join("; ");

  function markerLine(line) {
    return String(line).trimStart().startsWith(PREFIX);
  }

  function markerMetadata(marker) {
    if (!marker.endsWith(END) || marker.length > 4096) return null;
    try {
      const value = JSON.parse(marker.slice(PREFIX.length, -END.length));
      return typeof value?.path === "string" && value.path ? {
        wide: value.mode === "wide",
        title: typeof value.title === "string" ? value.title.trim().slice(0, 160) : "",
      } : null;
    } catch {
      return null;
    }
  }

  function frameDocument(html, dark) {
    const scheme = dark ? "dark" : "light";
    return '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<meta http-equiv="Content-Security-Policy" content="' + POLICY + '">'
      + '<style>:root{color-scheme:' + scheme + ';--background:Canvas;--foreground:CanvasText;'
      + '--primary:Highlight;--primary-foreground:HighlightText;--font-size-base:14px}'
      + 'html,body{margin:0;padding:0;background:transparent;color:CanvasText}'
      + 'body{font:14px/1.45 system-ui,sans-serif}img{max-width:100%;height:auto}</style></head><body>'
      + '<script>addEventListener("DOMContentLoaded",()=>{const report=()=>parent.postMessage('
      + '{kind:"agent-hub-visualization-size",height:Math.ceil(document.body.getBoundingClientRect().height)},"*");'
      + 'new ResizeObserver(report).observe(document.body);report();});</script>'
      + html + "</body></html>";
  }

  function frameDataUrl(html, hostColor) {
    const channels = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(hostColor);
    const dark = channels
      ? (0.299 * Number(channels[1]) + 0.587 * Number(channels[2]) + 0.114 * Number(channels[3])) > 128
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const data = new TextEncoder().encode(frameDocument(html, dark));
    let bytes = "";
    for (let offset = 0; offset < data.length; offset += 8192) {
      bytes += String.fromCharCode(...data.subarray(offset, offset + 8192));
    }
    return "data:text/html;charset=utf-8;base64," + btoa(bytes);
  }

  class MessageVisualization extends HTMLElement {
    #observer;
    #watching = false;
    #requested = false;
    #frame;
    #input;
    #status;

    configure(input) {
      this.#input = input;
      this.classList.add("message-visualization");
      if (input.metadata?.wide) this.classList.add("is-wide");
      this.#status = document.createElement("span");
      this.#status.setAttribute("role", "status");
      this.#status.textContent = input.metadata && input.load ? "Загрузка визуализации…" : UNAVAILABLE;
      this.append(this.#status);
    }

    connectedCallback() {
      if (!this.#input?.load || !this.#input?.metadata) return;
      if (this.#frame) this.#watchFrame();
      if (this.#requested) return;
      if (typeof IntersectionObserver === "undefined") { void this.#load(); return; }
      this.#observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void this.#load();
      });
      this.#observer.observe(this);
    }

    disconnectedCallback() {
      this.#observer?.disconnect();
      if (this.#watching) {
        window.removeEventListener("message", this.#resize);
        this.#watching = false;
      }
    }

    #resize = (event) => {
      if (!this.#frame || event.source !== this.#frame.contentWindow || event.origin !== "null"
        || event.data?.kind !== "agent-hub-visualization-size" || !Number.isFinite(event.data.height)) return;
      const height = Math.min(1024, Math.max(32, Math.ceil(event.data.height)));
      this.#frame.height = String(height);
    };

    #watchFrame() {
      if (this.#watching || !this.isConnected) return;
      this.#watching = true;
      window.addEventListener("message", this.#resize);
    }

    async #load() {
      if (!this.isConnected || this.#requested) return;
      this.#observer?.disconnect();
      this.#requested = true;
      try {
        const { marker, metadata, load } = this.#input;
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(marker)));
        const html = await load(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""));
        if (typeof html !== "string" || !html) throw new Error(UNAVAILABLE);
        const shell = document.querySelector('link[rel="agent-hub-visualization-frame"]')?.href;
        if (!shell) throw new Error(UNAVAILABLE);
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.referrerPolicy = "no-referrer";
        frame.title = metadata.title || "Визуализация";
        frame.width = "100%";
        frame.height = "180";
        const url = frameDataUrl(html, getComputedStyle(this).color);
        frame.addEventListener("load", () => {
          frame.contentWindow?.postMessage({ kind: "agent-hub-visualization-content", url, title: frame.title }, "*");
        }, { once: true });
        frame.src = shell;
        this.#frame = frame;
        this.#watchFrame();
        this.replaceChildren(frame);
      } catch {
        this.#status.textContent = UNAVAILABLE;
      }
    }
  }

  customElements.define("hub-message-visualization", MessageVisualization);
  window.AgentHubVisualization = {
    markerLine,
    card(line, load) {
      const marker = line.trim();
      const card = document.createElement("hub-message-visualization");
      card.configure({ marker, metadata: markerMetadata(marker), load });
      return card;
    },
  };
})();
