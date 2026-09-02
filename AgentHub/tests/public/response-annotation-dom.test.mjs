import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class FakeText {
  constructor(data) {
    this.data = data;
    this.parentNode = null;
  }

  get textContent() { return this.data; }

  splitText(offset) {
    const tail = new FakeText(this.data.slice(offset));
    this.data = this.data.slice(0, offset);
    const index = this.parentNode.childNodes.indexOf(this);
    tail.parentNode = this.parentNode;
    this.parentNode.childNodes.splice(index + 1, 0, tail);
    return tail;
  }

  replaceWith(...nodes) {
    const index = this.parentNode.childNodes.indexOf(this);
    for (const node of nodes) node.parentNode = this.parentNode;
    this.parentNode.childNodes.splice(index, 1, ...nodes);
  }
}

class FakeElement {
  constructor(ownerDocument, className = "") {
    this.ownerDocument = ownerDocument;
    this.className = className;
    this.childNodes = [];
    this.parentNode = null;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  get textContent() { return this.childNodes.map((node) => node.textContent).join(""); }

  contains(target) {
    return this === target || this.childNodes.some((node) => (
      node === target || (node instanceof FakeElement && node.contains(target))
    ));
  }

  replaceWith(...nodes) {
    const index = this.parentNode.childNodes.indexOf(this);
    for (const node of nodes) node.parentNode = this.parentNode;
    this.parentNode.childNodes.splice(index, 1, ...nodes);
  }

  normalize() {
    for (const child of this.childNodes) child.normalize?.();
    for (let index = this.childNodes.length - 1; index > 0; index -= 1) {
      const current = this.childNodes[index];
      const previous = this.childNodes[index - 1];
      if (current instanceof FakeText && previous instanceof FakeText) {
        previous.data += current.data;
        this.childNodes.splice(index, 1);
      }
    }
  }
}

function textNodes(root) {
  const values = [];
  const visit = (node) => {
    if (node instanceof FakeText) values.push(node);
    else node.childNodes.forEach(visit);
  };
  visit(root);
  return values;
}

class FakeRange {
  constructor(document) {
    this.document = document;
    this.root = null;
    this.startContainer = null;
    this.startOffset = 0;
    this.endContainer = null;
    this.endOffset = 0;
  }

  selectNodeContents(root) {
    this.root = root;
    const nodes = textNodes(root);
    this.startContainer = nodes[0];
    this.startOffset = 0;
    this.endContainer = nodes.at(-1);
    this.endOffset = nodes.at(-1).data.length;
  }

  setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }
  setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }

  absolute(node, offset) {
    let total = 0;
    for (const candidate of textNodes(this.root ?? this.document.root)) {
      if (candidate === node) return total + offset;
      total += candidate.data.length;
    }
    throw new Error("boundary outside root");
  }

  toString() {
    const root = this.root ?? this.document.root;
    const text = root.textContent;
    return text.slice(
      this.absolute(this.startContainer, this.startOffset),
      this.absolute(this.endContainer, this.endOffset),
    );
  }

  cloneContents() { return { textContent: this.toString() }; }
}

class FakeDocument {
  createElement() { return new FakeElement(this); }
  createRange() { return new FakeRange(this); }
  createTreeWalker(root) {
    const nodes = textNodes(root);
    let index = -1;
    return {
      currentNode: null,
      nextNode() {
        index += 1;
        if (index >= nodes.length) return false;
        this.currentNode = nodes[index];
        return true;
      },
    };
  }
}

function nestedText(document, value, className = "") {
  const element = new FakeElement(document, className);
  element.append(new FakeText(value));
  return element;
}

test("exact DOM ranges highlight across Markdown and code nodes then clean up", async () => {
  const script = await readFile(
    new URL("../../assets/web-app/messages/disclosure.js", import.meta.url),
    "utf8",
  );
  const context = vm.createContext({});
  context.window = context;
  vm.runInContext(script, context);
  const api = context.AgentHubMessageDisclosure;
  const document = new FakeDocument();
  const surface = new FakeElement(document, "turn-trace-reasoning");
  const before = new FakeText("duplicate ");
  const strong = nestedText(document, "target", "strong");
  const between = new FakeText(" and ");
  const code = nestedText(document, "code", "code");
  const after = new FakeText(" split");
  surface.append(before, strong, between, code, after);
  document.root = surface;
  const selected = document.createRange();
  selected.root = surface;
  selected.setStart(strong.childNodes[0], 0);
  selected.setEnd(code.childNodes[0], 4);
  const offsets = api.domRangeOffsets(surface, selected);
  const highlight = api.highlightResponseAnnotationRange(surface, offsets.start, offsets.end);
  const highlighted = textNodes(surface)
    .filter((node) => node.parentNode?.className === "msg-source-citation-highlight")
    .map((node) => node.data)
    .join("");
  assert.equal(highlight.rangeText, "target and code");
  assert.equal(highlighted, "target and code");
  assert.equal(surface.textContent, "duplicate target and code split");
  highlight.cleanup();
  assert.equal(surface.textContent, "duplicate target and code split");
  assert.equal(textNodes(surface).some((node) => node.parentNode?.className === "msg-source-citation-highlight"), false);
});
