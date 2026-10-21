import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, test, vi } from "vitest";
import { tick } from "svelte";
import TopTabs from "./TopTabs.svelte";
import type { SizeState } from "../lib/net/protocol";
import type { SizeClient } from "../lib/net/size-client";

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
});

function fixture() {
  const state = (sessionId: string, controller: SizeState['controller'] = 'self'): SizeState => ({
    sessionId, controller, window: '@1', revision: '1', cols: 120, rows: 36,
    policy: 'latest', effective: 'latest', blocked: false,
  });
  const listeners = new Set<(s: SizeState) => void>();
  const client = {
    states: new Map([['alpha', state('alpha')], ['beta', state('beta', 'other')]]),
    on: (cb: (s: SizeState) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    acquire: vi.fn(async () => {}), release: vi.fn(async () => {}), migrate: vi.fn(async () => {}),
  };
  const props = {
    tabs: [
      { id: 'alpha', title: 'alpha', kind: 'term' as const, state: 'idle' as const, closed: false, shell: false },
      { id: 'beta', title: 'beta', kind: 'term' as const, state: 'idle' as const, closed: false, shell: false },
      { id: 'shell', title: 'shell', kind: 'term' as const, state: 'idle' as const, closed: false, shell: true },
      { id: 'file:a', title: 'a.txt', kind: 'file' as const, path: '/a.txt' },
    ],
    activeId: 'alpha', sizeControl: client as unknown as SizeClient, online: true,
    canScroll: true, onScroll: vi.fn(),
    onSelect: vi.fn(), onNew: vi.fn(), onCloseTab: vi.fn(), onCopyPath: vi.fn(),
  };
  const view = render(TopTabs, props);
  props.onSelect.mockImplementation((id: string) => { props.activeId = id; void view.rerender({ activeId: id }); });
  const tab = (id: string) => view.container.querySelector<HTMLElement>(`.tab[title="${id}"]`)!;
  const emit = async (s: SizeState) => { client.states.set(s.sessionId, s); listeners.forEach(cb => cb(s)); await tick(); };
  return { view, props, client, tab, state, emit };
}

test('tmux active tab toggles without closing; switching selects first, arrows open directly', async () => {
  const { view, tab, props } = fixture();
  expect(view.queryByRole('dialog')).not.toBeInTheDocument();
  await fireEvent.click(tab('alpha'));
  expect(view.getByRole('dialog')).toHaveTextContent('本页控制尺寸');
  await fireEvent.click(tab('alpha'));
  expect(view.queryByRole('dialog')).not.toBeInTheDocument();
  // Pointer route, including fast consecutive taps, must not use double-tap close.
  for (let i = 0; i < 2; i++) {
    await fireEvent.pointerDown(tab('alpha'));
    await fireEvent.pointerUp(tab('alpha'));
  }
  expect(view.queryByRole('dialog')).not.toBeInTheDocument();
  expect(props.onCloseTab).not.toHaveBeenCalled();
  await fireEvent.click(tab('beta'));
  expect(props.onSelect).toHaveBeenLastCalledWith('beta');
  expect(view.queryByRole('dialog')).not.toBeInTheDocument();
  await fireEvent.click(view.getByRole('button', { name: '页面控制: alpha' }));
  expect(props.onSelect).toHaveBeenLastCalledWith('alpha');
  expect(view.getByRole('dialog')).toHaveAccessibleName('页面控制: alpha');
  await view.rerender({ activeId: 'file:a' });
  expect(view.queryByRole('dialog')).not.toBeInTheDocument();
  expect(tab('/a.txt').querySelector('.size-toggle')).toBeNull();
  expect(tab('shell').querySelector('.size-toggle')).toBeNull();
});

test('server changes update panel and collapsed label; closed tabs lose size actions', async () => {
  const { view, tab, emit, state } = fixture();
  await fireEvent.click(tab('alpha'));
  await emit(state('alpha', 'other'));
  expect(view.getByRole('dialog')).toHaveTextContent('另一客户端控制尺寸');
  expect(view.getByRole('button', { name: '接管尺寸' })).toBeEnabled();
  await fireEvent.keyDown(window, { key: 'Escape' });
  expect(tab('alpha')).toHaveFocus();
  expect(tab('alpha')).toHaveTextContent('他端控尺寸');
  await emit({ ...state('alpha'), blocked: true });
  expect(view.getByRole('status', { name: '尺寸操作未完成，请重新检查窗口状态。' })).toBeVisible();
  await fireEvent.click(tab('alpha'));
  expect(view.getByRole('button', { name: '释放尺寸' })).toBeDisabled();
  await view.rerender({ tabs: [{ id: 'alpha', title: 'alpha', kind: 'term', state: 'idle', closed: true, shell: false }] });
  expect(view.queryByRole('dialog')).not.toBeInTheDocument();
  expect(tab('alpha').querySelector('.size-toggle')).toBeNull();
});

test('pending actions stay with their original session and failures remain visible after closing', async () => {
  const { view, tab, client, props } = fixture();
  let reject!: (reason: Error) => void;
  client.release.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail; }));
  await fireEvent.click(tab('alpha'));
  await fireEvent.click(view.getByRole('button', { name: '释放尺寸' }));
  expect(client.release).toHaveBeenCalledExactlyOnceWith('alpha');
  expect(view.getByRole('button', { name: '释放尺寸' })).toBeDisabled();
  await fireEvent.click(view.getByRole('button', { name: '页面控制: beta' }));
  reject(new Error('offline'));
  await waitFor(() => expect(tab('alpha')).toHaveTextContent('!'));
  expect(view.getByRole('dialog')).toHaveAccessibleName('页面控制: beta');
  expect(view.getByRole('dialog')).not.toHaveTextContent('尺寸操作未完成');
  await fireEvent.click(view.getByRole('button', { name: '接管尺寸' }));
  expect(client.acquire).toHaveBeenCalledExactlyOnceWith('beta');
  await view.rerender({ ...props, online: false });
  if (!view.queryByRole('dialog')) await fireEvent.click(tab('beta'));
  expect(view.getByRole('button', { name: '接管尺寸' })).toBeDisabled();
});

