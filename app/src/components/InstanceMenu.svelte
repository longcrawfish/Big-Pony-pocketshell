<script lang="ts">
  import { tick } from "svelte";
  import { t } from "svelte-i18n";
  import type { ConnStatus } from "../lib/net/connection";

  let { instanceName, status, version, hasUpdate = false, eink = false,
    fullscreen, onFullscreen, onUpdate }: {
    instanceName: string | null;
    status: ConnStatus;
    version: string;
    hasUpdate?: boolean;
    eink?: boolean;
    fullscreen: boolean;
    onFullscreen: () => void;
    onUpdate: () => void;
  } = $props();

  const id = $props.id();
  const name = $derived(instanceName?.trim() || "PocketShell");
  let open = $state(false);
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let panel = $state<HTMLDivElement>();

  function close(restoreFocus = false) {
    open = false;
    if (restoreFocus) trigger?.focus({ preventScroll: true });
  }
  async function toggle() {
    if (open) { close(); return; }
    open = true;
    await tick();
    if (open) panel?.focus({ preventScroll: true });
  }
  function outside(e: PointerEvent) {
    if (open && e.target instanceof Node && !root.contains(e.target)) close();
  }
  function escape(e: KeyboardEvent) {
    if (open && e.key === "Escape") {
      e.preventDefault();
      close(true);
    }
  }
</script>

<svelte:window onpointerdown={outside} onkeydown={escape} />

<div class="instance-menu" bind:this={root}
  onfocusout={(e) => { if (e.relatedTarget instanceof Node && !root.contains(e.relatedTarget)) close(); }}>
  <button class="instance-trigger" bind:this={trigger} onclick={toggle}
    aria-label={`${$t('app.instanceMenu')}: ${name}${hasUpdate ? ` · ${$t('update.badge')}` : ''}`}
    aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
    title={name}>
    <span class="instance-name">{name}</span>
    <span class="instance-state">
      <span class="conn conn-{status}" role="status" aria-label={$t('app.status.' + status)} title={$t('app.status.' + status)}>
        <span class="conn-dot" aria-hidden="true"></span>
        {#if eink}<span class="conn-label">{$t('app.status.' + status)}</span>{/if}
      </span>
      <span class="menu-indicator" class:has-update={hasUpdate} aria-hidden="true">{hasUpdate ? '↑' : '⌄'}</span>
    </span>
  </button>
  {#if open}
    <div class="instance-panel" bind:this={panel} {id} role="dialog" tabindex="-1" aria-label={$t('app.instanceMenu')}>
      <div class="panel-heading">
        <div class="instance-info">
          <strong>{name}</strong>
          <span class="version">PocketShell{version ? ` · v${version}` : ''}</span>
          <span>{$t('app.status.' + status)}</span>
        </div>
        <button class="dismiss" onclick={() => close(true)} aria-label={$t('common.close')}>×</button>
      </div>
      {#if hasUpdate}
        <button class="menu-action update-action" onclick={() => { close(true); onUpdate(); }}>
          <span aria-hidden="true">↑</span>{$t('update.badge')}
        </button>
      {/if}
      <button class="menu-action" onclick={() => { close(true); onFullscreen(); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          {#if fullscreen}<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
          {:else}<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />{/if}
        </svg>
        {fullscreen ? $t('app.fullscreen.exit') : $t('app.fullscreen.enter')}
      </button>
    </div>
  {/if}
</div>

<style>
  .instance-menu { position: relative; flex: 0 0 auto; width: clamp(60px, 22vw, 104px); align-self: center; }
  button { font: inherit; color: var(--text); cursor: pointer; }
  .instance-trigger {
    display: flex; flex-direction: column; justify-content: center; align-items: flex-start;
    width: 100%; min-height: var(--ui-touch, 44px); padding: 2px 7px;
    border: 0; border-radius: var(--radius-sm); background: transparent;
  }
  .instance-trigger:hover, .instance-trigger[aria-expanded="true"], .menu-action:hover { background: var(--keyhi); }
  .instance-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--ui-small, 12px); font-weight: 700; }
  .instance-state { display: flex; align-items: center; gap: 5px; width: 100%; min-width: 0; }
  .conn { display: flex; align-items: center; gap: 4px; min-width: 0; color: var(--dim); }
  .conn-online { color: var(--ok); }
  .conn-connecting { color: var(--amber); }
  .conn-offline { color: var(--red); }
  .conn-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: currentColor; }
  .conn-label { color: var(--text); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu-indicator { flex: none; width: 12px; font-size: 12px; line-height: 14px; color: var(--dim); text-align: center; }
  .has-update { color: var(--accent); font-weight: 700; border: 1px solid currentColor; border-radius: 3px; }
  .instance-panel {
    position: absolute; z-index: 35; top: calc(100% + 5px); left: 0;
    width: min(320px, calc(100vw - 16px - env(safe-area-inset-left) - env(safe-area-inset-right)));
    max-height: calc(100dvh - 72px - var(--safe-top)); overflow-y: auto;
    background: var(--menu-bg); border: 1px solid var(--line-strong); border-radius: var(--radius-xl);
    box-shadow: var(--pop-shadow); padding: 6px; font-size: var(--ui-small, 13px);
  }
  .panel-heading { display: flex; align-items: flex-start; border-bottom: 1px solid var(--line); padding: 2px 0 10px 8px; margin-bottom: 4px; }
  .instance-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; padding-top: 7px; overflow-wrap: anywhere; }
  .version { color: var(--dim); }
  .dismiss { flex: none; width: var(--ui-touch, 44px); height: var(--ui-touch, 44px); border: 0; background: transparent; font-size: 20px; }
  .menu-action { display: flex; align-items: center; gap: 10px; width: 100%; min-height: var(--ui-touch, 44px); padding: 8px; text-align: left; border: 0; border-radius: var(--radius-sm); background: transparent; }
  .menu-action svg { width: 18px; height: 18px; flex: none; }
  .update-action { color: var(--accent); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  @media (min-width: 768px) { .instance-menu { width: 144px; } }
</style>
