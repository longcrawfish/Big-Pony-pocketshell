<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import type { SizeState } from "../lib/net/protocol";

  let { id, session, sizeState, anchor, focusOnOpen, busy, error, online, onAction, onClose, canScroll, onScroll }: {
    id: string; session: string; sizeState: SizeState; anchor: HTMLElement;
    focusOnOpen: boolean; busy: boolean; error: boolean; online: boolean;
    onAction: (action: "acquire" | "release" | "migrate") => void;
    onClose: (restoreFocus?: boolean) => void;
    canScroll: boolean;
    onScroll: (direction: "top" | "bottom") => void;
  } = $props();
  let panel: HTMLDivElement;
  let left = $state(8), top = $state(48), width = $state(320), maxHeight = $state(400);
  function position() {
    const viewport = window.visualViewport;
    const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
    const w = viewport?.width ?? window.innerWidth, h = viewport?.height ?? window.innerHeight;
    const rect = (anchor.closest('.tab') ?? anchor).getBoundingClientRect();
    const bar = anchor.closest('.topbar')?.getBoundingClientRect();
    width = Math.max(0, Math.min(w - 16, w < 768 ? w - 16 : 360));
    left = w < 768 ? x + 8 : Math.max(x + 8, Math.min(rect.left, x + w - width - 8));
    top = Math.max(y, Math.min(bar?.bottom ?? rect.bottom, y + h - 44));
    maxHeight = Math.max(0, y + h - top - 8);
  }
  function outside(e: PointerEvent) {
    if (!(e.target instanceof Element) || panel?.contains(e.target) || e.target.closest('.tab, .add, .size-backdrop')) return;
    onClose();
  }
  function escape(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation(); onClose(true);
    }
  }
  onMount(() => {
    position();
    if (focusOnOpen) panel.focus({ preventScroll: true });
    // Keep the panel inside the visual viewport when the keyboard or orientation changes.
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('pointerdown', outside);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    observer?.observe(anchor.closest('.topbar') ?? anchor);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('pointerdown', outside);
    };
  });
</script>

<!-- The backdrop consumes the entire dismissal gesture; no pointer/mouse event
     reaches xterm. Both layers are fixed and never participate in terminal fit. -->
<button class="size-backdrop" style:top={`${top}px`} tabindex="-1" aria-label={$t('common.close')}
  onpointerdown={(e) => e.preventDefault()} onclick={() => onClose()}></button>
<div class="size-controls" bind:this={panel} {id} role="dialog" tabindex="-1"
  aria-label={`${$t('terminal.pageControls')}: ${session}`}
  style:left={`${left}px`} style:top={`${top}px`} style:width={`${width}px`} style:max-height={`${maxHeight}px`}
  onfocusout={(e) => {
    if (e.relatedTarget instanceof Node && !panel.contains(e.relatedTarget) && !anchor.closest('.toptabs')?.contains(e.relatedTarget)) onClose();
  }}>
  <div class="heading">
    <strong>{session}</strong>
    <button class="dismiss" onclick={() => onClose(true)} aria-label={$t('common.close')}>×</button>
  </div>
  <div class="size-state" role="status">
    <span>{$t(`terminal.size.${sizeState.controller}`)}</span>
    <span>{sizeState.cols} × {sizeState.rows}</span>
  </div>
  {#if sizeState.controller === 'other'}<p>{$t('terminal.size.takeoverHint')}</p>{/if}
  <div class="actions" aria-busy={busy}>
    <button disabled={busy || sizeState.blocked || !online} onclick={() => onAction(sizeState.controller === 'self' ? 'release' : 'acquire')}>
      {$t(sizeState.controller === 'self' ? 'terminal.size.release' : 'terminal.size.acquire')}
    </button>
    {#if sizeState.controller === 'none' && sizeState.policy === 'manual'}
      <button disabled={busy || sizeState.blocked || !online} onclick={() => onAction('migrate')}>{$t('terminal.size.migrate')}</button>
    {/if}
  </div>
  {#if !online}<p role="status">{$t('terminal.size.offline')}</p>{/if}
  {#if sizeState.blocked || error}<p class="error" role="status">{$t('terminal.size.failed')}</p>{/if}
  <div class="actions scroll-actions">
    <button disabled={!canScroll} onclick={() => onScroll('top')}>{$t('terminal.scrollTop')}</button>
    <button disabled={!canScroll} onclick={() => onScroll('bottom')}>{$t('terminal.scrollBottom')}</button>
  </div>
</div>

<style>
  .size-backdrop { position: fixed; inset: 0; z-index: 29; border: 0; padding: 0; background: transparent; touch-action: none; }
  .size-controls { position: fixed; z-index: 30; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; padding: 8px 12px 12px; background: var(--menu-bg, var(--panel)); color: var(--text); border: 1px solid var(--line-strong, var(--line)); border-radius: 0 0 var(--radius-md, 8px) var(--radius-md, 8px); box-shadow: var(--pop-shadow); font-size: var(--ui-small, 13px); }
  .heading, .size-state, .actions { display: flex; align-items: center; gap: 8px; }
  .heading strong { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .size-state { flex-wrap: wrap; justify-content: space-between; margin-bottom: 8px; }
  .actions { flex-wrap: wrap; }
  .scroll-actions { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
  .scroll-actions button { flex: 1; }
  button { min-height: var(--ui-touch, 44px); padding: 6px 12px; font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-sm); cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  .dismiss { width: var(--ui-touch, 44px); flex: none; padding: 0; border: 0; background: transparent; font-size: 20px; }
  button:focus-visible, .size-controls:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  p { margin: 8px 0; overflow-wrap: anywhere; }
  .error { color: var(--red); }
</style>
