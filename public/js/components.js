// Reusable UI pieces: layout, tables, forms, pickers, rich editor, charts, timeline.
import {
  h, clear, icon, GET, debounce, cap, initials, money, num, date, dateTime, ago, toLocalInput, fromLocalInput, toast, modal, promptDialog,
} from './core.js';

// ---------- small pieces ----------
export const STATUS_TONE = { lead: 'slate', contacted: 'blue', qualified: 'violet', customer: 'green', partner: 'aqua', churned: 'red' };
export const pill = (value, tone) => h('span', { class: `pill pill-${tone || STATUS_TONE[value] || 'slate'}` }, h('i', { class: 'dot' }), cap(value || '—'));
export const avatar = (name, size = '') => h('span', { class: `avatar ${size}`, 'aria-hidden': 'true' }, initials(name));
export const tagList = (tags = []) => (tags.length ? h('span', { class: 'tags' }, tags.map((t) => h('span', { class: 'tag' }, t))) : null);
export const muted = (text) => h('span', { class: 'muted' }, text);

export function btn(label, { primary, danger, ghost, small, iconName, onClick, title, type = 'button', disabled } = {}) {
  const cls = ['btn', primary && 'btn-primary', danger && 'btn-danger', ghost && 'btn-ghost', small && 'btn-sm'].filter(Boolean).join(' ');
  return h('button', { class: cls, type, title, disabled, onclick: onClick }, iconName ? icon(iconName) : null, label ? h('span', null, label) : null);
}
export function dropdownMenu(trigger, items) {
  const menu = h('div', { class: 'menu', hidden: true, role: 'menu' }, items.filter(Boolean).map((it) => (it === '-' ? h('hr') : h('button', {
    type: 'button', class: `menu-item ${it.danger ? 'danger' : ''}`, role: 'menuitem', onclick: () => { menu.hidden = true; it.onClick(); },
  }, it.icon ? icon(it.icon) : null, it.label))));
  const onDoc = () => {
    if (!menu.isConnected) document.removeEventListener('click', onDoc);
    else menu.hidden = true;
  };
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
    menu.hidden = !open;
  });
  document.addEventListener('click', onDoc);
  return h('div', { class: 'dropdown' }, trigger, menu);
}

export const iconBtn = (name, title, onClick) => h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, onclick: onClick, disabled: !onClick }, icon(name));

export function pageHeader(title, { subtitle, actions = [], back } = {}) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'page-title' },
      back ? h('a', { class: 'back-link', href: back.href }, icon('chevronLeft'), back.label) : null,
      h('h1', null, title),
      subtitle ? h('p', { class: 'subtitle' }, subtitle) : null),
    h('div', { class: 'page-actions' }, actions));
}

export function emptyState({ iconName = 'inbox', title, text, action }) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, icon(iconName)), h('h3', null, title), text ? h('p', null, text) : null, action || null);
}

export function card(title, body, { actions, cls = '' } = {}) {
  return h('section', { class: `card ${cls}` },
    title ? h('div', { class: 'card-head' }, h('h3', null, title), actions ? h('div', { class: 'card-actions' }, actions) : null) : null,
    h('div', { class: 'card-body' }, body));
}

export function tabs(items, active, onChange) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.map((t) => h('button', {
    class: `tab ${t.id === active ? 'active' : ''}`, role: 'tab', 'aria-selected': String(t.id === active), type: 'button',
    onclick: () => onChange(t.id),
  }, t.icon ? icon(t.icon) : null, t.label, t.count !== undefined && t.count !== null ? h('span', { class: 'count' }, num(t.count)) : null)));
}

export function segmented(options, value, onChange) {
  return h('div', { class: 'segmented' }, options.map((o) => h('button', {
    type: 'button', class: o.value === value ? 'on' : '', onclick: () => onChange(o.value),
  }, o.label)));
}

export function loading() {
  return h('div', { class: 'loading-block' }, h('span', { class: 'spinner' }), 'Loading…');
}

