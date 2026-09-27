import { eventSource, event_types } from '../../../../script.js';

const MODULE_NAME = 'worldbook-search';
const log = (...a) => console.log(`[${MODULE_NAME}]`, ...a);

// ============================================================
// v3.0.0 —— 直接读酒馆的数据，不再依赖 DOM
//
// 依据 SillyTavern 官方源码 public/scripts/st-context.js：
//   context.loadWorldInfo(name)   → { entries: { "0": {...}, "7": {...} } }
//   context.saveWorldInfo(name, data, immediately)
//   context.getWorldInfoNames()
//
// 每条 entry 结构：
//   { uid, comment, key: [], content, depth, order, probability, disable, ... }
// ============================================================

const FIELD_LABELS = { comment: '备注', key: '关键词', content: '内容' };
const FIELD_ORDER = ['comment', 'key', 'content'];

const MAX_RESULTS = 300;
const MAX_SNIPPETS_PER_ENTRY = 3;
const SNIPPET_RADIUS = 44;

let searchText = '';
let ctx = null;
const activeFields = { comment: true, key: true, content: true };
const expandedUids = new Set();

const state = {
    bookName: null,
    bookData: null,
    dirty: false,
};

// ---------- 入口 ----------
jQuery(async () => {
    log('v3.0.0 加载中...');

    setInterval(tryInject, 800);

    if (event_types && event_types.WORLDINFO_SETTINGS_UPDATED) {
        eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, () => {
            state.bookName = null;
            state.bookData = null;
            setTimeout(tryInject, 300);
        });
    }
});

function getCtx() {
    if (!ctx) {
        try {
            ctx = SillyTavern.getContext();
        } catch (e) {
            log('getContext 失败', e);
            ctx = null;
        }
    }
    return ctx;
}

function tryInject() {
    const list = document.getElementById('world_popup_entries_list');
    if (!list) return;

    const panel = document.getElementById('wb-search-panel');
    if (panel) {
        if (panel.parentNode === list.parentNode) return;
        panel.remove();
    }
    injectUI(list);
}

// ---------- 界面 ----------
function injectUI(entriesContainer) {
    const panel = document.createElement('div');
    panel.id = 'wb-search-panel';
    panel.innerHTML = `
        <div class="wb-bar">
            <div class="wb-input-wrap">
                <span class="wb-input-icon">🔍</span>
                <input id="wb-search-input" type="text" placeholder="搜索条目内容（备注 / 关键词 / 正文）…" autocomplete="off" />
            </div>
            <span id="wb-search-count" class="wb-count">共 0 条</span>
            <div id="wb-search-clear" class="wb-icon-btn" title="清空">✕</div>
        </div>

        <div class="wb-filters">
            <label class="wb-chip active" data-field="comment">
                <input type="checkbox" id="wb-f-comment" checked>
                <span>备注</span>
            </label>
            <label class="wb-chip active" data-field="key">
                <input type="checkbox" id="wb-f-key" checked>
                <span>关键词</span>
            </label>
            <label class="wb-chip active" data-field="content">
                <input type="checkbox" id="wb-f-content" checked>
                <span>内容</span>
            </label>
            <div id="wb-save-btn" class="wb-save-btn" title="保存到酒馆">💾 保存</div>
            <div id="wb-diag-btn" class="wb-icon-btn small" title="查看诊断信息">🔧</div>
        </div>

        <pre id="wb-diag"></pre>

        <div id="wb-search-results"></div>

        <details id="wb-replace-box">
            <summary>批量替换</summary>
            <div class="wb-bar" style="margin-top:10px">
                <div class="wb-input-wrap">
                    <span class="wb-input-icon">↺</span>
                    <input id="wb-replace-input" type="text" placeholder="替换成…" />
                </div>
                <div id="wb-replace-btn" class="wb-action-btn">全部替换</div>
            </div>
            <div class="wb-hint">会直接改世界书数据。改完记得点 💾 保存～</div>
        </details>
    `;

    entriesContainer.parentNode.insertBefore(panel, entriesContainer);

    const input = panel.querySelector('#wb-search-input');
    input.addEventListener('input', debounce(() => {
        searchText = input.value;
        runSearch();
    }, 160));

    panel.querySelector('#wb-search-clear').addEventListener('click', () => {
        input.value = '';
        searchText = '';
        runSearch();
        input.focus();
    });

    ['comment', 'key', 'content'].forEach(f => {
        const chip = panel.querySelector(`.wb-chip[data-field="${f}"]`);
        const cb = panel.querySelector(`#wb-f-${f}`);
        cb.addEventListener('change', () => {
            activeFields[f] = cb.checked;
            chip.classList.toggle('active', cb.checked);
            runSearch();
        });
    });

    panel.querySelector('#wb-save-btn').addEventListener('click', async () => {
        const ok = await saveBook();
        if (ok) {
            toast('已保存到酒馆 ✅');
        } else {
            toast('保存失败 😿 看下控制台');
        }
    });

    panel.querySelector('#wb-replace-btn').addEventListener('click', () => {
        doReplace(panel.querySelector('#wb-replace-input').value);
    });

    const diagPre = panel.querySelector('#wb-diag');
    panel.querySelector('#wb-diag-btn').addEventListener('click', () => {
        if (diagPre.style.display === 'block') {
            diagPre.style.display = 'none';
            return;
        }
        diagPre.textContent = buildDiagnostics();
        diagPre.style.display = 'block';
    });

    const sel = document.getElementById('world_editor_select');
    if (sel && !sel.dataset.wbSearchBound) {
        sel.addEventListener('change', () => setTimeout(() => {
            state.bookName = null;
            state.bookData = null;
            state.dirty = false;
            expandedUids.clear();
            runSearch();
        }, 300));
        sel.dataset.wbSearchBound = '1';
    }

    runSearch();
    log('UI 注入完成 ✨');
}

