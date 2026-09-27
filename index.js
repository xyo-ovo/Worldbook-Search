import { eventSource, event_types } from '../../../../script.js';

const MODULE_NAME = 'worldbook-search';
const log = (...a) => console.log(`[${MODULE_NAME}]`, ...a);

// ============================================================
// 依据 SillyTavern 官方源码（public/scripts/world-info.js）：
//   - 条目容器：.world_entry[uid]
//   - 表单容器：.world_entry_form
//   - 字段：
//       <textarea name="comment">  备注
//       <textarea name="key">      关键词
//       <textarea name="content" id="world_entry_content_${uid}">  内容
//   - 内容框的 uid 也会存在 jQuery data 里（HTML 上不一定有）
// ============================================================

const FIELD_NAMES = {
    comment: 'comment',
    key: 'key',
    content: 'content',
};

const FIELD_LABELS = {
    comment: '备注',
    key: '关键词',
    content: '内容',
    other: '其他',
};

const FIELD_ORDER = ['comment', 'key', 'content', 'other'];

const IGNORE_TYPES = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'hidden', 'image'];
const IGNORE_NAMES = ['depth', 'order', 'probability', 'weight', 'position', 'index', 'uid', 'scan_depth', 'token_budget', 'role', 'group_weight', 'sticky', 'cooldown', 'delay'];

const MAX_RESULTS = 300;
const MAX_SNIPPETS_PER_ENTRY = 3;
const SNIPPET_RADIUS = 44;

let searchText = '';
const activeFields = { comment: true, key: true, content: true };
const expandedUids = new Set();

