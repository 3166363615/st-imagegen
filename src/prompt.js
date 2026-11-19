/**
 * 提示词构建（面向 NovelAI V4.5）
 *
 * V4.5 官方文档明确写了支持 natural language understanding，
 * 但它同时被 danbooru tag 训练过，两者混用时：
 *   - 纯长句 → 语义能懂，但构图/服装细节常丢
 *   - 纯 tag → 准确但僵硬
 * 最佳实践是「自然语言打底 + 关键 tag 兜底」。
 * 这里提供三种模式，默认用混合。
 */

export const PROMPT_MODES = {
    hybrid: '混合（自然语言 + 关键 tag）推荐',
    natural: '纯自然语言',
    tags: '纯 Danbooru tag',
};

export const STYLES = {
    none: { label: '不追加', positive: '', negative: '' },
    anime: {
        label: '动漫 / 赛璐璐',
        positive: 'anime coloring, cel shading, clean lineart, detailed eyes, beautiful lighting',
        negative: 'photorealistic, 3d render, photo',
    },
    soft: {
        label: '柔和插画',
        positive: 'soft lighting, pastel colors, watercolor texture, delicate lineart, gentle shading',
        negative: 'harsh shadows, high contrast, 3d render',
    },
    vivid: {
        label: '浓彩厚涂',
        positive: 'digital painting, painterly, rich colors, dramatic lighting, intricate details',
        negative: 'flat color, low saturation, sketch',
    },
    realistic: {
        label: '写实',
        positive: 'photorealistic, film photography, 85mm lens, natural skin texture, shallow depth of field',
        negative: 'anime, cartoon, illustration, cel shading, 3d render',
    },
    ink: {
        label: '国风水墨',
        positive: 'chinese ink painting, sumi-e, flowing brush strokes, rice paper texture, negative space',
        negative: 'photo, 3d render, western comic',
    },
    dark: {
        label: '暗黑氛围',
        positive: 'dark atmosphere, moody lighting, chiaroscuro, low key, cinematic shadows',
        negative: 'bright, cheerful, pastel',
    },
};

/* ------------------------------------------------------------------ */
/* 成人向组合（强制注入）                                                */
/* ------------------------------------------------------------------ */

/** NovelAI 常见质量 tag，qualityToggle 打开时官方会自动加，这里仅作兜底 */
export const NAI_QUALITY_TAGS = 'best quality, amazing quality, very aesthetic, absurdres';

/**
 * 成人向强化：把"露骨但合规"的描述词补进去，让画面真正到位。
 * 注意：这是提示词层面的强化，不是绕过模型安全分类；
 * V4.5 Curated 本身会拒绝敏感内容，需要用 Full 模型。
 */
export const ADULT_BOOST = {
    off: { label: '关闭', positive: '', negative: '' },
    mild: {
        label: '轻（暧昧/暗示）',
        positive: 'seductive pose, half-lidded eyes, parted lips, flushed cheeks, revealing clothes, cleavage',
        negative: 'child, loli, shota, chibi, extra limbs',
    },
    explicit: {
        label: '强（成人向，露骨）',
        positive:
            'explicit, uncensored, nsfw, nude, ' +
            'detailed anatomy, detailed skin, nipples, areola, mature female, adult',
        negative:
            'child, loli, shota, chibi, toddler, kid, teen, underage, ' +
            'censored, mosaic censoring, bar censor, ' +
            'extra limbs, bad anatomy, deformed, fused fingers',
    },
    hardcore: {
        label: '极强（硬核性行为）',
        positive:
            'explicit, uncensored, nsfw, hardcore, sex, intercourse, ' +
            'nude, completely nude, spread legs, pussy, penis, ' +
            'detailed anatomy, detailed skin, nipples, areola, mature female, adult',
        negative:
            'child, loli, shota, chibi, toddler, kid, teen, underage, ' +
            'censored, mosaic censoring, bar censor, ' +
            'extra limbs, bad anatomy, deformed, fused fingers, ' +
            'gore, guro, amputee',
    },
};

/**
 * NovelAI 官方负面预设（ucPreset）
 * 0=Heavy 1=Light 2=Human Focus 3=None
 */
export const UC_PRESETS = {
    0: '重（推荐，抑制崩坏）',
    1: '轻',
    2: '人像优先',
    3: '不预设',
};

/* ------------------------------------------------------------------ */
/* 本地启发式：把叙事压成可画的内容                                       */
/* ------------------------------------------------------------------ */