test('manual recovery keeps confirmation; outside dismissal consumes pointerdown; explicit close remains', async () => {
  const { view, tab, client, emit, state } = fixture();
  await emit({ ...state('alpha', 'none'), policy: 'manual' });
  await fireEvent.click(tab('alpha'));
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await fireEvent.click(view.getByRole('button', { name: '恢复继承策略' }));
  expect(client.migrate).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await fireEvent.click(view.getByRole('button', { name: '恢复继承策略' }));
  expect(client.migrate).toHaveBeenCalledExactlyOnceWith('alpha');
  confirm.mockRestore();
  const backdrop = view.container.querySelector('.size-backdrop')!;
  const press = new Event('pointerdown', { bubbles: true, cancelable: true });
  backdrop.dispatchEvent(press);
  expect(press.defaultPrevented).toBe(true);
  await fireEvent.click(backdrop);
  expect(view.queryByRole('dialog')).not.toBeInTheDocument();
  await fireEvent.click(tab('alpha'));
  await fireEvent.pointerDown(view.container.querySelector('.strip')!);
  expect(view.queryByRole('dialog')).not.toBeInTheDocument();
  await fireEvent.pointerUp(tab('alpha').querySelector('.x')!);
  expect(view.getByRole('dialog')).toHaveTextContent('alpha');
  expect(view.queryByRole('button', { name: '恢复继承策略' })).not.toBeInTheDocument();
});

test('scroll actions target the open session, dismiss the panel and restore tab focus', async () => {
  const { view, tab, props, client } = fixture();
  await fireEvent.click(tab('alpha'));
  await fireEvent.click(view.getByRole('button', { name: '滚动到顶部' }));
  expect(props.onScroll).toHaveBeenLastCalledWith('alpha', 'top');
  expect(view.queryByRole('dialog')).not.toBeInTheDocument();
  expect(tab('alpha')).toHaveFocus();

  await fireEvent.click(tab('beta'));
  await fireEvent.click(tab('beta'));
  await fireEvent.click(view.getByRole('button', { name: '滚动到底部' }));
  expect(props.onScroll).toHaveBeenLastCalledWith('beta', 'bottom');
  expect(view.queryByRole('dialog')).not.toBeInTheDocument();
  expect(tab('beta')).toHaveFocus();
  expect(client.acquire).not.toHaveBeenCalled();
  expect(client.release).not.toHaveBeenCalled();
});

test('local scroll stays available offline, blocked, released or during a size request', async () => {
  const { view, tab, props, client, emit, state } = fixture();
  client.release.mockImplementation(() => new Promise<void>(() => {}));
  await fireEvent.click(tab('alpha'));
  await fireEvent.click(view.getByRole('button', { name: '释放尺寸' }));
  expect(view.getByRole('button', { name: '释放尺寸' })).toBeDisabled();
  await fireEvent.click(view.getByRole('button', { name: '滚动到顶部' }));
  expect(props.onScroll).toHaveBeenLastCalledWith('alpha', 'top');

  await emit({ ...state('alpha', 'none'), blocked: true });
  await view.rerender({ online: false });
  await fireEvent.click(tab('alpha'));
  expect(view.getByRole('button', { name: '接管尺寸' })).toBeDisabled();
  await fireEvent.click(view.getByRole('button', { name: '滚动到底部' }));
  expect(props.onScroll).toHaveBeenLastCalledWith('alpha', 'bottom');
});

test('unavailable terminals disable scrolling and become usable when ready', async () => {
  const { view, tab, props } = fixture();
  await view.rerender({ canScroll: false });
  await fireEvent.click(tab('alpha'));
  for (const name of ['滚动到顶部', '滚动到底部']) {
    const button = view.getByRole('button', { name });
    expect(button).toBeDisabled();
    await fireEvent.click(button);
  }
  expect(props.onScroll).not.toHaveBeenCalled();
  expect(view.getByRole('dialog')).toBeVisible();
  await view.rerender({ canScroll: true });
  if (!view.queryByRole('dialog')) await fireEvent.click(tab('alpha'));
  expect(view.getByRole('button', { name: '滚动到顶部' })).toBeEnabled();
});
