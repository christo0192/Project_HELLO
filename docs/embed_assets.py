"""
Embed the latest call recording + render the scorecard natively into HELLO.html,
keeping the file fully self-contained (single-file share for the team).

Reads from docs/hello-assets/:
    recording.webm | recording.wav | recording.mp3   -> base64 <audio>
    assessment.json  (+ meta.json)                    -> native HTML scorecard
Replaces the placeholder blocks marked in HELLO.html. Idempotent (re-runnable).

Usage (repo root, PowerShell):  python docs/embed_assets.py
"""
import base64, html, json, mimetypes, re, sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent
HTML = DOCS / "HELLO.html"
ASSETS = DOCS / "hello-assets"


def find(patterns):
    for pat in patterns:
        hits = sorted(ASSETS.glob(pat))
        if hits:
            return hits[0]
    return None


def data_uri(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    if path.suffix.lower() == ".webm":
        mime = "audio/webm"
    mime = mime or "application/octet-stream"
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def replace_block(doc, start, end, inner):
    pat = re.compile(re.escape(start) + r".*?" + re.escape(end), re.DOTALL)
    if not pat.search(doc):
        print(f"  ! marker {start} not found — skipped")
        return doc
    return pat.sub(lambda _: f"{start}\n{inner}\n{end}", doc)


def esc(x):
    return html.escape(str(x if x is not None else ""))


# ── scorecard rendering (mirrors Scorecard.tsx) ──────────────────────
def bar(label, value):
    v = max(0, min(10, float(value or 0)))
    pct = v * 10
    col = "var(--ok)" if v >= 7 else "var(--warn)" if v >= 5 else "var(--danger)"
    return (
        f'<div style="margin:7px 0"><div style="display:flex;justify-content:space-between;'
        f'font-size:11.5px;margin-bottom:3px"><span style="color:var(--ink-dim)">{esc(label)}</span>'
        f'<span style="color:var(--ink);font-weight:600">{v:g}/10</span></div>'
        f'<div style="height:6px;border-radius:999px;background:var(--chip);overflow:hidden">'
        f'<div style="height:100%;width:{pct}%;background:{col};border-radius:999px"></div></div></div>'
    )


def chips(label, items, tone):
    tones = {"green": ("var(--ok)", "rgba(34,211,165,.12)"),
             "amber": ("var(--warn)", "rgba(245,183,78,.12)"),
             "red": ("var(--danger)", "rgba(255,107,107,.12)"),
             "accent": ("var(--brand)", "rgba(91,140,255,.12)")}
    fg, bgc = tones.get(tone, tones["accent"])
    if not items:
        body = '<span style="font-size:11.5px;color:var(--ink-dim)">None</span>'
    else:
        body = "".join(
            f'<span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;'
            f'color:{fg};background:{bgc};border:1px solid {fg};margin:2px 3px 0 0">{esc(i)}</span>'
            for i in items)
    return (f'<div style="margin-top:8px"><div style="font-size:11.5px;color:var(--ink-dim);'
            f'margin-bottom:3px">{esc(label)}</div><div>{body}</div></div>')


def signal(label, sig):
    if not sig:
        return ""
    lvl = sig.get("level", "")
    tone = "green" if lvl in ("none", "low") else "amber" if lvl == "moderate" else "red"
    fg = {"green": "var(--ok)", "amber": "var(--warn)", "red": "var(--danger)"}[tone]
    ex = sig.get("examples") or []
    ex_html = (f'<div style="margin-top:6px;font-size:11px;color:var(--ink-dim)">'
               f'<b>Examples:</b> {esc(", ".join(ex))}</div>') if ex else ""
    notes = (f'<div style="margin-top:4px;font-size:11px;color:var(--ink-dim);line-height:1.5">'
             f'{esc(sig.get("notes",""))}</div>') if sig.get("notes") else ""
    return (
        f'<div style="background:var(--chip);border-radius:8px;padding:9px 11px;margin-top:8px">'
        f'<div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:2px">'
        f'<span style="color:var(--ink);font-weight:600">{esc(label)}</span>'
        f'<span style="color:{fg};font-weight:600">{esc(lvl)}</span></div>'
        f'{bar("Impact", sig.get("impact_score",0))}{ex_html}{notes}</div>'
    )


def section(title, inner, notes=None):
    n = (f'<p style="margin-top:10px;font-size:11px;color:var(--ink-dim);line-height:1.55">{esc(notes)}</p>'
         if notes else "")
    return (f'<div style="border:1px solid var(--line);border-radius:10px;padding:14px">'
            f'<h4 style="margin:0 0 8px;font-size:13px;color:var(--ink)">{esc(title)}</h4>{inner}{n}</div>')


def render_scorecard(a, meta):
    comm = a.get("communication") or (a.get("raw") or {}).get("communication") or {}
    eng = comm.get("english_proficiency") or a.get("english") or {}
    motiv = a.get("motivation") or {}
    tone = a.get("tone") or {}
    rf = a.get("role_fit") or {}
    conflicts = a.get("resume_conflicts") or []
    overall = round(float(a.get("overall_score") or 0))
    reco = (a.get("recommendation") or "hold").lower()

    score_col = "var(--ok)" if overall >= 75 else "var(--warn)" if overall >= 50 else "var(--danger)"
    reco_map = {"advance": ("Advance", "var(--ok)", "rgba(34,211,165,.14)"),
                "hold": ("Hold", "var(--warn)", "rgba(245,183,78,.14)"),
                "reject": ("Reject", "var(--danger)", "rgba(255,107,107,.14)")}
    rlabel, rfg, rbg = reco_map.get(reco, reco_map["hold"])

    cand = (meta.get("candidate") or {}).get("name") or "Candidate"
    role = (meta.get("role") or {}).get("title") or "Role"
    turns = meta.get("turn_count")
    created = (a.get("created_at") or "")[:10]

    # header
    head = (
        f'<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;'
        f'padding-bottom:14px;border-bottom:1px solid var(--line-soft);margin-bottom:14px">'
        f'<div><div style="display:flex;align-items:baseline;gap:8px">'
        f'<span style="font-size:2.4rem;font-weight:800;color:{score_col};letter-spacing:-.02em">{overall}</span>'
        f'<span style="color:var(--ink-dim)">/ 100</span>'
        f'<span style="margin-left:6px;color:var(--ink-soft);font-size:13px">Overall score</span></div>'
        f'<div style="margin-top:4px;font-size:12.5px;color:var(--ink-dim)">'
        f'<b style="color:var(--ink)">{esc(cand)}</b> · {esc(role)} · {esc(turns)} turns · {esc(created)}</div></div>'
        f'<span style="padding:6px 14px;border-radius:999px;font-weight:700;font-size:13px;'
        f'color:{rfg};background:{rbg};border:1px solid {rfg}">{rlabel}</span></div>'
    )

    # communication
    c_inner = bar("Score", comm.get("score", 0))
    for k in ("clarity", "structure", "listening", "rapport"):
        if comm.get(k) is not None:
            c_inner += bar(k.capitalize(), comm[k])
    if eng:
        c_inner += (
            f'<div style="background:var(--chip);border-radius:8px;padding:9px 11px;margin-top:8px">'
            f'<div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:4px">'
            f'<span style="color:var(--ink);font-weight:600">English band</span>'
            f'<span style="color:var(--brand);font-weight:700">{esc(eng.get("band",""))}</span></div>'
            + bar("Grammar", eng.get("grammar", 0)) + bar("Vocabulary", eng.get("vocabulary", 0))
            + bar("Fluency", eng.get("fluency", 0)) + bar("Coherence", eng.get("coherence", 0))
            + (f'<div style="margin-top:6px;font-size:11px;color:var(--ink-dim);line-height:1.5">{esc(eng.get("notes",""))}</div>' if eng.get("notes") else "")
            + '</div>')
    c_inner += signal("Filler usage", comm.get("filler_usage"))
    c_inner += signal("Native-language usage", comm.get("native_language_usage"))
    comm_sec = section("Communication — 50%", c_inner, comm.get("notes"))

    motiv_sec = section("Motivation — 20%", bar("Score", motiv.get("score", 0)), motiv.get("notes"))

    t_inner = (bar("Clarity", tone.get("clarity", 0)) + bar("Confidence", tone.get("confidence", 0))
               + bar("Professionalism", tone.get("professionalism", 0))
               + f'<div style="display:flex;justify-content:space-between;font-size:11.5px;margin-top:8px">'
                 f'<span style="color:var(--ink-dim)">Sentiment</span>'
                 f'<span style="color:var(--ink-soft)">{esc(tone.get("sentiment",""))}</span></div>')
    tone_sec = section("Tone — 10%", t_inner, tone.get("notes"))

    rf_inner = (bar("Fit score", rf.get("score", 0))
                + chips("Matched skills", rf.get("matched_skills"), "green")
                + chips("Gaps", rf.get("gaps"), "amber")
                + chips("Red flags", rf.get("red_flags"), "red"))
    rf_sec = section("Role fit — 20%", rf_inner, rf.get("notes"))

    grid = (f'<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">'
            f'{comm_sec}{rf_sec}{motiv_sec}{tone_sec}</div>')

    # resume conflicts
    conf_html = ""
    if conflicts:
        rows = ""
        for c in conflicts:
            resolved = c.get("resolved")
            bc = "var(--line)" if resolved else "var(--warn)"
            tag_fg = "var(--ok)" if resolved else "var(--warn)"
            rows += (
                f'<div style="border:1px solid {bc};border-radius:9px;padding:10px 12px;margin-top:8px;'
                f'background:var(--panel-2)"><div style="display:flex;justify-content:space-between;margin-bottom:3px">'
                f'<b style="font-size:12px;color:var(--ink)">{esc(c.get("topic",""))}</b>'
                f'<span style="font-size:10.5px;color:{tag_fg};font-weight:600">'
                f'{"resolved" if resolved else "unresolved"}</span></div>'
                f'<div style="font-size:11.5px;color:var(--ink-soft)"><b>Resume:</b> {esc(c.get("resume_says",""))}</div>'
                f'<div style="font-size:11.5px;color:var(--ink-soft)"><b>Said on call:</b> {esc(c.get("candidate_said",""))}</div>'
                + (f'<div style="margin-top:3px;font-size:11px;font-style:italic;color:var(--ink-dim)">{esc(c.get("note",""))}</div>' if c.get("note") else "")
                + '</div>')
        conf_html = (f'<div style="margin-top:14px"><h4 style="margin:0 0 4px;font-size:13px;color:var(--ink)">'
                     f'Resume conflicts <span style="color:var(--warn)">({len(conflicts)})</span></h4>{rows}</div>')

    summ = ""
    if a.get("summary"):
        summ = (f'<div style="margin-top:14px;border-top:1px solid var(--line-soft);padding-top:12px">'
                f'<h4 style="margin:0 0 4px;font-size:13px;color:var(--ink)">Summary</h4>'
                f'<p style="margin:0;font-size:12.5px;color:var(--ink-soft);line-height:1.6">{esc(a["summary"])}</p></div>')

    return head + grid + conf_html + summ


def main():
    if not HTML.exists():
        print("HELLO.html not found", file=sys.stderr); return 1
    doc = HTML.read_text(encoding="utf-8")

    # Prefer MP3 (proper duration header, universal + seekable) over raw egress WebM.
    rec = find(["recording.mp3", "recording.wav", "recording.webm", "recording.*"])
    if rec and rec.suffix.lower() in {".webm", ".wav", ".mp3", ".m4a", ".ogg"}:
        block = (
            '    <div class="asset">\n'
            '      <div class="a-head"><span class="t">▶ Call recording — latest screening (RIJO J JOHN · Program Advisor)</span>'
            '<span class="mono-dim">LiveKit Egress → Supabase Storage · recordings_v2</span></div>\n'
            '      <div class="a-body">\n'
            f'        <audio controls preload="metadata" src="{data_uri(rec)}"></audio>\n'
            f'        <p class="mono-dim" style="margin:10px 0 0">{rec.name} · {rec.stat().st_size//1024//1024} MB · ~14 min · session 9ae76628 · LiveKit browser call (transcoded from egress WebM for portable playback)</p>\n'
            '      </div>\n'
            '    </div>'
        )
        doc = replace_block(doc, "<!-- ASSET:AUDIO:START -->", "<!-- ASSET:AUDIO:END -->", block)
        print(f"  ✓ embedded audio: {rec.name} ({rec.stat().st_size//1024//1024} MB)")
    else:
        print("  - no recording in docs/hello-assets/")

    ajson = ASSETS / "assessment.json"
    mjson = ASSETS / "meta.json"
    if ajson.exists():
        a = json.loads(ajson.read_text(encoding="utf-8"))
        meta = json.loads(mjson.read_text(encoding="utf-8")) if mjson.exists() else {}
        card = (
            '    <div class="asset">\n'
            '      <div class="a-head"><span class="t">▤ Scorecard — latest call (rendered from live assessment data)</span>'
            '<span class="mono-dim">schema Scorecard.tsx · assessments row</span></div>\n'
            '      <div class="a-body">\n'
            + render_scorecard(a, meta) + '\n'
            '      </div>\n'
            '    </div>'
        )
        doc = replace_block(doc, "<!-- ASSET:SCORECARD:START -->", "<!-- ASSET:SCORECARD:END -->", card)
        print("  ✓ rendered native scorecard from assessment.json")
    else:
        print("  - no assessment.json in docs/hello-assets/")

    HTML.write_text(doc, encoding="utf-8")
    print(f"Wrote {HTML}  ({HTML.stat().st_size//1024//1024} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
