/**
 * NovelAI 官方格式后端（支持第三方中转 URL）
 *
 * 请求结构依据 NekoAI-JS / NovelAI 官方网页端实现：
 *   POST {base}/ai/generate-image
 *   {
 *     input: "<base prompt>",
 *     model: "nai-diffusion-4-5-full",
 *     action: "generate",
 *     parameters: {
 *       v4_prompt: { caption: { base_caption, char_captions: [] }, use_coords, use_order },
 *       v4_negative_prompt: { caption: { base_caption, char_captions: [] }, legacy_uc },
 *       ...
 *     }
 *   }
 *   Authorization: Bearer <token>
 *
 * 响应：默认是 application/zip（内含多张 png），也可以是 msgpack 事件流。
 * 我们能可靠解析的是 ZIP —— 所以请求里显式要求 zip 返回。
 */

const DEFAULT_TIMEOUT = 240000;

export const NAI_MODELS = {
    'nai-diffusion-4-5-full': 'V4.5 Full（细节多，推荐）',
    'nai-diffusion-4-5-curated': 'V4.5 Curated（更稳，避免敏感内容）',
    'nai-diffusion-4-full': 'V4 Full',
    'nai-diffusion-4-curated-preview': 'V4 Curated',
    'nai-diffusion-3': 'V3',
};

export const NAI_SAMPLERS = [
    'k_euler_ancestral',
    'k_euler',
    'k_dpmpp_2m',
    'k_dpmpp_sde',
    'k_dpmpp_2s_ancestral',
    'k_dpm_2',
    'k_dpm_2_ancestral',
    'ddim',
    'k_lms',
    'k_heun',
];

export const NAI_SMEAS = ['SMEA', 'SMEA+DYN', '关闭'];

export const NAI_DEFAULT_NEGATIVE =
    'lowres, bad, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, ' +
    'watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, ' +
    'artistic error, username, scan, abstract';

