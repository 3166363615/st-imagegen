import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced, addOneMessage } from '../../../../script.js';
import { MEDIA_TYPE } from '../../../constants.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { generate, BACKENDS, NAI_MODELS, NAI_SAMPLERS, NAI_SMEAS, NAI_DEFAULT_NEGATIVE } from './src/backends.js';
import { buildPrompt, STYLES, PROMPT_MODES, ADULT_BOOST, UC_PRESETS, localExtract } from './src/prompt.js';
import { pickKeyParagraphs, splitParagraphs } from './src/segment.js';

const MODULE = 'st-imagegen';
const LOG = '[st-imagegen]';

const DEFAULTS = {
    enabled: false,
    // 后端
    backend: 'nai',
    url: 'https://dangao.iisbo.com',
    apiPath: '/v1/images/generations',
    apiKey: '',
    model: 'nai-diffusion-4-5-full',
    // 画面
    width: 832,
    height: 1216,
    steps: 28,
    cfg: 5,
    sampler: 'k_euler_ancestral',
    seed: -1,
    naiSmea: 'SMEA',
    naiCfgRescale: 0,
    naiQualityTags: true,
    naiUcPreset: 0,
    // tag 生成接口（与生图接口分离）
    tagSource: 'tavern',
    tagUrl: '',
    tagApiKey: '',
    tagModel: 'gpt-4o-mini',
    // 提示词
    promptMode: 'hybrid',
    useAI: true,
    allowLocalFallback: false,
    style: 'anime',
    stylePrefix: '',
    charAppearance: '',
    extraHint: '',
    negative: '',
    naiUC: '',
    adultBoost: 'mild',
    // 自动
    autoMode: 'off',
    autoEvery: 4,
    autoKeywords: '（画面, 场景描写, [画面',
    // 行为
    insertMode: 'inline',
    imagesPerMessage: 3,
    showPrompt: true,
    charProfiles: {},
    counter: 0,
    panelPos: { right: 16, bottom: 90 },
    panelOpen: false,
};

let busy = false;
let lastToggleAt = 0;
let selfInserting = false;
let ballEl = null;

/* ------------------------------------------------------------------ */

function resolveExtensionDir() {
    try {
        const parts = new URL(import.meta.url).pathname.split('/').filter(Boolean);
        const s = parts.lastIndexOf('scripts');
        const e = parts.indexOf('extensions', s >= 0 ? s : 0);
        if (e >= 0) return parts.slice(e + 1, -1).join('/');
    } catch (e) { console.warn(LOG, e); }
    return 'third-party/st-imagegen';
}

function getSettings() {
    if (!extension_settings[MODULE] || typeof extension_settings[MODULE] !== 'object') {
        extension_settings[MODULE] = {};
    }
    const s = extension_settings[MODULE];
    for (const k of Object.keys(DEFAULTS)) {
        if (s[k] === undefined) s[k] = k === 'charProfiles' ? {} : structuredClone(DEFAULTS[k]);
    }
    if (!s.charProfiles || typeof s.charProfiles !== 'object') s.charProfiles = {};
    // 旧版本遗留的负向词迁移
    if (s.negative === 'lowres, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, text') {
        s.negative = '';
    }
    // 旧版是 A1111 后端，URL 会残留 127.0.0.1:7860，切到 NovelAI 后必须纠正
    // 旧版是 a1111/comfyui/openai 后端，v2 只保留 NovelAI
    if (s.backend && s.backend !== 'nai') s.backend = 'nai';
    const u = String(s.url || '');
    if (!u || /127\.0\.0\.1:7860|localhost:7860/.test(u) || /^http:\/\/[^/]+:7860/.test(u)) {
        s.url = 'https://dangao.iisbo.com';
    }
    // 去掉旧版误加的 NAI 路径后缀（会造成 404）
    s.url = String(s.url).replace(/\/ai\/generate-image(-stream)?$/, '');
    if (!s.apiPath) s.apiPath = '/v1/images/generations';

    // v4 起默认改为"穿插到段落"，旧配置里残留的 message 要迁移
    if (!s.__v4Migrated) {
        if (s.insertMode === 'message' && s.imagesPerMessage === undefined) {
            s.insertMode = 'inline';
        }
        if (s.imagesPerMessage === undefined) s.imagesPerMessage = 3;
        s.__v4Migrated = true;
    }
    if (s.imagesPerMessage === undefined) s.imagesPerMessage = 3;
    if (!s.insertMode) s.insertMode = 'inline';
    return s;
}

const save = () => saveSettingsDebounced();

function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toast(kind, text) {
    if (globalThis.toastr) (globalThis.toastr[kind] || globalThis.toastr.info).call(globalThis.toastr, text, '文生图');
    else console.log(LOG, kind, text);
}

function blobToBase64(blob) {
    return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => { const s = String(fr.result || ''); res(s.slice(s.indexOf(',') + 1)); };
        fr.onerror = () => rej(new Error('读取图片失败'));
        fr.readAsDataURL(blob);
    });
}