export function errorBlock(err, retry) {
  return h('div', { class: 'error-block' }, icon('alert'), h('span', null, err?.message || String(err)), retry ? btn('Retry', { small: true, onClick: retry }) : null);
}

export function kv(rows) {
  return h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v === null || v === undefined || v === '' ? muted('—') : v)]));
}

export function copyField(value, { label } = {}) {
  const input = h('input', { class: 'input mono', readonly: true, value });
  input.addEventListener('focus', () => input.select());
  return h('div', { class: 'copy-field' }, label ? h('span', { class: 'label' }, label) : null,
    h('div', { class: 'copy-row' }, input, btn('', { iconName: 'copy', small: true, title: 'Copy', onClick: () => navigator.clipboard.writeText(value).then(() => toast('Copied')) })));
}

export function selectInput(options, value, onChange, { placeholder, cls = '' } = {}) {
  const sel = h('select', { class: `input ${cls}`, value: value ?? '' },
    placeholder !== undefined ? h('option', { value: '' }, placeholder) : null,
    options.map((o) => h('option', { value: String(o.value ?? o) }, o.label ?? cap(o))));
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

export function searchInput(value, onSearch, placeholder = 'Search…') {
  const input = h('input', { class: 'input', type: 'search', placeholder, value: value || '' });
  input.addEventListener('input', debounce(() => onSearch(input.value.trim()), 300));
  return h('div', { class: 'search-input' }, icon('search'), input);
}

// ---------- table ----------
export function dataTable({ columns, rows, onRowClick, selectable, selected, onSelectionChange, sort, onSort, empty }) {
  const sel = selected || new Set();
  const allIds = rows.map((r) => r.id);
  const headCheck = selectable ? h('input', { type: 'checkbox', 'aria-label': 'Select all', checked: allIds.length > 0 && allIds.every((id) => sel.has(id)) }) : null;
  headCheck?.addEventListener('change', () => {
    allIds.forEach((id) => (headCheck.checked ? sel.add(id) : sel.delete(id)));
    onSelectionChange?.(sel);
  });
  const sortKey = sort ? String(sort).replace(/^-/, '') : null;
  const desc = String(sort || '').startsWith('-');
  const thead = h('thead', null, h('tr', null,
    selectable ? h('th', { class: 'col-check' }, headCheck) : null,
    columns.map((c) => h('th', {
      class: [c.cls, c.sort ? 'sortable' : '', c.sort && sortKey === c.sort ? 'sorted' : ''].filter(Boolean).join(' '),
      style: c.width ? { width: c.width } : null,
      onclick: c.sort && onSort ? () => onSort(sortKey === c.sort && !desc ? `-${c.sort}` : c.sort) : null,
    }, c.label, c.sort && sortKey === c.sort ? icon(desc ? 'chevronDown' : 'arrowUp', 'sort-ico') : null))));
  const tbody = h('tbody', null, rows.map((r) => {
    const check = selectable ? h('input', { type: 'checkbox', 'aria-label': 'Select row', checked: sel.has(r.id) }) : null;
    check?.addEventListener('change', () => { (check.checked ? sel.add(r.id) : sel.delete(r.id)); onSelectionChange?.(sel); });
    return h('tr', {
      class: onRowClick ? 'clickable' : '',
      onclick: (e) => { if (e.target.closest('input, button, a, select, .no-row-click')) return; onRowClick?.(r, e); },
    }, selectable ? h('td', { class: 'col-check' }, check) : null,
    columns.map((c) => h('td', { class: c.cls }, c.render ? c.render(r) : (r[c.key] ?? muted('—')))));
  }));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, thead, tbody), rows.length ? null : (empty || h('div', { class: 'table-empty' }, 'Nothing here yet')));
}

