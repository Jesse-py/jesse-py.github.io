// Recipe Card content script. Injected only when the user clicks the toolbar button (activeTab),
// so it never runs on a page by itself. Reads the page's schema.org Recipe JSON-LD and shows it
// in an overlay. Nothing leaves the page; the only thing stored is the user's units choice.
(function () {
  'use strict';
  const L = globalThis.RecipeCardLib;
  const HOST_ID = 'recipe-card-ext-host';

  const existing = document.getElementById(HOST_ID);
  if (existing) {
    if (existing.__recipeCardClose) existing.__recipeCardClose();
    else { existing.remove(); document.documentElement.style.overflow = ''; }
    return;
  }

  const texts = Array.from(document.querySelectorAll('script[type="application/ld+json" i]')).map((s) => s.textContent);
  const recipe = L.extractRecipe(texts, location.href);

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('style', 'all: initial; position: fixed; inset: 0; z-index: 2147483647;');
  const root = host.attachShadow({ mode: 'open' });
  const css = document.createElement('style');
  css.textContent = STYLE();
  root.appendChild(css);

  const printStyle = document.createElement('style');
  printStyle.textContent = '@media print { body > *:not(#' + HOST_ID + ') { display: none !important; } ' +
    '#' + HOST_ID + ' { position: static !important; } html, body { overflow: visible !important; height: auto !important; } }';

  const prevOverflow = document.documentElement.style.overflow;
  let wakeLock = null;

  function close() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* already released */ } wakeLock = null; }
    document.removeEventListener('keydown', onKey, true);
    document.documentElement.style.overflow = prevOverflow;
    printStyle.remove();
    host.remove();
  }
  host.__recipeCardClose = close;

  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) => c && n.appendChild(c));
    return n;
  }

  const backdrop = el('div', { class: 'backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
  const card = el('div', { class: 'card', role: 'dialog', 'aria-modal': 'true', 'aria-label': recipe ? recipe.name : 'Recipe Card' });
  backdrop.appendChild(card);
  root.appendChild(backdrop);

  const closeBtn = el('button', { class: 'close', 'aria-label': 'Close recipe card (Esc)', title: 'Close (Esc)', text: '×', onclick: close });

  if (!recipe) {
    card.appendChild(closeBtn);
    card.appendChild(el('h1', { text: 'No recipe found on this page' }));
    card.appendChild(el('p', { class: 'muted', text: 'Recipe Card reads the recipe data that most recipe sites include for search engines (schema.org Recipe). This page doesn’t have any. Open the recipe’s own page (not a list or search page) and try again.' }));
  } else {
    let factor = 1;
    let servings = recipe.servings;
    let mode = 'original';

    const header = el('div', { class: 'head' });
    header.appendChild(closeBtn);
    if (recipe.image && /^https?:\/\//i.test(recipe.image)) {
      header.appendChild(el('img', { class: 'photo', src: recipe.image, alt: '', referrerpolicy: 'no-referrer' }));
    }
    header.appendChild(el('h1', { text: recipe.name }));
    const meta = [];
    if (recipe.prep) meta.push('Prep ' + L.formatMinutes(recipe.prep));
    if (recipe.cook) meta.push('Cook ' + L.formatMinutes(recipe.cook));
    if (recipe.total) meta.push('Total ' + L.formatMinutes(recipe.total));
    if (meta.length) header.appendChild(el('p', { class: 'meta', text: meta.join(' · ') }));
    card.appendChild(header);

    // controls
    const controls = el('div', { class: 'controls' });
    const servingsOut = el('output', { class: 'servings', 'aria-live': 'polite' });
    if (servings) {
      const minus = el('button', { class: 'step', 'aria-label': 'Fewer servings', text: '−', onclick: () => setServings(servings - stepSize()) });
      const plus = el('button', { class: 'step', 'aria-label': 'More servings', text: '+', onclick: () => setServings(servings + stepSize()) });
      controls.appendChild(el('div', { class: 'group' }, [el('span', { class: 'label', text: 'Servings' }), minus, servingsOut, plus]));
    } else {
      // no numeric yield: offer a plain multiplier instead
      const sel = el('select', { 'aria-label': 'Scale recipe', onchange: (e) => { factor = parseFloat(e.target.value); renderIngredients(); } });
      [['0.5', '½×'], ['1', '1×'], ['1.5', '1½×'], ['2', '2×'], ['3', '3×']].forEach(([v, t]) => {
        const o = el('option', { value: v, text: t }); if (v === '1') o.selected = true; sel.appendChild(o);
      });
      controls.appendChild(el('div', { class: 'group' }, [el('span', { class: 'label', text: 'Scale' }), sel]));
    }
    const unitsSel = el('select', { 'aria-label': 'Units', onchange: (e) => { mode = e.target.value; save(); renderAll(); } });
    [['original', 'As written'], ['metric', 'Metric'], ['us', 'US cups/oz']].forEach(([v, t]) => unitsSel.appendChild(el('option', { value: v, text: t })));
    controls.appendChild(el('div', { class: 'group' }, [el('span', { class: 'label', text: 'Units' }), unitsSel]));

    const cookBtn = el('button', { class: 'pill', 'aria-pressed': 'false', title: 'Keeps your screen from going to sleep while you cook', text: 'Cook mode', onclick: toggleCook });
    const printBtn = el('button', { class: 'pill', text: 'Print', onclick: () => { document.head.appendChild(printStyle); window.print(); } });
    controls.appendChild(el('div', { class: 'group' }, [cookBtn, printBtn]));
    card.appendChild(controls);

    const body = el('div', { class: 'body' });
    const ingBox = el('section', { class: 'ing' }, [el('h2', { text: 'Ingredients' })]);
    const ingList = el('ul', { class: 'checks' });
    ingBox.appendChild(ingList);
    const stepsBox = el('section', { class: 'steps' }, [el('h2', { text: 'Steps' })]);
    body.appendChild(ingBox);
    body.appendChild(stepsBox);
    card.appendChild(body);

    const src = el('p', { class: 'source' });
    let host_ = '';
    try { host_ = new URL(recipe.url || location.href).hostname.replace(/^www\./, ''); } catch (e) { host_ = location.hostname; }
    src.appendChild(document.createTextNode((host_ ? 'Recipe from ' + host_ : 'Recipe') + (recipe.author ? ' by ' + recipe.author : '') + '. '));
    src.appendChild(el('a', { href: '#', text: 'Back to the original page', onclick: (e) => { e.preventDefault(); close(); } }));
    card.appendChild(src);

    function stepSize() { return servings >= 12 ? 2 : 1; }
    function setServings(n) {
      if (n < 1 || n > 200) return;
      servings = n; factor = n / recipe.servings; renderIngredients();
    }
    function renderIngredients() {
      if (recipe.servings) servingsOut.textContent = String(servings);
      const checked = new Set(Array.from(ingList.querySelectorAll('input:checked')).map((i) => i.dataset.i));
      ingList.textContent = '';
      recipe.ingredients.forEach((line, i) => {
        const r = L.renderIngredient(line, factor, mode);
        const id = 'rc-ing-' + i;
        const box = el('input', { type: 'checkbox', id, 'data-i': String(i) });
        if (checked.has(String(i))) box.checked = true;
        const label = el('label', { for: id }, [r.amount ? el('strong', { text: r.amount }) : null, document.createTextNode((r.amount ? ' ' : '') + L.convertTemps(r.text, mode))]);
        ingList.appendChild(el('li', null, [box, label]));
      });
      if (factor !== 1 && recipe.ingredients.length) {
        ingList.appendChild(el('li', { class: 'note', text: 'Amounts are scaled; cooking times and pan sizes may need adjusting.' }));
      }
    }
    function renderSteps() {
      const done = new Set(Array.from(stepsBox.querySelectorAll('li.done')).map((li) => li.dataset.i));
      Array.from(stepsBox.querySelectorAll('h3, ol')).forEach((n) => n.remove());
      let k = 0;
      recipe.instructions.forEach((sec) => {
        if (sec.section) stepsBox.appendChild(el('h3', { text: sec.section }));
        const ol = el('ol', { start: String(k + 1) });
        sec.steps.forEach((s) => {
          const idx = String(k++);
          const li = el('li', { 'data-i': idx, tabindex: '0', title: 'Click to mark done' }, [document.createTextNode(L.convertTemps(s, mode))]);
          if (done.has(idx)) li.classList.add('done');
          const toggle = () => li.classList.toggle('done');
          li.addEventListener('click', toggle);
          li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
          ol.appendChild(li);
        });
        stepsBox.appendChild(ol);
      });
      if (!recipe.instructions.length) stepsBox.appendChild(el('ol', null, [el('li', { text: 'This page’s recipe data has no steps. See the original page.' })]));
    }
    function renderAll() { renderIngredients(); renderSteps(); }

    async function toggleCook() {
      if (wakeLock) { try { await wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; setCook(false); return; }
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; setCook(false); });
        setCook(true);
      } catch (e) {
        cookBtn.textContent = 'Cook mode not available';
        setTimeout(() => { cookBtn.textContent = 'Cook mode'; }, 2500);
      }
    }
    function setCook(on) { cookBtn.setAttribute('aria-pressed', on ? 'true' : 'false'); cookBtn.textContent = on ? 'Cook mode: screen stays on' : 'Cook mode'; }

    function save() { try { chrome.storage.local.set({ units: mode }); } catch (e) { /* storage unavailable */ } }

    renderAll();
    try {
      chrome.storage.local.get('units').then((v) => {
        if (v && (v.units === 'metric' || v.units === 'us')) { mode = v.units; unitsSel.value = mode; renderAll(); }
      }).catch(() => {});
    } catch (e) { /* storage unavailable */ }
  }

  document.documentElement.appendChild(host);
  document.documentElement.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey, true);
  closeBtn.focus();

  function STYLE() {
    return `
:host { all: initial; }
* { box-sizing: border-box; }
.backdrop { position: fixed; inset: 0; background: rgba(20, 20, 20, .55); overflow-y: auto; padding: 24px 12px;
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d1d1d; }
.card { position: relative; max-width: 760px; margin: 0 auto; background: #fffdf8; border-radius: 14px; padding: 28px 32px 20px;
  box-shadow: 0 10px 40px rgba(0,0,0,.3); }
.close { position: absolute; top: 10px; right: 12px; width: 40px; height: 40px; border: 0; border-radius: 50%; background: #eee8dc;
  font-size: 26px; line-height: 40px; cursor: pointer; color: #333; padding: 0; }
.close:hover, .close:focus-visible { background: #e0d6c3; }
.photo { display: block; width: 100%; max-height: 300px; object-fit: cover; border-radius: 10px; margin: 0 0 16px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 48px 6px 0; font-weight: 700; }
h2 { font-size: 19px; margin: 0 0 10px; border-bottom: 2px solid #e9dfcc; padding-bottom: 4px; }
h3 { font-size: 16px; margin: 14px 0 6px; color: #7a4b12; }
.meta, .muted { color: #5c5c5c; margin: 0 0 6px; }
.controls { display: flex; flex-wrap: wrap; gap: 10px 22px; align-items: center; padding: 12px 0; margin: 8px 0 16px;
  border-top: 1px solid #ece4d4; border-bottom: 1px solid #ece4d4; }
.group { display: flex; align-items: center; gap: 8px; }
.label { font-size: 14px; color: #5c5c5c; }
.step { width: 34px; height: 34px; border-radius: 50%; border: 1px solid #c9b98f; background: #fff; font-size: 20px; line-height: 1;
  cursor: pointer; color: #333; padding: 0; }
.servings { min-width: 2ch; text-align: center; font-weight: 700; font-size: 18px; }
select { font: inherit; font-size: 15px; padding: 5px 8px; border: 1px solid #c9b98f; border-radius: 8px; background: #fff; color: #1d1d1d; }
.pill { font: inherit; font-size: 14px; padding: 6px 14px; border-radius: 999px; border: 1px solid #c9b98f; background: #fff; cursor: pointer; color: #333; }
.pill[aria-pressed="true"] { background: #2f6b3a; border-color: #2f6b3a; color: #fff; }
button:focus-visible, select:focus-visible, li[tabindex]:focus-visible, input:focus-visible { outline: 3px solid #d08a1e; outline-offset: 2px; }
.body { display: grid; grid-template-columns: minmax(220px, 2fr) 3fr; gap: 28px; }
@media (max-width: 640px) { .card { padding: 22px 16px 16px; } .body { grid-template-columns: 1fr; } h1 { font-size: 23px; } }
ul.checks { list-style: none; margin: 0; padding: 0; }
ul.checks li { display: flex; gap: 10px; align-items: flex-start; padding: 5px 0; border-bottom: 1px dashed #eee5d3; }
ul.checks input { margin-top: 5px; width: 18px; height: 18px; flex: none; accent-color: #2f6b3a; }
ul.checks input:checked + label { color: #9a9a9a; text-decoration: line-through; }
ul.checks li.note { display: block; border: 0; font-size: 13px; color: #7a4b12; padding-top: 8px; }
ol { margin: 0 0 6px; padding-left: 24px; }
ol li { padding: 4px 4px 8px; cursor: pointer; border-radius: 6px; }
ol li:hover { background: #f6efe1; }
ol li.done { color: #9a9a9a; text-decoration: line-through; }
.source { margin: 18px 0 0; font-size: 13px; color: #6b6b6b; border-top: 1px solid #ece4d4; padding-top: 10px; }
.source a { color: #7a4b12; }
@media print {
  .backdrop { position: static; background: none; padding: 0; overflow: visible; }
  .card { box-shadow: none; max-width: none; padding: 0; }
  .close, .controls .group:last-child, .step { display: none; }
  .photo { max-height: 200px; }
  ol li.done, ul.checks input:checked + label { color: inherit; text-decoration: none; }
}`;
  }
})();
