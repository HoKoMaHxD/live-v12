import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { open, unlink } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from './errors.js';

const MAX_YTDLP_OUTPUT = 8 * 1024 * 1024;
const YTDLP_TIMEOUT_MS = 90_000;
const VISUAL_DOWNLOAD_TIMEOUT_MS = 45_000;
const MAX_VISUAL_BYTES = 100 * 1024 * 1024;
const MAX_VISUAL_REDIRECTS = 5;
const YOUTUBE_CACHE_MS = 5 * 60_000;
const BROWSER_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const ANONYMOUS_YOUTUBE_ARGS =
    'youtube:player_client=mweb,web_safari,tv_simply,web_embedded,android_vr,ios';
const youtubeHosts = new Set([
    'youtu.be',
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtube-nocookie.com',
    'www.youtube-nocookie.com',
]);
const youtubeResolutionCache = new Map();
let youtubeResolutionTail = Promise.resolve();

function isPrivateIpv4(address) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
        return true;
    }

    const [a, b, c] = octets;
    return a === 0
        || a === 10
        || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 0)
        || (a === 192 && b === 168)
        || (a === 192 && b === 0 && c === 2)
        || (a === 198 && (b === 18 || b === 19))
        || (a === 198 && b === 51 && c === 100)
        || (a === 203 && b === 0 && c === 113)
        || a >= 224;
}

function isPrivateIpv6(address) {
    const normalized = address.toLowerCase().split('%')[0];
    let ipv6 = normalized;
    const dottedIpv4 = ipv6.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (dottedIpv4) {
        const octets = dottedIpv4.split('.').map(Number);
        ipv6 = ipv6.slice(0, -dottedIpv4.length)
            + ((octets[0] << 8) | octets[1]).toString(16)
            + ':'
            + ((octets[2] << 8) | octets[3]).toString(16);
    }

    const halves = ipv6.split('::');
    if (halves.length > 2) return true;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
    const groups = [...left, ...Array(Math.max(0, fill)).fill('0'), ...right]
        .map((group) => Number.parseInt(group || '0', 16));
    if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group))) return true;

    const embeddedIpv4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    const firstFiveZero = groups.slice(0, 5).every((group) => group === 0);
    if (firstFiveZero && groups[5] === 0xffff) return isPrivateIpv4(embeddedIpv4);
    if (groups.slice(0, 6).every((group) => group === 0)) return isPrivateIpv4(embeddedIpv4);

    const first = groups[0];
    return (first & 0xfe00) === 0xfc00 // Unique local fc00::/7
        || (first & 0xffc0) === 0xfe80 // Link local fe80::/10
        || (first & 0xffc0) === 0xfec0 // Deprecated site local fec0::/10
        || (first & 0xff00) === 0xff00 // Multicast ff00::/8
        || (first & 0xe000) !== 0x2000 // Outside current global-unicast 2000::/3
        || (groups[0] === 0x2001 && groups[1] === 0x0) // Teredo/reserved
        || (groups[0] === 0x2001 && groups[1] === 0x0db8) // Documentation
        || groups[0] === 0x2002; // 6to4 can tunnel to private IPv4
}

export function isPublicIp(address) {
    const family = net.isIP(address);
    if (family === 4) {
        return !isPrivateIpv4(address);
    }
    if (family === 6) {
        return !isPrivateIpv6(address);
    }
    return false;
}

export async function validatePublicHttpUrl(rawUrl) {
    let url;
    try {
        url = new URL(String(rawUrl ?? '').trim());
    }
    catch {
        throw new AppError('الرابط غير صحيح.', 400, 'INVALID_URL');
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new AppError('المسموح روابط http وhttps فقط.', 400, 'INVALID_PROTOCOL');
    }
    if (url.username || url.password) {
        throw new AppError('لا تضع اسم مستخدم أو كلمة مرور داخل الرابط.', 400, 'URL_CREDENTIALS');
    }
    if (url.href.length > 4_096) {
        throw new AppError('الرابط طويل جدًا.', 400, 'URL_TOO_LONG');
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) {
        throw new AppError('روابط الشبكة الداخلية غير مسموحة.', 400, 'PRIVATE_URL');
    }

    if (net.isIP(hostname)) {
        if (!isPublicIp(hostname)) {
            throw new AppError('روابط الشبكة الداخلية غير مسموحة.', 400, 'PRIVATE_URL');
        }
        return url;
    }

    let addresses;
    try {
        addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    }
    catch {
        throw new AppError('تعذر الوصول إلى اسم النطاق في الرابط.', 400, 'DNS_FAILED');
    }

    if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
        throw new AppError('روابط الشبكة الداخلية غير مسموحة.', 400, 'PRIVATE_URL');
    }

    return url;
}

