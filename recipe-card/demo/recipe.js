// Recipe Card: pure functions shared by the content script and the Node tests.
// Reads schema.org Recipe data (JSON-LD), scales ingredient amounts, converts units.
(function (root) {
  'use strict';

  // ---------- text helpers ----------
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', frac12: '½', frac14: '¼',
    frac34: '¾', deg: '°', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…',
    eacute: 'é', egrave: 'è', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç', times: '×' };

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      const v = NAMED[e.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  function clean(s) {
    if (s === null || s === undefined) return '';
    if (typeof s === 'number') return String(s);
    if (typeof s !== 'string') return '';
    let t = s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ');
    // decode twice: some sites double-encode (&amp;#39;)
    t = decodeEntities(decodeEntities(t));
    return t.replace(/[\s ]+/g, ' ').trim();
  }

  // ---------- JSON-LD discovery ----------
  function parseJsonLoose(text) {
    let t = String(text || '').trim()
      .replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
      .replace(/^<!--/, '').replace(/-->$/, '').trim();
    try { return JSON.parse(t); } catch (e) { /* fall through */ }
    // raw control characters inside strings are a common breakage
    try { return JSON.parse(t.replace(/[\u0000-\u001f]+/g, ' ')); } catch (e) { return null; }
  }

  function isRecipeType(t) {
    const list = Array.isArray(t) ? t : [t];
    return list.some((x) => typeof x === 'string' && /^(https?:\/\/schema\.org\/|schema:)?Recipe$/i.test(x.trim()));
  }

  function findRecipes(node, out, depth) {
    if (!node || depth > 12) return out;
    if (Array.isArray(node)) { node.forEach((n) => findRecipes(n, out, depth + 1)); return out; }
    if (typeof node !== 'object') return out;
    if (isRecipeType(node['@type'])) out.push(node);
    for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item', 'hasPart']) {
      if (node[key] && typeof node[key] === 'object') findRecipes(node[key], out, depth + 1);
    }
    return out;
  }

  // ---------- field normalizers ----------
  function pickImage(img) {
    if (!img) return '';
    if (typeof img === 'string') return img;
    if (Array.isArray(img)) { for (const i of img) { const u = pickImage(i); if (u) return u; } return ''; }
    if (typeof img === 'object') return typeof img.url === 'string' ? img.url : (typeof img.contentUrl === 'string' ? img.contentUrl : '');
    return '';
  }

  function pickAuthor(a) {
    if (!a) return '';
    if (typeof a === 'string') return clean(a);
    if (Array.isArray(a)) return a.map(pickAuthor).filter(Boolean).join(', ');
    if (typeof a === 'object') return clean(a.name);
    return '';
  }

  // ISO 8601 duration (PT1H30M, P0DT0H20M, PT90M) -> minutes, or null
  function durationMinutes(d) {
    if (typeof d !== 'string') return null;
    const m = d.trim().match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
    if (!m || d.trim().toUpperCase() === 'P' || d.trim().toUpperCase() === 'PT') return null;
    const mins = (parseFloat(m[1] || 0) * 1440) + (parseFloat(m[2] || 0) * 60) + parseFloat(m[3] || 0) + (parseFloat(m[4] || 0) / 60);
    return Math.round(mins);
  }

  function formatMinutes(n) {
    if (n === null || n === undefined || n <= 0) return '';
    const h = Math.floor(n / 60), m = n % 60;
    if (!h) return m + ' min';
    return h + ' hr' + (m ? ' ' + m + ' min' : '');
  }

  // recipeYield: "4", 4, "4 servings", ["4", "4 servings"], "Makes 12 cookies", "6-8"
  function parseYield(y) {
    const list = Array.isArray(y) ? y : [y];
    let label = '';
    for (const item of list) {
      const s = clean(item);
      if (!s) continue;
      if (!label) label = s;
      const m = s.match(/(\d+(?:\.\d+)?)/);
      if (m) {
        const n = parseFloat(m[1]);
        if (n > 0 && n < 1000) return { count: n, label: s };
      }
    }
    return { count: null, label };
  }

  // Instructions -> [{section, steps: [text]}]
  function parseInstructions(ins) {
    const sections = [];
    let current = { section: '', steps: [] };
    sections.push(current);
    function addText(t) {
      const s = clean(t);
      if (s) current.steps.push(s);
    }
    function walk(x, depth) {
      if (!x || depth > 8) return;
      if (typeof x === 'string') {
        // a single string may hold several steps separated by newlines or <li>/<p>
        const parts = x.split(/\n+|<\/(?:li|p)>|<br\s*\/?>\s*<br\s*\/?>/i).map(clean).filter(Boolean);
        parts.forEach((p) => current.steps.push(p));
        return;
      }
      if (Array.isArray(x)) { x.forEach((i) => walk(i, depth + 1)); return; }
      if (typeof x !== 'object') return;
      const type = Array.isArray(x['@type']) ? x['@type'].join(' ') : String(x['@type'] || '');
      if (/HowToSection/i.test(type) || (x.itemListElement && !x.text)) {
        current = { section: clean(x.name), steps: [] };
        sections.push(current);
        walk(x.itemListElement, depth + 1);
        current = { section: '', steps: [] };
        sections.push(current);
        return;
      }
      if (x.text !== undefined) addText(x.text);
      else if (x.name !== undefined) addText(x.name);
    }
    walk(ins, 0);
    return sections.filter((s) => s.steps.length);
  }

  function normalizeRecipe(r, pageUrl) {
    const ingredients = (Array.isArray(r.recipeIngredient) ? r.recipeIngredient
      : Array.isArray(r.ingredients) ? r.ingredients
        : typeof r.recipeIngredient === 'string' ? r.recipeIngredient.split(/\n+/) : [])
      .map(clean).filter(Boolean);
    const y = parseYield(r.recipeYield !== undefined ? r.recipeYield : r.yield);
    return {
      name: clean(r.name) || clean(r.headline) || 'Recipe',
      description: clean(r.description),
      image: pickImage(r.image),
      author: pickAuthor(r.author),
      prep: durationMinutes(r.prepTime),
      cook: durationMinutes(r.cookTime),
      total: durationMinutes(r.totalTime),
      servings: y.count,
      yieldLabel: y.label,
      ingredients,
      instructions: parseInstructions(r.recipeInstructions),
      url: typeof r.url === 'string' ? r.url : (pageUrl || ''),
    };
  }

  // Takes the text of every <script type="application/ld+json"> on the page.
  // Returns the best recipe (the one with the most ingredients + steps), or null.
  function extractRecipe(jsonTexts, pageUrl) {
    const found = [];
    for (const t of jsonTexts) {
      const data = parseJsonLoose(t);
      if (data) findRecipes(data, found, 0);
    }
    const recipes = found.map((r) => normalizeRecipe(r, pageUrl))
      .filter((r) => r.ingredients.length || r.instructions.length);
    if (!recipes.length) return null;
    const score = (r) => r.ingredients.length + r.instructions.reduce((a, s) => a + s.steps.length, 0);
    recipes.sort((a, b) => score(b) - score(a));
    return recipes[0];
  }

  // ---------- quantities ----------
  const UNICODE_FRACTIONS = { '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅕': 1 / 5, '⅖': 2 / 5,
    '⅗': 3 / 5, '⅘': 4 / 5, '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8 };
  const UF = Object.keys(UNICODE_FRACTIONS).join('');

  // one number: "1 1/2", "1½", "1 ½", "½", "1/2", "1.5", "1,5", "2"
  const NUM = '(?:\\d+\\s*[' + UF + ']|\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+\\s*/\\s*\\d+|[' + UF + ']|\\d+(?:[.,]\\d+)?)';
  const QTY_RE = new RegExp('^\\s*(' + NUM + ')(?:\\s*(?:-|–|—|to|or)\\s*(' + NUM + '))?(?![\\d/])');

  function numValue(s) {
    s = s.trim();
    let m;
    if ((m = s.match(new RegExp('^(\\d+)\\s*([' + UF + '])$')))) return parseInt(m[1], 10) + UNICODE_FRACTIONS[m[2]];
    if ((m = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/))) return parseInt(m[1], 10) + parseInt(m[2], 10) / parseInt(m[3], 10);
    if ((m = s.match(/^(\d+)\s*\/\s*(\d+)$/))) return parseInt(m[2], 10) ? parseInt(m[1], 10) / parseInt(m[2], 10) : NaN;
    if (UNICODE_FRACTIONS[s] !== undefined) return UNICODE_FRACTIONS[s];
    return parseFloat(s.replace(',', '.'));
  }

  // unit aliases -> canonical id
  const UNIT_ALIASES = [
    ['tsp', ['teaspoons', 'teaspoon', 'tsps', 'tsp.', 'tsp', 't']],
    ['tbsp', ['tablespoons', 'tablespoon', 'tbsps', 'tbsp.', 'tbsp', 'tbs.', 'tbs', 'tbl', 'T']],
    ['floz', ['fluid ounces', 'fluid ounce', 'fl. oz.', 'fl. oz', 'fl oz.', 'fl oz', 'floz']],
    ['cup', ['cups', 'cup', 'c.']],
    ['pint', ['pints', 'pint', 'pt.', 'pt']],
    ['quart', ['quarts', 'quart', 'qt.', 'qt']],
    ['gallon', ['gallons', 'gallon', 'gal.', 'gal']],
    ['ml', ['milliliters', 'milliliter', 'millilitres', 'millilitre', 'ml.', 'ml', 'mL']],
    ['l', ['liters', 'liter', 'litres', 'litre', 'l']],
    ['oz', ['ounces', 'ounce', 'oz.', 'oz']],
    ['lb', ['pounds', 'pound', 'lbs.', 'lbs', 'lb.', 'lb']],
    ['g', ['grams', 'gram', 'gr.', 'g.', 'g']],
    ['kg', ['kilograms', 'kilogram', 'kilos', 'kilo', 'kg.', 'kg']],
  ];
  // Every unit, as [alias, id], longest first, case-sensitive only for t/T.
  const UNIT_LIST = [];
  UNIT_ALIASES.forEach(([id, names]) => names.forEach((n) => UNIT_LIST.push([n, id])));
  UNIT_LIST.sort((a, b) => b[0].length - a[0].length);

  function matchUnit(rest) {
    for (const [alias, id] of UNIT_LIST) {
      const caseSensitive = alias === 't' || alias === 'T';
      const head = rest.slice(0, alias.length);
      if (caseSensitive ? head !== alias : head.toLowerCase() !== alias.toLowerCase()) continue;
      const next = rest.charAt(alias.length);
      // a unit must end at a word boundary ("g" must not match "garlic")
      if (next && /[a-z]/i.test(next) && !alias.endsWith('.')) continue;
      return { id, text: rest.slice(0, alias.length) };
    }
    return null;
  }

  // "1 1/2 cups flour" -> {qty: 1.5, qty2: null, unit: 'cup', unitText: 'cups', rest: 'flour'}
  function parseIngredient(line) {
    const m = line.match(QTY_RE);
    if (!m) return { qty: null, qty2: null, unit: null, unitText: '', rest: line, raw: line };
    const qty = numValue(m[1]);
    const qty2 = m[2] ? numValue(m[2]) : null;
    if (!Number.isFinite(qty)) return { qty: null, qty2: null, unit: null, unitText: '', rest: line, raw: line };
    let after = line.slice(m[0].length);
    const gap = after.match(/^\s*/)[0];
    let unit = null, unitText = '';
    const u = matchUnit(after.slice(gap.length));
    // "2 large eggs": no unit. "1 t salt": unit t only when followed by a space.
    if (u) {
      unit = u.id; unitText = u.text;
      after = after.slice(gap.length + u.text.length);
    }
    return { qty, qty2: Number.isFinite(qty2) ? qty2 : null, unit, unitText, rest: after.replace(/^\s+/, ''), raw: line };
  }

  // ---------- formatting ----------
  const NICE = [[0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'],
    [3 / 4, '¾'], [7 / 8, '⅞'], [1, '']];

  // Kitchen-friendly number: fractions for small US amounts, whole numbers above 10.
  function formatQty(x) {
    if (!Number.isFinite(x)) return '';
    if (x >= 10) return String(Math.round(x));
    if (x > 0 && x < 1 / 16) return String(Math.round(x * 100) / 100);
    let whole = Math.floor(x), frac = x - whole;
    let best = NICE[0], bestErr = Infinity;
    for (const n of NICE) { const e = Math.abs(frac - n[0]); if (e < bestErr) { bestErr = e; best = n; } }
    if (best[0] === 1) { whole += 1; best = NICE[0]; }
    if (whole === 0 && !best[1]) return x > 0 ? '⅛' : '0';
    return (whole ? String(whole) : '') + best[1];
  }

  function formatMetric(x) {
    if (x >= 100) return String(Math.round(x / 5) * 5);
    if (x >= 10) return String(Math.round(x));
    const r = Math.round(x * 2) / 2;
    return String(r === 0 ? Math.round(x * 10) / 10 : r);
  }

  // ---------- conversion ----------
  const ML = { tsp: 4.92892, tbsp: 14.7868, floz: 29.5735, cup: 236.588, pint: 473.176, quart: 946.353, gallon: 3785.41, ml: 1, l: 1000 };
  const G = { oz: 28.3495, lb: 453.592, g: 1, kg: 1000 };
  const US_UNITS = { tsp: 1, tbsp: 1, floz: 1, cup: 1, pint: 1, quart: 1, gallon: 1, oz: 1, lb: 1 };
  const LABEL = { tsp: ['tsp', 'tsp'], tbsp: ['tbsp', 'tbsp'], cup: ['cup', 'cups'], floz: ['fl oz', 'fl oz'],
    pint: ['pint', 'pints'], quart: ['quart', 'quarts'], gallon: ['gallon', 'gallons'], oz: ['oz', 'oz'], lb: ['lb', 'lb'],
    ml: ['ml', 'ml'], l: ['l', 'l'], g: ['g', 'g'], kg: ['kg', 'kg'] };

  function toMetric(qty, unit) {
    if (ML[unit] !== undefined) {
      const ml = qty * ML[unit];
      return ml >= 1000 ? { qty: ml / 1000, unit: 'l' } : { qty: ml, unit: 'ml' };
    }
    if (G[unit] !== undefined) {
      const g = qty * G[unit];
      return g >= 1000 ? { qty: g / 1000, unit: 'kg' } : { qty: g, unit: 'g' };
    }
    return null;
  }

  function toUS(qty, unit) {
    if (ML[unit] !== undefined) {
      const ml = qty * ML[unit];
      // pick the largest unit that gives at least 1 of it (tsp under 1 tbsp, tbsp under 1/4 cup)
      if (ml < ML.tbsp) return { qty: ml / ML.tsp, unit: 'tsp' };
      if (ml < ML.cup / 4) return { qty: ml / ML.tbsp, unit: 'tbsp' };
      if (ml < ML.quart * 2) return { qty: ml / ML.cup, unit: 'cup' };
      return { qty: ml / ML.quart, unit: 'quart' };
    }
    if (G[unit] !== undefined) {
      const g = qty * G[unit];
      return g < G.lb ? { qty: g / G.oz, unit: 'oz' } : { qty: g / G.lb, unit: 'lb' };
    }
    return null;
  }

  // mode: 'original' | 'metric' | 'us'. factor: servings multiplier.
  // Returns {amount, text} where amount is the formatted quantity + unit (may be '') and text is the rest.
  function renderIngredient(line, factor, mode) {
    const p = parseIngredient(line);
    if (p.qty === null) return { amount: '', text: line, scaled: false };
    let q1 = p.qty * factor, q2 = p.qty2 === null ? null : p.qty2 * factor;
    let unit = p.unit, unitLabel = p.unitText;
    const target = mode === 'metric' && unit && US_UNITS[unit] ? toMetric
      : mode === 'us' && unit && !US_UNITS[unit] ? toUS : null;
    let metric = unit === 'ml' || unit === 'l' || unit === 'g' || unit === 'kg';
    let relabel = null;
    if (target) {
      const c1 = target(q1, unit);
      // keep a range in one unit: convert the second end with the first end's ratio
      q2 = q2 === null ? null : q2 * (c1.qty / q1);
      q1 = c1.qty;
      unit = c1.unit;
      metric = mode === 'metric';
      relabel = (plural) => LABEL[unit][plural ? 1 : 0];
    } else if (factor !== 1 && q2 === null && /^(teaspoon|tablespoon|cup|pint|quart|gallon|ounce|pound|gram|kilogram|liter|litre|milliliter|millilitre)s?$/i.test(unitLabel)) {
      // keep the recipe's own word, fix singular/plural ("2 cups" halved -> "1 cup")
      const base = unitLabel.replace(/s$/i, '');
      relabel = (plural) => (plural ? base + 's' : base);
    }
    const fmt = !metric ? formatQty : (unit === 'l' || unit === 'kg') ? (x) => String(Math.round(x * 10) / 10) : formatMetric;
    const a1 = fmt(q1);
    // plural follows what's shown: "1 cup" even when 1.06 cups was rounded to 1
    if (relabel) unitLabel = relabel(q2 !== null || (a1 !== '1' && q1 > 1));
    const amount = a1 + (q2 !== null ? '–' + fmt(q2) : '') + (unitLabel ? ' ' + unitLabel : '');
    return { amount, text: p.rest, scaled: true };
  }

  // 350°F / 350 degrees F -> adds the other scale in brackets when converting.
  function convertTemps(text, mode) {
    if (mode === 'metric') {
      return text.replace(/(\d{2,3})\s*(?:°|º|degrees?)\s*F(?:ahrenheit)?\b/gi, (m, f) => {
        const c = Math.round(((parseInt(f, 10) - 32) * 5 / 9) / 5) * 5;
        return m + ' (' + c + '°C)';
      });
    }
    if (mode === 'us') {
      return text.replace(/(\d{2,3})\s*(?:°|º|degrees?)\s*C(?:elsius)?\b/gi, (m, c) => {
        const f = Math.round((parseInt(c, 10) * 9 / 5 + 32) / 5) * 5;
        return m + ' (' + f + '°F)';
      });
    }
    return text;
  }

  const api = { clean, decodeEntities, parseJsonLoose, extractRecipe, durationMinutes, formatMinutes, parseYield,
    parseInstructions, parseIngredient, numValue, formatQty, formatMetric, toMetric, toUS, renderIngredient, convertTemps };
  root.RecipeCardLib = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
