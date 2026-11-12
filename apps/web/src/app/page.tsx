import Link from "next/link";

const EXAMPLES = [
  "Create a Gaming category with general, clips and LFG text channels and a Squad voice channel.",
  "Add a staff-only area that only Moderators can see.",
  "Make #announcements read-only for everyone except Staff.",
];

export default function Home() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-20">
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Manage your Discord server in plain English.</h1>
      <p className="mt-4 max-w-2xl text-lg text-muted">
        Describe what you want. Whispcord shows you every change it will make, runs it when you approve,
        and keeps an undo button for everything it creates.
      </p>
      <div className="mt-8 flex gap-3">
        <Link href="/login" className="btn-primary">Continue with Discord</Link>
        <Link href="/servers" className="btn-ghost">Open my servers</Link>
      </div>

      <div className="mt-16 grid gap-3">
        {EXAMPLES.map((e) => (
          <div key={e} className="card px-4 py-3 text-sm text-muted">“{e}”</div>
        ))}
      </div>

      <div className="mt-16 grid gap-6 sm:grid-cols-3">
        {[
          ["You stay in control", "Every plan is previewed. Nothing runs until you click Run, and deletions need typed confirmation."],
          ["Only your server", "Whispcord checks you have Manage Server on every run, and the AI can only touch the server you picked."],
          ["No Administrator", "The bot asks only for the permissions it needs and never grants Administrator to anyone."],
        ].map(([title, body]) => (
          <div key={title}>
            <h3 className="font-medium">{title}</h3>
            <p className="mt-1 text-sm text-muted">{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