function isYoutubeUrl(url) {
    return youtubeHosts.has(url.hostname.toLowerCase())
        || url.hostname.toLowerCase().endsWith('.youtube.com');
}

function cleanHeaders(headers = {}) {
    const allowed = new Set(['user-agent', 'referer', 'origin']);
    const result = {};

    for (const [name, value] of Object.entries(headers)) {
        if (!allowed.has(name.toLowerCase()) || typeof value !== 'string') {
            continue;
        }
        if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
            continue;
        }
        result[name] = value;
    }

    return result;
}

function mediaName(url) {
    const name = url.pathname.split('/').filter(Boolean).at(-1) || url.hostname;
    try {
        return decodeURIComponent(name);
    }
    catch {
        return name;
    }
}

function directMediaKind(url) {
    const pathname = url.pathname.toLowerCase();
    if (pathname.endsWith('.png')) return 'image';
    if (pathname.endsWith('.gif')) return 'gif';
    if (pathname.endsWith('.m3u8') || pathname.endsWith('.m3u')) return 'live';
    const declaredFormat = String(
        url.searchParams.get('format')
        || url.searchParams.get('fm')
        || url.searchParams.get('ext')
        || '',
    ).toLowerCase();
    if (declaredFormat === 'png') return 'image';
    if (declaredFormat === 'gif') return 'gif';
    return 'video';
}

function youtubeProxyUrl() {
    const proxy = String(process.env.YOUTUBE_PROXY_URL ?? '').trim();
    if (!proxy) return null;
    let parsedProxy;
    try { parsedProxy = new URL(proxy); } catch { /* Report below. */ }
    if (!parsedProxy || !['http:', 'https:'].includes(parsedProxy.protocol)) {
        throw new AppError(
            'متغير YOUTUBE_PROXY_URL غير صحيح؛ استخدم بروكسي HTTP أو HTTPS.',
            500,
            'YOUTUBE_PROXY_INVALID',
        );
    }
    return proxy;
}

export function buildYtDlpArgs(url) {
    const args = [
        '--ignore-config',
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        '--no-cookies-from-browser',
        '--skip-download',
        '--force-ipv4',
        '--js-runtimes',
        'node',
        '--impersonate',
        'chrome',
        '--extractor-args',
        ANONYMOUS_YOUTUBE_ARGS,
        '--extractor-args',
        'youtubepot-wpc:browser_path=/usr/bin/chromium',
        '--format',
        'best[height<=720][vcodec!=none][acodec!=none]/best[protocol*=m3u8][height<=720][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]',
        '--dump-single-json',
    ];

    const proxy = youtubeProxyUrl();
    if (proxy) {
        args.push('--proxy', proxy);
    }

    args.push('--', url.href);
    return args;
}

function visualFileKind(header) {
    if (header.length >= 8
        && header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        return 'image';
    }
    const signature = header.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'gif';
    return null;
}