function withTimeout(ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

/** 常见中转路径，按优先级尝试 */
export const NAI_PATHS = [
    '/ai/generate-image',
    '/v1/images/generations',
    '/api/ai/generate-image',
];

/**
 * 解析用户填的 URL：
 *  - 若已含具体 endpoint 路径，原样使用
 *  - 否则视为根地址，默认拼 /ai/generate-image
 */
export function resolveEndpoint(url, customPath) {
    let raw = String(url || '').trim().replace(/\/+$/, '');
    if (!raw) throw new Error('未填写 Base URL');

    // 用户可能误填了网页地址（/developer、/auth、/docs 等），只保留 origin
    try {
        const u = new URL(raw);
        if (/^\/(developer|auth|docs|login|console|dashboard)?\/?$/i.test(u.pathname)) {
            raw = u.origin;
        }
    } catch { /* 非标准 URL，保持原样 */ }

    // 已经带完整路径：直接用
    if (/\/images\/generations$/.test(raw)) return raw;

    const path = String(customPath || '').trim();
    if (path) return raw + (path.startsWith('/') ? path : '/' + path);

    return raw + '/v1/images/generations';
}

export function normalizeBaseUrl(url) {
    let base = String(url || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('未填写 Base URL');
    base = base.replace(/\/ai\/generate-image(-stream)?$/, '');
    base = base.replace(/\/images\/generations$/, '');
    return base.replace(/\/+$/, '');
}

export function buildPayload(cfg, prompt, negative) {
    const model = cfg.model || 'nai-diffusion-4-5-full';
    const isV4 = /nai-diffusion-4/.test(model);

    const params = {
        width: Number(cfg.width) || 832,
        height: Number(cfg.height) || 1216,
        steps: Number(cfg.steps) || 28,
        scale: Number(cfg.cfg) || 5,
        sampler: cfg.sampler || 'k_euler_ancestral',
        seed: Number(cfg.seed) > 0 ? Number(cfg.seed) : Math.floor(Math.random() * 4294967295),
        n_samples: 1,
        ucPreset: 0,
        qualityToggle: !!cfg.naiQualityTags,
        dynamic_thresholding: false,
        cfg_rescale: Number(cfg.naiCfgRescale) || 0,
        noise_schedule: 'karras',
        legacy: false,
        add_original_image: true,
        negative_prompt: negative || '',
    };

    if (!isV4) {
        // V3 使用 sm/sm_dyn；V4+ 必须省略这两个字段
        params.sm = /SMEA/.test(cfg.naiSmea || '');
        params.sm_dyn = /DYN/.test(cfg.naiSmea || '');
    }

    if (isV4) {
        params.v4_prompt = {
            caption: {
                base_caption: prompt,
                char_captions: [],
            },
            use_coords: false,
            use_order: true,
        };
        params.v4_negative_prompt = {
            caption: {
                base_caption: negative || '',
                char_captions: [],
            },
            legacy_uc: false,
        };
        params.params_version = 3;
        // V4/V4.5 不接受 V3 的 sm / sm_dyn，改用 autoSmea。
        // 传了 sm/sm_dyn 会被上游判为"参数组合未被正确处理"（HTTP 503）。
        params.autoSmea = /SMEA/.test(cfg.naiSmea || '');
    }

    return {
        input: prompt,
        model,
        action: 'generate',
        parameters: params,
    };
}

/** 从 ZIP 中提取第一张图片（PNG/JPEG/WebP） */
async function extractImageFromZip(buf) {
    const u8 = new Uint8Array(buf);

    // 先试原生 DecompressionStream（现代浏览器都有）
    if (typeof DecompressionStream === 'function') {
        let offset = 0;
        while (offset < u8.length - 4) {
            // 找 local file header 签名 0x04034b50
            if (u8[offset] === 0x50 && u8[offset + 1] === 0x4b
                && u8[offset + 2] === 0x03 && u8[offset + 3] === 0x04) {
                const method = u8[offset + 8] | (u8[offset + 9] << 8);
                let compSize = u8[offset + 18] | (u8[offset + 19] << 8)
                    | (u8[offset + 20] << 16) | (u8[offset + 21] << 24);
                const nameLen = u8[offset + 26] | (u8[offset + 27] << 8);
                const extraLen = u8[offset + 28] | (u8[offset + 29] << 8);
                const name = new TextDecoder().decode(u8.slice(offset + 30, offset + 30 + nameLen));
                const dataStart = offset + 30 + nameLen + extraLen;

                // size 为 0 时说明用了 data descriptor，从中央目录取
                if (compSize === 0) {
                    compSize = findSizeInCentralDir(u8, name);
                }

                if (/\.(png|jpg|jpeg|webp)$/i.test(name) && compSize > 0) {
                    const data = u8.slice(dataStart, dataStart + compSize);
                    if (method === 0) {
                        return { bytes: data, name };
                    }
                    if (method === 8) {
                        const ds = new DecompressionStream('deflate-raw');
                        const stream = new Blob([data]).stream().pipeThrough(ds);
                        const out = await new Response(stream).arrayBuffer();
                        return { bytes: new Uint8Array(out), name };
                    }
                }
                offset = dataStart + (compSize || 0);
                continue;
            }
            offset++;
        }
    }

    // 兜底：在 ZIP 里直接扫描 PNG 签名
    for (let i = 0; i < u8.length - 8; i++) {
        if (u8[i] === 0x89 && u8[i + 1] === 0x50 && u8[i + 2] === 0x4e && u8[i + 3] === 0x47) {
            // 找 IEND 结尾
            for (let j = i; j < u8.length - 8; j++) {
                if (u8[j] === 0x49 && u8[j + 1] === 0x45 && u8[j + 2] === 0x4e
                    && u8[j + 3] === 0x44) {
                    return { bytes: u8.slice(i, j + 8), name: 'image.png' };
                }
            }
            return { bytes: u8.slice(i), name: 'image.png' };
        }
    }
    throw new Error('ZIP 里没有找到图片');
}

function findSizeInCentralDir(u8, targetName) {
    for (let i = 0; i < u8.length - 4; i++) {
        if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x01 && u8[i + 3] === 0x02) {
            let compSize = u8[i + 20] | (u8[i + 21] << 8) | (u8[i + 22] << 16) | (u8[i + 23] << 24);
            const nameLen = u8[i + 28] | (u8[i + 29] << 8);
            const extraLen = u8[i + 30] | (u8[i + 31] << 8);
            const commentLen = u8[i + 32] | (u8[i + 33] << 8);
            const name = new TextDecoder().decode(u8.slice(i + 46, i + 46 + nameLen));
            if (name === targetName) return compSize >>> 0;
            i += 46 + nameLen + extraLen + commentLen - 1;
        }
    }
    return 0;
}

function guessMime(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
    return 'image/png';
}

/**
 * 生图（OpenAI 兼容协议）
 *
 * 目标站点实测为 OpenAI 兼容中转：
 *   POST {base}/v1/images/generations
 *   { model, prompt, n, size, response_format: "b64_json" }
 *   Authorization: Bearer <key>
 *
 * 注意：这类中转普遍不认 NovelAI 原生字段（v4_prompt / ucPreset / sm 等），
 * 传了会被判为"参数组合未被正确处理"。所以这里只发标准 OpenAI 字段，
 * 负向词并入 prompt 文本。
 */
export async function generateNAI(cfg, prompt, negative) {
    const token = String(cfg.apiKey || '').trim();
    if (!token) throw new Error('未填写密钥（填中转站给你的 API Key）');

    const endpoint = resolveEndpoint(cfg.url, cfg.apiPath || '/v1/images/generations');

    // 负向词并入正向：OpenAI 协议没有 negative_prompt
    const fullPrompt = negative
        ? `${prompt}\n\nNegative prompt: ${negative}`
        : prompt;

    const payload = {
        model: cfg.model || 'nai-diffusion-4-5-full',
        prompt: fullPrompt,
        n: 1,
        size: `${Number(cfg.width) || 832}x${Number(cfg.height) || 1216}`,
        response_format: 'b64_json',
    };

    const t = withTimeout(DEFAULT_TIMEOUT);

    let res;
    try {
        res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
            signal: t.signal,
        });
    } catch (e) {
        throw new Error(e?.name === 'AbortError'
            ? '请求超时（图片可能仍在生成）'
            : `无法连接：${e?.message || e}`);
    } finally {
        t.done();
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const hint = res.status === 400 ? '（请求参数被拒绝，检查模型名与尺寸）'
            : res.status === 401 ? '（密钥无效）'
            : res.status === 402 ? '（额度不足）'
            : res.status === 403 ? '（无权限访问该模型）'
            : res.status === 404 ? '（接口路径不存在）'
            : res.status === 429 ? '（请求过于频繁）'
            : res.status === 503 ? '（服务端拒绝该参数组合 / 模型不可用）'
            : '';
        const detail = text.replace(/\s+/g, ' ').slice(0, 400);
        const err = new Error(`HTTP ${res.status}${hint} ${detail}`);
        err.status = res.status;
        err.rawBody = text;
        err.sentPayload = payload;
        throw err;
    }

    // 可能返回 JSON（b64_json / url），也可能直接返回图片二进制
    const ctype = res.headers.get('content-type') || '';
    const buf = await res.arrayBuffer();
    const u8 = new Uint8Array(buf);

    // 直接是图片
    if (u8[0] === 0x89 && u8[1] === 0x50) {
        return { blob: new Blob([u8], { type: 'image/png' }), mime: 'image/png' };
    }
    if (u8[0] === 0xff && u8[1] === 0xd8) {
        return { blob: new Blob([u8], { type: 'image/jpeg' }), mime: 'image/jpeg' };
    }
    // ZIP（部分中转仍返回 NovelAI 风格）
    if (u8[0] === 0x50 && u8[1] === 0x4b) {
        const { bytes } = await extractImageFromZip(buf);
        const mime = guessMime(bytes);
        return { blob: new Blob([bytes], { type: mime }), mime };
    }

    // JSON
    let json = null;
    try { json = JSON.parse(new TextDecoder().decode(u8)); } catch { /* 非 JSON */ }

    if (json) {
        const item = json?.data?.[0] || json?.images?.[0];
        const b64 = item?.b64_json || (typeof item === 'string' ? item : null) || json?.image;
        // 不能用长度阈值判断：小图 base64 可能很短
        if (typeof b64 === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(b64) && b64.length > 20) {
            const clean = b64.replace(/^data:image\/\w+;base64,/, '');
            const bin = atob(clean);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return { blob: new Blob([bytes], { type: 'image/png' }), mime: 'image/png' };
        }
        const url = item?.url || json?.url;
        if (typeof url === 'string' && /^https?:/.test(url)) {
            const r = await fetch(url);
            if (r.ok) {
                const blob = await r.blob();
                return { blob, mime: blob.type || 'image/png' };
            }
            return { url, mime: 'image/png' };
        }
        // 中转返回了错误但状态码是 200
        const msg = json?.error?.message || json?.message || JSON.stringify(json).slice(0, 300);
        throw new Error(`接口返回异常：${msg}`);
    }

    throw new Error('无法解析响应（既不是图片，也不是带 b64_json/url 的 JSON）');
}

export const BACKENDS = {
    nai: { label: 'NovelAI', fn: generateNAI },
};

export async function generate(cfg, prompt, negative) {
    const backend = BACKENDS[cfg.backend];
    if (!backend) throw new Error(`未知后端：${cfg.backend}`);
    return await backend.fn(cfg, prompt, negative);
}