/**
 * 去掉对白，保留动作与场景。
 * 对话不是画面，但动作描写是。
 */
export function localExtract(text) {
    const raw = String(text || '');

    let s = raw;
    s = s.replace(/<[^>]*>/g, ' ');                        // HTML 标签
    s = s.replace(/\{\{[^}]*\}\}/g, ' ');                  // {{user}} 宏
    s = s.replace(/\[[^\]]{0,3}\]/g, ' ');                 // [1] 脚注
    // 对白整体剔除
    s = s.replace(/"[^"]*"/g, ' ')
         .replace(/“[^”]*”/g, ' ')
         .replace(/「[^」]*」/g, ' ')
         .replace(/『[^』]*』/g, ' ');
    // 动作/旁白：保留内容，只去掉 * 与括号
    s = s.replace(/\*+/g, ' ');
    s = s.replace(/[（(]([^）)]*)[）)]/g, ' $1 ');
    s = s.replace(/\s*[,，]\s*[,，]+/g, '，');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^[,，、\s]+|[,，、\s]+$/g, '');

    if (!s) {
        // 整段都是对白：退化为去掉符号，保留文字
        s = raw.replace(/[\s*"“”「」『』（）()]+/g, ' ').trim();
    }
    return s.slice(0, 600);
}

/**
 * 中→英的常见画面词映射。
 * 本地兜底用：不做完整翻译，只把高频名词/形容词替换成 danbooru 词，
 * 这样即使没开 AI 润色也能出个八九不离十的画面。
 */
const ZH_MAP = [
    [/(长|及腰)发/g, 'long hair'], [/短发/g, 'short hair'], [/双马尾/g, 'twintails'],
    [/马尾/g, 'ponytail'], [/辫子/g, 'braid'], [/卷发/g, 'curly hair'],
    [/银发|白发/g, 'silver hair'], [/黑发/g, 'black hair'], [/金发/g, 'blonde hair'],
    [/红发/g, 'red hair'], [/蓝发/g, 'blue hair'], [/粉发/g, 'pink hair'],
    [/红眼|血瞳/g, 'red eyes'], [/蓝眼/g, 'blue eyes'], [/绿眼/g, 'green eyes'],
    [/金眼|黄眼/g, 'yellow eyes'], [/紫眼/g, 'purple eyes'],
    [/女仆/g, 'maid'], [/护士/g, 'nurse'], [/和服|浴衣/g, 'kimono'],
    [/旗袍/g, 'cheongsam'], [/校服/g, 'school uniform'], [/西装/g, 'suit'],
    [/风衣|长外套/g, 'long coat'], [/裙子/g, 'skirt'], [/连衣裙/g, 'dress'],
    [/丝袜|长筒袜/g, 'thighhighs'], [/内衣/g, 'underwear'], [/裸体|全裸/g, 'nude'],
    [/微笑/g, 'smile'], [/哭|泪/g, 'tears'], [/害羞|脸红/g, 'blush'],
    [/生气/g, 'angry'], [/惊讶/g, 'surprised'], [/闭眼/g, 'closed eyes'],
    [/坐/g, 'sitting'], [/站/g, 'standing'], [/躺|卧/g, 'lying'],
    [/跪/g, 'kneeling'], [/抱/g, 'hug'], [/牵手/g, 'holding hands'],
    [/接吻|亲吻/g, 'kiss'], [/低头/g, 'looking down'], [/回头/g, 'looking back'],
    [/森林/g, 'forest'], [/房间|卧室/g, 'bedroom'], [/教室/g, 'classroom'],
    [/街道|街/g, 'street'], [/海边|海滩/g, 'beach'], [/花园/g, 'garden'],
    [/酒馆|酒吧/g, 'tavern'], [/图书馆/g, 'library'], [/浴室/g, 'bathroom'],
    [/床/g, 'bed'], [/窗/g, 'window'], [/雨/g, 'rain'], [/雪/g, 'snow'],
    [/夜/g, 'night'], [/黄昏|傍晚/g, 'dusk'], [/清晨|早晨/g, 'morning'],
    [/烛光|烛/g, 'candlelight'], [/月光/g, 'moonlight'], [/霓虹/g, 'neon lights'],
    [/少女|女孩/g, '1girl'], [/男孩/g, '1boy'], [/男人/g, '1boy'],
    [/女人/g, '1girl'], [/两人|二人/g, '2girls'],
    // 补：体态/表情/场景细节
    [/瘫软|瘫坐|无力/g, 'slumped'], [/颤抖|发抖|哆嗦/g, 'trembling'],
    [/喘息|喘/g, 'panting'], [/呜咽|啜泣/g, 'sobbing'],
    [/抬头|仰起头/g, 'head tilted back'], [/俯身|弯腰/g, 'leaning forward'],
    [/跪坐|跪着|双膝/g, 'kneeling'], [/地毯/g, 'carpet'],
    [/地板/g, 'floor'], [/墙/g, 'wall'],
    [/锁骨/g, 'collarbone'], [/下巴|下颌/g, 'chin'],
    [/额头/g, 'forehead'], [/舌头|舌/g, 'tongue'],
    [/嘴唇|唇/g, 'lips'], [/牙齿|齿/g, 'teeth'],
    [/湿润|水雾|泪眼/g, 'teary eyes'], [/凌乱|散乱/g, 'disheveled'],
    [/阴影/g, 'shadow'], [/倒影/g, 'reflection'],
    [/俯视|从上往下/g, 'from above'], [/特写/g, 'close-up'],
    [/背影/g, 'from behind'], [/侧脸/g, 'profile'],
    [/走廊/g, 'hallway'], [/楼梯|台阶/g, 'stairs'],
    [/门/g, 'door'], [/沙发/g, 'sofa'], [/桌子|桌/g, 'table'],
    [/书/g, 'book'], [/杯/g, 'cup'], [/酒/g, 'wine'],
    [/紫|紫水晶/g, 'purple'], [/黑发|黑/g, 'black hair'],
];

/** 去掉所有非 ASCII 字符（中文、emoji、全角标点），并清理孤立符号 */
export function stripNonAscii(text) {
    let s = String(text || '');
    // 全角标点转半角逗号，保留分隔语义
    s = s.replace(/[，、；：]/g, ', ');
    s = s.replace(/[。！？…]/g, '. ');
    // 删除其余非 ASCII
    s = s.replace(/[^\x00-\x7F]/g, ' ');
    s = s.replace(/\s*,\s*/g, ', ');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^[,\s.]+|[,\s.]+$/g, '');
    // 清理连续标点、空 tag、重复项
    const seen = new Set();
    const tags = [];
    for (const raw of s.split(',')) {
        const t = raw.replace(/[^\w\s'-]/g, '').trim();
        if (t.length < 2) continue;
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push(t);
    }
    return tags.join(', ');
}

export function zhToTags(text) {
    let s = String(text || '');
    const found = [];
    // 逐条匹配：命中的 tag 收集起来（去重、保持首次出现顺序）
    for (const [re, tag] of ZH_MAP) {
        const copy = new RegExp(re.source, re.flags.replace('g', ''));
        if (copy.test(s)) {
            for (const part of String(tag).split(',')) {
                const t = part.trim();
                if (t) found.push(t);
            }
        }
        s = s.replace(re, ' ');
    }
    // 英文原文里已有的关键词也保留
    const eng = s.replace(/[^\x00-\x7F]/g, ' ')
        .replace(/[^\w\s'-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2)
        .filter(w => /^[a-z][a-z-]*$/i.test(w));

    const seen = new Set();
    const out = [];
    for (const t of [...found, ...eng]) {
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(t);
    }
    return out.join(', ');
}

/** 判断是否主要是中文 */
export function isMostlyChinese(text) {
    const s = String(text || '');
    const zh = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    return zh > 0 && zh / Math.max(s.length, 1) > 0.2;
}

/* ------------------------------------------------------------------ */
/* 拒绝话术识别（关键：拒绝话术绝不能当提示词用）                        */
/* ------------------------------------------------------------------ */

const REFUSAL_PATTERNS = [
    /i'?m (just |only )?an? (ai|language model|assistant)/i,
    /i am (just |only )?an? (ai|language model|assistant)/i,
    /i can'?t (help|assist|comply|do that|create|generate)/i,
    /i cannot (help|assist|comply|create|generate|provide)/i,
    /i (won'?t|will not) (be able to|help|create|generate|provide)/i,
    /(can'?t|cannot|unable to) (help|assist) with (that|this)/i,
    /against my (guidelines|policy|policies|programming|principles)/i,
    /(may|might|could) go against my/i,
    /violates? (my|the) (policy|policies|guidelines|terms)/i,
    /not (able|allowed) to (help|assist|create|generate)/i,
    /as an ai\b/i,
    /i'?m sorry,? but i/i,
    /抱歉[，,]?\s*(我|作为)/,
    /我(无法|不能|没办法)(协助|提供|帮助|生成)/,
    /(违反|不符合).{0,8}(政策|准则|规范)/,
    /gemini\.google\/policy/i,
    /openai\.com\/policies/i,
];

/** 是否是拒绝话术 */
export function isRefusal(text) {
    const s = String(text || '');
    if (!s.trim()) return false;
    return REFUSAL_PATTERNS.some(re => re.test(s));
}

/**
 * 是否像有效提示词。
 * 拒绝话术、纯链接、过短内容一律判否。
 */
export function looksLikePrompt(text) {
    const s = String(text || '').trim();
    if (!s || s.length < 3) return false;
    if (isRefusal(s)) return false;
    if (/^https?:\/\//i.test(s)) return false;
    const commas = (s.match(/,/g) || []).length;
    if (commas >= 2) return true;
    return /\b(girl|boy|woman|man|hair|eyes|dress|coat|room|street|light|sitting|standing|looking|bed|window)\b/i.test(s);
}

/* ------------------------------------------------------------------ */
/* AI 润色：让模型输出"自然语言 + tag"                                  */
/* ------------------------------------------------------------------ */

function buildQuietInstruction(mode, styleKey, extraHint, adultKey) {
    const style = STYLES[styleKey] || STYLES.none;
    const adult = ADULT_BOOST[adultKey] || ADULT_BOOST.off;

    // 关键：示例必须中性且与场景无关，否则模型会照抄示例里的词
    // （之前示例写死了"silver-haired woman by window"，导致每张图都是同一个人）
    const base = [
        'Task: convert the text below into an image prompt.',
        'Read ONLY the given text. Describe ONLY what that text says.',
        '',
        'Hard rules:',
        '1. English only. Never output Chinese characters.',
        '2. Capture the SUBJECT, their POSE, CLOTHING, EXPRESSION, what body parts are visible,',
        '   the SETTING, and the LIGHTING — exactly as the text describes them.',
        '3. If the text describes a sexual act, describe that act explicitly and literally.',
        '4. Drop dialogue, inner monologue, and quotation marks.',
        '5. Do NOT invent a different person, outfit, or location. Only use what is in the text.',
        '6. Output ONE line. No markdown, no quotes, no explanation, no refusal.',
    ];

    let shape;
    if (mode === 'tags') {
        shape = [
            '',
            'Format: comma-separated danbooru tags. Order: subject count, hair, eyes, expression,',
            'clothing/state of undress, pose/action, body parts in focus, setting, lighting, camera.',
            'Write only tags that match the given text.',
        ];
    } else if (mode === 'natural') {
        shape = [
            '',
            'Format: 2-4 English sentences describing that exact scene cinematically.',
            'Mention who, doing what, where, and how it is lit.',
        ];
    } else {
        shape = [
            '',
            'Format: one short English sentence of the scene, then a comma-separated tag list.',
            'Both parts must describe the same scene from the given text.',
        ];
    }

    const styleLine = style.positive ? ['', `Art style (visual only, not content): ${style.positive}.`] : [];
    // 成人词只作为"画风补充"，不能让模型以为要改成别的场景
    const adultLine = adult.positive
        ? ['', `Also append these quality/explicitness tags at the end: ${adult.positive}.`]
        : [];
    const hint = extraHint ? ['', `Extra requirement: ${extraHint}.`] : [];

    return [...base, ...shape, ...styleLine, ...adultLine, ...hint].join('\n');
}

/** 清洗模型输出：去代码块、去前缀、压缩空白 */
export function cleanModelOutput(raw) {
    let out = String(raw || '');
    out = out.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
    out = out.replace(/^\s+|\s+$/g, '');          // 先剥掉围栏残留的首尾空白/换行
    out = out.replace(/^\s*(prompt|image prompt|tags)\s*[:：]\s*/i, '');
    out = out.replace(/^["'`]+|["'`]+$/g, '');
    out = out.replace(/\s*\n+\s*/g, ', ');
    out = out.replace(/\s+/g, ' ').trim();
    out = out.replace(/\s*,\s*,+/g, ', ');
    return out;
}

export async function aiCondense(context, narrative, opts) {
    const { mode, style, extraHint, adult } = opts;
    const quietPrompt = [
        buildQuietInstruction(mode, style, extraHint, adult),
        '',
        'Narration:',
        narrative,
    ].join('\n');

    const raw = await context.generateQuietPrompt({
        quietPrompt,
        quietName: 'image-prompt',
        responseLength: 300,
        trimToSentence: false,
    });

    if (!raw || typeof raw !== 'string') throw new Error('模型未返回提示词');

    const out = cleanModelOutput(raw);
    if (!out) throw new Error('模型返回空提示词');

    // 关键防线：拒绝话术绝不能当提示词用。
    // 一旦送去生图，会把"I'm just a language model..."画进图里，且浪费额度。
    if (isRefusal(out)) {
        throw new Error('模型拒绝了这段内容（未生成 tag），已放弃本次，请改用「本地抽取」或换模型');
    }
    if (!looksLikePrompt(out)) {
        throw new Error('模型没有返回有效提示词，已放弃本次');
    }

    return out.slice(0, 1200);
}

/* ------------------------------------------------------------------ */
/* 组装                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {object} opts
 * @param {object} opts.cfg 插件设置
 * @param {string} opts.narrative 叙事原文
 * @param {object} [opts.context] 酒馆 context（用于 AI 润色）
 * @returns {Promise<{positive:string, negative:string, usedAI:boolean, debug:object}>}
 */
/**
 * 判断场景是否"涉及身体/亲密"。
 * 没有信号就不注入成人 tag —— 否则会把普通场景画成不合场景的图。
 */
const ADULT_SIGNALS = /\b(nude|naked|nakedness|breasts?|nipples?|areola|pussy|penis|cum|semen|sex|intercourse|orgasm|climax|moan|moans|moaned|moaning|fuck|fucking|aroused|arousal|horny|lewd|fondle|fondling|grope|undress|undressed|strip|stripped|lingerie|underwear|panties|bra|thighs|ass|butt|cleavage|seduce|seductive|kiss|kissing|lick|licking|suck|sucking|crotch|navel|bare skin|topless|bottomless|spread legs|missionary|doggy|cowgirl|oral)\b/i;
const ZH_ADULT_SIGNALS = /裸|露乳|乳房|乳首|乳头|下体|私处|阴|性交|做爱|交合|插入|高潮|喘息|呻吟|爱抚|抚摸|脱|内裤|胸罩|屁股|臀|大腿|淫|色情|情色|亲吻|舔|含住|吮/;

export function sceneWantsAdult(text) {
    const t = String(text || '');
    if (!t.trim()) return false;
    return ADULT_SIGNALS.test(t) || ZH_ADULT_SIGNALS.test(t);
}

/**
 * 调用 tag 生成接口，把一段正文转成英文提示词。
 * 支持两种来源：酒馆当前模型 / 独立 OpenAI 兼容 chat 接口。
 */
export async function generateTags({ narrative, tagCfg, context }) {
    const mode = tagCfg.mode || 'hybrid';
    const style = tagCfg.style || 'anime';
    const extraHint = tagCfg.extraHint || '';
    const adult = tagCfg.adultBoost || 'off';

    const instruction = buildQuietInstruction(mode, style, extraHint, adult);
    const userContent = `${instruction}\n\nText:\n${narrative}`;

    let raw = '';

    if (tagCfg.source === 'external') {
        const base = String(tagCfg.url || '').trim().replace(/\/+$/, '');
        if (!base) throw new Error('tag 接口未填写 URL');
        const endpoint = /\/chat\/completions\/?$/.test(base)
            ? base
            : base.replace(/\/v\d+$/, '') + '/v1/chat/completions';

        const headers = { 'Content-Type': 'application/json' };
        if (tagCfg.apiKey) headers.Authorization = `Bearer ${tagCfg.apiKey}`;

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 90000);
        let res;
        try {
            res = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: tagCfg.model || 'gpt-4o-mini',
                    messages: [
                        { role: 'system', content: 'You convert narration into image prompts. Output one line only. Never refuse.' },
                        { role: 'user', content: userContent },
                    ],
                    temperature: 0.5,
                    max_tokens: 400,
                }),
                signal: ctrl.signal,
            });
        } catch (e) {
            throw new Error(e?.name === 'AbortError' ? 'tag 接口超时' : `连不上 tag 接口：${e?.message || e}`);
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`tag 接口 HTTP ${res.status} ${t.slice(0, 160)}`);
        }
        const json = await res.json();
        raw = json?.choices?.[0]?.message?.content || '';
    } else {
        if (!context?.generateQuietPrompt) throw new Error('当前酒馆不支持 generateQuietPrompt');
        raw = await context.generateQuietPrompt({
            quietPrompt: userContent,
            quietName: 'image-tags',
            responseLength: 300,
            trimToSentence: false,
        });
    }

    if (!raw || typeof raw !== 'string') throw new Error('tag 接口未返回内容');

    const out = cleanModelOutput(raw);
    if (!out) throw new Error('tag 接口返回空内容');
    if (isRefusal(out)) throw new Error('模型拒绝了这段内容（未生成 tag）');
    if (!looksLikePrompt(out)) throw new Error('模型没有返回有效 tag');
    return out.slice(0, 1200);
}

export async function buildPrompt({ cfg, narrative, context }) {
    const mode = cfg.promptMode || 'hybrid';
    const style = STYLES[cfg.style] || STYLES.none;
    const adult = ADULT_BOOST[cfg.adultBoost] || ADULT_BOOST.off;

    let core = '';
    let usedAI = false;
    const debug = { mode, fallback: null };

    // 1) 通过独立的 tag 生成接口把叙事转成英文提示词
    if (cfg.useAI) {
        try {
            core = await generateTags({
                narrative,
                tagCfg: {
                    source: cfg.tagSource || 'tavern',
                    url: cfg.tagUrl,
                    apiKey: cfg.tagApiKey,
                    model: cfg.tagModel,
                    mode: cfg.promptMode,
                    style: cfg.style,
                    extraHint: cfg.extraHint,
                    adultBoost: cfg.adultBoost,
                },
                context,
            });
            usedAI = true;
        } catch (e) {
            debug.fallback = `${e?.message || e}`;
            console.warn('[st-imagegen] tag 生成失败：', debug.fallback, '→ 回退本地抽取');
        }
    }

    // 2) 本地兜底（仅在明确允许时）：
    //    词表映射很容易产出与正文无关的词（如正文是口交却画出 maid/sitting），
    //    所以默认不启用，宁可报错也不给错图。
    if (!core && cfg.allowLocalFallback) {
        let s = localExtract(narrative);
        s = zhToTags(s);
        s = stripNonAscii(s);
        core = s.trim();
        debug.usedLocal = !!core;
    }
    if (!core) {
        debug.fallback = debug.fallback
            ? `${debug.fallback}；已放弃本地兜底（词表容易走偏）`
            : '未生成提示词：请在「Tag 生成接口」里开启 AI 生成';
        // 抛错，避免用无意义的词去生图
        const err = new Error('无法根据正文生成提示词，请开启 AI 生成 tag 或检查 Tag 接口');
        err.noPrompt = true;
        throw err;
    }

    // 3) 拼装
    const parts = [];
    if (cfg.stylePrefix?.trim()) parts.push(cfg.stylePrefix.trim());
    if (cfg.charAppearance?.trim()) parts.push(cfg.charAppearance.trim());
    if (core) parts.push(core);
    if (style.positive) parts.push(style.positive);
    if (cfg.naiQualityTags && mode === 'tags') parts.push(NAI_QUALITY_TAGS);
    if (cfg.extraHint?.trim() && !cfg.useAI) parts.push(cfg.extraHint.trim());

    // 成人向强化：用【原始叙事】判定（core 已被清洗成英文，会丢失中文信号）
    if (adult.positive && sceneWantsAdult(String(narrative || ''))) {
        parts.push(adult.positive);
    }

    // 合并后去重（角色外观与模型输出常重复同一 tag，如 1girl）
    const merged = parts.filter(Boolean).join(', ')
        .replace(/\s*[,，]\s*[,，]+/g, ', ')
        .replace(/\s+/g, ' ')
        .trim();
    const seen = new Set();
    const positive = merged.split(',').map(t => t.trim()).filter(Boolean).filter((t) => {
        const k = t.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    }).join(', ');

    const negParts = [];
    if (cfg.naiUC) negParts.push(cfg.naiUC);          // 官方 ucPreset 的文本版
    if (cfg.negative?.trim()) negParts.push(cfg.negative.trim());
    if (style.negative) negParts.push(style.negative);
    if (adult.negative) negParts.push(adult.negative);

    const negative = negParts.filter(Boolean).join(', ')
        .replace(/\s*,\s*,+/g, ', ')
        .trim();

    return { positive, negative, usedAI, debug };
}