async function cacheRemoteVisual(inputUrl, expectedKind, signal) {
    const extension = expectedKind === 'gif' ? 'gif' : 'png';
    const temporaryPath = path.join(
        tmpdir(),
        `discord-go-live-${randomUUID()}.${extension}`,
    );
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(new AppError(
        'انتهت مهلة تحميل الصورة من الرابط.',
        504,
        'VISUAL_DOWNLOAD_TIMEOUT',
    )), VISUAL_DOWNLOAD_TIMEOUT_MS);
    timeout.unref?.();
    const downloadSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;
    let file = null;

    try {
        let currentUrl = inputUrl;
        let response = null;
        for (let redirects = 0; redirects <= MAX_VISUAL_REDIRECTS; redirects += 1) {
            response = await fetch(currentUrl, {
                method: 'GET',
                redirect: 'manual',
                signal: downloadSignal,
                headers: {
                    'User-Agent': BROWSER_USER_AGENT,
                    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                },
            });

            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get('location');
                if (!location || redirects === MAX_VISUAL_REDIRECTS) {
                    throw new AppError(
                        'رابط الصورة يحتوي تحويلات أكثر من المسموح.',
                        400,
                        'VISUAL_REDIRECTS',
                    );
                }
                await response.body?.cancel().catch(() => undefined);
                currentUrl = await validatePublicHttpUrl(
                    new URL(location, currentUrl).href,
                );
                continue;
            }
            break;
        }

        if (!response?.ok || !response.body) {
            throw new AppError(
                `تعذر تحميل الصورة من الرابط${response ? ` (HTTP ${response.status})` : ''}.`,
                400,
                'VISUAL_DOWNLOAD_FAILED',
            );
        }

        const declaredSize = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredSize) && declaredSize > MAX_VISUAL_BYTES) {
            throw new AppError(
                'حجم PNG/GIF أكبر من 100MB.',
                413,
                'VISUAL_TOO_LARGE',
            );
        }

        file = await open(temporaryPath, 'wx', 0o600);
        let totalBytes = 0;
        let header = Buffer.alloc(0);
        for await (const part of response.body) {
            downloadSignal.throwIfAborted();
            const chunk = Buffer.from(part);
            totalBytes += chunk.length;
            if (totalBytes > MAX_VISUAL_BYTES) {
                throw new AppError(
                    'حجم PNG/GIF أكبر من 100MB.',
                    413,
                    'VISUAL_TOO_LARGE',
                );
            }
            if (header.length < 16) {
                header = Buffer.concat([header, chunk]).subarray(0, 16);
            }
            await file.writeFile(chunk);
        }
        await file.close();
        file = null;

        const detectedKind = visualFileKind(header);
        if (!detectedKind) {
            throw new AppError(
                'الرابط لم يرجع ملف PNG أو GIF صالح؛ غالبًا رجّع صفحة HTML.',
                400,
                'VISUAL_INVALID_FILE',
            );
        }

        let cleaned = false;
        return {
            mediaUrl: temporaryPath,
            mediaKind: detectedKind,
            cleanup: async () => {
                if (cleaned) return;
                cleaned = true;
                await unlink(temporaryPath).catch(() => undefined);
            },
        };
    }
    catch (error) {
        try { await file?.close(); } catch { /* Already closed. */ }
        await unlink(temporaryPath).catch(() => undefined);
        if (signal?.aborted) throw signal.reason ?? error;
        if (timeoutController.signal.aborted) {
            throw timeoutController.signal.reason ?? error;
        }
        if (error instanceof AppError) throw error;
        throw new AppError(
            'تعذر تحميل ملف PNG/GIF من الرابط.',
            400,
            'VISUAL_DOWNLOAD_FAILED',
            { cause: error },
        );
    }
    finally {
        clearTimeout(timeout);
    }
}

