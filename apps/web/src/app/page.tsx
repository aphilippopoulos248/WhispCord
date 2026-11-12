import Link from "next/link";

const EXAMPLES = [
  "Create a Gaming category with general, clips and LFG text channels and a Squad voice channel.",
  "Add a staff-only area that only Moderators can see.",
  "Make #announcements read-only for everyone except Staff.",
];

const PROMISES: Array<[title: string, body: string, led: string]> = [
  ["You stay in control", "Every plan is previewed. Nothing runs until you press RUN, and deletions need typed confirmation.", "led-ok"],
  ["Only your server", "Whispcord checks you have Manage Server on every run, and the AI can only touch the server you picked.", "led-accent"],
  ["No Administrator", "The bot asks only for the permissions it needs and never grants Administrator to anyone.", "led-danger"],
];

export default function Home() {
  return (
    <div className="mx-auto max-w-5xl px-4 pb-20 pt-10">
      <span className="label-caps">Discord server control</span>
      <h1 className="mt-3 max-w-3xl text-4xl font-extrabold tracking-tight sm:text-6xl">Manage your Discord server in plain English.</h1>
      <p className="mt-5 max-w-2xl text-base text-muted">
        Describe what you want. Whispcord shows you every change it will make, runs it when you approve,
        and keeps an undo button for everything it creates.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/login" className="btn-primary">Continue with Discord</Link>
        <Link href="/servers" className="btn-ghost">Open my servers</Link>
      </div>

      <div className="well mt-14 grid gap-1.5 p-4">
        <span className="label-caps text-[#4f8a70]">Command input</span>
        {EXAMPLES.map((e) => (
          <p key={e} className="font-mono text-[13px] text-phosphor">› {e}</p>
        ))}
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        {PROMISES.map(([title, body, led]) => (
          <div key={title} className="chassis screws grid gap-2 px-4 pb-4 pt-7">
            <div className="flex items-center gap-2">
              <span className={`led ${led}`} aria-hidden />
              <h2 className="text-base font-semibold">{title}</h2>
            </div>
            <p className="text-[13px] text-muted">{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
