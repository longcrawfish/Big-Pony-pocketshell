import { test, expect } from "vitest";
import { previewAssets } from "./preview-assets";

test("explicit resources resolve relative to the entry; secret and external refs are excluded", () => {
  const files = previewAssets('<img src="../a.png"><script src="main.js"></script><img src=".env"><img src="%2Egit/config"><img src="https://other/a.png"><img src="data:image/png,x"><img src="settings.json"><link rel="stylesheet" href="style.css">', "html", "web/index.html");
  expect(files).toEqual(["web/index.html", "a.png", "web/main.js", "web/style.css"]);
});
test("Markdown grants images only and excessive input skips expensive parsing", () => {
  expect(previewAssets('[code](code.js) ![pic](a.png)', "markdown", "docs/readme.md")).toEqual(["docs/a.png"]);
  expect(previewAssets("x".repeat(129 * 1024), "markdown", "a.md")).toEqual([]);
  expect(previewAssets("\n".repeat(3001), "html", "a.html")).toEqual(["a.html"]);
});
