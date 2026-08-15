from markdown import markdown
from pathlib import Path

template = '''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0d2445">
  <link rel="icon" type="image/png" sizes="32x32" href="assets/favicon-32.png">
  <link rel="apple-touch-icon" sizes="180x180" href="assets/icon-180.png">
  <title>{{TITLE}}</title>
  <style>
    @font-face {
      font-family: "Syncopate";
      src: url("fonts/Syncopate-Bold.ttf") format("truetype");
      font-weight: 700;
      font-style: normal;
      font-display: swap;
    }
    :root {
      --navy: #0d2445;
      --navy-900: #081626;
      --navy-700: #14365f;
      --navy-muted: #6d829c;
      --sentry-blue: #4285f4;
      --sentry-soft: #d4e6fd;
      --teal: #0d8f8f;
      --bg: #f7f8fa;
      --surface: #ffffff;
      --rule: #dbe1e8;
      --radius: 0.5rem;
      --shadow: 0 8px 30px rgba(13, 36, 69, 0.08);
      --shadow-raised: 0 12px 40px rgba(13, 36, 69, 0.14);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--navy); color: var(--navy); line-height: 1.65; }
    .hero { text-align: center; padding: clamp(2.5rem, 6vw, 4rem) 1.5rem 5rem; background: var(--navy); color: #fff; }
    .hero h1 { font-family: "Syncopate", sans-serif; font-size: clamp(1.5rem, 4vw, 2.5rem); font-weight: 700; letter-spacing: 0.08em; }
    .hero a { color: #fff; text-decoration: none; font-size: 0.85rem; opacity: 0.8; }
    .hero a:hover { opacity: 1; text-decoration: underline; }
    .sheet { max-width: 54rem; margin: -3rem auto 3rem; background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow-raised); padding: clamp(1.5rem, 4vw, 2.5rem); position: relative; z-index: 2; }
    .sheet h1, .sheet h2, .sheet h3 { font-family: "Syncopate", sans-serif; color: var(--navy); margin: 1.5rem 0 0.75rem; }
    .sheet h1 { font-size: 1.5rem; }
    .sheet h2 { font-size: 1.1rem; text-transform: uppercase; letter-spacing: 0.08em; padding-bottom: 0.25rem; border-bottom: 2px solid var(--sentry-blue); display: inline-block; }
    .sheet h3 { font-size: 0.95rem; color: var(--sentry-blue); }
    .sheet p, .sheet li { font-size: 0.95rem; color: #334155; margin-bottom: 0.85rem; }
    .sheet a { color: var(--sentry-blue); }
    .sheet blockquote { background: #eff6ff; border-left: 4px solid var(--sentry-blue); padding: 1rem 1.25rem; margin: 1rem 0; border-radius: var(--radius); font-style: italic; }
    .sheet table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin: 1rem 0; box-shadow: var(--shadow); border-radius: var(--radius); overflow: hidden; }
    .sheet th { background: var(--navy-700); color: #fff; text-align: left; padding: 0.65rem 0.75rem; font-family: "Syncopate", sans-serif; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; }
    .sheet td { padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
    .sheet tr:nth-child(even) { background: #f8fafc; }
    .sheet code { font-family: "Courier New", Courier, monospace; background: #eef2f6; padding: 0.1rem 0.35rem; border-radius: 0.2rem; font-size: 0.9em; }
    .sheet pre { background: var(--navy-900); color: #e2e8f0; padding: 1rem; border-radius: var(--radius); overflow-x: auto; }
    .sheet pre code { background: transparent; }
    .sheet hr { border: none; border-top: 2px solid var(--rule); margin: 1.5rem 0; }
    .sheet ul { margin-left: 1.25rem; margin-bottom: 1rem; }
    @media (max-width: 520px) { .sheet { margin: -2.5rem 1rem 2rem; } }
  </style>
</head>
<body>
  <section class="hero">
    <a href="https://qainsights.github.io/leadsentry/">&larr; Back to one-pager</a>
    <h1>{{TITLE}}</h1>
  </section>
  <main class="sheet">
    {{BODY}}
  </main>
</body>
</html>
'''

for md_file, title in [
    ('report.md', 'LeadSentry Sample Triage Report'),
    ('validation-report.md', 'LeadSentry Ground-Truth Validation'),
]:
    md = Path(md_file).read_text(encoding='utf-8')
    html_body = markdown(md, extensions=['tables', 'fenced_code'])
    out = template.replace('{{TITLE}}', title).replace('{{BODY}}', html_body)
    Path(md_file.replace('.md', '.html')).write_text(out, encoding='utf-8')
    print(f'wrote {md_file.replace(".md", ".html")}')
