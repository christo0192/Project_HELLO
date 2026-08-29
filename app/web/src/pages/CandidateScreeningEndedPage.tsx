import '../styles/candidate-experience.css';

/** Terminal candidate surface. It intentionally has no links or actions. */
export function CandidateScreeningEndedPage() {
  return (
    <main className="candidate-experience candidate-shell candidate-scope">
      <div className="candidate-shell__inner">
        <header className="candidate-brand" aria-label="Interview Kickstart">
          <img src="/ik-logo.png" alt="Interview Kickstart" />
          <div><b>Interview Kickstart</b><span>Private candidate interview</span></div>
        </header>
        <section className="candidate-glass-card candidate-landing candidate-status-card" aria-labelledby="screening-ended-title">
          <p className="candidate-eyebrow">Screening ended</p>
          <h1 id="screening-ended-title">The screening has ended.</h1>
          <p className="candidate-muted">Thank you for your time. Your responses have been securely submitted, and you are safe to close this browser.</p>
        </section>
      </div>
    </main>
  );
}
