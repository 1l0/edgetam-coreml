import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type { PromptPoint } from "../types.ts";
import { MAX_PROMPT_POINTS } from "../types.ts";
import { Icon, Section } from "./parts.tsx";

export function PointsPanel(props: {
  points: PromptPoint[];
  mode: 1 | 0;
  disabled: boolean;
  onMode: (mode: 1 | 0) => void;
  onFlip: (index: number) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}): JSX.Element {
  const positives = () => props.points.filter((point) => point.label === 1).length;

  return (
    <Section
      step="03"
      title="Points"
      aside={
        <span class={["badge", { good: props.points.length === MAX_PROMPT_POINTS }]}>
          {props.points.length} / {MAX_PROMPT_POINTS}
        </span>
      }
    >
      <div class="segmented" role="group" aria-label="Type of point to add">
        <button
          type="button"
          class={[{ active: props.mode === 1 }]}
          disabled={props.disabled}
          onClick={() => props.onMode(1)}
        >
          <span class="dot positive" />
          Object
        </button>
        <button
          type="button"
          class={[{ active: props.mode === 0 }]}
          disabled={props.disabled}
          onClick={() => props.onMode(0)}
        >
          <span class="dot negative" />
          Background
        </button>
      </div>

      <p class="hint">
        Click the frame to add a point; click a marker to remove it. <kbd>⌫</kbd> removes the last one.
        Object and background share a limit of {MAX_PROMPT_POINTS} points.
      </p>

      <Show
        when={props.points.length > 0}
        fallback={<p class="empty">No points yet. Click the object.</p>}
      >
        <ul class="points">
          <For each={props.points}>
            {(point, index) => (
              <li class={{ negative: point.label === 0 }}>
                <span class="point-index">{index() + 1}</span>
                <span class="point-kind">{point.label === 1 ? "Object" : "Background"}</span>
                <span class="point-coords mono">
                  {point.x}, {point.y}
                </span>
                <button
                  class="btn icon tiny"
                  type="button"
                  title={point.label === 1 ? "Mark as background" : "Mark as object"}
                  aria-label={point.label === 1 ? "Mark as background" : "Mark as object"}
                  disabled={props.disabled}
                  onClick={() => props.onFlip(index())}
                >
                  <span class={["dot", { positive: point.label === 1, negative: point.label === 0 }]} />
                </button>
                <button
                  class="btn icon tiny danger"
                  type="button"
                  title="Remove"
                  aria-label="Remove"
                  disabled={props.disabled}
                  onClick={() => props.onRemove(index())}
                >
                  <Icon name="trash" size={14} />
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <div class="row between">
        <span class="dim mono">
          Object {positives()} · Background {props.points.length - positives()}
        </span>
        <button
          class="btn ghost small"
          type="button"
          disabled={props.disabled || props.points.length === 0}
          onClick={props.onClear}
        >
          Clear all
        </button>
      </div>
    </Section>
  );
}