export function pager({ total, limit, offset, onChange }) {
  if (total <= limit) return h('div', { class: 'pager' }, muted(`${num(total)} total`));
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return h('div', { class: 'pager' },
    muted(`${num(offset + 1)}–${num(Math.min(offset + limit, total))} of ${num(total)}`),
    h('div', { class: 'pager-btns' },
      btn('', { iconName: 'chevronLeft', small: true, title: 'Previous page', disabled: page <= 1, onClick: () => onChange(offset - limit) }),
      h('span', { class: 'pager-page' }, `${page} / ${pages}`),
      btn('', { iconName: 'chevronRight', small: true, title: 'Next page', disabled: page >= pages, onClick: () => onChange(offset + limit) })));
}

// ---------- entity picker (autocomplete) ----------
export function picker({ kind = 'contact', value = null, placeholder, allowCreate = false, onChange } = {}) {
  let current = value && (value.id || value.label) ? value : null;
  const input = h('input', { class: 'input', placeholder: placeholder || `Search ${kind === 'contact' ? 'contacts' : 'companies'}…`, value: current?.label || '', autocomplete: 'off' });
  const list = h('div', { class: 'picker-list', hidden: true });
  let firstItem = null;
  const select = (v) => { current = v; input.value = v?.label || ''; list.hidden = true; onChange?.(v); };
  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) { list.hidden = true; return; }
    const data = await GET(kind === 'contact' ? `/contacts?q=${encodeURIComponent(q)}&limit=8` : `/companies?q=${encodeURIComponent(q)}&limit=8`).catch(() => null);
    const rows = (kind === 'contact' ? data?.contacts : data?.companies) || [];
    clear(list);
    firstItem = null;
    for (const r of rows) {
      const v = { id: r.id, label: kind === 'contact' ? r.full_name : r.name, record: r };
      firstItem = firstItem || v;
      list.append(h('button', { type: 'button', class: 'picker-item', onmousedown: (e) => { e.preventDefault(); select(v); } },
        h('b', null, v.label),
        muted(kind === 'contact' ? ` ${[r.email, r.company_name].filter(Boolean).join(' · ')}` : ` ${r.domain || ''}`)));
    }
    if (allowCreate && !rows.some((r) => String(r.name || r.full_name).toLowerCase() === q.toLowerCase())) {
      const v = { id: null, label: q };
      firstItem = firstItem || v;
      list.append(h('button', { type: 'button', class: 'picker-item picker-create', onmousedown: (e) => { e.preventDefault(); select(v); } }, icon('plus'), ` Create “${q}”`));
    }
    if (!list.children.length) list.append(h('div', { class: 'picker-empty' }, 'No matches'));
    list.hidden = false;
  }, 200);
  input.addEventListener('input', () => {
    if (!input.value) current = null;
    else if (!current || current.label !== input.value) current = allowCreate ? { id: null, label: input.value } : null;
    search();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !list.hidden && firstItem) { e.preventDefault(); select(firstItem); } });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  return { el: h('div', { class: 'picker' }, input, list), getValue: () => current, setValue: select, input };
}

// ---------- HTML sanitizing for editor content ----------
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, link, meta, form, input, button').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  });
  return doc.body.innerHTML;
}

// ---------- rich text editor ----------
export const TEMPLATE_VARS = ['first_name', 'last_name', 'full_name', 'company', 'title', 'email', 'city', 'country', 'sender_name', 'signature', 'my_company', 'my_website', 'unsubscribe_url'];