async function materializeImage(blob, chName) {
    let b64 = null;
    try {
        b64 = await blobToBase64(blob);
        const ext = (blob.type || 'image/png').includes('jpeg') ? 'jpg' : 'png';
        const res = await fetch('/api/images/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: b64, format: ext, ch_name: chName || 'imagegen', filename: `imagegen_${Date.now()}` }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data?.path) throw new Error('无 path');
        return data.path;
    } catch (e) {
        console.warn(LOG, '上传失败，改用内联显示', e?.message || e);
        if (!b64) b64 = await blobToBase64(blob);
        return `data:${blob.type || 'image/png'};base64,${b64}`;
    }
}

/* ------------------------------------------------------------------ */
/* 生成                                                                */
/* ------------------------------------------------------------------ */

/** 判断一段文本是否"可画"：排除欢迎语、系统提示、纯指令 */
function isPaintingWorthy(text) {
    const t = String(text || '').trim();
    if (t.length < 12) return false;
    // 欢迎语 / 使用提示
    if (/如果你已连接|试着问我|提示[:：]|欢迎页面助手|从他们的|菜单中将任何角色/i.test(t)) return false;
    if (/^(hi|hello|你好|在吗)[!！。.\s]*$/i.test(t)) return false;
    // 纯英文拒绝话术
    if (/i'?m (just )?a language model|i can'?t help with that/i.test(t)) return false;
    // 指令性文本（不是叙事）
    if (/^(请|帮我|给我|生成|画)[^。！？]{0,10}$/.test(t)) return false;
    return true;
}

function lastAiMessageText() {
    const chat = getContext().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        const t = String(m.mes || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        if (!isPaintingWorthy(t)) continue;
        return t;
    }
    return '';
}

async function runGeneration({ narrative, override, silent, sourceMessageId } = {}) {
    const cfg = getSettings();
    if (busy) { if (!silent) toast('warning', '上一张还在生成'); return; }
    if (!BACKENDS[cfg.backend]) { if (!silent) toast('error', '后端配置有误'); return; }
    if (!cfg.url) { if (!silent) toast('error', '请填写 Base URL'); return; }
    if (!cfg.apiKey) { if (!silent) toast('error', '请填写 NovelAI Token'); return; }

    const text = String(narrative || '').trim() || lastAiMessageText();
    if (!text && !override) { if (!silent) toast('warning', '没有可用文本，先聊一句或用 /img 指定'); return; }

    busy = true;
    setBallBusy(true);
    const prog = silent ? null : showProgress('整理画面…');
    try {
        let positive, negative, usedAI = false;
        if (override) {
            positive = override;
            negative = cfg.negative || '';
        } else {
            const built = await buildPrompt({ cfg, narrative: text, context: getContext() });
            positive = built.positive;
            negative = built.negative;
            usedAI = built.usedAI;
        }
        if (!positive) throw new Error('提示词为空');

        prog?.setText(usedAI ? '模型已理解场景，正在出图…' : '本地抽取，正在出图…');
        const t0 = Date.now();
        const result = await generate(cfg, positive, negative);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);

        prog?.setText('保存图片…');
        let src;
        if (result?.blob) src = await materializeImage(result.blob, getContext().name2 || 'imagegen');
        else if (result?.url) src = result.url;
        else throw new Error('后端未返回图像');

        prog?.close();
        await presentResult({ cfg, src, positive, negative, secs, seed: result?.seed, sourceMessageId });
        cfg.counter = 0;
        save();
        renderPreview(src, positive);
    } catch (e) {
        console.error(LOG, e);
        if (!silent) toast('error', `失败：${e?.message || e}`);
        renderError(e?.message || String(e));
    } finally {
        prog?.close();
        busy = false;
        setBallBusy(false);
    }
}

async function presentResult({ cfg, src, positive, negative, secs, seed, sourceMessageId }) {
    const meta = cfg.showPrompt
        ? `<div class="si-meta"><b>Prompt</b> ${esc(positive)}` +
          (negative ? `<br><b>Negative</b> ${esc(negative)}` : '') +
          `<br><span class="si-time">${BACKENDS[cfg.backend]?.label || cfg.backend}${seed ? ` · seed ${seed}` : ''} · ${secs}s</span></div>`
        : '';

    if (cfg.insertMode === 'message') {
        const ctx = getContext();
        const message = {
            name: '文生图',
            is_user: false,
            is_system: true,
            send_date: Date.now(),
            mes: meta,
            extra: {
                media: [{ url: src, type: MEDIA_TYPE.IMAGE, title: positive, source: 'generated' }],
                media_index: 0,
                imagegen: { prompt: positive, negative, backend: cfg.backend, seed },
            },
        };
        selfInserting = true;
        try {
            // 若来自某楼按钮，插到该楼之后；否则追加到末尾
            const srcIdx = sourceMessageId != null ? Number(sourceMessageId) : NaN;
            let insertAfter = null;
            if (Number.isInteger(srcIdx) && srcIdx >= 0 && srcIdx < ctx.chat.length) {
                ctx.chat.splice(srcIdx + 1, 0, message);
                insertAfter = srcIdx;
            } else {
                ctx.chat.push(message);
            }
            const idx = insertAfter != null ? insertAfter + 1 : ctx.chat.length - 1;
            try {
                ctx.addOneMessage(message, insertAfter != null ? { insertAfter } : undefined);
            } catch {
                ctx.addOneMessage(message);
            }
            await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, idx, 'extension');
            await ctx.saveChat();
            if (typeof ctx.scrollOnMediaLoad === 'function') setTimeout(() => ctx.scrollOnMediaLoad(), 200);
        } catch (e) {
            console.error(LOG, '插入聊天失败', e);
            toast('error', '插入聊天失败，已改为面板预览');
        } finally {
            selfInserting = false;
        }
    }
    toast('success', `出图完成（${secs}s）`);
}

