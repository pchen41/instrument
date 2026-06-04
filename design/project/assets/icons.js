/* Instrument icon layer — a self-contained inline-SVG icon set.
   The icons are drawn locally in a rounded, 1.75px-stroke style (visually a
   close match to Phosphor's friendly geometry). There is no icon-font CDN and
   no runtime font detection — every icon always renders as the same inline SVG,
   so there is never a missing glyph or a double-icon.

   Authoring: <i class="ic" data-icon="bell"> (HTML) or <Icon name="bell"/>
   (React). Friendly names resolve to a stable internal class (ph-*) that keys
   the SVG below — the class name is an implementation detail, not a font.
*/
(function () {
  // friendly name -> internal SVG key
  const MAP = {
    signal:'ph-pulse', levels:'ph-chart-bar', gauge:'ph-gauge', chart:'ph-chart-line',
    search:'ph-magnifying-glass', warning:'ph-warning', critical:'ph-warning-circle',
    check:'ph-check', 'check-circle':'ph-check-circle', bell:'ph-bell', 'bell-off':'ph-bell-slash',
    pr:'ph-git-pull-request', branch:'ph-git-branch', commit:'ph-git-commit', sparkle:'ph-sparkle',
    plug:'ph-plugs-connected', cube:'ph-cube', timeline:'ph-clock-countdown', logs:'ph-stack',
    flask:'ph-flask', shield:'ph-shield-check', undo:'ph-arrow-u-up-left', tree:'ph-tree-structure',
    eye:'ph-eye', 'arrow-right':'ph-arrow-right', 'arrow-left':'ph-arrow-left',
    'chevron-down':'ph-caret-down', close:'ph-x', plus:'ph-plus', info:'ph-info',
    'file-code':'ph-file-code', external:'ph-arrow-square-out',
    lightbulb:'ph-lightbulb', wrench:'ph-wrench', archive:'ph-archive', clock:'ph-clock', sliders:'ph-sliders'
  };
  // internal key -> inline-SVG inner markup
  const SVG = {
    'ph-pulse':'<path d="M2 13h3.2l2-6.5 3 13 2.4-8.7 1.6 2.7H22"/>',
    'ph-chart-bar':'<path d="M5 14v4M10 9v9M15 6v12M19.5 11v7"/>',
    'ph-gauge':'<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4.5-5.5"/><circle cx="12" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
    'ph-chart-line':'<path d="M4 4v16h16"/><path d="M7.5 14.5l3.5-4 3 2.5 4.5-6"/>',
    'ph-magnifying-glass':'<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    'ph-warning':'<path d="M12 4.2 2.8 19.5a1 1 0 0 0 .9 1.5h16.6a1 1 0 0 0 .9-1.5z"/><path d="M12 10v4.2"/><path d="M12 17.4h.01"/>',
    'ph-warning-circle':'<circle cx="12" cy="12" r="8.6"/><path d="M12 8v4.4"/><path d="M12 15.8h.01"/>',
    'ph-check':'<path d="M5 12.5l4.2 4.2L19 7"/>',
    'ph-check-circle':'<circle cx="12" cy="12" r="8.6"/><path d="M8.4 12.2l2.6 2.6 4.8-5.2"/>',
    'ph-bell':'<path d="M6 9.5a6 6 0 0 1 12 0c0 4.6 1.8 5.7 2.4 6.3a.7.7 0 0 1-.5 1.2H4.1a.7.7 0 0 1-.5-1.2C4.2 15.2 6 14.1 6 9.5z"/><path d="M9.8 20a2.3 2.3 0 0 0 4.4 0"/>',
    'ph-bell-slash':'<path d="M6 9.5a6 6 0 0 1 9.3-5"/><path d="M18 12.5c0 3 1.4 4.1 2 4.6"/><path d="M9.8 20a2.3 2.3 0 0 0 4.4 0"/><path d="M4 4l16 16"/>',
    'ph-git-pull-request':'<circle cx="6.5" cy="6" r="2.3"/><circle cx="6.5" cy="18" r="2.3"/><path d="M6.5 8.3v7.4"/><circle cx="17.5" cy="18" r="2.3"/><path d="M17.5 15.7v-5.2a3 3 0 0 0-3-3H10.5"/><path d="M13 5.2 10 7.6 13 10"/>',
    'ph-git-branch':'<circle cx="6.5" cy="6" r="2.3"/><circle cx="6.5" cy="18" r="2.3"/><circle cx="17.5" cy="7.5" r="2.3"/><path d="M6.5 8.3v7.4"/><path d="M17.5 9.8c0 4.2-5.5 2.6-5.5 6.4"/>',
    'ph-git-commit':'<circle cx="12" cy="12" r="3.2"/><path d="M3 12h5.8"/><path d="M15.2 12H21"/>',
    'ph-sparkle':'<path d="M12 2.5l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9z" fill="currentColor" stroke="none"/><path d="M18.5 15l.8 2.2L21.5 18l-2.2.8L18.5 21l-.8-2.2L15.5 18l2.2-.8z" fill="currentColor" stroke="none"/>',
    'ph-plugs-connected':'<path d="M9 3v4M15 3v4"/><path d="M7 7h10v3.5a5 5 0 0 1-10 0z"/><path d="M12 15.5V21"/>',
    'ph-cube':'<path d="M12 3 4 7.4v9.2L12 21l8-4.4V7.4z"/><path d="M4 7.4 12 12l8-4.6"/><path d="M12 12v9"/>',
    'ph-clock-countdown':'<circle cx="5" cy="6.5" r="1.7"/><path d="M9 6.5h11"/><circle cx="5" cy="12" r="1.7"/><path d="M9 12h11"/><circle cx="5" cy="17.5" r="1.7"/><path d="M9 17.5h11"/>',
    'ph-stack':'<path d="M12 3 3 8l9 5 9-5z"/><path d="M3 13l9 5 9-5"/>',
    'ph-flask':'<path d="M9.5 3h5"/><path d="M10 3v6.2l-4.6 8.3a1.4 1.4 0 0 0 1.2 2.1h10.8a1.4 1.4 0 0 0 1.2-2.1L14 9.2V3"/><path d="M7.7 15h8.6"/>',
    'ph-shield-check':'<path d="M12 3l7 2.8v5.2c0 4.8-3.3 7.6-7 9.2-3.7-1.6-7-4.4-7-9.2V5.8z"/><path d="M9 11.8l2.2 2.2 4-4.2"/>',
    'ph-arrow-u-up-left':'<path d="M7.5 4.5 4 8l3.5 3.5"/><path d="M4 8h10.5a5.5 5.5 0 0 1 0 11H10"/>',
    'ph-tree-structure':'<circle cx="12" cy="5" r="2.4"/><circle cx="6" cy="19" r="2.4"/><circle cx="18" cy="19" r="2.4"/><path d="M12 7.4v3.1M12 10.5H6v6.1M12 10.5h6v6.1"/>',
    'ph-eye':'<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    'ph-arrow-right':'<path d="M4.5 12h15"/><path d="M13 5.5l6.5 6.5-6.5 6.5"/>',
    'ph-arrow-left':'<path d="M19.5 12h-15"/><path d="M11 5.5 4.5 12l6.5 6.5"/>',
    'ph-caret-down':'<path d="M6 9.5l6 6 6-6"/>',
    'ph-x':'<path d="M6 6l12 12M18 6 6 18"/>',
    'ph-plus':'<path d="M12 5v14M5 12h14"/>',
    'ph-info':'<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5"/><path d="M12 7.8h.01"/>',
    'ph-file-code':'<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><path d="M10.5 12l-2 2 2 2M13.5 12l2 2-2 2"/>',
    'ph-arrow-square-out':'<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5"/>',
    'ph-lightbulb':'<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 1 3.8 10.6c-.7.6-1.1 1.1-1.3 2.1-.1.4-.4.8-.9.8h-3.2c-.5 0-.8-.4-.9-.8-.2-1-.6-1.5-1.3-2.1A6 6 0 0 1 12 3z"/>',
    'ph-wrench':'<path d="M15 4.5a4.2 4.2 0 0 0-5.4 5.4l-5.1 5.1a1.5 1.5 0 0 0 0 2.1l1.4 1.4a1.5 1.5 0 0 0 2.1 0l5.1-5.1A4.2 4.2 0 0 0 19.5 9l-2.4 2.4-2.5-.6-.6-2.5z"/>',
    'ph-archive':'<path d="M4 7h16v3H4z"/><path d="M5.5 10v8.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V10"/><path d="M9.8 13.5h4.4"/>',
    'ph-clock':'<circle cx="12" cy="12" r="8.6"/><path d="M12 7.6V12l3 2"/>',
    'ph-sliders':'<path d="M5 7h9M18 7h1M5 17h1M10 17h9"/><circle cx="16" cy="7" r="2.1"/><circle cx="8" cy="17" r="2.1"/>'
  };

  function wrap(inner) {
    return '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" '
      + 'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" '
      + 'style="display:inline-block;vertical-align:-0.15em;flex:none">' + inner + '</svg>';
  }
  function phClass(name) { return MAP[name] || name; }                 // friendly -> internal key
  function svgFor(name) { return SVG[phClass(name)] || ''; }
  function iconHTML(name) { return wrap(svgFor(name)); }               // friendly -> full <svg> string
  function phNameOf(el) {
    for (const c of el.classList) if (c.startsWith('ph-') && c !== 'ph-fill' && c !== 'ph-bold' && SVG[c]) return c;
    return null;
  }

  // hydrate plain-HTML <i class="ic" data-icon="x"> into <i class="ic ph ph-x">
  function hydrate(root) {
    (root || document).querySelectorAll('[data-icon]:not([data-iconized])').forEach(function (el) {
      const ph = phClass(el.getAttribute('data-icon'));
      el.classList.add('ph'); el.classList.add(ph);
      el.setAttribute('data-iconized', '1');
    });
  }

  // render: replace each icon element's content with its inline SVG
  function inject(el) {
    if (el.getAttribute('data-ph-fb')) return;
    const ph = phNameOf(el); if (!ph) return;
    el.innerHTML = wrap(SVG[ph]); el.setAttribute('data-ph-fb', '1');
  }
  function injectAll(root) { (root || document).querySelectorAll('i.ph,span.ph').forEach(inject); }
  function renderIcons() {
    injectAll(document);
    if (!window.MutationObserver) return;
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.classList && n.classList.contains('ph')) inject(n);
          if (n.querySelectorAll) n.querySelectorAll('.ph').forEach(inject);
        });
      });
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
  function boot() {
    hydrate();
    renderIcons();
  }

  window.Instrument = window.Instrument || {};
  window.Instrument.phClass = phClass;
  window.Instrument.hydrateIcons = hydrate;
  window.Instrument.iconHTML = iconHTML;
  window.Instrument.iconNames = Object.keys(MAP);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
