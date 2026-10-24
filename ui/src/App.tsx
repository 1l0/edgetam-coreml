import type { JSX } from "@solidjs/web";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { api, errorMessage, type StateResponse } from "./api.ts";
import { EnvironmentPanel } from "./components/EnvironmentPanel.tsx";
import { ExportPanel } from "./components/ExportPanel.tsx";
import { PointsPanel } from "./components/PointsPanel.tsx";
import { Stage } from "./components/Stage.tsx";
import { VideoPanel } from "./components/VideoPanel.tsx";
import { Icon, Note } from "./components/parts.tsx";
import type { JobSnapshot, PromptPoint, SettingsPatch, VideoMeta } from "./types.ts";
import { MAX_PROMPT_POINTS } from "./types.ts";

/** One step of the rail under the video. A component (not a fresh object in a `<For>`) keeps the four rows stable. */
function RailStep(props: { index: number; label: string; done: boolean }): JSX.Element {
  return (
    <li class={{ done: props.done }}>
      <span class="rail-index">
        <Show when={props.done} fallback={props.index}>
          <Icon name="check" size={11} />
        </Show>
      </span>
      <span>{props.label}</span>
    </li>
  );
}

export default function App(): JSX.Element {
  const [state, setState] = createSignal<StateResponse | null>(null);
  const [job, setJob] = createSignal<JobSnapshot | null>(null);
  const [logs, setLogs] = createSignal<string[]>([]);
  const [meta, setMeta] = createSignal<VideoMeta | null>(null);
  const [videoError, setVideoError] = createSignal<string | null>(null);
  const [points, setPoints] = createSignal<PromptPoint[]>([]);
  const [mode, setMode] = createSignal<1 | 0>(1);
  const [banner, setBanner] = createSignal<string | null>(null);
  const [bootError, setBootError] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());

  let logCursor = 0;
  let logJobId = -1;
  let loadedVideo = "";
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;

  const env = () => state()?.env;
  const running = () => job()?.running ?? false;

  function showBanner(message: string): void {
    setBanner(message);
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => setBanner(null), 9000);
  }

  /** Appends only the log lines this tab has not seen; a new job id resets the cursor. */
  function ingest(next: JobSnapshot | null): void {
    if (!next) return;
    if (next.id !== logJobId) {
      logJobId = next.id;
      logCursor = next.logFrom;
      setLogs([]);
    }
    // `load()` and a poll can race at boot, and a reconnect asks for the whole log again: skip what is already here.
    const skip = next.logFrom < logCursor ? logCursor - next.logFrom : 0;
    if (skip < next.log.length) {
      const fresh = next.log.slice(skip);
      setLogs((previous) => [...previous, ...fresh].slice(-3000));
      logCursor = next.logFrom + next.log.length;
    } else if (next.logFrom > logCursor) {
      logCursor = next.logFrom;
    }
    setJob(next);
  }

  async function load(): Promise<void> {
    try {
      const next = await api.state(0);
      setState(next);
      ingest(next.job);
      setBootError(null);
    } catch (error) {
      setBootError(errorMessage(error));
    }
  }

  async function refresh(): Promise<void> {
    try {
      const next = await api.state(logCursor);
      setState(next);
      ingest(next.job);
    } catch {
      // A transient poll failure should not replace the page with an error; the next poll retries.
    }
  }

  async function patch(next: SettingsPatch): Promise<void> {
    try {
      const saved = await api.updateSettings(next);
      setState((previous) => (previous ? { ...previous, settings: saved.settings, env: saved.env } : previous));
    } catch (error) {
      showBanner(errorMessage(error));
    }
  }

  async function browse(dialog: "folder" | "file", prompt: string, startPath: string): Promise<string | null> {
    try {
      const result = await api.dialog(dialog, prompt, startPath);
      if (!result.path) return null;
      return result.path.replace(/\/+$/, "");
    } catch (error) {
      showBanner(errorMessage(error));
      return null;
    }
  }

  async function startConvert(): Promise<void> {
    try {
      const result = await api.startConvert();
      ingest(result.job);
    } catch (error) {
      showBanner(errorMessage(error));
    }
  }

  async function startTrack(): Promise<void> {
    try {
      const result = await api.startTrack(points());
      ingest(result.job);
    } catch (error) {
      showBanner(errorMessage(error));
    }
  }

  async function cancel(): Promise<void> {
    try {
      const result = await api.cancelJob();
      ingest(result.job);
    } catch (error) {
      showBanner(errorMessage(error));
    }
  }

  async function reveal(path: string): Promise<void> {
    try {
      await api.reveal(path);
    } catch (error) {
      showBanner(errorMessage(error));
    }
  }

  function addPoint(x: number, y: number): void {
    if (running()) return;
    if (points().length >= MAX_PROMPT_POINTS) {
      showBanner(`At most ${MAX_PROMPT_POINTS} points (object + background). Remove a point to add another.`);
      return;
    }
    setPoints((previous) => [...previous, { x, y, label: mode() }]);
  }

  // Settings persist server-side; the path in state is the single source of truth for what is loaded.
  createEffect(
    () => state()?.settings.videoPath ?? "",
    (path) => {
      if (!path) {
        loadedVideo = "";
        setMeta(null);
        setVideoError(null);
        setPoints([]);
        return;
      }
      if (path === loadedVideo) return;
      loadedVideo = path;
      setPoints([]);
      setMeta(null);
      setVideoError(null);
      void api
        .videoMeta(path)
        .then((next) => {
          if (loadedVideo === path) setMeta(next);
        })
        .catch((error: unknown) => {
          if (loadedVideo === path) setVideoError(errorMessage(error));
        });
    },
  );

  void load();

  // One poll at a time: fast while a job runs, slow when idle, and it doubles as a reconnect loop while the API is
  // unreachable at boot.
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const schedule = () => {
    if (disposed) return;
    pollTimer = setTimeout(pollOnce, state() ? (job()?.running ? 400 : 1200) : 1500);
  };

  async function pollOnce(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      if (!state()) {
        await load();
      } else {
        const { job: next } = await api.job(logCursor);
        if (next) {
          const wasRunning = job()?.running ?? false;
          ingest(next);
          if (wasRunning && !next.running && next.kind === "convert") void refresh();
        }
      }
    } catch {
      // Transient; the next tick retries.
    } finally {
      polling = false;
      schedule();
    }
  }

  pollTimer = setTimeout(pollOnce, 300);

  const tick = setInterval(() => setNow(Date.now()), 500);

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === "Backspace" && !running() && points().length > 0) {
      event.preventDefault();
      setPoints((previous) => previous.slice(0, -1));
    }
  };
  window.addEventListener("keydown", onKeyDown);

  onCleanup(() => {
    disposed = true;
    clearTimeout(pollTimer);
    clearInterval(tick);
    clearTimeout(bannerTimer);
    window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true" />
          <div>
            <h1>EdgeTAM Track</h1>
            <p>Core ML · Neural Engine</p>
          </div>
        </div>
        <div class="topline">
          <Show when={env()}>
            {(info) => (
              <span class={["chip", { good: info().ready }]}>
                <span class="chip-dot" />
                {info().ready ? "Environment ready" : "Environment not ready"}
              </span>
            )}
          </Show>
          <Show when={meta()}>
            {(video) => (
              <span class="chip">
                <Icon name="video" size={13} />
                {video().width}×{video().height}
              </span>
            )}
          </Show>
          <span class="chip">
            <Icon name="target" size={13} />
            {points().length} point{points().length === 1 ? "" : "s"}
          </span>
          <Show when={job()?.running ? job() : null}>
            {(active) => (
              <span class="chip accent">
                <span class="spinner tiny" />
                {active().label}
              </span>
            )}
          </Show>
        </div>
      </header>

      <Show
        when={state()}
        fallback={
          <div class="boot">
            <Show
              when={bootError()}
              fallback={
                <>
                  <span class="spinner" />
                  <p>Connecting to the local server…</p>
                </>
              }
            >
              <Note tone="error">Cannot reach the server: {bootError()}</Note>
              <p class="dim">Check that <code>npm run dev</code> (or <code>npm start</code>) is running in a terminal.</p>
              <button class="btn" type="button" onClick={() => void load()}>
                Retry
              </button>
            </Show>
          </div>
        }
      >
        {(current) => (
          <main class="workspace">
            <section class="stage-panel">
              <Show
                when={meta()}
                fallback={
                  <div class="stage-empty">
                    <Icon name="video" size={34} />
                    <h2>{videoError() ? "Could not load the video" : "Open a video"}</h2>
                    <p>
                      {videoError() ??
                        "Points are placed on the first frame. Pick a video to preview it here and click the object."}
                    </p>
                    <button
                      class="btn primary"
                      type="button"
                      disabled={running()}
                      onClick={async () => {
                        const file = await browse("file", "Choose a video", current().settings.videoPath);
                        if (file) void patch({ videoPath: file });
                      }}
                    >
                      <Icon name="folder" />
                      Open video
                    </button>
                  </div>
                }
              >
                {(video) => (
                  <Stage
                    meta={video()}
                    streamUrl={api.streamUrl(video().path)}
                    posterUrl={api.posterUrl(video().path)}
                    points={points()}
                    locked={running()}
                    onAdd={addPoint}
                    onRemove={(index) => {
                      if (running()) return;
                      setPoints((previous) => previous.filter((_, at) => at !== index));
                    }}
                  />
                )}
              </Show>

              <ol class="rail">
                <RailStep index={1} label="Environment" done={current().env.ready} />
                <RailStep index={2} label="Video" done={meta() !== null} />
                <RailStep index={3} label="Points" done={points().some((point) => point.label === 1)} />
                <RailStep index={4} label="Export" done={job()?.kind === "track" && job()?.phase === "done"} />
              </ol>
            </section>

            <aside class="sidebar">
              <EnvironmentPanel
                settings={current().settings}
                env={current().env}
                job={job()}
                now={now()}
                logs={job()?.kind === "convert" ? logs() : []}
                busy={running()}
                onPickWorkDir={async () => {
                  const dir = await browse("folder", "Choose the work folder (convert.sh output)", current().settings.workDir);
                  if (dir) void patch({ workDir: dir });
                }}
                onWorkDir={(value) => void patch({ workDir: value })}
                onNoParity={(value) => void patch({ noParity: value })}
                onConvert={() => void startConvert()}
                onCancel={() => void cancel()}
                onReveal={(path) => void reveal(path)}
              />

              <VideoPanel
                settings={current().settings}
                meta={meta()}
                error={videoError()}
                busy={running()}
                onOpen={async () => {
                  const file = await browse("file", "Choose a video", current().settings.videoPath);
                  if (file) void patch({ videoPath: file });
                }}
                onVideoPath={(value) => void patch({ videoPath: value })}
              />

              <PointsPanel
                points={points()}
                mode={mode()}
                disabled={running()}
                onMode={setMode}
                onFlip={(index) => {
                  if (running()) return;
                  setPoints((previous) =>
                    previous.map((point, at) => (at === index ? { ...point, label: point.label === 1 ? 0 : 1 } : point)),
                  );
                }}
                onRemove={(index) => {
                  if (running()) return;
                  setPoints((previous) => previous.filter((_, at) => at !== index));
                }}
                onClear={() => {
                  if (!running()) setPoints([]);
                }}
              />

              <ExportPanel
                settings={current().settings}
                env={current().env}
                job={job()}
                now={now()}
                logs={job()?.kind === "track" ? logs() : []}
                points={points()}
                meta={meta()}
                onPickOutDir={async () => {
                  const dir = await browse("folder", "Choose the export folder", current().settings.outDir);
                  if (dir) void patch({ outDir: dir });
                }}
                onOutDir={(value) => void patch({ outDir: value })}
                onUnits={(value) => void patch({ units: value })}
                onOpenOnFinish={(value) => void patch({ openOnFinish: value })}
                onExport={() => void startTrack()}
                onCancel={() => void cancel()}
                onReveal={(path) => void reveal(path)}
              />

              <p class="footnote">
                Runs the same loop as <code>examples/track.py</code> on this machine. Keep the server running while exporting.
              </p>
            </aside>
          </main>
        )}
      </Show>

      <Show when={banner()}>
        {(message) => (
          <div class="toast" role="status">
            <Icon name="alert" size={15} />
            <span>{message()}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setBanner(null)}>
              ×
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}
