import assert from "node:assert/strict";
import test from "node:test";
import { albumMedia, parseArguments } from "./send-images.mjs";


test("parseArguments reads image options", () => {
  assert.deepEqual(
    parseArguments(["--bind-current", "--silent", "--caption", "Код", "one.png", "two.png"]),
    {
      help: false,
      chatId: null,
      silent: true,
      bindCurrent: true,
      bindActive: false,
      caption: "Код",
      files: ["one.png", "two.png"],
    },
  );
});

test("parseArguments validates binding and album size", () => {
  assert.throws(
    () => parseArguments(["--bind-current", "--bind-active", "one.png"]),
    /either --bind-current or --bind-active/,
  );
  assert.throws(() => parseArguments([]), /at least one image/);
  assert.throws(
    () => parseArguments(Array.from({ length: 11 }, (_, index) => `${index}.png`)),
    /at most 10 images/,
  );
});

test("albumMedia attaches caption only to the first image", () => {
  assert.deepEqual(albumMedia(["one.png", "two.png"], "Код"), [
    { type: "photo", media: "attach://photo0", caption: "Код" },
    { type: "photo", media: "attach://photo1" },
  ]);
});
