export default function Home() {
  return (
    <main className="holding">
      <section className="holding__card">
        <div className="badge">LIVE CONCORD DEMO</div>
        <div className="mole">🕳️</div>
        <h1>Whack-a-Mole</h1>
        <p>Two agents are about to build this app in parallel.</p>
        <div className="tasks">
          <span>
            <b className="dot dot--fe" /> Claude · game UI
          </span>
          <span>
            <b className="dot dot--be" /> Codex · score API
          </span>
        </div>
        <small>Watch Concord catch their overlap before either agent edits the shared page.</small>
      </section>
    </main>
  );
}
