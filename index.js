import { eventSource, event_types } from '../../../../script.js';

const MODULE_NAME = 'worldbook-search';
const log = (...a) => console.log(`[${MODULE_NAME}]`, ...a);

// ---------- 字段识别 ----------
const FIELD_HINTS = {
    comment: ['comment', '备注', '标题', 'title', 'name'],
    key: ['key', 'keys', '关键词', '关键字', '触发'],
    content: ['content', '内容', '正文'],
};

const FIELD_LABELS = {
    comment: '备注',
    key: '关键词',
    content: '内容',
    other: '其他',
};

const FIELD_ORDER = ['comment', 'key', 'content', 'other'];

const MAX_RESULTS = 300;
const MAX_SNIPPETS_PER_ENTRY = 3;
const SNIPPET_RADIUS = 44;

let searchText = '';
const activeFields = { comment: true, key: true, content: true };
const expandedUids = new Set();

// ---------- 入口 ----------
jQuery(async () => {
    log('v2.1.0 加载中...');

    setInterval(tryInject, 800);

    if (event_types && event_types.WORLDINFO_SETTINGS_UPDATED) {
        eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, () => setTimeout(tryInject, 300));
    }
});

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
                <input id="wb-search-input" type="text" placeholder="搜索条目内容…" autocomplete="off" />
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
            <div id="wb-diag-btn" class="wb-icon-btn small" title="查看诊断信息" style="margin-left:auto">🔧</div>
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
            <div class="wb-hint">会把当前世界书中匹配字段里的关键词全部替换掉，操作前请确认～</div>
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
            expandedUids.clear();
            runSearch();
        }, 300));
        sel.dataset.wbSearchBound = '1';
    }

    runSearch();
    log('UI 注入完成 ✨');
}

// ---------- 读取原生条目 ----------
function getEntries() {
    return Array.from(document.querySelectorAll('#world_popup_entries_list .world_entry'));
}

