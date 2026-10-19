<script lang="ts">
  let { path, active, onEditingChange }: {
    path: string; active: boolean; onEditingChange?: (editing: boolean) => void;
  } = $props();
  let editing = $state(false);
</script>

<div data-testid="file-{path}" data-active={String(active)}>
  <button onclick={() => { editing = !editing; onEditingChange?.(editing); }}>Toggle editor {path}</button>
</div>
