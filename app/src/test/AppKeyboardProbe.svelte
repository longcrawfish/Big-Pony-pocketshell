<script lang="ts">
  import type { AppCommand } from "../lib/term/input-router";
  let { onCommand }: { onCommand: (command: AppCommand) => void } = $props();
  let draft = $state("");
</script>

<input aria-label="Keyboard draft" bind:value={draft} />
<button onclick={() => onCommand({ type: "toggleFullscreen" })}>Toggle content fullscreen</button>