export function richEditor({ value = '', placeholder = 'Write your message…', variables = TEMPLATE_VARS, minHeight = 200 } = {}) {
  let mode = 'rich';
  let savedRange = null;
  const area = h('div', { class: 'rte-area', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'data-placeholder': placeholder, style: { minHeight: `${minHeight}px` } });
  area.innerHTML = sanitizeHtml(value);
  const source = h('textarea', { class: 'input rte-source mono', hidden: true, style: { minHeight: `${minHeight}px` } });
  const saveSel = () => {
    const s = window.getSelection();
    if (s.rangeCount && area.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
  };
  const restoreSel = () => {
    area.focus();
    if (savedRange) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
  };
  area.addEventListener('keyup', saveSel);
  area.addEventListener('mouseup', saveSel);
  area.addEventListener('blur', saveSel);
  area.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
  const cmd = (name, arg) => (e) => { e.preventDefault(); if (mode !== 'rich') return; restoreSel(); document.execCommand(name, false, arg); saveSel(); };
  const tool = (iconName, title, handler) => h('button', { type: 'button', class: 'rte-btn', title, 'aria-label': title, onmousedown: handler }, icon(iconName));
  const insertText = (text) => {
    if (mode === 'rich') { restoreSel(); document.execCommand('insertText', false, text); saveSel(); }
    else { source.setRangeText(text, source.selectionStart, source.selectionEnd, 'end'); source.focus(); }
  };
  const varSelect = h('select', { class: 'rte-vars', 'aria-label': 'Insert variable' },
    h('option', { value: '' }, '{ } Insert variable'), variables.map((v) => h('option', { value: v }, v)));
  varSelect.addEventListener('mousedown', saveSel);
  varSelect.addEventListener('change', () => { if (varSelect.value) insertText(`{{${varSelect.value}}}`); varSelect.value = ''; });
  const modeBtn = h('button', { type: 'button', class: 'rte-btn rte-mode', title: 'Edit HTML' }, icon('code'));
  modeBtn.addEventListener('click', () => {
    if (mode === 'rich') { source.value = area.innerHTML; area.hidden = true; source.hidden = false; mode = 'html'; modeBtn.classList.add('on'); }
    else { area.innerHTML = sanitizeHtml(source.value); source.hidden = true; area.hidden = false; mode = 'rich'; modeBtn.classList.remove('on'); }
  });
  const toolbar = h('div', { class: 'rte-toolbar' },
    tool('bold', 'Bold', cmd('bold')), tool('italic', 'Italic', cmd('italic')), tool('underline', 'Underline', cmd('underline')),
    tool('link', 'Insert link', async (e) => {
      e.preventDefault();
      saveSel();
      const url = await promptDialog('Link URL', { title: 'Insert link', placeholder: 'https://', confirmLabel: 'Insert' });
      if (url) { restoreSel(); document.execCommand('createLink', false, /^https?:|^mailto:/.test(url) ? url : `https://${url}`); }
    }),
    tool('list', 'Bulleted list', cmd('insertUnorderedList')), tool('listOrdered', 'Numbered list', cmd('insertOrderedList')),
    h('span', { class: 'rte-sep' }), variables.length ? varSelect : null, h('span', { class: 'grow' }), modeBtn);
  const getValue = () => {
    const html = mode === 'rich' ? area.innerHTML : source.value;
    return /^(<br\s*\/?>|\s|&nbsp;|<p>\s*<\/p>|<div>\s*<br>\s*<\/div>)*$/i.test(html) ? '' : html;
  };
  const setValue = (v) => { area.innerHTML = sanitizeHtml(v || ''); source.value = v || ''; };
  return { el: h('div', { class: 'rte' }, toolbar, area, source), getValue, setValue, insertText, focus: () => area.focus() };
}

// ---------- form builder ----------
// spec: [{ name, label, type, options, required, placeholder, span, help, kind, valueLabel, allowCreate, createAs }]
export function formFields(spec, values = {}) {
  const inputs = {};
  const grid = h('div', { class: 'form-grid' });
  for (const f of spec) {
    if (f.type === 'section') { grid.append(h('div', { class: 'form-section span-2' }, f.label)); continue; }
    const v = values[f.name] ?? f.default ?? '';
    let input;
    switch (f.type) {
      case 'textarea': input = h('textarea', { class: 'input', rows: f.rows || 3, placeholder: f.placeholder, value: v ?? '' }); break;
      case 'select':
        input = h('select', { class: 'input', value: v === null ? '' : String(v) },
          f.placeholder !== undefined ? h('option', { value: '' }, f.placeholder) : null,
          (f.options || []).map((o) => h('option', { value: String(o.value ?? o) }, o.label ?? cap(o))));
        break;
      case 'checkbox': input = h('input', { type: 'checkbox', checked: !!v }); break;
      case 'picker': input = picker({ kind: f.kind, value: v ? { id: v, label: f.valueLabel || `#${v}` } : (f.valueLabel ? { id: null, label: f.valueLabel } : null), allowCreate: f.allowCreate, placeholder: f.placeholder }); break;
      case 'datetime': input = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(v) }); break;
      case 'date': input = h('input', { class: 'input', type: 'date', value: v ? String(v).slice(0, 10) : '' }); break;
      case 'tags': input = h('input', { class: 'input', value: Array.isArray(v) ? v.join(', ') : v, placeholder: f.placeholder || 'e.g. vip, india, event-2026' }); break;
      case 'rich': input = richEditor({ value: v, minHeight: f.minHeight || 180, variables: f.variables }); break;
      default:
        input = h('input', { class: 'input', type: f.type || 'text', value: v ?? '', placeholder: f.placeholder, step: f.step, min: f.min, max: f.max, list: f.list, autocomplete: f.autocomplete });
    }
    inputs[f.name] = { f, input };
    const control = input.el || input;
    const labelEl = h('span', { class: 'label' }, f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null);
    let wrap;
    if (f.type === 'checkbox') wrap = h('label', { class: `field field-check span-${f.span || 1}` }, control, h('span', null, f.label), f.help ? h('span', { class: 'help' }, f.help) : null);
    else if (input.el) wrap = h('div', { class: `field span-${f.span || 1}` }, labelEl, control, f.help ? h('span', { class: 'help' }, f.help) : null);
    else wrap = h('label', { class: `field span-${f.span || 1}` }, labelEl, control, f.help ? h('span', { class: 'help' }, f.help) : null);
    grid.append(wrap);
  }
  return {
    el: grid,
    inputs,
    values() {
      const out = {};
      for (const [name, { f, input }] of Object.entries(inputs)) {
        if (f.type === 'checkbox') out[name] = input.checked;
        else if (f.type === 'picker') {
          const val = input.getValue();
          out[name] = val?.id ?? null;
          if (f.createAs) out[f.createAs] = val && !val.id ? val.label : undefined;
        } else if (f.type === 'datetime') out[name] = fromLocalInput(input.value);
        else if (f.type === 'number') out[name] = input.value === '' ? null : Number(input.value);
        else if (f.type === 'rich') out[name] = input.getValue();
        else out[name] = input.value;
      }
      return out;
    },
    validate() {
      const vals = this.values();
      for (const [name, { f, input }] of Object.entries(inputs)) {
        const empty = vals[name] === null || vals[name] === undefined || String(vals[name]).trim() === '';
        const created = f.createAs && vals[f.createAs];
        if (f.required && empty && !created) {
          toast(`${f.label} is required`, 'error');
          (input.input || input.el?.querySelector?.('input, [contenteditable]') || input).focus?.();
          return false;
        }
      }
      return true;
    },
  };
}