function collectInputs(entry) {
    return Array.from(entry.querySelectorAll('textarea, input'))
        .filter(el => !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file', 'hidden'].includes(el.type));
}

// 属性猜不出来时的兜底：按元素类型 + 长度猜
function heuristicField(el) {
    if (el.tagName === 'INPUT') return 'comment';
    if (el.tagName === 'TEXTAREA') {
        const len = (el.value || '').length;
        return len >= 150 ? 'content' : 'key';
    }
    return null;
}

function guessField(el) {
    const hay = [
        el.getAttribute('name'),
        el.id,
        el.getAttribute('placeholder'),
        el.getAttribute('data-field'),
        el.getAttribute('data-name'),
    ].filter(Boolean).join(' ').toLowerCase();

    if (hay) {
        for (const [field, hints] of Object.entries(FIELD_HINTS)) {
            if (hints.some(h => hay.includes(h))) return field;
        }
    }

    return heuristicField(el);
}

function collectEntry(entry) {
    const buckets = { comment: [], key: [], content: [], other: [] };

    collectInputs(entry).forEach(el => {
        const v = (el.value || '').trim();
        if (!v) return;
        const f = guessField(el);
        (f && buckets[f] ? buckets[f] : buckets.other).push(v);
    });

    const text = (entry.textContent || '').replace(/\s+/g, ' ').trim();
    const other = buckets.other.join('\n');
    const allValues = [
        buckets.comment.join('\n'),
        buckets.key.join('\n'),
        buckets.content.join('\n'),
        other,
    ].filter(Boolean).join('\n');

    // 某个字段没识别到东西时，退回「全部文本」，保证一定搜得到
    return {
        comment: [buckets.comment.join('\n') || allValues, other, text].filter(Boolean).join('\n'),
        key: [buckets.key.join('\n') || allValues, other, text].filter(Boolean).join('\n'),
        content: [buckets.content.join('\n') || allValues, other, text].filter(Boolean).join('\n'),
    };
}

function getFieldText(entry, field) {
    return collectEntry(entry)[field] || '';
}

function getEntryName(entry) {
    const inputs = collectInputs(entry);
    for (const el of inputs) {
        if (guessField(el) === 'comment' && (el.value || '').trim()) {
            return el.value.trim().slice(0, 60);
        }
    }
    const first = inputs.find(el => (el.value || '').trim());
    if (first) return first.value.trim().slice(0, 60);
    const uid = entry.getAttribute('uid');
    return uid ? `条目 #${uid}` : '未命名条目';
}

// ---------- 片段 ----------
function findSnippets(text, kw, radius, max) {
    const out = [];
    const flat = text.replace(/\s+/g, ' ');
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

    const groups = new Map();
    collectInputs(entry).forEach(el => {
        const f = guessField(el) || 'other';
        if (!groups.has(f)) groups.set(f, []);
        groups.get(f).push(el);
    });

    let count = 0;

    FIELD_ORDER.forEach(f => {
        const els = groups.get(f);
        if (!els || !els.length) return;

        els.forEach((el, i) => {
            count++;
            const wrap = document.createElement('div');
            wrap.className = 'wb-edit-group';

            const lab = document.createElement('div');
            lab.className = 'wb-editor-label';
            lab.textContent = (FIELD_LABELS[f] || f) + (els.length > 1 ? ` #${i + 1}` : '');
            wrap.appendChild(lab);

            const isArea = el.tagName === 'TEXTAREA';
            const field = document.createElement(isArea ? 'textarea' : 'input');
            field.className = 'wb-edit-field';
            if (isArea) {
                const len = (el.value || '').length;
                field.rows = Math.min(12, Math.max(3, Math.ceil(len / 55)));
            } else {
                field.type = 'text';
            }
            field.value = el.value || '';
            field.spellcheck = false;

            field.addEventListener('input', () => {
                el.value = field.value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            });

            wrap.appendChild(field);
            editor.appendChild(wrap);
        });
    });

    if (count === 0) {
        const empty = document.createElement('div');
        empty.className = 'wb-hint';
        empty.textContent = '这个条目没有可编辑的输入框 🥲';
        editor.appendChild(empty);
    }

    body.appendChild(editor);
    return body;
}

// ---------- 搜索 ----------
function runSearch() {
    const entries = getEntries();
    const kw = searchText.trim();
    const fields = Object.keys(activeFields).filter(f => activeFields[f]);

    const resultsBox = document.getElementById('wb-search-results');
    const counter = document.getElementById('wb-search-count');
    if (!resultsBox) return;

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
        const uid = entry.getAttribute('uid') || '';

        const matchedFields = [];
        const texts = {};

        for (const f of fields) {
            const t = getFieldText(entry, f);
            if (t.toLowerCase().includes(kwLower)) {
                matchedFields.push(f);
                texts[f] = t;
            }
        }

        if (matchedFields.length === 0) continue;

        hits++;
        if (rendered >= MAX_RESULTS) continue;
        rendered++;

        resultsBox.appendChild(buildResultItem(entry, uid, matchedFields, texts, kw));
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

function buildResultItem(entry, uid, matchedFields, texts, kw) {
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
    name.textContent = getEntryName(entry);
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
    if (!uid) return;
    const entry = document.querySelector(`#world_popup_entries_list .world_entry[uid="${CSS.escape(uid)}"]`);
    if (!entry) return;

    entry.scrollIntoView({ behavior: 'smooth', block: 'center' });
    entry.classList.remove('wb-flash');
    void entry.offsetWidth;
    entry.classList.add('wb-flash');
    setTimeout(() => entry.classList.remove('wb-flash'), 1800);
}

// ---------- 批量替换 ----------
function doReplace(replacement) {
    const kw = searchText.trim();
    if (!kw) return alert('先在上面输入要搜索的关键词哦～');

    const entries = getEntries();
    const re = new RegExp(escapeRegExp(kw), 'gi');

    let affectedEntries = 0;
    let affectedFields = 0;

    entries.forEach(entry => {
        let touched = false;
        collectInputs(entry).forEach(el => {
            const v = el.value || '';
            if (!v) return;

            const f = guessField(el);
            const shouldTouch = f ? activeFields[f] : Object.values(activeFields).some(Boolean);
            if (!shouldTouch) return;

            re.lastIndex = 0;
            if (!re.test(v)) return;

            affectedFields++;
            touched = true;
        });
        if (touched) affectedEntries++;
    });

    if (affectedFields === 0) return alert('没有找到可以替换的地方～');

    if (!confirm(`将会修改 ${affectedEntries} 个条目里的 ${affectedFields} 处：\n「${kw}」 → 「${replacement}」\n\n只影响当前打开的世界书，确定继续吗？`)) return;

    entries.forEach(entry => {
        collectInputs(entry).forEach(el => {
            const v = el.value || '';
            if (!v) return;

            const f = guessField(el);
            const shouldTouch = f ? activeFields[f] : Object.values(activeFields).some(Boolean);
            if (!shouldTouch) return;

            re.lastIndex = 0;
            if (!re.test(v)) return;
            re.lastIndex = 0;

            el.value = v.replace(re, replacement);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

    alert('替换完成啦～记得点一下世界书面板的保存按钮确认哦 ✅');
    runSearch();
}

// ---------- 诊断 ----------
function buildDiagnostics() {
    const lines = [];
    const containers = document.querySelectorAll('#world_popup_entries_list');
    const entries = getEntries();

    lines.push(`=== 容器 ===`);
    lines.push(`#world_popup_entries_list 数量: ${containers.length}`);
    containers.forEach((c, i) => {
        lines.push(`  [${i}] 可见=${c.offsetParent !== null} 条目数=${c.querySelectorAll('.world_entry').length}`);
    });

    lines.push('');
    lines.push(`=== 条目 ===`);
    lines.push(`.world_entry 总数: ${entries.length}`);

    const e = entries[0];
    if (!e) {
        lines.push('没有找到任何 .world_entry');
        return lines.join('\n');
    }

    lines.push(`第一个条目 uid=${e.getAttribute('uid')} 可见=${e.offsetParent !== null}`);
    lines.push(`  textContent 长度: ${(e.textContent || '').length}`);

    const inputs = collectInputs(e);
    lines.push('');
    lines.push(`=== 输入框（${inputs.length} 个）===`);
    inputs.forEach((el, i) => {
        lines.push(`  ${i + 1}. <${el.tagName.toLowerCase()}>`);
        lines.push(`     name="${el.getAttribute('name') || ''}" id="${el.id}"`);
        lines.push(`     placeholder="${el.getAttribute('placeholder') || ''}"`);
        lines.push(`     值长度=${(el.value || '').length} 猜测字段=${guessField(el)}`);
        lines.push(`     值预览: ${(el.value || '').slice(0, 60).replace(/\n/g, ' ')}`);
    });

    lines.push('');
    lines.push('=== 收集结果长度 ===');
    const c = collectEntry(e);
    Object.keys(c).forEach(k => lines.push(`  ${k}: ${c[k].length}`));

    return lines.join('\n');
}

window.wbSearchDebug = function () {
    const txt = buildDiagnostics();
    console.log(txt);
    log('诊断信息已打印到上方');
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
