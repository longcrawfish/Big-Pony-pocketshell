import { fireEvent, render } from "@testing-library/svelte";
import { expect, test, vi } from "vitest";
import InstanceMenu from "./InstanceMenu.svelte";

const props = () => ({
  instanceName: "生产服务器-完整名称", status: "online" as const, version: "1.2.3",
  fullscreen: false, onFullscreen: vi.fn(), onUpdate: vi.fn(),
});

test("menu exposes full identity and version, Escape restores focus, outside presses dismiss", async () => {
  const view = render(InstanceMenu, props());
  const trigger = view.getByRole("button", { name: /实例与应用菜单/ });
  expect(view.queryByRole("dialog")).not.toBeInTheDocument();
  await fireEvent.click(trigger);
  const dialog = view.getByRole("dialog");
  expect(dialog).toHaveFocus();
  expect(dialog).toHaveTextContent("生产服务器-完整名称");
  expect(dialog).toHaveTextContent("PocketShell · v1.2.3");
  await fireEvent.keyDown(window, { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await fireEvent.click(trigger);
  await fireEvent.pointerDown(document.body);
  expect(view.queryByRole("dialog")).not.toBeInTheDocument();
});

test("update and fullscreen actions dismiss before invoking their handlers", async () => {
  const p = { ...props(), hasUpdate: true };
  const view = render(InstanceMenu, p);
  const trigger = view.getByRole("button", { name: /实例与应用菜单/ });
  expect(trigger).toHaveAccessibleName(/有新版本/);
  await fireEvent.click(trigger);
  await fireEvent.click(view.getByRole("button", { name: "有新版本" }));
  expect(p.onUpdate).toHaveBeenCalledOnce();
  expect(view.queryByRole("dialog")).not.toBeInTheDocument();
  await fireEvent.click(trigger);
  await fireEvent.click(view.getByRole("button", { name: "全屏" }));
  expect(p.onFullscreen).toHaveBeenCalledOnce();
  expect(trigger).toHaveFocus();
  await view.rerender({ ...p, fullscreen: true });
  await fireEvent.click(trigger);
  expect(view.getByRole("button", { name: "退出全屏" })).toBeInTheDocument();
});

test("eink keeps status readable and tabbing outside closes the nonmodal panel", async () => {
  const view = render(InstanceMenu, { ...props(), instanceName: null, eink: true, status: "offline" });
  expect(view.getByRole("status")).toHaveTextContent("已断开");
  const trigger = view.getByRole("button", { name: /PocketShell/ });
  await fireEvent.click(trigger);
  await fireEvent.focusOut(view.getByRole("dialog"), { relatedTarget: document.body });
  expect(view.queryByRole("dialog")).not.toBeInTheDocument();
});