// ---------- 世界书数据 ----------
function getCurrentBookName() {
    const sel = document.getElementById('world_editor_select');
    if (!sel || sel.selectedIndex < 0) return null;
    const opt = sel.options[sel.selectedIndex];
    const t = opt ? String(opt.text || '').trim() : '';
    if (!t || /select world/i.test(t)) return null;
    return t;
}

async function loadBook(force) {
    const c = getCtx();
    if (!c || typeof c.loadWorldInfo !== 'function') return null;

    const name = getCurrentBookName();
    if (!name) return null;

    if (!force && state.bookName === name && state.bookData) return state.bookData;

    try {
        const data = await c.loadWorldInfo(name);
        state.bookName = name;
        state.bookData = data;
        state.dirty = false;
        return data;
    } catch (e) {
        log('loadWorldInfo 失败', e);
        return null;
    }
}

function getEntries() {
    const data = state.bookData;
    if (!data || !data.entries) return [];
    const raw = data.entries;
    const list = Array.isArray(raw) ? raw.slice() : Object.values(raw);
    return list.filter(e => e && typeof e === 'object');
}

function fieldTextOf(entry, field) {
    if (field === 'comment') return entry.comment || '';
    if (field === 'content') return entry.content || '';
    if (field === 'key') {
        const k = entry.key;
        if (Array.isArray(k)) return k.join(', ');
        return k ? String(k) : '';
    }
    return '';
}

function setFieldValue(entry, field, value) {
    if (field === 'comment') {
        entry.comment = value;
    } else if (field === 'content') {
        entry.content = value;
    } else if (field === 'key') {
        entry.key = String(value)
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
    }
    state.dirty = true;
    markDirty();
}

function markDirty() {
    const btn = document.getElementById('wb-save-btn');
    if (!btn) return;
    btn.classList.toggle('dirty', state.dirty);
}

async function saveBook() {
    const c = getCtx();
    if (!c || typeof c.saveWorldInfo !== 'function') return false;
    if (!state.bookName || !state.bookData) return false;

    try {
        await c.saveWorldInfo(state.bookName, state.bookData, true);
        state.dirty = false;
        markDirty();
        return true;
    } catch (e) {
        log('saveWorldInfo 失败', e);
        return false;
    }
}