/* ------------------------------------------------------------------ */
/* 悬浮球                                                              */
/* ------------------------------------------------------------------ */

function buildBall() {
    if (document.getElementById('si-ball')) return;
    const el = document.createElement('div');
    el.id = 'si-ball';
    el.className = 'si-ball';
    el.title = '文生图 ImageGen';
    el.innerHTML = `
      <div class="si-ball-inner">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path fill="currentColor" d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2ZM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5Z"/>
        </svg>
      </div>
      <span class="si-ball-badge"></span>`;
    document.body.appendChild(el);
    ballEl = el;

    // 不能同时监听 click 与 pointerup —— 触摸设备两者都会触发，
    // togglePanel 会连调两次互相抵消，表现为"点了没反应/关不掉"。
    // 点击判定统一放在 pointerup 里处理。

    // 拖动
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    el.addEventListener('pointerdown', (e) => {
        dragging = true; moved = false;
        sx = e.clientX; sy = e.clientY;
        const r = el.getBoundingClientRect();
        ox = r.left; oy = r.top;
        try { el.setPointerCapture?.(e.pointerId); } catch { /* 部分 WebView 不支持 */ }
        el.classList.add('si-dragging');
    });
    el.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        if (!moved) return;
        const w = el.offsetWidth, h = el.offsetHeight;
        let left = Math.min(Math.max(0, ox + dx), window.innerWidth - w);
        let top = Math.min(Math.max(0, oy + dy), window.innerHeight - h);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    });
    el.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('si-dragging');
        try { el.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }

        if (moved) {
            const r = el.getBoundingClientRect();
            const s = getSettings();
            if (r.left > 0 && r.top > 0) s.panelPos = { left: Math.round(r.left), top: Math.round(r.top) };
            save();
            return;
        }
        // 单击：切换面板
        togglePanel();
    });

    // 触摸设备兜底：某些 WebView 的 pointer 事件不完整，补一次 touchend
    let touchMoved = false;
    el.addEventListener('touchstart', () => { touchMoved = false; }, { passive: true });
    el.addEventListener('touchmove', () => { touchMoved = true; }, { passive: true });
    el.addEventListener('touchend', (e) => {
        if (touchMoved) return;
        // 若 pointerup 已处理过，这里会再切一次 —— 用时间戳去重
        const now = Date.now();
        if (now - lastToggleAt < 350) return;
        e.preventDefault();
        togglePanel();
    }, { passive: false });

    // 恢复位置
    const s = getSettings();
    if (s.panelPos?.left != null && s.panelPos?.top != null) {
        el.style.left = `${s.panelPos.left}px`;
        el.style.top = `${s.panelPos.top}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    }
}

function setBallBusy(on) {
    ballEl?.classList.toggle('si-busy', !!on);
}

function togglePanel(force) {
    const panel = document.getElementById('si-panel');
    if (!panel) return;
    const s = getSettings();
    const now = Date.now();
    // 同一时刻只处理一次，避免 click/touchend/pointerup 多重触发互相抵消
    if (force === undefined && now - lastToggleAt < 200) return;
    lastToggleAt = now;
    const open = force !== undefined ? force : panel.classList.contains('si-hidden');
    panel.classList.toggle('si-hidden', !open);
    ballEl?.classList.toggle('si-active', open);
    // 兜底：若样式表未生效，至少保证面板内部可滚动
    if (open) {
        const body = panel.querySelector('.si-body');
        if (body && body.getBoundingClientRect().height > (globalThis.window?.innerHeight || 800) * 0.9) {
            Object.assign(body.style, { overflowY: 'auto', minHeight: '0', flex: '1 1 auto' });
        }
    }
    s.panelOpen = open;
    save();
    if (open) syncFormToUI();
}

async function showPanel() {
    let html = '';
    try {
        html = await renderExtensionTemplateAsync(resolveExtensionDir(), 'settings');
    } catch (e) {
        console.error(LOG, '模板加载失败', e);
        html = `<div id="st-imagegen-settings"><div class="si-panel si-hidden" id="si-panel">
            <div class="si-head"><div class="si-title"><span>文生图</span></div>
              <div class="si-head-actions"><button class="si-icon-btn" id="si_close" type="button">×</button></div></div>
            <div class="si-body"><div class="si-error">settings.html 加载失败，请确认扩展文件完整。</div></div>
          </div></div>`;
    }

    // 关键：必须挂到 body，不能挂进 extensions_settings。
    // 扩展抽屉收起时父容器是 display:none，position:fixed 也无法显示。
    // 若宿主的 HTML 消毒剥掉了 fixed 定位，再补一层内联样式兜底。
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const panel = holder.querySelector('#si-panel');
    if (panel) {
        // 若宿主的 HTML 消毒剥掉了 fixed 定位，补内联样式兜底。
        // 这段必须绝不抛错：一旦抛异常，整个面板都不会渲染。
        let needFallback = false;
        try {
            const gcs = globalThis.getComputedStyle
                || globalThis.window?.getComputedStyle
                || null;
            const cs = gcs ? gcs.call(globalThis.window || globalThis, panel) : null;
            needFallback = !cs || cs.position !== 'fixed';
        } catch {
            needFallback = true;
        }
        if (needFallback) {
        panel.classList.add('si-fallback');
            // 注意：这里写死宽度会覆盖样式表里的宽度（内联优先级最高）。
            // 只补定位与层级，尺寸交给 CSS，避免又把面板压窄。
            const vw = (globalThis.window?.innerWidth) || 400;
            Object.assign(panel.style, {
                position: 'fixed',
                right: '12px',
                bottom: '148px',
                zIndex: '29995',
                width: `min(680px, calc(100vw - 16px))`,
                maxHeight: `calc(100vh - 172px)`,
                // 不要在这里写 display！内联 display 会盖过 .si-hidden{display:none}，
                // 导致面板永远关不掉。布局交给 CSS 类，这里只补定位尺寸。
                flexDirection: 'column',
                minHeight: '0',
                maxWidth: `${vw - 16}px`,
            });
        }
        document.body.appendChild(panel);
    }

    // 兜底：确保设置面板外壳存在于 DOM（部分逻辑按 id 查找）
    if (!document.getElementById('st-imagegen-settings')) {
        const shell = holder.querySelector('#st-imagegen-settings');
        if (shell) document.body.appendChild(shell);
        else {
            const w = document.createElement('div');
            w.id = 'st-imagegen-settings';
            w.style.display = 'none';
            document.body.appendChild(w);
        }
    }

    bindUI();
}

/* ------------------------------------------------------------------ */
/* 面板逻辑                                                            */
/* ------------------------------------------------------------------ */

const FIELDS = [
    ['#si_enabled', 'checked', 'enabled', v => !!v],
    ['#si_url', 'value', 'url', String],
    ['#si_api_key', 'value', 'apiKey', String],
    ['#si_api_path', 'value', 'apiPath', String],
    ['#si_model', 'value', 'model', String],
    ['#si_width', 'value', 'width', Number],
    ['#si_height', 'value', 'height', Number],
    ['#si_steps', 'value', 'steps', Number],
    ['#si_cfg', 'value', 'cfg', Number],
    ['#si_sampler', 'value', 'sampler', String],
    ['#si_seed', 'value', 'seed', Number],
    ['#si_smea', 'value', 'naiSmea', String],
    ['#si_cfg_rescale', 'value', 'naiCfgRescale', Number],
    ['#si_quality', 'checked', 'naiQualityTags', v => !!v],
    ['#si_uc_preset', 'value', 'naiUcPreset', Number],
    ['#si_tag_source', 'value', 'tagSource', String],
    ['#si_tag_url', 'value', 'tagUrl', String],
    ['#si_tag_api_key', 'value', 'tagApiKey', String],
    ['#si_tag_model', 'value', 'tagModel', String],
    ['#si_prompt_mode', 'value', 'promptMode', String],
    ['#si_use_ai', 'checked', 'useAI', v => !!v],
    ['#si_allow_local', 'checked', 'allowLocalFallback', v => !!v],
    ['#si_style', 'value', 'style', String],
    ['#si_style_prefix', 'value', 'stylePrefix', String],
    ['#si_char_appearance', 'value', 'charAppearance', String],
    ['#si_extra_hint', 'value', 'extraHint', String],
    ['#si_negative', 'value', 'negative', String],
    ['#si_adult', 'value', 'adultBoost', String],
    ['#si_auto_mode', 'value', 'autoMode', String],
    ['#si_auto_every', 'value', 'autoEvery', Number],
    ['#si_auto_keywords', 'value', 'autoKeywords', String],
    ['#si_insert_mode', 'value', 'insertMode', String],
    ['#si_per_msg', 'value', 'imagesPerMessage', Number],
    ['#si_show_prompt', 'checked', 'showPrompt', v => !!v],
];

function syncFormToUI() {
    const cfg = getSettings();
    if (!document.getElementById('si-panel')) return;
    for (const [sel, prop, key] of FIELDS) {
        const el = document.querySelector(sel);
        if (!el) continue;
        if (prop === 'checked') el.checked = !!cfg[key];
        else el.value = cfg[key] ?? '';
    }
    const styleSel = document.querySelector('#si_style');
    if (styleSel && !styleSel.options.length) {
        styleSel.innerHTML = Object.entries(STYLES)
            .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    }
    if (styleSel) styleSel.value = cfg.style;

    const modeSel = document.querySelector('#si_prompt_mode');
    if (modeSel && !modeSel.options.length) {
        modeSel.innerHTML = Object.entries(PROMPT_MODES)
            .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    }
    if (modeSel) modeSel.value = cfg.promptMode;

    const adultSel = document.querySelector('#si_adult');
    if (adultSel && !adultSel.options.length) {
        adultSel.innerHTML = Object.entries(ADULT_BOOST)
            .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    }
    if (adultSel) adultSel.value = cfg.adultBoost;

    const smeaSel = document.querySelector('#si_smea');
    if (smeaSel && !smeaSel.options.length) {
        smeaSel.innerHTML = NAI_SMEAS.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    }
    if (smeaSel) smeaSel.value = cfg.naiSmea;

    const ucSel = document.querySelector('#si_uc_preset');
    if (ucSel && !ucSel.options.length) {
        ucSel.innerHTML = Object.entries(UC_PRESETS)
            .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    }
    if (ucSel) ucSel.value = String(cfg.naiUcPreset);

    syncTagSource();
}

/** 显示/隐藏独立 tag 接口配置，并更新分组提示 */
function syncTagSource() {
    const cfg = getSettings();
    const box = document.querySelector('#si_tag_ext_box');
    if (box) box.classList.toggle('si-hidden', cfg.tagSource !== 'external');
    const hint = document.querySelector('#si_tag_hint');
    if (hint) hint.textContent = cfg.tagSource === 'external' ? '独立接口' : '酒馆模型';
}

function bindUI() {
    const cfg = getSettings();
    // 面板现已直接挂在 body 上，控件按文档级查找
    if (!document.getElementById('si-panel')) return;

    syncFormToUI();

    for (const [sel, prop, key, cast] of FIELDS) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const handler = () => {
            getSettings()[key] = cast(el[prop]);
            save();
        };
        // 同时听 input 与 change：输入时即时保存，
        // 也能覆盖粘贴/自动填充后仅触发 change 的情况
        if (prop === 'checked' || el.tagName === 'SELECT') {
            el.addEventListener('change', handler);
        } else {
            el.addEventListener('input', handler);
            el.addEventListener('change', handler);
        }
    }

    document.querySelector('#si_draw')?.addEventListener('click', () => {
        togglePanel(false);
        runGeneration({});
    });

    document.querySelector('#si_close')?.addEventListener('click', () => togglePanel(false));

    document.querySelector('#si_test')?.addEventListener('click', testConnection);

    document.querySelector('#si_tag_source')?.addEventListener('change', () => {
        syncTagSource();
        save();
    });

    document.querySelector('#si_test_tag')?.addEventListener('click', testTagConnection);
    document.querySelector('#si_diagnose')?.addEventListener('click', runDiagnose);

    document.querySelector('#si_preview_prompt')?.addEventListener('click', () => {
        previewPrompt();
    });

    document.querySelector('#si_remember_char')?.addEventListener('click', () => {
        const c = getContext();
        const key = String(c.characterId ?? c.name2 ?? 'unknown');
        const v = String(document.querySelector('#si_char_appearance')?.value || '').trim();
        const s = getSettings();
        s.charProfiles[key] = { name: c.name2 || '', appearance: v };
        s.charAppearance = v;
        save();
        toast('success', `已记住「${c.name2 || key}」的外观`);
    });

    // 拖动面板标题栏
    const panel = document.getElementById('si-panel');
    const handle = document.querySelector('#si-panel .si-head');
    if (panel && handle) {
        let drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button')) return;
            drag = true; sx = e.clientX; sy = e.clientY;
            const r = panel.getBoundingClientRect();
            ox = r.left; oy = r.top;
            try { handle.setPointerCapture?.(e.pointerId); } catch { /* 同上 */ }
        });
        handle.addEventListener('pointermove', (e) => {
            if (!drag) return;
            panel.style.left = `${Math.min(Math.max(0, ox + e.clientX - sx), window.innerWidth - panel.offsetWidth)}px`;
            panel.style.top = `${Math.min(Math.max(0, oy + e.clientY - sy), window.innerHeight - 60)}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        });
        handle.addEventListener('pointerup', (e) => {
            drag = false;
            try { handle.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
        });
    }

    applyCharProfile();

    // 恢复开合状态
    if (getSettings().panelOpen) togglePanel(true);
}

