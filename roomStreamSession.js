import { EventEmitter } from 'node:events';
import { Client } from 'discord.js-selfbot-v13';
import {
    Encoders,
    Streamer,
    Utils,
    playStream,
    prepareStream,
} from '@dank074/discord-video-stream';
import { AppError, SupersededError, publicError } from './errors.js';
import { resolveMedia } from './mediaResolver.js';

const discordIdPattern = /^\d{17,20}$/;
const CONNECT_TIMEOUT_MS = 35_000;
const STREAM_START_TIMEOUT_MS = 25_000;
const LOOP_DELAY_MS = 1_000;
const VOICE_STATE_OPCODE = 4;
const STREAM_HEIGHTS = Object.freeze([144, 240, 360, 480, 720, 1080, 1440, 2160]);
const STREAM_FRAME_RATES = Object.freeze([15, 24, 30, 60]);
const discordLoginQueues = new Map();

const defaultRuntime = {
    ClientClass: Client,
    StreamerClass: Streamer,
    prepareStream,
    playStream,
    resolveMedia,
};

function sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, milliseconds);
        const onAbort = () => {
            clearTimeout(timeout);
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };

        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

async function waitFor(check, timeoutMs, signal, timeoutMessage) {
    const startedAt = Date.now();
    while (!check()) {
        signal?.throwIfAborted();
        if (Date.now() - startedAt >= timeoutMs) {
            throw new AppError(timeoutMessage, 504, 'TIMEOUT');
        }
        await sleep(100, signal);
    }
}

function withTimeout(promise, timeoutMs, message) {
    let timeout;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timeout = setTimeout(
                () => reject(new AppError(message, 504, 'CONNECT_TIMEOUT')),
                timeoutMs,
            );
        }),
    ]).finally(() => clearTimeout(timeout));
}

// Discord user accounts can only hold one voice channel per Gateway session.
// Keep one Gateway session per dashboard room, but serialize IDENTIFY/login for
// the same token so pressing all four join buttons quickly does not race logins.
function queueDiscordLogin(token, login) {
    const previous = discordLoginQueues.get(token) ?? Promise.resolve();
    const current = previous
        .catch(() => undefined)
        .then(login);
    discordLoginQueues.set(token, current);
    return current.finally(() => {
        if (discordLoginQueues.get(token) === current) {
            discordLoginQueues.delete(token);
        }
    });
}

function redactLogMessage(error) {
    return String(error?.message || error || 'Unknown error')
        .replace(/https?:\/\/\S+/gi, '[URL]')
        .slice(0, 800);
}

function publicDiscordError(error) {
    if (error instanceof AppError) return error;
    const detail = String(error?.code || error?.message || error || '');
    if (/TOKEN_INVALID|invalid token|incorrect login|unauthorized/i.test(detail)) {
        return new AppError(
            'متغير token1 غير صحيح أو انتهت صلاحيته.',
            401,
            'DISCORD_TOKEN_INVALID',
        );
    }
    if (/captcha|verify (?:your )?account|verification required/i.test(detail)) {
        return new AppError(
            'Discord طلب تحقق للحساب. افتح الحساب في Discord وأكمل التحقق أولًا.',
            403,
            'DISCORD_VERIFICATION_REQUIRED',
        );
    }
    return publicError(error);
}

function closestAllowed(value, allowed, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return allowed.reduce((closest, candidate) => (
        Math.abs(candidate - numeric) < Math.abs(closest - numeric) ? candidate : closest
    ), fallback);
}

function selectedStreamSetting(rawValue, currentValue, allowed, message, code) {
    if (rawValue === undefined || rawValue === null) return currentValue;
    const value = Number(rawValue);
    if (!Number.isInteger(value) || !allowed.includes(value)) {
        throw new AppError(message, 400, code);
    }
    return value;
}

function encodingSettings(height, frameRate, streamOptions) {
    const baseHeight = closestAllowed(streamOptions.height, STREAM_HEIGHTS, 480);
    const baseFrameRate = closestAllowed(streamOptions.frameRate, STREAM_FRAME_RATES, 24);
    const baseBitrate = Number.isFinite(streamOptions.bitrateVideo)
        ? streamOptions.bitrateVideo
        : 1_400;
    const baseBitrateMax = Number.isFinite(streamOptions.bitrateVideoMax)
        ? streamOptions.bitrateVideoMax
        : 1_800;
    const resolutionScale = (height / baseHeight) ** 1.35;
    const frameRateScale = Math.sqrt(frameRate / baseFrameRate);
    const scale = resolutionScale * frameRateScale;
    const rounded = (value) => Math.round(value / 50) * 50;
    const bitrateVideo = Math.min(15_000, Math.max(200, rounded(baseBitrate * scale)));
    const bitrateVideoMax = Math.min(
        20_000,
        Math.max(bitrateVideo, 300, rounded(baseBitrateMax * scale)),
    );
    return { bitrateVideo, bitrateVideoMax };
}

