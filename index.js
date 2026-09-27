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

// ---------- 状态 ----------
let searchText = '';
let onlyShowMatches = true;
const activeFields = { comment: true, key: true, content: true };

// ---------- 入口 ----------
jQuery(async () => {
    log('插件加载中...');

    setInterval(tryInject, 800);

    if (event_types && event_types.WORLDINFO_SETTINGS_UPDATED) {
        eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, () => setTimeout(tryInject, 300));
    }

    log('诊断命令：控制台输入 wbSearchDebug() 可打印条目结构');
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
            <input id="wb-search-input" class="text_pole" type="text" placeholder="🔍 搜索当前世界书的条目..." />
            <span id="wb-search-count" class="wb-search-count"></span>
            <div id="wb-search-clear" class="menu_button wb-mini-btn" title="清空">✕</div>
        </div>
        <div class="wb-search-row wb-search-options">
            <span class="wb-dim">范围：</span>
            <label><input type="checkbox" id="wb-f-comment" checked> 备注</label>
            <label><input type="checkbox" id="wb-f-key" checked> 关键词</label>
            <label><input type="checkbox" id="wb-f-content" checked> 内容</label>
            <label class="wb-right"><input type="checkbox" id="wb-only-match" checked> 只显示匹配</label>
        </div>
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

    panel.querySelector('#wb-only-match').addEventListener('change', e => {
        onlyShowMatches = e.target.checked;
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
        .filter(el => el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'button' && el.type !== 'submit');
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

// ---------- 搜索 ----------
function runSearch() {
    const entries = getEntries();
    const kw = searchText.trim().toLowerCase();
    const fields = Object.keys(FIELD_LABELS).filter(f => activeFields[f]);
    let hits = 0;

    entries.forEach(entry => {
        entry.classList.remove('wb-search-hit', 'wb-search-hidden');
        entry.querySelectorAll('.wb-search-badge').forEach(b => b.remove());

        if (!kw) return;

        const matched = fields.filter(f => getFieldText(entry, f).toLowerCase().includes(kw));

        if (matched.length > 0) {
            hits++;
            entry.classList.add('wb-search-hit');
            const badge = document.createElement('span');
            badge.className = 'wb-search-badge';
            badge.textContent = `🔍 ${matched.map(f => FIELD_LABELS[f]).join(' / ')}`;
            entry.insertBefore(badge, entry.firstChild);
        } else if (onlyShowMatches) {
            entry.classList.add('wb-search-hidden');
        }
    });

    const counter = document.getElementById('wb-search-count');
    if (counter) {
        counter.textContent = kw ? `命中 ${hits} / ${entries.length}` : `共 ${entries.length} 条`;
    }
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
