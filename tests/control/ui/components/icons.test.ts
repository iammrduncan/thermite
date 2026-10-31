import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  APPLE_TOUCH_ICON,
  FAVICON_ICO,
  FAVICON_SVG,
  ICON_LINKS,
} from "../../../../src/control/ui/components/icons.ts";

const site = (name: string) =>
  readFileSync(new URL(`../../../../docs/_site/public/${name}`, import.meta.url));

describe("the dashboard's icons", () => {
  test("are the docs site's flame, byte for byte", () => {
    assert.equal(FAVICON_SVG, site("favicon.svg").toString("utf8").trim());
    assert.ok(FAVICON_ICO.equals(site("favicon.ico")), "favicon.ico differs from the site's");
    assert.ok(
      APPLE_TOUCH_ICON.equals(site("apple-touch-icon.png")),
      "apple-touch-icon.png differs from the site's",
    );
  });

  test("a page's head links all three", () => {
    for (const href of ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"])
      assert.match(ICON_LINKS, new RegExp(`href="${href}"`));
  });
});
