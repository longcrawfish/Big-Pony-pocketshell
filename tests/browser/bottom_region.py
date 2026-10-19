"""Bottom-area layout regression, using the local demo transport.

Start app with VITE_POCKETSHELL_DEV_HELPERS=1 vite --mode demo --port 5197.
Run with Python Playwright; PS_TEST_URL and PS_TEST_OUTPUT are optional.
No real agent or remote data is used.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

url = os.environ.get("PS_TEST_URL", "http://127.0.0.1:5197/")
out = Path(os.environ.get("PS_TEST_OUTPUT", "/tmp/pocketshell-bottom-region"))
out.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 390, "height": 844}, locale="en-US", has_touch=True)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    expect(page.locator(".conn-online")).to_be_visible()
    toggle = page.locator(".bottom-toggle")
    expect(toggle).to_have_attribute("aria-expanded", "true")
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(600)

    # Observe actual outgoing terminal resize calls, without changing app code.
    page.evaluate("""async () => {
      const { Connection } = await import('/src/lib/net/connection.ts');
      const resize = Connection.prototype.resize;
      window.layoutResizes = [];
      Connection.prototype.resize = function(sessionId, cols, rows) {
        window.layoutResizes.push({sessionId, cols, rows});
        return resize.call(this, sessionId, cols, rows);
      };
    }""")
    # Adjust the split first so restoration is checked against a user choice.
    divider = page.locator('#bottom-status [role="separator"]')
    box = divider.bounding_box()
    page.mouse.move(box["x"] + 100, box["y"] + 10)
    page.mouse.down()
    page.mouse.move(100, 480, steps=8)
    page.mouse.up()
    page.wait_for_timeout(700)
    before = page.locator(".top").bounding_box()
    page.get_by_role("button", name="✎ IME buffer", exact=True).click()
    page.locator(".ime textarea").fill("unsent draft")
    page.screenshot(path=str(out / "expanded.png"))
    page.evaluate("window.layoutResizes = []")
    toggle.click()
    for ident in ["bottom-status", "bottom-panel", "bottom-menu"]:
        expect(page.locator("#" + ident)).to_be_hidden()
    page.wait_for_function("window.layoutResizes.length > 0")
    collapsed_rows = page.evaluate("window.layoutResizes.at(-1).rows")
    collapsed = page.locator(".top").bounding_box()
    assert collapsed["height"] > before["height"] + 100
    assert abs(collapsed["y"] + collapsed["height"] - 844) < 2
    page.screenshot(path=str(out / "collapsed.png"))
    toggle.click()
    expect(page.locator(".ime textarea")).to_have_value("unsent draft")
    page.wait_for_function("rows => window.layoutResizes.at(-1).rows < rows", arg=collapsed_rows)
    restored = page.locator(".top").bounding_box()
    assert abs(restored["height"] - before["height"]) < 2

    # The old divider gesture and menu swipe continue to work after restoration.
    divider.dblclick(position={"x": 100, "y": 10})
    expect(toggle).to_have_attribute("aria-expanded", "false")
    toggle.click()
    page.locator('#bottom-menu button').filter(has_text="Files").click()
    toggle.click()
    toggle.click()
    expect(page.locator('#bottom-menu .active')).to_have_text("Files")
    menu_box = page.locator('#bottom-menu').bounding_box()
    y = menu_box["y"] + 20
    touch = context.new_cdp_session(page)
    touch.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": 300, "y": y}]})
    for x in [270, 230, 180, 130, 80]:
        touch.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]})
    touch.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    expect(page.locator('#bottom-menu .active')).to_have_text("Keyboard")

    # Editor temporarily collapses; the top button can still expand it.
    page.evaluate("window.pocketshell.openFile('/home/demo/project/src/auth.ts')")
    page.get_by_role("button", name="Edit", exact=True).click()
    expect(page.locator(".ed-root")).to_be_visible()
    expect(toggle).to_have_attribute("aria-expanded", "false")
    toggle.click()
    page.wait_for_timeout(200)
    editor = page.locator(".ed-root").bounding_box()
    top = page.locator(".top").bounding_box()
    assert editor["y"] + editor["height"] <= top["y"] + top["height"] + 1
    page.locator('.ed-bar button[aria-label="Close"]').click()
    expect(toggle).to_have_attribute("aria-expanded", "true")

    # Safe-area protection and browser fullscreen are independent of collapse.
    toggle.click()
    page.evaluate("document.documentElement.style.setProperty('--safe-bottom', '24px')")
    safe = page.locator(".top").bounding_box()
    assert abs(safe["y"] + safe["height"] - (844 - 24)) < 2
    page.locator('.topbar .fs-btn:not(.bottom-toggle)').click()
    page.wait_for_function("document.fullscreenElement !== null")
    expect(toggle).to_have_attribute("aria-expanded", "false")
    page.evaluate("document.exitFullscreen?.()")
    page.reload()
    expect(toggle).to_have_attribute("aria-expanded", "false")
    toggle.click()
    page.reload()
    expect(toggle).to_have_attribute("aria-expanded", "true")

    # Narrow portrait, landscape and desktop; also stress the crowded top bar.
    for width, height in [(320, 568), (844, 390), (1280, 800)]:
        page.set_viewport_size({"width": width, "height": height})
        page.evaluate("""() => {
          document.querySelector('.brand').firstChild.textContent = 'Very long instance name · pocketshell';
          if (!document.querySelector('.upd-badge')) {
            const badge = document.createElement('button');
            badge.textContent = 'Update available';
            badge.className = 'upd-badge';
            document.querySelector('.version').after(badge);
          }
        }""")
        for expanded in [False, True]:
            toggle.click()
            expect(toggle).to_have_attribute("aria-expanded", str(expanded).lower())
            b = toggle.bounding_box()
            assert b["x"] >= 0 and b["x"] + b["width"] <= width
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.screenshot(path=str(out / f"layout-{width}.png"))
    assert not errors, errors
    result = {"expandedHeight": before["height"], "collapsedHeight": collapsed["height"],
              "collapsedTerminalRows": collapsed_rows, "checks": "passed", "pageErrors": errors}
    (out / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
    browser.close()
