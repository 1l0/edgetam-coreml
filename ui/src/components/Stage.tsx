import type { JSX } from "@solidjs/web";
import { For, Show, createEffect, createSignal } from "solid-js";
import type { PromptPoint, VideoMeta } from "../types.ts";
import { Icon } from "./parts.tsx";

interface StageProps {
  meta: VideoMeta;
  streamUrl: string;
  posterUrl: string;
  points: PromptPoint[];
  /** 0-based frame the points belong to; the player parks there when points are added. */
  promptFrame: number;
  locked: boolean;
  onAdd: (x: number, y: number) => void;
  onTime: (seconds: number) => void;
  onRemove: (index: number) => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00.00";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, "0")}`;
}

/** The video preview and the prompt editor: points live in the prompt frame's pixel coordinates. */
export function Stage(props: StageProps): JSX.Element {
  let video: HTMLVideoElement | undefined;
  const [playing, setPlaying] = createSignal(false);
  const [time, setTime] = createSignal(0);
  const [failed, setFailed] = createSignal(false);

  const radius = () => Math.max(7, props.meta.width * 0.0105);
  const aspect = () => props.meta.width / props.meta.height;
  const played = () => (props.meta.duration > 0 ? Math.min(100, (time() / props.meta.duration) * 100) : 0);
  const fps = () => props.meta.fps || 30;
  const promptTime = () => props.promptFrame / fps();

  const seek = (seconds: number) => {
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(seconds, props.meta.duration || seconds));
    setTime(video.currentTime);
  };

  const toggle = () => {
    if (!video) return;
    if (video.paused) void video.play().catch(() => setFailed(true));
    else video.pause();
  };

  const addPoint = (event: MouseEvent & { currentTarget: SVGSVGElement }) => {
    if (props.locked) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * props.meta.width;
    const y = ((event.clientY - rect.top) / rect.height) * props.meta.height;
    if (x < 0 || y < 0 || x > props.meta.width || y > props.meta.height) return;
    props.onAdd(Math.round(x), Math.round(y));
    // Points describe the prompt frame, so show the frame they describe.
    video?.pause();
    seek(promptTime());
  };

  // Follow the prompt frame when it is changed elsewhere (the number field or Use playhead). The time and the
  // tolerance are computed in the tracked phase; the effect itself only touches the player.
  createEffect(
    () => ({ seconds: promptTime(), step: 0.5 / fps() }),
    ({ seconds, step }) => {
      if (video && Math.abs(video.currentTime - seconds) > step) seek(seconds);
    },
  );

  return (
    <div class="stage">
      <div
        class="stage-inner"
        style={`aspect-ratio:${props.meta.width}/${props.meta.height}; width:min(100%, calc(58vh * ${aspect()}))`}
      >
        <video
          ref={video}
          class="stage-video"
          src={props.streamUrl}
          poster={props.posterUrl}
          preload="metadata"
          playsinline
          onLoadedMetadata={() => seek(promptTime())}
          onTimeUpdate={(event) => {
            setTime(event.currentTarget.currentTime);
            props.onTime(event.currentTarget.currentTime);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => setFailed(true)}
        />
        <svg
          class={["stage-overlay", { locked: props.locked }]}
          viewBox={`0 0 ${props.meta.width} ${props.meta.height}`}
          preserveAspectRatio="none"
          onClick={addPoint}
        >
          <For each={props.points}>
            {(point, index) => (
              <g
                class={["marker", { negative: point.label === 0 }]}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!props.locked) props.onRemove(index());
                }}
              >
                <title>{point.label === 1 ? "Object" : "Background"} — click to remove</title>
                <circle cx={point.x} cy={point.y} r={radius()} />
                <text x={point.x} y={point.y} font-size={String(radius() * 1.05)}>
                  {index() + 1}
                </text>
              </g>
            )}
          </For>
        </svg>
        <div class="stage-frame mono">Start frame {props.promptFrame}</div>
        <Show when={props.points.length === 0 && !props.locked}>
          <div class="stage-hint">Click the object to add a point</div>
        </Show>
        <Show when={failed()}>
          <div class="stage-error">
            <Icon name="alert" />
            This video cannot play in the browser (tracking and export still work)
          </div>
        </Show>
      </div>

      <div class="transport">
        <button class="btn icon" type="button" onClick={toggle} title={playing() ? "Pause" : "Play"} aria-label={playing() ? "Pause" : "Play"}>
          <Icon name={playing() ? "pause" : "play"} size={18} />
        </button>
        <button class="btn icon" type="button" onClick={() => seek(promptTime())} title="Jump to the start frame" aria-label="Jump to the start frame">
          <Icon name="rewind" size={16} />
        </button>
        <span class="time mono">
          {formatTime(time())} <span class="dim">/ {formatTime(props.meta.duration)}</span>
        </span>
        <input
          class="scrub"
          type="range"
          min="0"
          max={Math.max(props.meta.duration, 0.01)}
          step="0.01"
          value={time()}
          style={`--fill:${played()}%`}
          aria-label="Playback position"
          disabled={!props.meta.browserPlayable}
          onInput={(event) => {
            video?.pause();
            seek(Number(event.currentTarget.value));
          }}
        />
        <span class="meta mono dim">
          {props.meta.width}×{props.meta.height} · {props.meta.fps.toFixed(props.meta.fps % 1 === 0 ? 0 : 2)} fps
          <Show when={props.meta.frames}>
            {(frames) => <span> · {frames()} frames</span>}
          </Show>
        </span>
      </div>
    </div>
  );
}