function toast(msg) {
    try {
        const c = getCtx();
        if (c && c.callGenericPopup) {
            // 轻提示用 popup 太重，这里用 console + 自绘
        }
    } catch (e) { /* ignore */ }

    let el = document.getElementById('wb-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'wb-toast';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 1800);
}

// ---------- 片段 ----------
function findSnippets(text, kw, radius, max) {
    const out = [];
    const flat = String(text).replace(/\s+/g, ' ');
    const lower = flat.toLowerCase();
    const k = kw.toLowerCase();
    if (!k) return out;

    let from = 0;
    while (out.length < max) {
        const idx = lower.indexOf(k, from);
        if (idx === -1) break;

        const start = Math.max(0, idx - radius);
        const end = Math.min(flat.length, idx + k.length + radius);

        out.push({
            before: (start > 0 ? '…' : '') + flat.slice(start, idx),
            hit: flat.slice(idx, idx + k.length),
            after: flat.slice(idx + k.length, end) + (end < flat.length ? '…' : ''),
        });

        from = idx + k.length;
    }
    return out;
}

function renderSnippet(sn, field) {
    const div = document.createElement('div');
    div.className = 'wb-snippet';

    const tag = document.createElement('span');
    tag.className = 'wb-snippet-tag';
    tag.textContent = FIELD_LABELS[field] || field;
    div.appendChild(tag);

    div.appendChild(document.createTextNode(sn.before));

    const mark = document.createElement('mark');
    mark.className = 'wb-hit';
    mark.textContent = sn.hit;
    div.appendChild(mark);

    div.appendChild(document.createTextNode(sn.after));

    return div;
}

// ---------- 编辑区 ----------
function buildEditor(entry) {
    const body = document.createElement('div');
    body.className = 'wb-result-body';

    const editor = document.createElement('div');
    editor.className = 'wb-editor';

    FIELD_ORDER.forEach(f => {
        const wrap = document.createElement('div');
        wrap.className = 'wb-edit-group';

        const lab = document.createElement('div');
        lab.className = 'wb-editor-label';
        lab.textContent = FIELD_LABELS[f];
        wrap.appendChild(lab);

        const isContent = f === 'content';
        const field = document.createElement(isContent ? 'textarea' : 'input');
        field.className = 'wb-edit-field';
        if (isContent) {
            const len = fieldTextOf(entry, f).length;
            field.rows = Math.min(14, Math.max(4, Math.ceil(len / 50)));
        } else {
            field.type = 'text';
        }
        field.value = fieldTextOf(entry, f);
        field.spellcheck = false;

        field.addEventListener('input', () => {
            setFieldValue(entry, f, field.value);
        });

        wrap.appendChild(field);
        editor.appendChild(wrap);
    });

    body.appendChild(editor);
    return body;
}

// ---------- 搜索 ----------
async function runSearch() {
    const resultsBox = document.getElementById('wb-search-results');
    const counter = document.getElementById('wb-search-count');
    if (!resultsBox) return;

    const data = await loadBook(false);

    if (!data) {
        resultsBox.innerHTML = '';
        resultsBox.style.display = 'flex';
        const warn = document.createElement('div');
        warn.className = 'wb-empty';
        warn.textContent = '读不到世界书数据 😿 请确认已打开某本世界书';
        resultsBox.appendChild(warn);
        if (counter) counter.textContent = '—';
        return;
    }

    const entries = getEntries();
    const kw = searchText.trim();
    const fields = FIELD_ORDER.filter(f => activeFields[f]);

    resultsBox.innerHTML = '';

    if (!kw) {
        resultsBox.style.display = 'none';
        if (counter) counter.textContent = `共 ${entries.length} 条`;
        return;
    }

    const kwLower = kw.toLowerCase();
    let hits = 0;
    let rendered = 0;

    for (const entry of entries) {
        const matchedFields = [];
        const texts = {};

        for (const f of fields) {
            const t = fieldTextOf(entry, f);
            if (t && t.toLowerCase().includes(kwLower)) {
                matchedFields.push(f);
                texts[f] = t;
            }
        }

        if (matchedFields.length === 0) continue;

        hits++;
        if (rendered >= MAX_RESULTS) continue;
        rendered++;

        resultsBox.appendChild(buildResultItem(entry, matchedFields, texts, kw));
    }

    resultsBox.style.display = 'flex';

    if (counter) {
        counter.textContent = `命中 ${hits} / ${entries.length}`;
        counter.title = rendered < hits ? `结果过多，只显示前 ${rendered} 条` : '';
    }

    if (hits === 0) {
        const empty = document.createElement('div');
        empty.className = 'wb-empty';
        empty.textContent = '没有找到匹配的条目 🥲';
        const tip = document.createElement('div');
        tip.className = 'wb-hint';
        tip.style.textAlign = 'center';
        tip.textContent = '搜不到？点右上角 🔧 查看诊断信息';
        resultsBox.appendChild(empty);
        resultsBox.appendChild(tip);
    }
}

function buildResultItem(entry, matchedFields, texts, kw) {
    const uid = String(entry.uid);
    const item = document.createElement('div');
    item.className = 'wb-result-item';
    item.dataset.uid = uid;

    const head = document.createElement('div');
    head.className = 'wb-result-head';

    const dot = document.createElement('span');
    dot.className = 'wb-result-dot';
    head.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'wb-result-name';
    name.textContent = entry.comment ? String(entry.comment).slice(0, 60) : `条目 #${uid}`;
    head.appendChild(name);

    const tags = document.createElement('span');
    tags.className = 'wb-result-tags';
    tags.textContent = matchedFields.map(f => FIELD_LABELS[f]).join(' · ');
    head.appendChild(tags);

    const locate = document.createElement('div');
    locate.className = 'wb-icon-btn small';
    locate.title = '定位到原生条目';
    locate.textContent = '⌖';
    locate.addEventListener('click', e => {
        e.stopPropagation();
        jumpToEntry(uid);
    });
    head.appendChild(locate);

    item.appendChild(head);

    const snippetWrap = document.createElement('div');
    snippetWrap.className = 'wb-snippets';

    let snippetCount = 0;
    for (const f of matchedFields) {
        const snips = findSnippets(texts[f], kw, SNIPPET_RADIUS, 2);
        for (const sn of snips) {
            if (snippetCount >= MAX_SNIPPETS_PER_ENTRY) break;
            snippetWrap.appendChild(renderSnippet(sn, f));
            snippetCount++;
        }
        if (snippetCount >= MAX_SNIPPETS_PER_ENTRY) break;
    }
    item.appendChild(snippetWrap);

    if (expandedUids.has(uid)) {
        item.classList.add('expanded');
        item.appendChild(buildEditor(entry));
    }

    head.addEventListener('click', () => {
        if (expandedUids.has(uid)) {
            expandedUids.delete(uid);
            item.classList.remove('expanded');
            item.querySelector('.wb-result-body')?.remove();
        } else {
            expandedUids.add(uid);
            item.classList.add('expanded');
            item.appendChild(buildEditor(entry));
        }
    });

    return item;
}

// ---------- 定位 ----------
function jumpToEntry(uid) {
    const node =
        document.querySelector(`.world_entry[uid="${CSS.escape(uid)}"]`) ||
        document.querySelector(`.world_entry[data-uid="${CSS.escape(uid)}"]`);

    if (!node) return;

    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.remove('wb-flash');
    void node.offsetWidth;
    node.classList.add('wb-flash');
    setTimeout(() => node.classList.remove('wb-flash'), 1800);
}

// ---------- 批量替换 ----------
async function doReplace(replacement) {
    const kw = searchText.trim();
    if (!kw) return alert('先在上面输入要搜索的关键词哦～');

    const data = await loadBook(false);
    if (!data) return alert('读不到世界书数据 😿');

    const entries = getEntries();
    const fields = FIELD_ORDER.filter(f => activeFields[f]);
    const re = new RegExp(escapeRegExp(kw), 'gi');

    let affectedEntries = 0;
    let affectedFields = 0;

    entries.forEach(entry => {
        let touched = false;
        fields.forEach(f => {
            const v = fieldTextOf(entry, f);
            if (!v) return;
            re.lastIndex = 0;
            if (!re.test(v)) return;
            affectedFields++;
            touched = true;
        });
        if (touched) affectedEntries++;
    });

    if (affectedFields === 0) return alert('没有找到可以替换的地方～');

    if (!confirm(`将会修改 ${affectedEntries} 个条目里的 ${affectedFields} 处：\n「${kw}」 → 「${replacement}」\n\n确定继续吗？`)) return;

    entries.forEach(entry => {
        fields.forEach(f => {
            const v = fieldTextOf(entry, f);
            if (!v) return;
            re.lastIndex = 0;
            if (!re.test(v)) return;
            re.lastIndex = 0;
            setFieldValue(entry, f, v.replace(re, replacement));
        });
    });

    await saveBook();
    toast('替换完成并已保存 ✅');
    runSearch();
}

// ---------- 诊断 ----------
function buildDiagnostics() {
    const lines = [];
    const c = getCtx();

    lines.push('=== 环境 ===');
    lines.push(`SillyTavern.getContext: ${c ? '可用' : '不可用'}`);
    lines.push(`context.loadWorldInfo: ${c && typeof c.loadWorldInfo === 'function' ? '有' : '无'}`);
    lines.push(`context.saveWorldInfo: ${c && typeof c.saveWorldInfo === 'function' ? '有' : '无'}`);
    lines.push(`#world_editor_select: ${document.getElementById('world_editor_select') ? '有' : '无'}`);
    lines.push(`当前世界书名: ${getCurrentBookName() || '(未选中)'}`);

    const entries = getEntries();
    lines.push('');
    lines.push(`=== 数据（共 ${entries.length} 条）===`);

    entries.slice(0, 3).forEach((e, i) => {
        lines.push(`[${i}] uid=${e.uid}`);
        lines.push(`    comment: ${String(e.comment || '').slice(0, 40)} (${String(e.comment || '').length} 字)`);
        lines.push(`    key: ${fieldTextOf(e, 'key').slice(0, 60)} (${fieldTextOf(e, 'key').length} 字)`);
        lines.push(`    content: ${String(e.content || '').slice(0, 40).replace(/\n/g, ' ')} (${String(e.content || '').length} 字)`);
    });

    if (entries.length === 0) {
        lines.push('（没有读到条目 —— 可能是世界书没打开，或 loadWorldInfo 失败）');
    }

    return lines.join('\n');
}

window.wbSearchDebug = function () {
    const txt = buildDiagnostics();
    console.log(txt);
    return txt;
};

// ---------- 工具 ----------
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function debounce(fn, wait) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
}