function mediaInputOptions(mediaKind, startPosition, frameRate, proxyUrl = null) {
    const options = [];
    if (proxyUrl) {
        options.push('-http_proxy', proxyUrl);
    }
    if (startPosition > 0) {
        options.push('-ss', startPosition.toFixed(3));
    }
    if (mediaKind === 'image') {
        options.push('-stream_loop', '-1', '-framerate', String(frameRate));
    }
    else if (mediaKind === 'gif') {
        options.push('-stream_loop', '-1', '-ignore_loop', '1');
    }
    options.push('-rw_timeout', '15000000');
    return options;
}

function streamStartupError(error) {
    if (error instanceof AppError
        || error?.name === 'AbortError'
        || error instanceof SupersededError) {
        return error;
    }
    const detail = String(error?.message || error || '');
    if (/no main startcode|eof before video frames|invalid data found|no video stream/i
        .test(detail)) {
        return new AppError(
            'الرابط لم ينتج فريمات فيديو صالحة. تأكد أنه رابط PNG أو GIF أو MP4 مباشر وليس صفحة مشاهدة.',
            400,
            'MEDIA_HAS_NO_VIDEO',
            { cause: error },
        );
    }
    if (/http error|server returned|403 forbidden|404 not found|input\/output error/i
        .test(detail)) {
        return new AppError(
            'تعذر قراءة ملف الوسائط من الرابط. تأكد أن الرابط عام ومباشر ولم تنتهِ صلاحيته.',
            400,
            'MEDIA_URL_UNAVAILABLE',
            { cause: error },
        );
    }
    return new AppError(
        'فشل تجهيز أول فريم للبث. راجع سجل Render لمعرفة خطأ FFmpeg.',
        500,
        'STREAM_PIPELINE_FAILED',
        { cause: error },
    );
}

function failIfPipelineEndsBeforeReady(promise) {
    return Promise.resolve(promise).then(
        () => {
            throw new AppError(
                'انتهى ملف الوسائط قبل أن يبدأ الشير؛ استخدم ملفًا صالحًا أو أطول.',
                400,
                'MEDIA_ENDED_BEFORE_START',
            );
        },
        (error) => {
            throw streamStartupError(error);
        },
    );
}

function normalizeVoiceTarget(rawServerId, rawChannelId) {
    const serverId = String(rawServerId ?? '').trim();
    const channelId = String(rawChannelId ?? '').trim();
    if (!discordIdPattern.test(serverId) || !discordIdPattern.test(channelId)) {
        throw new AppError(
            'أيدي السيرفر والروم يجب أن يكون أرقامًا من 17 إلى 20 خانة.',
            400,
            'INVALID_VOICE_TARGET',
        );
    }
    return { serverId, channelId };
}

async function validateDiscordVoiceTarget(client, serverId, channelId) {
    const guildManager = client?.guilds;
    const channelManager = client?.channels;
    if (!guildManager?.cache?.get || !channelManager?.cache?.get) return;

    let guild = guildManager.cache.get(serverId);
    if (!guild && typeof guildManager.fetch === 'function') {
        try { guild = await guildManager.fetch(serverId); } catch { /* Report a clear error below. */ }
    }
    if (!guild) {
        throw new AppError(
            'الحساب غير موجود في هذا السيرفر أو أيدي السيرفر غير صحيح.',
            400,
            'GUILD_NOT_ACCESSIBLE',
        );
    }

    let channel = channelManager.cache.get(channelId);
    if (!channel && typeof channelManager.fetch === 'function') {
        try { channel = await channelManager.fetch(channelId); } catch { /* Report below. */ }
    }
    if (!channel) {
        throw new AppError(
            'لم يجد الحساب الروم. تأكد من أيدي الروم ومن صلاحية View Channel.',
            400,
            'CHANNEL_NOT_ACCESSIBLE',
        );
    }
    if (String(channel.guildId ?? channel.guild?.id ?? '') !== serverId) {
        throw new AppError(
            'أيدي الروم لا يتبع للسيرفر الذي أدخلته.',
            400,
            'CHANNEL_GUILD_MISMATCH',
        );
    }
    if (typeof channel.isVoice === 'function' && !channel.isVoice()) {
        throw new AppError('الأيدي المدخل ليس لروم صوتي.', 400, 'CHANNEL_NOT_VOICE');
    }

    const permissions = channel.permissionsFor?.(client.user);
    if (permissions?.has && !permissions.has('CONNECT')) {
        throw new AppError(
            'الحساب لا يملك صلاحية Connect في هذا الروم.',
            403,
            'CONNECT_PERMISSION_MISSING',
        );
    }
}

