/**
 * 段落切分与"精彩段落"智能选取。
 * 目标：把一条长回复切成若干段落，挑出最值得配图的几段，做到正文中间穿插。
 */

/** 段落分隔：空行、多个换行 */
export function splitParagraphs(text) {
    const raw = String(text || '');
    return raw
        .split(/\n\s*\n+|\r\n\s*\r\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 0);
}

/** 判断段落是否可画（排除纯对白、纯系统行、时间戳行） */
export function isPaintable(paragraph) {
    const p = String(paragraph || '').trim();
    if (p.length < 30) return false;

    // 去掉引用/斜体/加粗标记后看实质内容
    const bare = p.replace(/^[>*\-\s]+/, '').replace(/[*_`]/g, '').trim();
    if (bare.length < 30) return false;

    // 时间戳/标题行：必须在长度检查之前用"整行结构"判断
    // 如『Monday - 2050 - 5 - 4 - 18:22 - Tokyo / Minato - Sunny』
    if (/^[『「\[【]/.test(bare) && /[』」\]】]$/.test(bare)) {
        const inner = bare.replace(/^[『「\[【]|[』」\]】]$/g, '');
        // 括号内是纯元信息（多段短横/冒号分隔、无句号），不画
        if (/[-–—:]/.test(inner) && !/[。！？.!?]/.test(inner)) return false;
    }
    if (/^\d{1,2}:\d{2}/.test(bare)) return false;
    // 形如 "Monday - 2050 - 5 - 4 ..." 的裸标题行
    if (/^[A-Za-z]+\s*[-–—]\s*\d{4}/.test(bare) && bare.length < 120) return false;

    // 纯对白段（整段被引号包裹且无叙述）
    const quotes = (bare.match(/[「『“"]/g) || []).length;
    const narrChars = bare.replace(/[「」『』“”"]/g, '').length;
    if (quotes > 0 && narrChars < bare.length * 0.55) return false;

    // 至少要有一定比例的实词（非纯符号）
    const solid = (bare.match(/[\u4e00-\u9fff\w]/g) || []).length;
    if (solid / Math.max(bare.length, 1) < 0.5) return false;

    return true;
}

/** 画面信号词：出现越多越"值得画" */
const VISUAL_SIGNALS = [
    // 场景
    /窗|门外|房间|卧室|床|地毯|沙发|浴室|走廊|楼梯|街|雨|雪|夜|黄昏|清晨|烛|月光|霓虹|灯|火|雾|庭院|森林|海|餐厅|酒馆|图书馆|教室|办公室|车里|阳台上/g,
    /window|room|bed|street|rain|snow|night|candle|neon|forest|beach|tavern|library|classroom/gi,
    // 人物外观与动作
    /发|眼|瞳|唇|脸|颊|颈|肩|手|指|腿|足|腰|背|胸|肌肤|衣|裙|外套|丝袜|领带|纽扣|鞋/g,
    /hair|eyes|lips|face|cheek|neck|shoulder|hand|finger|leg|waist|back|chest|skin|dress|coat|skirt|uniform/gi,
    // 姿态与表情
    /坐|站|跪|躺|卧|倚|靠|转身|回头|低头|抬头|伸手|握住|抱|拥|吻|笑|哭|颤|抖|喘|闭眼|睁/g,
    /sit|stand|kneel|lie|lean|turn|look|reach|hold|hug|kiss|smile|cry|tremble|breathe/gi,
    // 光影与镜头
    /逆光|侧光|阴影|倒影|映|洒|洒落|柔光|暖光|冷光|剪影|特写|俯视|仰视/g,
    /light|shadow|reflection|silhouette|close-?up|from above|from below/gi,
];

/** 给段落打"可画性"分数 */
export function scoreParagraph(paragraph) {
    const p = String(paragraph || '');
    if (!isPaintable(p)) return -1;

    let score = 0;
    for (const re of VISUAL_SIGNALS) {
        const m = p.match(re);
        if (m) score += Math.min(m.length, 4);
    }
    // 长度适中加分（太短信息少，太长难画）
    if (p.length > 60 && p.length < 400) score += 3;
    else if (p.length >= 400) score += 1;

    // 含对话的开头略扣分（画面感弱）
    if (/^[「『“"]/.test(p.trim())) score -= 2;

    return score;
}

/**
 * 从整段回复中挑出最值得配图的段落。
 * @param {string} text 整楼正文
 * @param {number} count 想要几张图
 * @returns {Array<{index:number, text:string, score:number}>} 按原文顺序
 */
export function pickKeyParagraphs(text, count) {
    const paras = splitParagraphs(text);
    const want = Math.max(1, Math.min(Number(count) || 1, 10));
    if (paras.length === 0) return [];

    const scored = paras
        .map((p, i) => ({ index: i, text: p, score: scoreParagraph(p) }))
        .filter(x => x.score >= 0);

    if (scored.length === 0) {
        // 没有合格段落：退化为均匀取
        const step = Math.max(1, Math.floor(paras.length / want));
        return Array.from({ length: Math.min(want, paras.length) }, (_, k) => {
            const i = Math.min(k * step, paras.length - 1);
            return { index: i, text: paras[i], score: 0 };
        });
    }

    // 按分数取前 N，再按原文位置排序
    const picked = [...scored]
        .sort((a, b) => b.score - a.score)
        .slice(0, want)
        .sort((a, b) => a.index - b.index);

    return picked;
}
