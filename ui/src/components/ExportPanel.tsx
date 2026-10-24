import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type { EnvironmentInfo, JobSnapshot, PromptPoint, Settings, Units, VideoMeta } from "../types.ts";
import { JobStatus } from "./JobStatus.tsx";
import { Icon, LogPanel, PathField, Section, Switch } from "./parts.tsx";

const UNIT_LABELS: Record<Units, string> = {
  ane: "ANE（Neural Engine）",
  gpu: "GPU",
  all: "All",
  cpu: "CPU only",
};

export function ExportPanel(props: {
  settings: Settings;
  env: EnvironmentInfo;
  job: JobSnapshot | null;
  now: number;
  logs: string[];
  points: PromptPoint[];
  meta: VideoMeta | null;
  onPickOutDir: () => void;
  onOutDir: (value: string) => void;
  onUnits: (value: Units) => void;
  onOpenOnFinish: (value: boolean) => void;
  onExport: () => void;
  onCancel: () => void;
  onReveal: (path: string) => void;
}): JSX.Element {
  const trackRunning = () => (props.job?.kind === "track" ? props.job.running : false);
  const anyRunning = () => props.job?.running ?? false;
  const positives = () => props.points.filter((point) => point.label === 1).length;

  const blockers = () => {
    const found: string[] = [];
    if (!props.meta) found.push("Open a video");
    if (!props.env.modelsReady) found.push("Models are not converted yet (run Initialize)");
    if (!props.env.pythonReady) found.push("The Python environment is missing");
    if (!props.env.mediaReady) found.push("ffmpeg / ffprobe not found");
    if (positives() === 0) found.push("Add at least one object point");
    return found;
  };

  const ready = () => blockers().length === 0 && !anyRunning();

  return (
    <Section
      step="04"
      title="Export"
      aside={
        <Show when={props.meta}>
          {(meta) => <span class="badge">{meta().frames ? `${meta().frames} frames` : "Video"}</span>}
        </Show>
      }
    >
      <PathField
        value={props.settings.outDir}
        placeholder="/path/to/masks"
        disabled={trackRunning()}
        onBrowse={props.onPickOutDir}
        onCommit={props.onOutDir}
      />

      <div class="field-row">
        <label for="units">Compute unit</label>
        <select
          id="units"
          value={props.settings.units}
          disabled={trackRunning()}
          onChange={(event) => props.onUnits(event.currentTarget.value as Units)}
        >
          <For each={Object.keys(UNIT_LABELS) as Units[]}>
            {(unit) => <option value={unit}>{UNIT_LABELS[unit]}</option>}
          </For>
        </select>
      </div>

      <Switch
        checked={props.settings.openOnFinish}
        label="Open the folder when done"
        disabled={trackRunning()}
        onChange={props.onOpenOnFinish}
      />

      <Show when={blockers().length > 0 && !anyRunning()}>
        <ul class="blockers">
          <For each={blockers()}>{(blocker) => <li>{blocker}</li>}</For>
        </ul>
      </Show>

      <button class="btn primary wide" type="button" disabled={!ready()} onClick={props.onExport}>
        <Icon name="export" />
        Track and export
      </button>

      <JobStatus job={props.job} kind="track" now={props.now} onCancel={props.onCancel} onReveal={props.onReveal} />

      <Show when={props.logs.length > 0 || trackRunning()}>
        <LogPanel
          lines={props.logs}
          running={trackRunning()}
          tall
          empty="track.py output appears here"
        />
      </Show>
    </Section>
  );
}
