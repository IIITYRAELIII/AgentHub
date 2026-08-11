"use strict";

const path = require("node:path");

const LOCAL_ASSET_REFERENCE = /\b(?:src|href)=["'](\/(?!\/)[^"']+)["']/giu;
const LOCAL_ASSET_PATH = /\.(?:avif|css|gif|ico|jpe?g|js|mjs|png|svg|ttf|webp|woff2?)(?:[?#]|$)/iu;

function localAssetReferences(html) {
  return [...new Set([...String(html).matchAll(LOCAL_ASSET_REFERENCE)]
    .map((match) => match[1])
    .filter((reference) => LOCAL_ASSET_PATH.test(reference)))];
}

function localAssetPathname(reference) {
  const rawPathname = String(reference).split(/[?#]/u, 1)[0];
  let pathname;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    throw new Error(`Некорректный путь ресурса Agent Hub: ${rawPathname}`);
  }
  const segments = pathname.replace(/^\/+/, "").split("/");
  if (
    !pathname.startsWith("/")
    || pathname.startsWith("//")
    || !segments.length
    || segments.some((segment) => (
      !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.includes(":")))
  ) {
    throw new Error(`Некорректный путь ресурса Agent Hub: ${rawPathname}`);
  }
  return pathname;
}

function localAssetFile(rootDirectory, reference) {
  const root = path.resolve(rootDirectory);
  const pathname = localAssetPathname(reference);
  const target = path.resolve(root, ...pathname.slice(1).split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Ресурс Agent Hub выходит за пределы runtime: ${pathname}`);
  }
  return { pathname, relative, target };
}

function replaceLocalAssetReference(html, reference, replacement) {
  return String(html)
    .replaceAll(`"${reference}"`, `"${replacement}"`)
    .replaceAll(`'${reference}'`, `'${replacement}'`);
}

module.exports = {
  localAssetFile,
  localAssetPathname,
  localAssetReferences,
  replaceLocalAssetReference,
};