function runYtDlp(url, signal) {
    const executable = process.env.YT_DLP_PATH || 'yt-dlp';
    const args = buildYtDlpArgs(url);

    return new Promise((resolve, reject) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        const usesProcessGroup = process.platform !== 'win32';
        const child = spawn(executable, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: usesProcessGroup,
        });

        const terminateProcessTree = () => {
            if (usesProcessGroup && child.pid) {
                try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
                return;
            }
            try { child.kill('SIGTERM'); } catch { /* Already stopped. */ }
        };

        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            callback(value);
        };

        const onAbort = () => {
            terminateProcessTree();
            finish(reject, signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };

        const timeout = setTimeout(() => {
            terminateProcessTree();
            finish(reject, new AppError(
                'انتهت مهلة تجهيز رابط YouTube. حاول مرة أخرى.',
                504,
                'YTDLP_TIMEOUT',
            ));
        }, YTDLP_TIMEOUT_MS);

        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        child.once('error', (error) => {
            if (error.code === 'ENOENT') {
                finish(reject, new AppError(
                    'yt-dlp غير مثبت على الخادم. شغّل المشروع عن طريق Dockerfile المرفق.',
                    500,
                    'YTDLP_MISSING',
                ));
                return;
            }
            finish(reject, error);
        });

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > MAX_YTDLP_OUTPUT) {
                terminateProcessTree();
                finish(reject, new AppError('رد YouTube أكبر من المتوقع.', 502, 'YTDLP_OUTPUT'));
            }
        });
        child.stderr.on('data', (chunk) => {
            if (stderr.length < 8_192) stderr += chunk.toString();
        });

        child.once('close', (code) => {
            terminateProcessTree();
            if (settled) return;
            if (code !== 0) {
                const detail = stderr.trim().split('\n').at(-1);
                const verificationRequired = /sign in to confirm you(?:'|’)re not a bot|http error 429/i
                    .test(stderr);
                if (verificationRequired) {
                    finish(reject, new AppError(
                        'YouTube رفض عنوان Render حتى بعد PO Token المجهول. أعد المحاولة، وإن استمر الحظر أضف بروكسي في YOUTUBE_PROXY_URL؛ المشروع لا يستخدم Cookies حسابك.',
                        502,
                        'YOUTUBE_ANONYMOUS_BLOCKED',
                    ));
                    return;
                }
                const safeDetail = detail?.replace(/https?:\/\/\S+/gi, '[رابط المساعدة]');
                finish(reject, new AppError(
                    safeDetail ? `تعذر فتح رابط YouTube: ${safeDetail}` : 'تعذر فتح رابط YouTube.',
                    400,
                    'YTDLP_FAILED',
                ));
                return;
            }

            try {
                finish(resolve, JSON.parse(stdout));
            }
            catch {
                finish(reject, new AppError('تعذر قراءة بيانات YouTube.', 502, 'YTDLP_JSON'));
            }
        });
    });
}

function queueYoutubeResolution(task) {
    const current = youtubeResolutionTail
        .catch(() => undefined)
        .then(task);
    youtubeResolutionTail = current;
    return current;
}

async function resolveYoutubeInfo(url, signal) {
    return queueYoutubeResolution(async () => {
        signal?.throwIfAborted();
        const cached = youtubeResolutionCache.get(url.href);
        if (cached && cached.expiresAt > Date.now()) return cached.info;
        if (cached) youtubeResolutionCache.delete(url.href);

        const info = await runYtDlp(url, signal);
        youtubeResolutionCache.set(url.href, {
            info,
            expiresAt: Date.now() + YOUTUBE_CACHE_MS,
        });
        if (youtubeResolutionCache.size > 50) {
            const oldestKey = youtubeResolutionCache.keys().next().value;
            youtubeResolutionCache.delete(oldestKey);
        }
        return info;
    });
}

export async function resolveMedia(rawUrl, { signal } = {}) {
    signal?.throwIfAborted();
    const inputUrl = await validatePublicHttpUrl(rawUrl);
    signal?.throwIfAborted();

    if (!isYoutubeUrl(inputUrl)) {
        const mediaKind = directMediaKind(inputUrl);
        if (mediaKind === 'image' || mediaKind === 'gif') {
            const visual = await cacheRemoteVisual(inputUrl, mediaKind, signal);
            return {
                inputUrl: inputUrl.href,
                mediaUrl: visual.mediaUrl,
                title: mediaName(inputUrl),
                duration: null,
                headers: {},
                source: 'direct-cached',
                mediaKind: visual.mediaKind,
                seekable: false,
                cleanup: visual.cleanup,
            };
        }
        return {
            inputUrl: inputUrl.href,
            mediaUrl: inputUrl.href,
            title: mediaName(inputUrl),
            duration: null,
            headers: {},
            source: 'direct',
            mediaKind,
            seekable: mediaKind === 'video',
        };
    }

    const info = await resolveYoutubeInfo(inputUrl, signal);
    if (typeof info?.url !== 'string') {
        throw new AppError(
            'لم يجد YouTube صيغة واحدة تحتوي فيديو وصوت لهذا المقطع.',
            400,
            'YTDLP_NO_MEDIA_URL',
        );
    }

    const mediaUrl = await validatePublicHttpUrl(info.url);
    return {
        inputUrl: inputUrl.href,
        mediaUrl: mediaUrl.href,
        title: String(info.title || 'YouTube').slice(0, 300),
        duration: Number.isFinite(info.duration) ? info.duration : null,
        headers: cleanHeaders(info.http_headers),
        source: 'youtube',
        mediaKind: 'video',
        seekable: true,
        proxyUrl: youtubeProxyUrl(),
    };
}