export class RoomStreamSession extends EventEmitter {
    constructor(config, runtime = defaultRuntime) {
        super();
        this.id = config.id;
        this.name = config.name;
        this.token = config.token;
        this.serverId = String(config.serverId ?? '').trim();
        this.channelId = String(config.channelId ?? '').trim();
        this.streamOptions = config.streamOptions ?? {};
        this.runtime = runtime;
        this.loopDelayMs = Number.isFinite(runtime.loopDelayMs)
            ? Math.max(0, runtime.loopDelayMs)
            : LOOP_DELAY_MS;

        this.voiceStatus = 'offline';
        this.streamStatus = 'idle';
        this.volume = 100;
        this.streamHeight = closestAllowed(
            this.streamOptions.height,
            STREAM_HEIGHTS,
            480,
        );
        this.streamFps = closestAllowed(
            this.streamOptions.frameRate,
            STREAM_FRAME_RATES,
            24,
        );
        const initialEncoding = encodingSettings(
            this.streamHeight,
            this.streamFps,
            this.streamOptions,
        );
        this.videoBitrate = initialEncoding.bitrateVideo;
        this.videoBitrateMax = initialEncoding.bitrateVideoMax;
        this.inputUrl = '';
        this.mediaTitle = '';
        this.mediaKind = null;
        this.mediaDuration = null;
        this.seekable = false;
        this.hasAudio = true;
        this.positionSeconds = 0;
        this.playbackOffset = 0;
        this.playbackStartedAtMs = null;
        this.startedAt = null;
        this.endedAt = null;
        this.loopCount = 0;
        this.selfMute = false;
        this.selfDeaf = false;
        this.preferredSelfMute = false;
        this.preferredSelfDeaf = false;
        this.error = null;
        this.username = null;

        this.client = null;
        this.streamer = null;
        this.connectPromise = null;
        this.abortController = null;
        this.prepared = null;
        this.playPromise = null;
        this.lifecyclePromise = null;
        this.mediaCleanup = null;
        this.generation = 0;
        this.closed = false;
        this.joinConfirmed = false;
        this.reconnectTimer = null;
    }

    currentPlaybackPosition() {
        let position = Number(this.positionSeconds) || 0;
        if (this.streamStatus === 'streaming' && Number.isFinite(this.playbackStartedAtMs)) {
            position = this.playbackOffset + ((Date.now() - this.playbackStartedAtMs) / 1_000);
        }
        if (Number.isFinite(this.mediaDuration) && this.mediaDuration >= 0) {
            position = Math.min(position, this.mediaDuration);
        }
        return Math.round(Math.max(0, position) * 10) / 10;
    }

    getState() {
        return {
            id: this.id,
            name: this.name,
            configured: true,
            serverId: this.serverId,
            channelId: this.channelId,
            voiceStatus: this.voiceStatus,
            streamStatus: this.streamStatus,
            volume: this.volume,
            streamHeight: this.streamHeight,
            streamFps: this.streamFps,
            videoBitrate: this.videoBitrate,
            inputUrl: this.inputUrl,
            mediaTitle: this.mediaTitle,
            mediaKind: this.mediaKind,
            durationSeconds: this.mediaDuration,
            positionSeconds: this.currentPlaybackPosition(),
            seekable: this.seekable,
            hasAudio: this.hasAudio,
            startedAt: this.startedAt,
            endedAt: this.endedAt,
            loopCount: this.loopCount,
            selfMute: this.selfMute,
            selfDeaf: this.selfDeaf,
            error: this.error,
            username: this.username,
        };
    }

    update(patch = {}) {
        Object.assign(this, patch);
        this.emit('state', this.getState());
    }

    sharesAccountWith(other) {
        return Boolean(this.token && this.token === other?.token);
    }

    requireReadyVoice() {
        if (this.voiceStatus !== 'ready' || !this.streamer?.voiceConnection) {
            throw new AppError('اضغط دخول الروم أولًا.', 409, 'VOICE_NOT_READY');
        }
    }

    signalVoiceState() {
        this.requireReadyVoice();
        try {
            this.streamer.sendOpcode(VOICE_STATE_OPCODE, {
                guild_id: this.serverId,
                channel_id: this.channelId,
                self_mute: this.preferredSelfMute,
                self_deaf: this.preferredSelfDeaf,
                self_video: false,
            });
        }
        catch {
            throw new AppError(
                'تعذر تحديث الميوت أو الدفن في Discord.',
                502,
                'VOICE_STATE_FAILED',
            );
        }
    }

    async setSelfMute(enabled) {
        if (typeof enabled !== 'boolean') {
            throw new AppError('قيمة الميوت غير صحيحة.', 400, 'INVALID_MUTE_STATE');
        }
        this.requireReadyVoice();
        const previous = this.preferredSelfMute;
        this.preferredSelfMute = enabled;
        try {
            this.signalVoiceState();
        }
        catch (error) {
            this.preferredSelfMute = previous;
            throw error;
        }
        this.update({ selfMute: enabled, error: null });
        return this.getState();
    }

    async setSelfDeaf(enabled) {
        if (typeof enabled !== 'boolean') {
            throw new AppError('قيمة الدفن غير صحيحة.', 400, 'INVALID_DEAF_STATE');
        }
        this.requireReadyVoice();
        const previous = this.preferredSelfDeaf;
        this.preferredSelfDeaf = enabled;
        try {
            this.signalVoiceState();
        }
        catch (error) {
            this.preferredSelfDeaf = previous;
            throw error;
        }
        this.update({ selfDeaf: enabled, error: null });
        return this.getState();
    }