function applyCharProfile() {
    const s = getSettings();
    const c = getContext();
    const key = String(c.characterId ?? c.name2 ?? '');
    if (!key) return;
    s.charAppearance = s.charProfiles?.[key]?.appearance || '';
    save();
    const el = document.getElementById('si_char_appearance');
    if (el) el.value = s.charAppearance;
}

async function previewPrompt() {
    const cfg = getSettings();
    const text = lastAiMessageText();
    if (!text) { toast('warning', '没有可用文本，先聊一句'); return; }
    const box = document.getElementById('si-prompt-preview');
    try {
        const built = await buildPrompt({ cfg, narrative: text, context: getContext() });
        if (box) {
            const src = built.usedAI
                ? (cfg.tagSource === 'external' ? '独立 tag 接口' : '酒馆模型')
                : '本地抽取';
            const warn = built.debug?.fallback
                ? `<div class="si-pv-warn">${esc(built.debug.fallback)}</div>`
                : '';
            box.innerHTML = `<div class="si-pv-title">正向（来源：${src}）</div>
              <div class="si-pv-body">${esc(built.positive)}</div>
              ${warn}
              <div class="si-pv-title">负向</div>
              <div class="si-pv-body">${esc(built.negative || '（空）')}</div>`;
            box.classList.remove('si-hidden');
        }
    } catch (e) {
        toast('error', `预览失败：${e?.message || e}`);
        if (box) {
            box.innerHTML = `<div class="si-error">${esc(e?.message || String(e))}</div>`;
            box.classList.remove('si-hidden');
        }
    }
}

