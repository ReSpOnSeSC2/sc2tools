"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { buttonClassName } from "@/components/ui/Button";
import { ArrowLeft, ArrowRight, Check, RotateCcw } from "lucide-react";

const STORAGE_KEY = "sc2tools:stream-studio:crash-course:v1";
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const LINK = buttonClassName({ variant: "secondary" });

type Lesson = {
  id: string;
  title: string;
  time: string;
  promise: string;
  steps: ReadonlyArray<{ title: string; body: ReactNode }>;
  tryIt: string;
  expected: string;
  links: ReadonlyArray<{ href: string; label: string }>;
};

const LESSONS: ReadonlyArray<Lesson> = [
  {
    id: "connect-the-dots",
    title: "Connect the dots",
    time: "2 min",
    promise: "Understand how a game on your PC becomes a widget on your stream.",
    steps: [
      {
        title: "The agent reads your game",
        body: "The desktop agent runs on the Windows PC where you play StarCraft II. It sends live game information and uploads completed replays to your SC2 Tools account.",
      },
      {
        title: "Your account supplies the information",
        body: "Pairing connects that PC to your account. Your replay history adds context, such as previous meetings with an opponent. A new opponent may have little history; that is normal.",
      },
      {
        title: "A Browser Source displays it",
        body: <>In <strong>Settings → Overlay</strong>, your personal overlay URLs open transparent web pages. OBS Studio or Streamlabs displays those pages as Browser Sources above your gameplay. The URL connects the source to your account; keep it private, like a stream key.</>,
      },
    ],
    tryIt: "Trace this route once: StarCraft II → desktop agent → your account → overlay URL → OBS Browser Source. Which part collects information, and which part puts it on screen?",
    expected: "The agent collects game information. Your account supplies the data and history. The Browser Source paints the widget in your scene. Adding a URL to OBS does not install or pair the agent.",
    links: [{ href: "/settings?tab=overlay", label: "Find your overlay URLs" }],
  },
  {
    id: "pair-your-pc",
    title: "Pair your gaming PC",
    time: "3 min",
    promise: "Give live widgets a reliable connection to the game you are playing.",
    steps: [
      {
        title: "Install and launch the desktop agent",
        body: <>Download the agent on your gaming PC and open it. Find its six-digit pairing code in the agent window or tray menu. Sign in to SC2 Tools with the account you want to use on stream.</>,
      },
      {
        title: "Claim the code in Devices",
        body: <>Open <strong>Devices → Pair a new device</strong>, enter the code and choose <strong>Pair device</strong>. Check <strong>Connected devices</strong> for your PC and its last-seen time. Allow a few seconds for the agent to pick up the pairing.</>,
      },
      {
        title: "Know what a replay upload proves",
        body: "Browser replay analysis can populate your history, but a browser page cannot read StarCraft II’s live game API on your PC. Keep the paired agent running for live opponent scouting, automatic replay uploads and game-start updates. An installed agent still needs to be paired.",
      },
    ],
    tryIt: "Open Devices and identify the PC you are playing on. Check its last-seen time, then keep the agent running while you open StarCraft II.",
    expected: "Your gaming PC is listed under Connected devices with a recent last-seen time. If it is missing, finish pairing. If the time is stale, reopen the agent and check its connection before troubleshooting OBS.",
    links: [
      { href: "/download", label: "Download the agent" },
      { href: "/devices", label: "Open Devices" },
    ],
  },
  {
    id: "build-your-scene",
    title: "Build your first scene",
    time: "4 min",
    promise: "Choose a simple layout and put your first source in the right place.",
    steps: [
      {
        title: "Choose one starting point",
        body: <>In <strong>Settings → Overlay → Widgets</strong>, choose a starter pack and review which widgets it enables before confirming. Use Setup&apos;s <strong>All-in-one URL</strong> for a ready-arranged core layout, or choose individual widget cards to position each source yourself. Chat, Ghost Build coach and Build profile use dedicated sources.</>,
      },
      {
        title: "Let the app build it",
        body: <>In the desktop app, open <strong>Settings → OBS scene switching</strong>, enter your OBS WebSocket details and press <strong>Test connection → Build my scenes</strong>. Pick your captures and review <strong>During games</strong>: All-in-one starts on; Ghost Build, Build randomizer and the slim scene ticker are optional. Choose your credit preference, then confirm. <strong>Update</strong> later adds missing selected sources while keeping your existing layout. For one source, enable website OBS requests in the desktop app and use a widget card&apos;s <strong>Add to OBS</strong>, then confirm the named program scene locally. Cancel is the default.</>,
      },
      {
        title: "Add a Browser Source in OBS",
        body: <>Use <strong>Drag into OBS</strong> on a widget card to create a named source at its recommended size. Alternatively, choose <strong>Sources → + → Browser</strong>, paste its private URL with Copy and enter the card&apos;s width and height. All-in-one uses your canvas size, usually <strong>1920 × 1080</strong>; Build profile uses <strong>720 × 900</strong>. Press Test and review Preview before sending any live sample.</>,
      },
      {
        title: "Place it above your gameplay",
        body: "Move the Browser Source above your game capture in the Sources list and leave its eye icon on. Use the preview to position individual widgets and keep your minimap and supply count clear. Avoid showing the same widget through both All-in-one and an individual source.",
      },
    ],
    tryIt: "Add one source named “SC2 Tools — Session record” using the Session record URL. Enable Session record in Settings, then position the source above your game capture.",
    expected: "The source is visible in the OBS preview and has transparent space around its content. Session record can appear as soon as the overlay connects. Other cards may stay empty until their trigger or a Test; a transparent page alone does not mean setup failed.",
    links: [{ href: "/settings?tab=overlay", label: "Choose a Browser Source URL" }],
  },
  {
    id: "test-with-purpose",
    title: "Test, then play",
    time: "3 min",
    promise: "Separate a layout check from proof that real game information is arriving.",
    steps: [
      {
        title: "Preview in the playground, then Test in OBS",
        body: <>Choose <strong>Preview</strong> on a Settings widget card, or open the <Link href="/stream-studio/playground" className="text-accent underline">local widget playground</Link>. Try the sample scenarios, theme presets and Show all together; these silent samples use no account or overlay token. Then enable a widget in <strong>Settings → Overlay</strong> and choose <strong>Test</strong> while watching OBS. Most tests display a sample for about 20 seconds; choose <strong>Stop</strong> to dismiss it sooner. <strong>Test all</strong> helps check a complete scene. Build profile is controlled directly from its settings or the Stream Dock.</>,
      },
      {
        title: "Expect different cards at different times",
        body: "Opponent identity and scouting use live game information. Match result, Post-game build and MMR delta need the finished game’s replay to upload and process. Streak needs a qualifying run; history-based cards need relevant history. A successful sample checks rendering, not your agent’s live connection.",
      },
      {
        title: "Check a real game, then troubleshoot in order",
        body: <>Keep the agent running, play a match and let its replay upload. If a test is invisible, check the widget toggle, copied URL, source eye icon and source order first. Use the connection check in Overlay settings. For a stuck source in OBS Studio, right-click it and choose <strong>Refresh cache of current page</strong>.</>,
      },
    ],
    tryIt: "Test Match result once, then stop the test. After your next completed game, compare the real result with the sample and check that the replay reached your account.",
    expected: "The sample card appears temporarily in OBS. Later, the processed real replay produces your own result. You may see a delay while it uploads and processes. If samples work but real updates do not, check the agent and replay upload before changing the scene layout.",
    links: [
      { href: "/settings?tab=overlay", label: "Test your widgets" },
      { href: "/devices", label: "Check your agent" },
    ],
  },
  {
    id: "make-it-yours",
    title: "Add your next feature",
    time: "4 min",
    promise: "Grow the scene one useful feature at a time, with a clear place to control it.",
    steps: [
      {
        title: "Start chat with one platform",
        body: <>In <strong>Settings → Overlay → Multi-platform chat</strong>, enable and configure one platform you use, then choose <strong>Save chat settings</strong>. Add the dedicated <strong>Multi-platform chat</strong> URL as a Browser Source. Its Test is a sample stream; verify the connection with a real message from your channel too.</>,
      },
      {
        title: "Keep the controls within reach",
        body: <>Copy the <strong>Stream Dock</strong> URL from the Multi-platform chat section. Open it on a second screen, or in OBS Studio under <strong>Docks → Custom Browser Docks</strong>. It controls highlights, polls, goals and more. To show one of those features on stream, also add its corresponding widget Browser Source.</>,
      },
      {
        title: "Choose one practice upgrade",
        body: <>For <strong>Build randomizer</strong>, choose a matchup, enable it, select builds and save in the Build randomizer tab. For <strong>Ghost Build coach</strong>, save a build from a completed game, assign it to a matchup in Overlay settings, then copy its dedicated URL again after changing assignments. For spoken scouting, use the <strong>All-in-one</strong> or <strong>Scouting tells</strong> source, enable <strong>Enable voice readout</strong> in Voice and try <strong>Hear the OBS version</strong>; keep only one speaking source audible.</>,
      },
    ],
    tryIt: "Pick one upgrade: send a real chat message, pin a highlight from the Stream Dock, or configure a build pool for one matchup. Verify it before adding another feature.",
    expected: "Your chosen feature has both its configuration and its display source in place. A Stream Dock action appears in its matching widget, real chat reaches the feed, or the randomizer has saved builds for the matchup you selected. You know where to return to change it.",
    links: [
      { href: "/settings?tab=overlay", label: "Set up chat and the Stream Dock" },
      { href: "/settings?tab=randomizer", label: "Choose randomizer builds" },
      { href: "/settings?tab=voice", label: "Set up voice" },
    ],
  },
];

