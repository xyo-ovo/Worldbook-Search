import { eventSource, event_types } from '../../../../script.js';

const MODULE_NAME = 'worldbook-search';
const log = (...a) => console.log(`[${MODULE_NAME}]`, ...a);

// ---------- 字段识别：靠 name / id / placeholder 里的关键词猜 ----------
const FIELD_HINTS = {
    comment: ['comment', '备注', '标题', 'title', 'name'],
    key: ['key', 'keys', '关键词', '触发'],
    content: ['content', '内容', '正文'],
};

const FIELD_LABELS = {
    comment: '备注',
    key: '关键词',
    content: '内容',
};

// ---------- 参数 ----------
const MAX_RESULTS = 300;          // 最多渲染多少条结果
const MAX_SNIPPETS_PER_ENTRY = 4; // 每个条目最多几个片段
const SNIPPET_RADIUS = 40;        // 片段前后各截多少字

// ---------- 状态 ----------
let searchText = '';
let syncFilter = false;
const activeFields = { comment: true, key: true, content: true };

// ---------- 入口 ----------
jQuery(async () => {
    log('插件加载中...');

    setInterval(tryInject, 800);

    if (event_types && event_types.WORLDINFO_SETTINGS_UPDATED) {
        eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, () => setTimeout(tryInject, 300));
    }

    log('诊断命令：控制台输入 wbSearchDebug()');
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

// ---------- 注入界面 ----------
function injectUI(entriesContainer) {
    const panel = document.createElement('div');
    panel.id = 'wb-search-panel';
    panel.innerHTML = `
        <div class="wb-search-row">
            <input id="wb-search-input" class="text_pole" type="text" placeholder="🔍 搜索条目内容（支持备注 / 关键词 / 正文）..." />
            <span id="wb-search-count" class="wb-search-count"></span>
            <div id="wb-search-clear" class="menu_button wb-mini-btn" title="清空">✕</div>
        </div>
        <div class="wb-search-row wb-search-options">
            <span class="wb-dim">范围：</span>
            <label><input type="checkbox" id="wb-f-comment" checked> 备注</label>
            <label><input type="checkbox" id="wb-f-key" checked> 关键词</label>
            <label><input type="checkbox" id="wb-f-content" checked> 内容</label>
            <label class="wb-right"><input type="checkbox" id="wb-sync-filter"> 同时过滤原生列表</label>
        </div>
        <div id="wb-search-results"></div>
        <details id="wb-replace-box">
            <summary>🔁 批量替换</summary>
            <div class="wb-search-row" style="margin-top:8px">
                <input id="wb-replace-input" class="text_pole" type="text" placeholder="替换成..." />
                <div id="wb-replace-btn" class="menu_button wb-mini-btn">全部替换</div>
            </div>
            <div class="wb-dim" style="margin-top:4px">会把当前世界书中匹配字段里的关键词全部替换掉，操作前请确认～</div>
        </details>
    `;

    entriesContainer.parentNode.insertBefore(panel, entriesContainer);

    const input = panel.querySelector('#wb-search-input');
    input.addEventListener('input', debounce(() => {
        searchText = input.value;
        runSearch();
    }, 150));

    panel.querySelector('#wb-search-clear').addEventListener('click', () => {
        input.value = '';
        searchText = '';
        runSearch();
        input.focus();
    });

    ['comment', 'key', 'content'].forEach(f => {
        panel.querySelector(`#wb-f-${f}`).addEventListener('change', e => {
            activeFields[f] = e.target.checked;
            runSearch();
        });
    });

    panel.querySelector('#wb-sync-filter').addEventListener('change', e => {
        syncFilter = e.target.checked;
        runSearch();
    });

    panel.querySelector('#wb-replace-btn').addEventListener('click', () => {
        doReplace(panel.querySelector('#wb-replace-input').value);
    });

    const sel = document.getElementById('world_editor_select');
    if (sel && !sel.dataset.wbSearchBound) {
        sel.addEventListener('change', () => setTimeout(runSearch, 300));
        sel.dataset.wbSearchBound = '1';
    }

    runSearch();
    log('UI 注入完成 ✨');
}

// ---------- 条目 & 字段收集 ----------
function getEntries() {
    return Array.from(document.querySelectorAll('#world_popup_entries_list .world_entry'));
}

function collectInputs(entry) {
    return Array.from(entry.querySelectorAll('textarea, input'))
        .filter(el => !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(el.type));
}

function guessField(el) {
    const hay = [
        el.getAttribute('name'),
        el.id,
        el.getAttribute('placeholder'),
        el.getAttribute('data-field'),
        el.getAttribute('data-name'),
    ].filter(Boolean).join(' ').toLowerCase();

    if (!hay) return null;

    for (const [field, hints] of Object.entries(FIELD_HINTS)) {
        if (hints.some(h => hay.includes(h))) return field;
    }
    return null;
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

    return {
        comment: [buckets.comment.join('\n'), other, text].filter(Boolean).join('\n'),
        key: [buckets.key.join('\n'), other, text].filter(Boolean).join('\n'),
        content: [buckets.content.join('\n'), other, text].filter(Boolean).join('\n'),
        all: [buckets.comment, buckets.key, buckets.content, buckets.other, text].flat().join('\n'),
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

// ---------- 片段提取 ----------
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
    tag.className = 'wb-snippet-field';
    tag.textContent = FIELD_LABELS[field];
    div.appendChild(tag);

    div.appendChild(document.createTextNode(sn.before));

    const mark = document.createElement('mark');
    mark.className = 'wb-hit';
    mark.textContent = sn.hit;
    div.appendChild(mark);

    div.appendChild(document.createTextNode(sn.after));

    return div;
}

// ---------- 搜索 ----------
function runSearch() {
    const entries = getEntries();
    const kw = searchText.trim();
    const fields = Object.keys(FIELD_LABELS).filter(f => activeFields[f]);

    const resultsBox = document.getElementById('wb-search-results');
    const counter = document.getElementById('wb-search-count');

    // 清掉上一次的标记
    entries.forEach(entry => entry.classList.remove('wb-search-hidden'));

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

        if (matchedFields.length === 0) {
            if (syncFilter) entry.classList.add('wb-search-hidden');
            continue;
        }

        hits++;

        if (rendered >= MAX_RESULTS) continue;
        rendered++;

        const item = document.createElement('div');
        item.className = 'wb-result-item';
        item.dataset.uid = uid;

        const head = document.createElement('div');
        head.className = 'wb-result-head';

        const name = document.createElement('span');
        name.className = 'wb-result-name';
        name.textContent = getEntryName(entry);
        head.appendChild(name);

        const tags = document.createElement('span');
        tags.className = 'wb-result-tags';
        tags.textContent = matchedFields.map(f => FIELD_LABELS[f]).join(' · ');
        head.appendChild(tags);

        item.appendChild(head);

        let snippetCount = 0;
        for (const f of matchedFields) {
            const snips = findSnippets(texts[f], kw, SNIPPET_RADIUS, 2);
            for (const sn of snips) {
                if (snippetCount >= MAX_SNIPPETS_PER_ENTRY) break;
                item.appendChild(renderSnippet(sn, f));
                snippetCount++;
            }
            if (snippetCount >= MAX_SNIPPETS_PER_ENTRY) break;
        }

        item.addEventListener('click', () => jumpToEntry(uid));
        resultsBox.appendChild(item);
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
        resultsBox.appendChild(empty);
    }
}

// ---------- 跳转定位 ----------
function jumpToEntry(uid) {
    if (!uid) return;
    const entry = document.querySelector(`#world_popup_entries_list .world_entry[uid="${CSS.escape(uid)}"]`);
    if (!entry) return;

    entry.classList.remove('wb-search-hidden');
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
window.wbSearchDebug = function () {
    const entries = getEntries();
    log(`找到 ${entries.length} 个 .world_entry`);

    const e = entries[0];
    if (!e) return log('没有找到任何条目');

    log('第一个条目的 outerHTML（截断 4000 字）:');
    console.log(e.outerHTML.slice(0, 4000));

    log('识别到的输入控件:');
    console.table(collectInputs(e).map(el => ({
        tag: el.tagName,
        name: el.getAttribute('name'),
        id: el.id,
        placeholder: el.getAttribute('placeholder'),
        猜测字段: guessField(el),
        值: (el.value || '').slice(0, 40),
    })));

    log('收集到的字段文本:');
    console.log(collectEntry(e));
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
