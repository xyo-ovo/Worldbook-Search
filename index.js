import { eventSource, event_types } from '../../../../script.js';

const MODULE_NAME = 'worldbook-search';
const log = (...a) => console.log(`[${MODULE_NAME}]`, ...a);

// ---------- 字段定义（多选择器兜底，兼容不同酒馆版本）----------
const FIELDS = {
    comment: {
        label: '备注',
        selectors: ['.world_entry_name', 'input[name="comment"]', 'textarea[name="comment"]'],
    },
    key: {
        label: '关键词',
        selectors: ['textarea[name="key"]', '.world_entry_key textarea', '[data-field="key"]'],
    },
    content: {
        label: '内容',
        selectors: ['textarea[name="content"]', '.world_entry_content textarea', '[data-field="content"]'],
    },
};

// ---------- 状态 ----------
let searchText = '';
let onlyShowMatches = true;
const activeFields = { comment: true, key: true, content: true };

// ---------- 入口 ----------
jQuery(async () => {
    log('插件加载中...');

    // 世界书弹窗是动态出现的，轮询 + 事件双保险
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
        if (panel.parentNode === list.parentNode) return; // 位置正确，不用管
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

    // ---- 搜索框 ----
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

    // ---- 范围勾选 ----
    ['comment', 'key', 'content'].forEach(f => {
        panel.querySelector(`#wb-f-${f}`).addEventListener('change', e => {
            activeFields[f] = e.target.checked;
            runSearch();
        });
    });

    // ---- 只显示匹配 ----
    panel.querySelector('#wb-only-match').addEventListener('change', e => {
        onlyShowMatches = e.target.checked;
        runSearch();
    });

    // ---- 批量替换 ----
    panel.querySelector('#wb-replace-btn').addEventListener('click', () => {
        doReplace(panel.querySelector('#wb-replace-input').value);
    });

    // ---- 切换世界书时重新搜 ----
    const sel = document.getElementById('world_editor_select');
    if (sel && !sel.dataset.wbSearchBound) {
        sel.addEventListener('change', () => setTimeout(runSearch, 300));
        sel.dataset.wbSearchBound = '1';
    }

    runSearch();
    log('UI 注入完成 ✨');
}

// ---------- 取条目 ----------
function getEntries() {
    return Array.from(document.querySelectorAll('#world_popup_entries_list .world_entry'));
}

function getFieldEl(entry, field) {
    for (const sel of FIELDS[field].selectors) {
        const el = entry.querySelector(sel);
        if (el) return el;
    }
    return null;
}

function getFieldText(entry, field) {
    const el = getFieldEl(entry, field);
    if (!el) return '';
    if (typeof el.value === 'string') return el.value;
    return el.textContent || '';
}

// ---------- 搜索 ----------
function runSearch() {
    const entries = getEntries();
    const kw = searchText.trim().toLowerCase();
    const fields = Object.keys(FIELDS).filter(f => activeFields[f]);
    let hits = 0;

    entries.forEach(entry => {
        // 清掉上一次的痕迹
        entry.classList.remove('wb-search-hit', 'wb-search-hidden');
        entry.querySelectorAll('.wb-search-badge').forEach(b => b.remove());

        if (!kw) return;

        const matched = fields.filter(f => getFieldText(entry, f).toLowerCase().includes(kw));

        if (matched.length > 0) {
            hits++;
            entry.classList.add('wb-search-hit');
            const badge = document.createElement('span');
            badge.className = 'wb-search-badge';
            badge.textContent = `🔍 ${matched.map(f => FIELDS[f].label).join(' / ')}`;
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

    const fields = Object.keys(FIELDS).filter(f => activeFields[f]);
    const entries = getEntries();

    // 先统计影响面
    let affectedEntries = 0;
    let affectedFields = 0;
    entries.forEach(entry => {
        let touched = false;
        fields.forEach(f => {
            const el = getFieldEl(entry, f);
            if (!el) return;
            const val = (typeof el.value === 'string' ? el.value : el.textContent) || '';
            if (val.toLowerCase().includes(kw.toLowerCase())) {
                affectedFields++;
                touched = true;
            }
        });
        if (touched) affectedEntries++;
    });

    if (affectedFields === 0) return alert('没有找到可以替换的地方～');

    if (!confirm(`将会修改 ${affectedEntries} 个条目里的 ${affectedFields} 处：\n「${kw}」 → 「${replacement}」\n\n只影响当前打开的世界书，确定继续吗？`)) return;

    const re = new RegExp(escapeRegExp(kw), 'gi');

    entries.forEach(entry => {
        fields.forEach(f => {
            const el = getFieldEl(entry, f);
            if (!el) return;
            const isInput = typeof el.value === 'string';
            const val = isInput ? el.value : el.textContent;
            if (!val) return;

            re.lastIndex = 0;
            if (!re.test(val)) return;
            re.lastIndex = 0;

            const next = val.replace(re, replacement);
            if (isInput) el.value = next;
            else el.textContent = next;

            // 通知酒馆同步数据
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

    alert('替换完成啦～记得点一下世界书面板的保存按钮确认哦 ✅');
    runSearch();
}

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