type Progress = { activeId: string; completed: string[] };

function emptyProgress(): Progress {
  return { activeId: LESSONS[0].id, completed: [] };
}

function readProgress(raw: unknown): Progress {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyProgress();
  const candidate = raw as Partial<Progress>;
  const knownIds = new Set(LESSONS.map((lesson) => lesson.id));
  return {
    activeId: typeof candidate.activeId === "string" && knownIds.has(candidate.activeId)
      ? candidate.activeId
      : LESSONS[0].id,
    completed: Array.isArray(candidate.completed)
      ? [...new Set(candidate.completed.filter((id): id is string => typeof id === "string" && knownIds.has(id)))]
      : [],
  };
}

export function CrashCourse() {
  const headingId = useId();
  const lessonHeadingId = useId();
  const lessonPanelId = useId();
  const answerId = useId();
  // Keep the server render and first browser render identical. Read storage
  // only after mounting, and do not overwrite it with the initial fallback.
  const [progress, setProgress] = useState<Progress>(emptyProgress);
  const [hydrated, setHydrated] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState<boolean | null>(null);
  const [answerVisible, setAnswerVisible] = useState(false);
  const [resetUndo, setResetUndo] = useState<{ progress: Progress } | null>(null);
  useEffect(() => {
    if (!resetUndo) return;
    const timer = setTimeout(() => setResetUndo(null), 8000);
    return () => clearTimeout(timer);
  }, [resetUndo]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved !== null) setProgress(readProgress(JSON.parse(saved) as unknown));
      setStorageAvailable(true);
    } catch {
      setStorageAvailable(false);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
      setStorageAvailable(true);
    } catch {
      // Storage may be disabled or full. Navigation and the current checklist
      // still work, and stay intact until the component is unmounted.
      setStorageAvailable(false);
    }
  }, [progress, hydrated]);

  const activeIndex = LESSONS.findIndex((lesson) => lesson.id === progress.activeId);
  const lesson = LESSONS[activeIndex];
  const completed = progress.completed.includes(lesson.id);
  const finished = progress.completed.length === LESSONS.length;

  function selectLesson(id: string) {
    setProgress((current) => ({ ...current, activeId: id }));
    setAnswerVisible(false);
  }

  return (
    <section id="crash-course" aria-labelledby={headingId} className="scroll-mt-28 space-y-6 pt-12 md:pt-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="kicker">The first-scene crash course</p>
          <h2 id={headingId} className="mt-3 font-serif text-[30px] font-semibold leading-tight text-text md:text-[38px]">
            From download to “I’m live.”
          </h2>
          <p className="mt-3 text-body-lg text-text-muted">
            Five short lessons, a small task in each, and a clear check before you move on. Jump to any lesson and come back when you need it.
          </p>
        </div>
        <button
          type="button"
          className={`inline-flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-caption font-semibold text-text-muted hover:bg-bg-elevated hover:text-text ${FOCUS}`}
          onClick={() => { setResetUndo({ progress }); setProgress(emptyProgress()); setAnswerVisible(false); }}
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
          Reset course progress
        </button>
      </div>

      {resetUndo ? <div role="status" className="fixed bottom-5 right-5 z-50 max-w-[calc(100vw-2.5rem)] rounded-md border-2 border-line bg-bg-surface p-4 text-body text-text shadow-hard">Progress reset · <button type="button" className="font-semibold text-accent underline" onClick={() => { setProgress(resetUndo.progress); setResetUndo(null); setAnswerVisible(false); }}>Undo</button></div> : null}
      <div className="space-y-2">
        <p role="status" aria-live="polite" className="text-body font-semibold text-text">
          {progress.completed.length} of {LESSONS.length} lessons complete{finished ? <> — nice work. Next: add your first widgets in <Link href="/settings?tab=overlay" className="underline text-accent">Overlay settings</Link>.</> : "."}
        </p>
        <div className="h-2 overflow-hidden rounded-full bg-accent/15" aria-hidden>
          <div className="h-full rounded-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${progress.completed.length / LESSONS.length * 100}%` }} />
        </div>
        <p className="text-caption text-text-muted">
          {storageAvailable === false
            ? "Browser storage is unavailable. You can still use every lesson; progress may reset when you leave."
            : "Your place and checklist are saved in this browser. Mark a lesson complete when you have tried it."}
        </p>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <nav aria-label="Crash course lessons" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
          {LESSONS.map((item, index) => {
            const isActive = lesson.id === item.id;
            const isComplete = progress.completed.includes(item.id);
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={isActive}
                aria-controls={lessonPanelId}
                onClick={() => selectLesson(item.id)}
                className={`flex min-h-16 items-center gap-3 rounded-md border-2 px-4 py-3 text-left transition-colors ${FOCUS} ${isActive ? "border-accent bg-accent/10 text-text" : "border-line bg-bg-surface text-text-muted hover:bg-bg-elevated"}`}
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-caption font-bold ${isComplete ? "border-accent bg-accent text-white" : "border-current"}`}>
                  {isComplete ? <Check className="h-4 w-4" aria-hidden /> : <span aria-hidden>{index + 1}</span>}
                </span>
                <span className="min-w-0">
                  <span className="block font-display text-body font-bold">{index + 1}. {item.title}</span>
                  <span className="block text-caption">{item.time}{isComplete ? " · Complete" : ""}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <article id={lessonPanelId} aria-labelledby={lessonHeadingId} className="min-w-0 rounded-md border-2 border-line bg-bg-surface p-5 shadow-hard sm:p-7">
          <p className="text-caption font-semibold uppercase tracking-wider text-accent">Lesson {activeIndex + 1} / {LESSONS.length} · {lesson.time}</p>
          <h3 id={lessonHeadingId} className="mt-2 font-display text-h2 text-text">{lesson.title}</h3>
          <p className="mt-2 text-body-lg text-text-muted">{lesson.promise}</p>

          <ol className="mt-6 space-y-5">
            {lesson.steps.map((step, index) => (
              <li key={step.title} className="flex gap-3">
                <span aria-hidden className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-caption font-bold text-accent">{index + 1}</span>
                <div className="min-w-0">
                  <h4 className="font-display text-h4 text-text">{step.title}</h4>
                  <p className="mt-1 text-body leading-relaxed text-text-muted">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-6 rounded-md border-2 border-line bg-bg-subtle p-4 sm:p-5">
            <h4 className="font-display text-h4 text-text">Try it now</h4>
            <p className="mt-2 text-body text-text-muted">{lesson.tryIt}</p>
            <button
              type="button"
              aria-expanded={answerVisible}
              aria-controls={answerId}
              onClick={() => setAnswerVisible((visible) => !visible)}
              className={`mt-3 inline-flex min-h-11 items-center gap-2 rounded-md px-1 py-2 text-body font-semibold text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent ${FOCUS}`}
            >
              What should you see?
              <ArrowRight className={`h-4 w-4 transition-transform motion-reduce:transition-none ${answerVisible ? "rotate-90" : ""}`} aria-hidden />
            </button>
            {answerVisible ? <p id={answerId} className="mt-2 border-l-2 border-accent pl-3 text-body text-text">{lesson.expected}</p> : null}
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            {lesson.links.map((link) => <Link key={link.href} href={link.href} className={LINK}>{link.label}<ArrowRight className="h-4 w-4 shrink-0" aria-hidden /></Link>)}
          </div>

          <div className="mt-6 border-t border-border pt-5">
            <label className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 py-2 text-body font-semibold text-text ${FOCUS}`}>
              <input
                type="checkbox"
                checked={completed}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setProgress((current) => ({ ...current, completed: checked ? [...current.completed, lesson.id] : current.completed.filter((id) => id !== lesson.id) }));
                }}
                className={`h-5 w-5 shrink-0 accent-accent ${FOCUS}`}
              />
              I tried this lesson and checked the result
            </label>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <button type="button" className={`${LINK} disabled:cursor-default disabled:opacity-40`} disabled={activeIndex === 0} onClick={() => selectLesson(LESSONS[activeIndex - 1].id)}>
                <ArrowLeft className="h-4 w-4" aria-hidden />Previous lesson
              </button>
              {activeIndex < LESSONS.length - 1 ? (
                <button type="button" className={LINK} onClick={() => selectLesson(LESSONS[activeIndex + 1].id)}>Next lesson<ArrowRight className="h-4 w-4" aria-hidden /></button>
              ) : <span className="text-caption text-text-muted">Revisit any lesson whenever you need a refresher.</span>}
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