    async join(rawServerId, rawChannelId) {
        if (this.closed) {
            throw new AppError('الجلسة متوقفة.', 503, 'SESSION_CLOSED');
        }
        const target = normalizeVoiceTarget(rawServerId, rawChannelId);

        if (this.connectPromise) {
            await this.connectPromise.catch(() => undefined);
        }
        const sameTarget = target.serverId === this.serverId
            && target.channelId === this.channelId;
        if (sameTarget && this.voiceStatus === 'ready' && this.streamer?.voiceConnection) {
            return this.getState();
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        await this.stop({ quiet: true });
        await this.destroyClient();
        this.serverId = target.serverId;
        this.channelId = target.channelId;
        this.update({ voiceStatus: 'offline', error: null });
        await this.connect();
        return this.getState();
    }

    async leave() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.connectPromise) {
            await this.connectPromise.catch(() => undefined);
        }
        await this.stop({ quiet: true });
        await this.destroyClient();
        this.preferredSelfMute = false;
        this.preferredSelfDeaf = false;
        this.update({
            voiceStatus: 'offline',
            streamStatus: 'idle',
            startedAt: null,
            selfMute: false,
            selfDeaf: false,
            error: null,
        });
        console.log(`[${this.name}] Left voice: ${this.serverId}/${this.channelId}`);
        return this.getState();
    }

    async connect() {
        if (this.closed) {
            throw new AppError('الجلسة متوقفة.', 503, 'SESSION_CLOSED');
        }
        normalizeVoiceTarget(this.serverId, this.channelId);
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.voiceStatus === 'ready' && this.streamer?.voiceConnection) {
            return;
        }
        if (this.connectPromise) {
            return this.connectPromise;
        }

        this.connectPromise = this.connectInternal().finally(() => {
            this.connectPromise = null;
        });
        return this.connectPromise;
    }

    async connectInternal() {
        this.update({ voiceStatus: 'connecting', error: null });
        await this.destroyClient();
        let client = null;
        let streamer = null;
        try {
            client = new this.runtime.ClientClass({ checkUpdate: false });
            streamer = new this.runtime.StreamerClass(client);
            this.client = client;
            this.streamer = streamer;

            if (this.boundClient !== client) {
                this.boundClient = client;
                client.on?.('error', (error) => {
                    console.error(`[${this.name}] Discord: ${redactLogMessage(error)}`);
                });
                client.on?.('shardDisconnect', () => {
                    if (this.client === client && this.streamer?.voiceConnection) {
                        this.update({ voiceStatus: 'connecting' });
                    }
                });
                client.on?.('shardResume', () => {
                    if (this.client === client && this.streamer?.voiceConnection) {
                        this.update({ voiceStatus: 'ready', error: null });
                    }
                });
            }

            await queueDiscordLogin(this.token, async () => {
                if (this.client !== client || this.closed) throw new SupersededError();
                return withTimeout(
                    client.login(this.token),
                    CONNECT_TIMEOUT_MS,
                    'انتهت مهلة تسجيل الدخول إلى Discord.',
                );
            });
            if (this.client !== client || this.closed) {
                throw new SupersededError();
            }
            await validateDiscordVoiceTarget(client, this.serverId, this.channelId);
            if (this.client !== client || this.closed) {
                throw new SupersededError();
            }
            this.username = client.user?.tag || client.user?.username || null;
            this.update({ voiceStatus: 'joining' });

            const joinPromise = streamer.joinVoice(this.serverId, this.channelId);
            this.patchVoiceStateListener(streamer, client);
            await withTimeout(
                joinPromise,
                CONNECT_TIMEOUT_MS,
                'انتهت مهلة دخول الروم الصوتي.',
            );

            if (this.client !== client) {
                throw new SupersededError();
            }
            this.joinConfirmed = true;
            this.update({ voiceStatus: 'ready', error: null });
            this.signalVoiceState();
            this.update({
                selfMute: this.preferredSelfMute,
                selfDeaf: this.preferredSelfDeaf,
            });
            console.log(`[${this.name}] Voice ready: ${this.serverId}/${this.channelId}`);
        }
        catch (error) {
            const safe = publicDiscordError(error);
            this.update({ voiceStatus: 'error', error: safe.message });
            if (client && this.client === client) {
                await this.destroyClient();
            }
            else if (streamer) {
                try { streamer.leaveVoice?.(); } catch { /* Already closed. */ }
                try { await Promise.resolve(client?.destroy?.()); } catch { /* Already closed. */ }
            }
            console.error(`[${this.name}] Connection failed: ${redactLogMessage(error)}`);
            throw safe;
        }
    }

    patchVoiceStateListener(streamer, client) {
        const emitter = streamer?._gatewayEmitter;
        const voiceConnection = streamer?.voiceConnection;
        if (!emitter?.removeAllListeners || !voiceConnection) {
            return;
        }

        // كل Client يستقبل أحداث الحساب في جميع السيرفرات. فلترة السيرفر والروم
        // هنا تمنع جلسة روم آخر من استبدال session_id لهذه الجلسة.
        emitter.removeAllListeners('VOICE_STATE_UPDATE');
        emitter.on('VOICE_STATE_UPDATE', (data) => {
            if (this.client !== client || this.closed) return;
            if (String(data?.user_id ?? '') !== String(client.user?.id ?? '')) return;
            if (String(data?.guild_id ?? '') !== this.serverId) return;
            if (String(data?.channel_id ?? '') === this.channelId) {
                if (data?.session_id) voiceConnection.setSession(data.session_id);
                const patch = {};
                if (typeof data?.self_mute === 'boolean') patch.selfMute = data.self_mute;
                if (typeof data?.self_deaf === 'boolean') patch.selfDeaf = data.self_deaf;
                if (Object.keys(patch).length) this.update(patch);
                return;
            }

            // لا نتفاعل مع الحالات الانتقالية أثناء أول دخول. بعد تأكيد الدخول،
            // خروج حقيقي واحد فقط ينشئ مؤقت إعادة اتصال واحدًا.
            if (this.joinConfirmed) this.scheduleVoiceReconnect();
        });
    }

    scheduleVoiceReconnect() {
        if (this.closed || this.reconnectTimer) return;
        this.joinConfirmed = false;
        void this.stop();
        this.update({ voiceStatus: 'connecting', error: 'انقطع الصوت؛ ستتم إعادة المحاولة.' });
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.closed) return;
            try {
                await this.connect();
            }
            catch {
                this.scheduleVoiceReconnect();
            }
        }, 5_000);
        this.reconnectTimer.unref?.();
    }

    async start(rawUrl, {
        restarting = false,
        height: rawHeight,
        frameRate: rawFrameRate,
        startPosition: rawStartPosition = 0,
    } = {}) {
        const url = String(rawUrl ?? '').trim();
        if (!url) {
            throw new AppError('ضع رابط المقطع أولًا.', 400, 'URL_REQUIRED');
        }
        if (this.voiceStatus !== 'ready' || !this.streamer?.voiceConnection) {
            throw new AppError('اضغط دخول الروم أولًا ثم شغّل الشير.', 409, 'VOICE_NOT_READY');
        }

        const streamHeight = restarting
            ? this.streamHeight
            : selectedStreamSetting(
                rawHeight,
                this.streamHeight,
                STREAM_HEIGHTS,
                'الجودة غير صحيحة. اختر دقة من 144p حتى 4K.',
                'INVALID_STREAM_HEIGHT',
            );
        const streamFps = restarting
            ? this.streamFps
            : selectedStreamSetting(
                rawFrameRate,
                this.streamFps,
                STREAM_FRAME_RATES,
                'قيمة FPS غير صحيحة. اختر 15 أو 24 أو 30 أو 60.',
                'INVALID_STREAM_FPS',
            );
        const requestedStartPosition = Number(rawStartPosition);
        if (!Number.isFinite(requestedStartPosition) || requestedStartPosition < 0) {
            throw new AppError('موضع تشغيل المقطع غير صحيح.', 400, 'INVALID_START_POSITION');
        }
        const encoding = encodingSettings(streamHeight, streamFps, this.streamOptions);

        await this.stop({ quiet: true });
        const generation = ++this.generation;
        const abortController = new AbortController();
        this.abortController = abortController;
        this.update({
            streamStatus: 'resolving',
            streamHeight,
            streamFps,
            videoBitrate: encoding.bitrateVideo,
            videoBitrateMax: encoding.bitrateVideoMax,
            inputUrl: url,
            mediaTitle: restarting ? this.mediaTitle : '',
            positionSeconds: requestedStartPosition,
            playbackOffset: requestedStartPosition,
            playbackStartedAtMs: null,
            startedAt: null,
            endedAt: null,
            loopCount: restarting ? this.loopCount : 0,
            error: null,
        });

        try {
            this.assertCurrent(generation, abortController.signal);

            const media = await this.runtime.resolveMedia(url, {
                signal: abortController.signal,
            });
            this.assertCurrent(generation, abortController.signal);
            this.releaseResolvedMedia();
            this.mediaCleanup = typeof media.cleanup === 'function'
                ? media.cleanup
                : null;
            const mediaKind = media.mediaKind || 'video';
            const mediaDuration = Number.isFinite(media.duration) && media.duration > 0
                ? media.duration
                : null;
            const seekable = Boolean(media.seekable ?? mediaKind === 'video');
            if (requestedStartPosition > 0 && !seekable) {
                throw new AppError(
                    'هذا المصدر لا يدعم التقديم أو التأخير.',
                    409,
                    'MEDIA_NOT_SEEKABLE',
                );
            }
            const startPosition = mediaDuration === null
                ? requestedStartPosition
                : Math.min(requestedStartPosition, Math.max(0, mediaDuration - 0.25));
            const hasAudio = !['image', 'gif'].includes(mediaKind);
            this.update({
                streamStatus: 'starting',
                inputUrl: media.inputUrl,
                mediaTitle: media.title,
                mediaKind,
                mediaDuration,
                seekable,
                hasAudio,
                positionSeconds: startPosition,
                playbackOffset: startPosition,
                playbackStartedAtMs: null,
            });

            const prepared = this.runtime.prepareStream(media.mediaUrl, {
                width: -2,
                height: this.streamHeight,
                frameRate: this.streamFps,
                bitrateVideo: this.videoBitrate,
                bitrateVideoMax: this.videoBitrateMax,
                bitrateAudio: this.streamOptions.bitrateAudio ?? 96,
                includeAudio: hasAudio,
                videoCodec: Utils.normalizeVideoCodec('H264'),
                encoder: Encoders.software({ x264: { preset: 'veryfast' } }),
                customHeaders: media.headers,
                customInputOptions: mediaInputOptions(
                    mediaKind,
                    startPosition,
                    this.streamFps,
                    media.proxyUrl,
                ),
            }, abortController.signal);

            this.prepared = prepared;
            this.playPromise = this.runtime.playStream(
                prepared.output,
                this.streamer,
                { type: 'go-live', streamPreview: false },
                abortController.signal,
            );

            await Promise.race([
                waitFor(
                    () => Boolean(this.streamer?.voiceConnection?.streamConnection?.webRtcParams),
                    STREAM_START_TIMEOUT_MS,
                    abortController.signal,
                    'انتهت مهلة بدء الشير في Discord.',
                ),
                failIfPipelineEndsBeforeReady(prepared.promise),
                failIfPipelineEndsBeforeReady(this.playPromise),
            ]);
            this.assertCurrent(generation, abortController.signal);
            this.watchPlayback(generation, abortController, prepared, this.playPromise, url);
            const playbackStartedAtMs = Date.now();
            this.update({
                streamStatus: 'streaming',
                positionSeconds: startPosition,
                playbackOffset: startPosition,
                playbackStartedAtMs,
                startedAt: new Date(playbackStartedAtMs).toISOString(),
            });

            if (hasAudio && this.volume !== 100) {
                await prepared.controller.setVolume(this.volume / 100).catch(() => false);
            }
            return this.getState();
        }
        catch (error) {
            if (generation !== this.generation) {
                throw new AppError('تم إلغاء طلب التشغيل.', 409, 'START_CANCELLED');
            }

            const original = abortController.signal.aborted
                ? abortController.signal.reason ?? error
                : error;
            const safe = publicError(original);
            const positionSeconds = this.currentPlaybackPosition();
            this.abortCurrent(original);
            this.update({
                streamStatus: 'error',
                positionSeconds,
                playbackOffset: positionSeconds,
                playbackStartedAtMs: null,
                error: safe.message,
            });
            console.error(`[${this.name}] Stream start failed: ${redactLogMessage(original)}`);
            throw safe;
        }
    }

    watchPlayback(generation, abortController, prepared, playPromise, inputUrl) {
        this.lifecyclePromise = Promise.all([prepared.promise, playPromise])
            .then(() => {
                if (generation !== this.generation || abortController.signal.aborted) return;
                const positionSeconds = this.currentPlaybackPosition();
                this.clearStreamHandles();
                this.streamer?.stopStream?.();
                this.update({
                    streamStatus: 'looping',
                    positionSeconds,
                    playbackOffset: positionSeconds,
                    playbackStartedAtMs: null,
                    endedAt: new Date().toISOString(),
                    loopCount: this.loopCount + 1,
                    error: null,
                });
                void this.restartAfterEnd(generation, abortController, inputUrl);
            })
            .catch((error) => {
                if (generation !== this.generation || abortController.signal.aborted) return;
                const safe = publicError(error);
                const positionSeconds = this.currentPlaybackPosition();
                this.abortCurrent(error);
                this.update({
                    streamStatus: 'error',
                    positionSeconds,
                    playbackOffset: positionSeconds,
                    playbackStartedAtMs: null,
                    error: safe.message,
                });
                console.error(`[${this.name}] Stream ended with error: ${redactLogMessage(error)}`);
            });
    }

    async restartAfterEnd(generation, abortController, inputUrl) {
        try {
            await sleep(this.loopDelayMs, abortController.signal);
            this.assertCurrent(generation, abortController.signal);
            if (this.voiceStatus !== 'ready' || !this.streamer?.voiceConnection) return;
            await this.start(inputUrl, { restarting: true });
        }
        catch (error) {
            if (generation !== this.generation || abortController.signal.aborted) return;
            const safe = publicError(error);
            this.update({ streamStatus: 'error', error: safe.message });
            console.error(`[${this.name}] Loop restart failed: ${redactLogMessage(error)}`);
        }
    }

    assertCurrent(generation, signal) {
        if (generation !== this.generation) {
            throw new SupersededError();
        }
        signal.throwIfAborted();
    }

    abortCurrent(reason = new SupersededError()) {
        const controller = this.abortController;
        this.abortController = null;
        if (controller && !controller.signal.aborted) {
            controller.abort(reason);
        }

        try {
            // SIGTERM remains pending on a SIGSTOP'ed FFmpeg process until it continues.
            this.prepared?.command?.kill?.('SIGCONT');
            this.prepared?.command?.kill?.('SIGTERM');
        }
        catch {
            // FFmpeg may already have exited.
        }
        try {
            this.streamer?.stopStream?.();
        }
        catch {
            // The Go Live connection may not have completed yet.
        }
        this.clearStreamHandles();
    }

    clearStreamHandles() {
        this.prepared = null;
        this.playPromise = null;
        this.lifecyclePromise = null;
        this.releaseResolvedMedia();
    }

    releaseResolvedMedia() {
        const cleanup = this.mediaCleanup;
        this.mediaCleanup = null;
        if (!cleanup) return;
        try {
            void Promise.resolve(cleanup()).catch((error) => {
                console.error(`[${this.name}] Media cleanup failed: ${redactLogMessage(error)}`);
            });
        }
        catch (error) {
            console.error(`[${this.name}] Media cleanup failed: ${redactLogMessage(error)}`);
        }
    }

    async stop({ quiet = false } = {}) {
        const positionSeconds = this.currentPlaybackPosition();
        const wasActive = ['resolving', 'starting', 'streaming', 'paused', 'stopping', 'looping']
            .includes(this.streamStatus);
        ++this.generation;
        if (wasActive && !quiet) this.update({ streamStatus: 'stopping', error: null });
        this.abortCurrent(new SupersededError());

        if (!quiet || wasActive) {
            this.update({
                streamStatus: 'idle',
                positionSeconds,
                playbackOffset: positionSeconds,
                playbackStartedAtMs: null,
                startedAt: null,
                endedAt: wasActive ? new Date().toISOString() : this.endedAt,
                error: null,
            });
        }
        return this.getState();
    }

    async pause() {
        if (this.streamStatus !== 'streaming' || !this.prepared?.command) {
            throw new AppError('لا يوجد مقطع يعمل لإيقافه مؤقتًا.', 409, 'STREAM_NOT_PLAYING');
        }
        const positionSeconds = this.currentPlaybackPosition();
        try {
            this.prepared.command.kill('SIGSTOP');
        }
        catch {
            throw new AppError('تعذر إيقاف المقطع مؤقتًا.', 500, 'PAUSE_FAILED');
        }
        this.update({
            streamStatus: 'paused',
            positionSeconds,
            playbackOffset: positionSeconds,
            playbackStartedAtMs: null,
            error: null,
        });
        return this.getState();
    }

    async resume() {
        if (this.streamStatus !== 'paused' || !this.prepared?.command) {
            throw new AppError('المقطع ليس متوقفًا مؤقتًا.', 409, 'STREAM_NOT_PAUSED');
        }
        try {
            this.prepared.command.kill('SIGCONT');
        }
        catch {
            throw new AppError('تعذر استكمال المقطع.', 500, 'RESUME_FAILED');
        }
        const playbackStartedAtMs = Date.now();
        this.update({
            streamStatus: 'streaming',
            playbackOffset: this.positionSeconds,
            playbackStartedAtMs,
            error: null,
        });
        if (this.hasAudio && this.prepared?.controller) {
            await this.prepared.controller.setVolume(this.volume / 100).catch(() => false);
        }
        return this.getState();
    }

    async seek(rawSeconds) {
        const seconds = Number(rawSeconds);
        if (![15, -15].includes(seconds)) {
            throw new AppError('المسموح تقديم أو تأخير 15 ثانية فقط.', 400, 'INVALID_SEEK');
        }
        if (!['streaming', 'paused'].includes(this.streamStatus)) {
            throw new AppError('شغّل المقطع أولًا.', 409, 'STREAM_NOT_PLAYING');
        }
        if (!this.seekable) {
            throw new AppError(
                'التقديم والتأخير متاحان للفيديو وYouTube، وليس للصورة أو GIF أو البث المباشر.',
                409,
                'MEDIA_NOT_SEEKABLE',
            );
        }

        const wasPaused = this.streamStatus === 'paused';
        const currentPosition = this.currentPlaybackPosition();
        let targetPosition = Math.max(0, currentPosition + seconds);
        if (Number.isFinite(this.mediaDuration)) {
            targetPosition = Math.min(targetPosition, Math.max(0, this.mediaDuration - 0.25));
        }
        if (wasPaused) {
            try { this.prepared?.command?.kill?.('SIGCONT'); } catch { /* stop() will clean up. */ }
        }
        await this.start(this.inputUrl, {
            restarting: true,
            startPosition: targetPosition,
        });
        if (wasPaused) return this.pause();
        return this.getState();
    }

    async setVolume(value) {
        const volume = Number(value);
        if (!Number.isFinite(volume) || volume < 0 || volume > 200) {
            throw new AppError('مستوى الصوت يجب أن يكون بين 0 و200.', 400, 'INVALID_VOLUME');
        }

        this.volume = Math.round(volume);
        if (this.hasAudio && this.prepared?.controller && this.streamStatus === 'streaming') {
            const changed = await this.prepared.controller.setVolume(this.volume / 100);
            if (!changed) {
                throw new AppError(
                    'تعذر تغيير الصوت أثناء البث. تأكد أن FFmpeg يدعم libzmq.',
                    500,
                    'VOLUME_FAILED',
                );
            }
        }
        this.update({ volume: this.volume });
        return this.getState();
    }

    async destroyClient() {
        const streamer = this.streamer;
        const client = this.client;
        const hadVoiceConnection = Boolean(streamer?.voiceConnection);
        this.joinConfirmed = false;

        try {
            streamer?.leaveVoice?.();
        }
        catch {
            // Nothing to close.
        }
        if (hadVoiceConnection && discordIdPattern.test(this.serverId)) {
            try {
                // The streaming library sends guild_id=null on leave. Send the guild-specific
                // leave as well before closing this room's isolated Gateway session.
                streamer?.sendOpcode?.(VOICE_STATE_OPCODE, {
                    guild_id: this.serverId,
                    channel_id: null,
                    self_mute: true,
                    self_deaf: false,
                    self_video: false,
                });
            }
            catch {
                // The Gateway may already be closed.
            }
        }
        this.streamer = null;
        this.client = null;
        this.boundClient = null;
        try { await Promise.resolve(client?.destroy?.()); } catch { /* Already closed. */ }
    }

    async shutdown() {
        this.closed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        await this.stop({ quiet: true });
        await this.destroyClient();
        this.update({ voiceStatus: 'offline' });
    }
}