async function testConnection() {
    const cfg = getSettings();
    if (!cfg.apiKey) { toast('error', '先填 Token'); return; }
    const base = String(cfg.url || '').replace(/\/+$/, '').replace(/\/ai\/generate-image$/, '');
    try {
        const res = await fetch(`${base}/user/subscription`, {
            headers: { Authorization: `Bearer ${cfg.apiKey}` },
        });
        if (res.status === 401) { toast('error', 'Token 无效或已过期'); return; }
        if (!res.ok) { toast('warning', `接口可达，但返回 HTTP ${res.status}（部分中转不支持该探测）`); return; }
        const j = await res.json().catch(() => ({}));
        const tier = j?.tier ?? '未知';
        toast('success', `连接成功，订阅等级：${tier}`);
    } catch (e) {
        toast('error', `连不上：${e?.message || e}`);
    }
}

/**
 * 诊断：发一个最小请求，把请求体与响应原样打出来。
 * 用于判断 503 到底是参数问题还是中转限制。
 */
async function runDiagnose() {
    const cfg = getSettings();
    const box = document.getElementById('si-diag');
    const show = (html) => {
        if (!box) return;
        box.innerHTML = html;
        box.classList.remove('si-hidden');
    };

    if (!cfg.apiKey) { toast('error', '先填密钥'); return; }

    const lines = [];
    const add = (t, v, cls = '') => lines.push(
        `<div class="si-pv-title">${esc(t)}</div><div class="si-pv-body ${cls}">${esc(String(v))}</div>`);

    // 1) 先探测 /v1/models，确认鉴权与可用模型
    let base = String(cfg.url || '').trim().replace(/\/+$/, '');
    try { base = new URL(base).origin; } catch { /* ignore */ }

    show('<div class="si-pv-title">诊断中…</div>');
    try {
        const r = await fetch(`${base}/v1/models`, {
            headers: { Authorization: `Bearer ${cfg.apiKey.trim()}` },
        });
        const txt = await r.text();
        if (r.ok) {
            let names = [];
            try {
                const j = JSON.parse(txt);
                names = (j?.data || []).map(m => m?.id).filter(Boolean);
            } catch { /* ignore */ }
            add('模型列表', r.ok && names.length ? names.join(', ') : '(已连通，未列出模型)');
            if (names.length) {
                const hasNai = names.some(n => /nai|diffusion/i.test(n));
                add('是否含 NovelAI 模型', hasNai ? '是' : '否 —— 请把模型名改成列表里的名字', hasNai ? 'si-diag-ok' : 'si-diag-bad');
            }
        } else {
            add('/v1/models', `HTTP ${r.status} ${txt.slice(0, 200)}`, 'si-diag-bad');
        }
    } catch (e) {
        add('/v1/models', `请求异常：${e?.message || e}`, 'si-diag-bad');
    }

    // 2) 发一次真实生图请求
    const endpoint = (() => {
        try {
            const u = String(cfg.url || '').trim().replace(/\/+$/, '');
            const origin = new URL(u).origin;
            const p = String(cfg.apiPath || '/v1/images/generations').trim();
            return origin + (p.startsWith('/') ? p : '/' + p);
        } catch { return ''; }
    })();

    const payload = {
        model: cfg.model || 'nai-diffusion-4-5-full',
        prompt: '1girl, solo, simple background',
        n: 1,
        size: `${Number(cfg.width) || 832}x${Number(cfg.height) || 1216}`,
        response_format: 'b64_json',
    };

    const t0 = Date.now();
    let status = 0, bodyText = '';
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey.trim()}` },
            body: JSON.stringify(payload),
        });
        status = res.status;
        const buf = await res.arrayBuffer();
        const u8 = new Uint8Array(buf);
        if (u8[0] === 0x89 && u8[1] === 0x50) bodyText = `[PNG 图片 ${buf.byteLength} 字节]`;
        else if (u8[0] === 0xff && u8[1] === 0xd8) bodyText = `[JPEG 图片 ${buf.byteLength} 字节]`;
        else if (u8[0] === 0x50 && u8[1] === 0x4b) bodyText = `[ZIP ${buf.byteLength} 字节]`;
        else bodyText = new TextDecoder().decode(buf).slice(0, 500);
    } catch (e) {
        bodyText = `请求异常：${e?.message || e}`;
    }
    const ms = Date.now() - t0;
    const ok = status === 200 && /PNG|JPEG|ZIP/.test(bodyText);

    add('生图端点', endpoint);
    add(`生图结果`, `HTTP ${status || '—'} · ${ms}ms`, ok ? 'si-diag-ok' : 'si-diag-bad');
    add('响应内容', bodyText || '(空)');
    add('发送的请求体', JSON.stringify(payload), 'si-mono');

    show(lines.join(''));
}

async function testTagConnection() {
    const cfg = getSettings();
    if (cfg.tagSource !== 'external') {
        toast('info', '当前用酒馆模型生成 tag，无需单独测试');
        return;
    }
    const base = String(cfg.tagUrl || '').trim().replace(/\/+$/, '');
    if (!base) { toast('error', '先填 Tag 接口 URL'); return; }
    const endpoint = /\/chat\/completions\/?$/.test(base)
        ? base
        : base.replace(/\/v\d+$/, '') + '/v1/chat/completions';
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(cfg.tagApiKey ? { Authorization: `Bearer ${cfg.tagApiKey}` } : {}),
            },
            body: JSON.stringify({
                model: cfg.tagModel || 'gpt-4o-mini',
                messages: [{ role: 'user', content: 'Say OK' }],
                max_tokens: 5,
            }),
        });
        if (res.status === 401) { toast('error', 'Tag 接口 Key 无效'); return; }
        if (!res.ok) { toast('warning', `Tag 接口返回 HTTP ${res.status}`); return; }
        const j = await res.json().catch(() => ({}));
        const reply = j?.choices?.[0]?.message?.content || '';
        toast('success', `Tag 接口可用，回复：${String(reply).slice(0, 20)}`);
    } catch (e) {
        toast('error', `连不上 Tag 接口：${e?.message || e}`);
    }
}

function showProgress(text) {
    document.querySelector('.si-progress')?.remove();
    const el = document.createElement('div');
    el.className = 'si-progress';
    el.innerHTML = `<span class="si-spin"></span><span class="si-progress-text">${esc(text)}</span>`;
    document.body.appendChild(el);
    return {
        setText(t) { const n = el.querySelector('.si-progress-text'); if (n) n.textContent = t; },
        close() { el.remove(); },
    };
}

function renderPreview(src, prompt) {
    const box = document.getElementById('si-result');
    if (!box) return;
    box.innerHTML = `<img class="si-result-img" src="${esc(src)}" alt="result">
      <div class="si-result-cap">${esc(String(prompt).slice(0, 160))}</div>`;
    box.classList.remove('si-hidden');
    box.querySelector('img')?.addEventListener('click', () => window.open(src, '_blank'));
}

function renderError(msg) {
    const box = document.getElementById('si-result');
    if (!box) return;
    box.innerHTML = `<div class="si-error">${esc(msg)}</div>`;
    box.classList.remove('si-hidden');
}

/* ------------------------------------------------------------------ */
/* 段落内穿插图片                                                      */
/* ------------------------------------------------------------------ */

/**
 * 把图片插到指定消息的第 N 个段落之后。
 * 直接操作 DOM 的 .mes_text，不改动原文与聊天记录，
 * 刷新后图片消失（可重新点按钮），但阅读体验是"图文混排"。
 *
 * @param {number} mesId 消息索引
 * @param {number} paraIndex 段落序号（在 .mes_text 的 <p> 里）
 * @param {string} src 图片地址
 * @param {string} caption 提示词
 */
function insertImageIntoMessage(mesId, paraIndex, src, caption) {
    const mesEl = document.querySelector(`.mes[mesid="${mesId}"]`);
    if (!mesEl) return false;
    const textEl = mesEl.querySelector('.mes_text');
    if (!textEl) return false;

    const fig = document.createElement('figure');
    fig.className = 'si-inline-fig';
    fig.innerHTML = `<img src="${esc(src)}" alt="generated" loading="lazy">
        <figcaption>${esc(String(caption || '').slice(0, 120))}</figcaption>`;
    fig.querySelector('img')?.addEventListener('click', () => window.open(src, '_blank'));

    // 优先按 <p> 段落定位
    const ps = [...textEl.querySelectorAll(':scope > p')];
    if (ps.length > 0) {
        const target = ps[Math.min(paraIndex, ps.length - 1)];
        target.insertAdjacentElement('afterend', fig);
        return true;
    }

    // 退化为按文本节点切分
    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
        if (walker.currentNode.textContent.trim()) nodes.push(walker.currentNode);
    }
    if (nodes.length === 0) {
        textEl.appendChild(fig);
        return true;
    }
    const node = nodes[Math.min(paraIndex, nodes.length - 1)];
    const br = document.createElement('br');
    node.parentNode.insertBefore(br, node.nextSibling);
    node.parentNode.insertBefore(fig, br.nextSibling);
    return true;
}

/** 给一条消息批量生成多张图并穿插 */
async function generateForMessage(mesId, count) {
    const ctx = getContext();
    const msg = ctx.chat?.[Number(mesId)];
    if (!msg) { toast('error', '找不到这条消息'); return; }

    const rawText = String(msg.mes || '');
    const picks = pickKeyParagraphs(rawText, count);
    if (!picks.length) { toast('warning', '这条消息没有可画的段落'); return; }

    const cfg = getSettings();
    toast('info', `已选中 ${picks.length} 个段落，开始生成…`);

    let done = 0;
    for (const pick of picks) {
        try {
            const built = await buildPrompt({ cfg, narrative: pick.text, context: ctx });
            const prog = showProgress(`生成第 ${done + 1}/${picks.length} 张…`);
            try {
                const result = await generate(cfg, built.positive, built.negative);
                let src;
                if (result?.blob) src = await materializeImage(result.blob, ctx.name2 || 'imagegen');
                else if (result?.url) src = result.url;
                else throw new Error('后端未返回图像');

                insertImageIntoMessage(mesId, pick.index, src, built.positive);
                done++;
            } finally {
                prog.close();
            }
        } catch (e) {
            console.error(LOG, `段落 ${pick.index} 生成失败`, e);
            toast('error', `第 ${done + 1} 张失败：${e?.message || e}`);
        }
    }
    if (done > 0) {
        toast('success', `完成，已插入 ${done} 张图`);
        getContext().saveChat?.();
    }
}

/* ------------------------------------------------------------------ */
/* 每楼生图按钮                                                        */
/* ------------------------------------------------------------------ */

/**
 * 给每条 AI 消息注入「生图」按钮。
 * 点击流程：取该楼文本 → tag 生成接口 → 生图接口。
 */
function injectMessageButtons() {
    const chat = document.getElementById('chat');
    if (!chat) return;

    chat.querySelectorAll('.mes').forEach((mesEl) => {
        // 已有按钮就跳过
        if (mesEl.querySelector('.si_mes_gen')) return;

        // 跳过我们自己插入的图片消息
        const isUser = mesEl.getAttribute('is_user') === 'true';
        if (isUser) return;
        if (mesEl.querySelector('.st-imagegen-block, .si-meta')) return;
        // 系统消息（含我们自己插的图）不显示
        if (mesEl.getAttribute('is_system') === 'true') return;

        const wrap = mesEl.querySelector('.extraMesButtons');
        if (!wrap) return;

        const btn = document.createElement('div');
        btn.className = 'mes_button si_mes_gen fa-solid fa-wand-magic-sparkles';
        btn.title = '用这一楼生成图片';
        btn.setAttribute('data-si-mes', '1');
        wrap.insertBefore(btn, wrap.firstChild);
    });
}

/** 从消息元素取干净文本 */
function messageTextOf(mesEl) {
    const textEl = mesEl.querySelector('.mes_text');
    if (!textEl) return '';
    const clone = textEl.cloneNode(true);
    // 移除引用的 reasoning / 图片等
    clone.querySelectorAll('img, .st-imagegen-block, .si-meta, .mes_img_container').forEach(n => n.remove());
    return String(clone.textContent || '').replace(/\s+/g, ' ').trim();
}

function bindMessageButtons() {
    // 事件委托：按钮是动态注入的，必须绑在 document 上
    document.addEventListener('click', async (e) => {
        const btn = e.target?.closest?.('.si_mes_gen');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();

        const mesEl = btn.closest('.mes');
        if (!mesEl) return;

        const text = messageTextOf(mesEl);
        if (!text) {
            toast('warning', '这一楼没有可用的文字');
            return;
        }

        const mesId = mesEl.getAttribute('mesid');
        btn.classList.add('si-loading');
        try {
            const cfg = getSettings();
            if (cfg.insertMode === 'inline') {
                await generateForMessage(mesId, cfg.imagesPerMessage);
            } else {
                await runGeneration({ narrative: text, sourceMessageId: mesId });
            }
        } finally {
            btn.classList.remove('si-loading');
        }
    }, true);

    // 首次注入 + 监听后续渲染（新消息、切换聊天、滑动、编辑）
    try {
        injectMessageButtons();
    } catch (e) {
        console.warn(LOG, '注入楼层按钮失败', e);
    }

    const chat = document.getElementById('chat');
    // MutationObserver 在部分 WebView 里可能缺失，绝不能让它中断初始化
    const MO = globalThis.MutationObserver || globalThis.window?.MutationObserver;
    if (chat && typeof MO === 'function') {
        try {
            let scheduled = false;
            const obs = new MO(() => {
                if (scheduled) return;
                scheduled = true;
                setTimeout(() => { scheduled = false; try { injectMessageButtons(); } catch { /* ignore */ } }, 60);
            });
            obs.observe(chat, { childList: true, subtree: true });
        } catch (e) {
            console.warn(LOG, 'MutationObserver 启动失败，改用定时补偿', e);
        }
    }
    // 兜底：定时补偿（覆盖没有 MO 或 MO 失效的环境）
    if (!globalThis.__siBtnTimer) {
        globalThis.__siBtnTimer = setInterval(() => {
            try { injectMessageButtons(); } catch { /* ignore */ }
        }, 1500);
    }
}

/* ------------------------------------------------------------------ */
/* 自动出图                                                            */
/* ------------------------------------------------------------------ */

function shouldAutoGenerate(text) {
    const cfg = getSettings();
    if (!cfg.enabled || cfg.autoMode === 'off') return false;
    if (cfg.autoMode === 'interval') {
        cfg.counter = (cfg.counter || 0) + 1;
        save();
        if (cfg.counter >= Math.max(1, Number(cfg.autoEvery) || 4)) { cfg.counter = 0; return true; }
        return false;
    }
    if (cfg.autoMode === 'keyword') {
        const words = String(cfg.autoKeywords || '').split(/[,，\n]/).map(w => w.trim()).filter(Boolean);
        return words.some(w => String(text || '').includes(w));
    }
    return false;
}

async function onMessageReceived(messageId, type) {
    if (busy || selfInserting) return;
    if (type === 'extension' || type === 'imagegen') return;
    const cfg = getSettings();
    if (!cfg.enabled || cfg.autoMode === 'off') return;

    const ctx = getContext();
    const msg = Array.isArray(ctx.chat) ? ctx.chat[Number(messageId)] : null;
    let text = '';
    if (msg && !msg.is_user && !msg.is_system) {
        text = String(msg.mes || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (!text) text = lastAiMessageText();
    if (!text) return;
    if (!shouldAutoGenerate(text)) return;
    await runGeneration({ narrative: text, silent: true });
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */

function registerCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'img',
        callback: async (_a, value) => {
            const v = String(value ?? '').trim();
            await runGeneration(v ? { override: v } : {});
            return '';
        },
        returns: '生成一张图像',
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: '可选：直接指定提示词（英文自然语言或 tag 都行）',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
        })],
        helpString: '生成图像并插入聊天。<br />例：<code>/img</code> 或 <code>/img 1girl, library, candlelight</code>',
    }));
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function init() {
    getSettings();
    await showPanel();
    buildBall();
    registerCommands();
    bindMessageButtons();

    // 多一条关闭途径：Esc 键
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const p = document.getElementById('si-panel');
            if (p && !p.classList.contains('si-hidden')) {
                togglePanel(false);
                e.stopPropagation();
            }
        }
    }, true);

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        applyCharProfile();
        getSettings().counter = 0;
        save();
        // 切聊天后 DOM 重建，需要重新注入按钮
        setTimeout(() => injectMessageButtons(), 300);
    });

    console.log(LOG, '已加载（NovelAI 后端），点右下角悬浮球打开面板');
}

jQuery(async () => { await init(); });

export { runGeneration };
