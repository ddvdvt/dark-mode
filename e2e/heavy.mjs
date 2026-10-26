// Generated heavy page for the perf test: `n` elements in nested cards, `rules` CSS rules
// (colors, gradients, variables, media queries), inline styles, and a script that keeps adding
// content after load (like an infinite feed). crossOrigin adds an unreadable stylesheet, which makes
// the smart engine scan every element (its worst case).
export function heavyPage(n = 5000, rules = 3000, crossOrigin = false) {
  const css = [];
  css.push(':root{--bg:#ffffff;--fg:#1d1d1f;--line:#e5e5ea;--accent:#0071e3}');
  css.push('body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}');
  for (let i = 0; i < rules; i++) {
    const h = (i * 37) % 360;
    if (i % 5 === 0) css.push(`@media (min-width:${300 + (i % 7) * 100}px){.c${i}{background:hsl(${h} 60% 96%);border-color:hsl(${h} 30% 85%)}}`);
    else if (i % 5 === 1) css.push(`.c${i}{background:linear-gradient(#fff,hsl(${h} 50% 95%));color:hsl(${h} 40% 20%)}`);
    else if (i % 5 === 2) css.push(`.c${i} .t{color:#${(i * 2654435761 % 0x1000000).toString(16).padStart(6, '0')};text-decoration-color:var(--accent)}`);
    else if (i % 5 === 3) css.push(`.c${i}:hover{background-color:rgba(0,0,0,.04);box-shadow:0 1px 2px rgba(0,0,0,.1)}`);
    else css.push(`.c${i}{padding:${i % 9}px;margin:${i % 4}px;border:1px solid var(--line)}`);
  }
  const items = [];
  const per = 5; // elements per card
  for (let i = 0; i < n / per; i++) {
    const c = i % rules;
    const inline = i % 25 === 0 ? ' style="background:#fafafa;color:#333"' : '';
    items.push(`<div class="card c${c}"${inline}><h3 class="t">Card ${i}</h3><p>Some text <a href="#${i}">link ${i}</a></p><span class="badge">tag</span></div>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Heavy page</title>${crossOrigin ? '<link rel="stylesheet" href="/x-origin/remote.css">' : ''}<style>${css.join('\n')}</style></head>
<body><h1>Heavy page: ${n} elements, ${rules} rules</h1><div id="feed">${items.join('')}</div>
<script>
  // after load, append 1000 more elements in 10 batches (infinite scroll)
  window.addEventListener('load', () => {
    let k = 0;
    const timer = setInterval(() => {
      const feed = document.getElementById('feed');
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 20; i++) {
        const d = document.createElement('div');
        d.className = 'card c' + ((k * 20 + i) % ${rules});
        d.innerHTML = '<h3 class="t">More ' + k + '-' + i + '</h3><p>Loaded later <a href="#">link</a></p><span>x</span>';
        if (i === 0) d.style.background = '#ffffff';
        frag.appendChild(d);
      }
      feed.appendChild(frag);
      if (++k === 10) { clearInterval(timer); window.__feedDone = performance.now(); }
    }, 100);
  });
</script></body></html>`;
}