// ---------- charts (single-series; HTML bars stay crisp at any width) ----------
let tipEl;
function showTip(e, lines) {
  if (!tipEl) tipEl = document.body.appendChild(h('div', { class: 'chart-tip', role: 'tooltip' }));
  clear(tipEl).append(...lines.map((l, i) => h(i === 0 ? 'b' : 'div', null, l)));
  tipEl.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tipEl.offsetWidth - 8);
  const y = Math.max(8, e.clientY - tipEl.offsetHeight - 10);
  tipEl.style.transform = `translate(${x}px, ${y}px)`;
}
const hideTip = () => { if (tipEl) tipEl.hidden = true; };

function niceMax(v) {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

// Horizontal bars: magnitude by category, value labelled at the tip.
export function barChart(data, { format = num, detail } = {}) {
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  return h('div', { class: 'hbar-chart', role: 'list' }, data.map((d) => {
    const row = h('div', { class: 'hbar-row', role: 'listitem', 'aria-label': `${d.label}: ${format(d.value)}` },
      h('span', { class: 'hbar-label' }, d.label),
      h('span', { class: 'hbar-track' },
        h('span', { class: 'hbar-fill', style: { width: `${d.value > 0 ? Math.max(1.5, (d.value / max) * 100) : 0}%` } }),
        h('span', { class: 'hbar-value' }, format(d.value))));
    row.addEventListener('mousemove', (e) => showTip(e, [d.label, format(d.value), detail ? detail(d) : null].filter(Boolean)));
    row.addEventListener('mouseleave', hideTip);
    return row;
  }));
}

// Vertical columns over time with hairline gridlines; labels the latest and peak values only.
export function columnChart(data, { format = num, detail } = {}) {
  const top = niceMax(Math.max(...data.map((d) => d.value), 0));
  const ticks = [0, top / 2, top];
  const peak = data.reduce((m, d, i) => (d.value > data[m].value ? i : m), 0);
  return h('div', { class: 'col-chart' },
    h('div', { class: 'col-axis' }, ticks.slice().reverse().map((t) => h('span', null, format(t)))),
    h('div', { class: 'col-plot' },
      ticks.map((t) => h('span', { class: 'col-grid', style: { bottom: `${(t / top) * 100}%` } })),
      h('div', { class: 'col-bars' }, data.map((d, i) => {
        const showLabel = d.value > 0 && (i === data.length - 1 || i === peak);
        const col = h('div', { class: 'col', 'aria-label': `${d.label}: ${format(d.value)}` },
          h('div', { class: 'col-stack' },
            showLabel ? h('span', { class: 'col-value', style: { bottom: `calc(${(d.value / top) * 100}% + 4px)` } }, format(d.value)) : null,
            h('span', { class: 'col-fill', style: { height: `${(d.value / top) * 100}%` } })),
          h('span', { class: 'col-label' }, d.label));
        col.addEventListener('mousemove', (e) => showTip(e, [d.label, format(d.value), detail ? detail(d) : null].filter(Boolean)));
        col.addEventListener('mouseleave', hideTip);
        return col;
      }))));
}

export function statTile(label, value, sub, { iconName } = {}) {
  return h('div', { class: 'stat' },
    h('div', { class: 'stat-label' }, iconName ? icon(iconName) : null, label),
    h('div', { class: 'stat-value' }, value),
    sub ? h('div', { class: 'stat-sub' }, sub) : null);
}

// ---------- timeline ----------
const ACTIVITY_ICON = { note: 'note', call: 'phone', meeting: 'calendar', task: 'task', email: 'mail', sms: 'chat', whatsapp: 'chat', linkedin: 'linkedin', system: 'zap' };

export function timelineView(items, { onOpenEmail, onToggleTask, showContact = false } = {}) {
  if (!items.length) return emptyState({ iconName: 'clock', title: 'No activity yet', text: 'Notes, calls, emails and tasks will show up here.' });
  return h('ol', { class: 'timeline' }, items.map((it) => {
    if (it.kind === 'email') {
      const chips = [];
      if (it.direction === 'in') chips.push(h('span', { class: 'chip chip-green' }, icon('reply'), 'Reply'));
      if (it.status === 'failed') chips.push(h('span', { class: 'chip chip-red' }, 'Failed'));
      if (it.status === 'queued') chips.push(h('span', { class: 'chip' }, 'Queued'));
      if (it.open_count) chips.push(h('span', { class: 'chip chip-blue' }, icon('eye'), `Opened ${it.open_count}×`));
      if (it.click_count) chips.push(h('span', { class: 'chip chip-violet' }, icon('pointer'), `Clicked ${it.click_count}×`));
      if (it.replied_at && it.direction === 'out') chips.push(h('span', { class: 'chip chip-green' }, icon('reply'), 'Replied'));
      return h('li', { class: `tl-item tl-email ${it.direction === 'in' ? 'tl-in' : ''}` },
        h('span', { class: 'tl-ico' }, icon(it.direction === 'in' ? 'reply' : 'mail')),
        h('div', { class: 'tl-main' },
          h('button', { class: 'tl-title link-btn', type: 'button', onclick: () => onOpenEmail?.(it.id) }, it.subject || '(no subject)'),
          h('div', { class: 'tl-meta' }, it.direction === 'in' ? `From ${it.from_addr}` : `To ${it.to_addr}`, it.user_name ? ` · ${it.user_name}` : '',
            it.campaign_id ? ' · Campaign' : '', it.enrollment_id ? ' · Sequence' : ''),
          chips.length ? h('div', { class: 'tl-chips' }, chips) : null,
          it.error && it.status === 'failed' ? h('div', { class: 'tl-error' }, it.error) : null),
        h('time', { class: 'tl-time', datetime: it.date, title: dateTime(it.date) }, ago(it.date)));
    }
    const isTask = it.type === 'task';
    const check = isTask ? h('input', { type: 'checkbox', checked: it.done, 'aria-label': 'Mark task done' }) : null;
    check?.addEventListener('change', () => onToggleTask?.(it, check.checked));
    return h('li', { class: `tl-item tl-${it.type} ${isTask && it.done ? 'done' : ''}` },
      h('span', { class: 'tl-ico' }, icon(ACTIVITY_ICON[it.type] || 'note')),
      h('div', { class: 'tl-main' },
        h('div', { class: 'tl-title' }, check, it.subject || cap(it.type)),
        it.body ? h('div', { class: 'tl-body' }, it.body) : null,
        h('div', { class: 'tl-meta' },
          cap(it.type),
          it.user_name ? ` · ${it.user_name}` : '',
          showContact && it.contact_name ? [' · ', h('a', { href: `#/contacts/${it.contact_id}` }, it.contact_name)] : '',
          it.deal_title ? [' · ', h('a', { href: `#/deals/${it.deal_id}` }, it.deal_title)] : '',
          isTask && it.due_at ? ` · due ${dateTime(it.due_at)}` : '')),
      h('time', { class: 'tl-time', datetime: it.date || it.created_at, title: dateTime(it.date || it.created_at) }, ago(it.date || it.created_at)));
  }));
}

// ---------- email viewer ----------
export async function openEmailViewer(id) {
  const { email: e } = await GET(`/emails/${id}`);
  const frame = h('iframe', { class: 'email-frame', sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox', title: 'Email content' });
  // Sandboxed (no scripts); also strip tags that could navigate or embed content.
  const bodyHtml = String(e.body || '').replace(/<(script|meta|iframe|object|embed|form|base)\b[\s\S]*?(<\/\1>|>)/gi, '');
  frame.srcdoc = `<!doctype html><html><head><base target="_blank"><style>body{font:14px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2433;background:#fff;margin:0;padding:12px;word-wrap:break-word}img{max-width:100%}</style></head><body>${bodyHtml || `<pre style="white-space:pre-wrap">${(e.text_body || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`}</body></html>`;
  frame.addEventListener('load', () => {
    try { frame.style.height = `${Math.min(900, frame.contentDocument.documentElement.scrollHeight + 16)}px`; } catch { /* cross-origin */ }
  });
  modal({
    title: e.subject || '(no subject)',
    size: 'lg',
    body: h('div', { class: 'email-view' },
      kv([
        ['From', e.from_addr],
        ['To', e.contact_id ? [h('a', { href: `#/contacts/${e.contact_id}` }, e.contact_name || e.to_addr), ` <${e.to_addr}>`] : e.to_addr],
        e.cc ? ['Cc', e.cc] : null,
        ['Date', dateTime(e.sent_at || e.created_at)],
        ['Status', h('span', null, pill(e.status, { sent: 'green', received: 'blue', failed: 'red', queued: 'slate', cancelled: 'slate' }[e.status]), e.error ? h('span', { class: 'muted' }, ` ${e.error}`) : null)],
        e.direction === 'out' && e.status === 'sent' ? ['Engagement', `${e.open_count} open(s) · ${e.click_count} click(s)${e.replied_at ? ` · replied ${ago(e.replied_at)}` : ''}`] : null,
      ]),
      frame),
    actions: [{ label: 'Close' }],
  });
}

export { money, num, date, dateTime, ago };