export class DisabledRoomSession {
    constructor(config) {
        this.id = config.id;
        this.name = config.name;
        this.serverId = config.serverId || '';
        this.channelId = config.channelId || '';
        this.streamOptions = config.streamOptions ?? {};
        this.reason = config.reason || 'متغير token1 غير موجود في Environment.';
    }

    getState() {
        return {
            id: this.id,
            name: this.name,
            configured: false,
            serverId: this.serverId,
            channelId: this.channelId,
            voiceStatus: 'disabled',
            streamStatus: 'idle',
            volume: 100,
            streamHeight: closestAllowed(
                this.streamOptions?.height,
                STREAM_HEIGHTS,
                480,
            ),
            streamFps: closestAllowed(
                this.streamOptions?.frameRate,
                STREAM_FRAME_RATES,
                24,
            ),
            videoBitrate: Number(this.streamOptions?.bitrateVideo) || 1_400,
            inputUrl: '',
            mediaTitle: '',
            mediaKind: null,
            durationSeconds: null,
            positionSeconds: 0,
            seekable: false,
            hasAudio: true,
            startedAt: null,
            endedAt: null,
            loopCount: 0,
            selfMute: false,
            selfDeaf: false,
            error: this.reason,
            username: null,
        };
    }

    reject() {
        throw new AppError(this.reason, 409, 'ROOM_NOT_CONFIGURED');
    }