// ---------- 入口 ----------
jQuery(async () => {
    log('v2.3.0 加载中...');

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

// ---------- uid 提取（多路） ----------
function extractUid(el) {
    const own = el.getAttribute('uid') || el.getAttribute('data-uid');
    if (own) return own;

    const id = el.id || '';
    const m = id.match(/world_entry_(?:content|key|comment|title)_(.+)$/i);
    if (m) return m[1];

    let n = el.parentElement;
    let depth = 0;
    while (n && depth < 15) {
        if (n.getAttribute) {
            const u = n.getAttribute('uid') || n.getAttribute('data-uid');
            if (u) return u;
        }
        n = n.parentElement;
        depth++;
    }
    return null;
}

// ---------- 收集候选输入框 ----------
function isInOwnPanel(el) {
    const panel = document.getElementById('wb-search-panel');
    return !!(panel && panel.contains(el));
}

function isUsable(el) {
    if (isInOwnPanel(el)) return false;
    const t = (el.type || '').toLowerCase();
    return !IGNORE_TYPES.includes(t);
}

function getScope() {
    const popup = document.getElementById('world_popup');
    if (popup) return popup;

    const list = document.getElementById('world_popup_entries_list');
    if (!list) return null;

    let n = list;
    for (let i = 0; i < 8 && n.parentElement; i++) {
        n = n.parentElement;
        const idc = ((n.id || '') + ' ' + (n.className || '')).toLowerCase();
        if (idc.includes('world')) return n;
    }
    return list.parentElement || list;
}

function collectCandidateInputs() {
    const all = Array.from(document.querySelectorAll('textarea, input')).filter(isUsable);

    // 第一优先：世界书标准 name（comment / key / content）
    const named = all.filter(el => {
        const n = (el.getAttribute('name') || '').toLowerCase();
        return n === 'comment' || n === 'key' || n === 'keys' || n === 'content';
    });
    if (named.length > 0) return named;

    // 兜底：在 scope 内扫全部输入框
    const scope = getScope();
    if (!scope) return [];
    return Array.from(scope.querySelectorAll('textarea, input')).filter(isUsable);
}

// ---------- 分组 ----------
function buildGroups() {
    const inputs = collectCandidateInputs();
    if (!inputs.length) return [];

    const map = new Map();
    let lastUid = null;

    inputs.forEach((el, idx) => {
        let uid = extractUid(el);
        if (uid) {
            lastUid = uid;
        } else {
            uid = lastUid;
        }
        if (!uid) uid = '__g' + idx;

        if (!map.has(uid)) map.set(uid, { uid, inputs: [], first: idx });
        map.get(uid).inputs.push(el);
    });

    const groups = Array.from(map.values()).sort((a, b) => a.first - b.first);

    groups.forEach(g => {
        g.node =
            document.querySelector(`.world_entry[uid="${CSS.escape(g.uid)}"]`) ||
            document.querySelector(`.world_entry[data-uid="${CSS.escape(g.uid)}"]`) ||
            null;

        if (!g.node) {
            let n = g.inputs[0];
            let d = 0;
            while (n && d < 15) {
                if (n.classList && n.classList.contains('world_entry')) {
                    g.node = n;
                    break;
                }
                n = n.parentElement;
                d++;
            }
        }
    });

    return groups;
}

// ---------- 字段识别 ----------
function heuristicField(el) {
    const tag = el.tagName;

    if (tag === 'INPUT') {
        const t = (el.type || 'text').toLowerCase();
        if (t === 'number' || t === 'tel') return 'ignore';
        return 'comment';
    }

    if (tag === 'TEXTAREA') {
        const len = (el.value || '').length;
        return len >= 150 ? 'content' : 'key';
    }

    return null;
}

function guessField(el) {
    const name = (el.getAttribute('name') || '').toLowerCase();
    const id = (el.id || '').toLowerCase();

    if (name === 'comment') return 'comment';
    if (name === 'key' || name === 'keys') return 'key';
    if (name === 'content') return 'content';

    if (IGNORE_NAMES.includes(name) || IGNORE_NAMES.includes(id)) return 'ignore';

    if (id.includes('world_entry_content')) return 'content';
    if (id.includes('world_entry_key')) return 'key';
    if (id.includes('world_entry_comment') || id.includes('world_entry_title')) return 'comment';

    const hay = [
        name,
        id,
        el.getAttribute('placeholder'),
        el.getAttribute('data-field'),
        el.getAttribute('data-name'),
    ].filter(Boolean).join(' ').toLowerCase();

    if (hay) {
        for (const [field, hints] of Object.entries({
            comment: ['comment', '备注', '标题', '备忘录', 'title'],
            key: ['key', 'keys', '关键词', '关键字', '触发'],
            content: ['content', '内容', '正文'],
        })) {
            if (hints.some(h => hay.includes(h))) return field;
        }
    }

    return heuristicField(el);
}

// ---------- 收集文本 ----------
function collectEntry(group) {
    const buckets = { comment: [], key: [], content: [], other: [] };

    group.inputs.forEach(el => {
        const v = (el.value || '').trim();
        if (!v) return;
        const f = guessField(el);
        if (f === 'ignore') return;
        (f && buckets[f] ? buckets[f] : buckets.other).push(v);
    });

    const node = group.node;
    const text = node ? (node.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const other = buckets.other.join('\n');

    const all = [
        buckets.comment.join('\n'),
        buckets.key.join('\n'),
        buckets.content.join('\n'),
        other,
    ].filter(Boolean).join('\n');

    return {
        comment: [buckets.comment.join('\n') || all, other, text].filter(Boolean).join('\n'),
        key: [buckets.key.join('\n') || all, other, text].filter(Boolean).join('\n'),
        content: [buckets.content.join('\n') || all, other, text].filter(Boolean).join('\n'),
    };
}

function getFieldText(group, field) {
    return collectEntry(group)[field] || '';
}

function getEntryName(group) {
    for (const el of group.inputs) {
        if (guessField(el) === 'comment' && (el.value || '').trim()) {
            return el.value.trim().slice(0, 60);
        }
    }
    for (const el of group.inputs) {
        if (guessField(el) !== 'ignore' && (el.value || '').trim()) {
            return el.value.trim().slice(0, 60);
        }
    }
    return group.uid ? `条目 #${group.uid}` : '未命名条目';
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
function buildEditor(group) {
    const body = document.createElement('div');
    body.className = 'wb-result-body';

    const editor = document.createElement('div');
    editor.className = 'wb-editor';

    const groups = new Map();
    group.inputs.forEach(el => {
        const f = guessField(el);
        if (f === 'ignore') return;
        const key = f || 'other';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(el);
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
    const groups = buildGroups();
    const kw = searchText.trim();
    const fields = Object.keys(activeFields).filter(f => activeFields[f]);

    const resultsBox = document.getElementById('wb-search-results');
    const counter = document.getElementById('wb-search-count');
    if (!resultsBox) return;

    resultsBox.innerHTML = '';

    if (!kw) {
        resultsBox.style.display = 'none';
        if (counter) counter.textContent = `共 ${groups.length} 条`;
        return;
    }

    const kwLower = kw.toLowerCase();
    let hits = 0;
    let rendered = 0;

    for (const group of groups) {
        const matchedFields = [];
        const texts = {};

        for (const f of fields) {
            const t = getFieldText(group, f);
            if (t.toLowerCase().includes(kwLower)) {
                matchedFields.push(f);
                texts[f] = t;
            }
        }

        if (matchedFields.length === 0) continue;

        hits++;
        if (rendered >= MAX_RESULTS) continue;
        rendered++;

        resultsBox.appendChild(buildResultItem(group, matchedFields, texts, kw));
    }

    resultsBox.style.display = 'flex';

    if (counter) {
        counter.textContent = `命中 ${hits} / ${groups.length}`;
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

function buildResultItem(group, matchedFields, texts, kw) {
    const uid = group.uid;
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
    name.textContent = getEntryName(group);
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
        jumpToEntry(group);
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
        item.appendChild(buildEditor(group));
    }

    head.addEventListener('click', () => {
        if (expandedUids.has(uid)) {
            expandedUids.delete(uid);
            item.classList.remove('expanded');
            item.querySelector('.wb-result-body')?.remove();
        } else {
            expandedUids.add(uid);
            item.classList.add('expanded');
            item.appendChild(buildEditor(group));
        }
    });

    return item;
}

// ---------- 定位 ----------
function jumpToEntry(group) {
    let node = group.node;
    if (!node) {
        node =
            document.querySelector(`.world_entry[uid="${CSS.escape(group.uid)}"]`) ||
            document.querySelector(`.world_entry[data-uid="${CSS.escape(group.uid)}"]`);
    }
    if (!node) return;

    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.remove('wb-flash');
    void node.offsetWidth;
    node.classList.add('wb-flash');
    setTimeout(() => node.classList.remove('wb-flash'), 1800);
}

// ---------- 批量替换 ----------
function doReplace(replacement) {
    const kw = searchText.trim();
    if (!kw) return alert('先在上面输入要搜索的关键词哦～');

    const groups = buildGroups();
    const re = new RegExp(escapeRegExp(kw), 'gi');

    let affectedEntries = 0;
    let affectedFields = 0;

    groups.forEach(group => {
        let touched = false;
        group.inputs.forEach(el => {
            const v = el.value || '';
            if (!v) return;

            const f = guessField(el);
            if (f === 'ignore') return;

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

    groups.forEach(group => {
        group.inputs.forEach(el => {
            const v = el.value || '';
            if (!v) return;

            const f = guessField(el);
            if (f === 'ignore') return;

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
    const scope = getScope();
    const groups = buildGroups();

    lines.push('=== 环境 ===');
    lines.push(`#world_popup: ${document.getElementById('world_popup') ? '有' : '无'}`);
    lines.push(`#world_popup_entries_list: ${document.getElementById('world_popup_entries_list') ? '有' : '无'}`);
    lines.push(`scope: ${scope ? (scope.id || scope.className || scope.tagName) : 'null'}`);

    const named = Array.from(document.querySelectorAll('textarea, input')).filter(el => {
        const n = (el.getAttribute('name') || '').toLowerCase();
        return n === 'comment' || n === 'key' || n === 'keys' || n === 'content';
    });
    lines.push(`全局 name=comment/key/content 的输入框: ${named.length}`);

    lines.push('');
    lines.push(`=== 分组（共 ${groups.length} 组）===`);

    groups.slice(0, 4).forEach((g, i) => {
        lines.push(`[${i}] uid=${g.uid} 输入框=${g.inputs.length} 有原生节点=${g.node ? '是' : '否'}`);
        g.inputs.forEach((el, j) => {
            const nm = el.getAttribute('name') || '';
            const id = el.id || '';
            const len = (el.value || '').length;
            const f = guessField(el);
            lines.push(`    ${j + 1}. <${el.tagName.toLowerCase()}> name="${nm}" id="${id}"`);
            lines.push(`        字段=${f} 长度=${len} 预览: ${(el.value || '').slice(0, 40).replace(/\n/g, ' ')}`);
        });
    });

    lines.push('');
    lines.push('=== 收集结果长度（第一组）===');
    if (groups[0]) {
        const c = collectEntry(groups[0]);
        Object.keys(c).forEach(k => lines.push(`  ${k}: ${c[k].length}`));
    } else {
        lines.push('  （没有分组）');
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