    connect() { return Promise.resolve(); }
    join() { return this.reject(); }
    leave() { return this.reject(); }
    setSelfMute() { return this.reject(); }
    setSelfDeaf() { return this.reject(); }
    start() { return this.reject(); }
    pause() { return this.reject(); }
    resume() { return this.reject(); }
    seek() { return this.reject(); }
    stop() { return this.reject(); }
    setVolume() { return this.reject(); }
    shutdown() { return Promise.resolve(); }
}

export function createRoomSessions(accountConfigs, streamOptions = {}, runtime = defaultRuntime) {
    const configs = Array.isArray(accountConfigs) ? accountConfigs : [];
    const account = configs.find((item) => typeof item?.token === 'string' && item.token.trim())
        ?? configs[0]
        ?? {};
    const token = typeof account?.token === 'string' ? account.token.trim() : '';
    const voiceChannels = Array.isArray(account?.voiceChannels)
        ? account.voiceChannels
        : [];
    return Array.from({ length: 4 }, (_, index) => {
        const roomNumber = index + 1;
        const channel = voiceChannels[index] ?? {};
        const config = {
            id: `room-${roomNumber}`,
            name: String(channel?.name || `الروم ${roomNumber}`),
            token,
            serverId: String(channel?.serverId ?? '').trim(),
            channelId: String(channel?.channelId ?? '').trim(),
            streamOptions,
            reason: token ? '' : 'متغير token1 غير موجود في Environment.',
        };
        return token
            ? new RoomStreamSession(config, runtime)
            : new DisabledRoomSession(config);
    });
}
