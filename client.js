import WebSocket from 'ws';
import { EventEmitter } from 'events';

const blackListedEvents = [
    'CHANNEL_UNREAD_UPDATE',
    'CONVERSATION_SUMMARY_UPDATE',
    'SESSIONS_REPLACE',
];
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const statusList = ['online', 'idle', 'dnd', 'invisible', 'offline'];
const discordIdPattern = /^\d{17,20}$/;

export class voiceClient extends EventEmitter {
    ws = null;
    heartbeatInterval = null;
    gatewayReconnectTimeout = null;
    sequenceNumber = null;
    hasReady = false;
    manualDisconnect = false;
    invalidSession = false;
    token;
    voiceChannels = [];
    voiceChannelsByGuild = new Map();
    joinedGuilds = new Set();
    voiceSessionIds = new Map();
    pendingVoiceJoins = new Map();
    voiceReconnectStates = new Map();
    selfMute;
    selfDeaf;
    autoReconnect;
    presence;
    user_id = null;

    constructor(config) {
        super();

        if (!config?.token) {
            throw new Error('token is required');
        }

        this.token = config.token;
        this.selfMute = config.selfMute ?? true;
        this.selfDeaf = config.selfDeaf ?? true;

        const configuredDelay = Number(config.autoReconnect?.delay ?? 1);
        const configuredMaxRetries = Number(config.autoReconnect?.maxRetries ?? 9999);
        const configuredConfirmationTimeout = Number(
            config.autoReconnect?.confirmationTimeout ?? 15,
        );
        this.autoReconnect = {
            enabled: config.autoReconnect?.enabled ?? false,
            delay: (Number.isFinite(configuredDelay) && configuredDelay >= 0
                ? configuredDelay
                : 1) * 1000,
            maxRetries: Number.isInteger(configuredMaxRetries) && configuredMaxRetries >= 0
                ? configuredMaxRetries
                : 9999,
            confirmationTimeout: (Number.isFinite(configuredConfirmationTimeout)
                && configuredConfirmationTimeout >= 1
                ? configuredConfirmationTimeout
                : 15) * 1000,
        };

        const configuredVoiceChannels = Array.isArray(config.voiceChannels)
            ? config.voiceChannels
            : [{
                serverId: config.serverId,
                channelId: config.channelId,
                selfMute: config.selfMute,
                selfDeaf: config.selfDeaf,
            }];

        configuredVoiceChannels.forEach((voiceChannel, index) => {
            const serverId = String(voiceChannel?.serverId ?? '').trim();
            const channelId = String(voiceChannel?.channelId ?? '').trim();

            // يسمح بترك السطر الثاني فارغًا إلى أن تتم إضافة الأيديات.
            if (!serverId && !channelId) {
                return;
            }

            if (!discordIdPattern.test(serverId) || !discordIdPattern.test(channelId)) {
                throw new Error(`Invalid serverId/channelId in voiceChannels[${index}]`);
            }

            const existingTarget = this.voiceChannelsByGuild.get(serverId);
            if (existingTarget && existingTarget.channelId !== channelId) {
                throw new Error(`Only one voice channel can be configured per server (${serverId})`);
            }

            const target = {
                serverId,
                channelId,
                selfMute: voiceChannel.selfMute ?? this.selfMute,
                selfDeaf: voiceChannel.selfDeaf ?? this.selfDeaf,
            };

            this.voiceChannelsByGuild.set(serverId, target);
        });

        this.voiceChannels = [...this.voiceChannelsByGuild.values()];

        if (config.presence?.status) {
            this.presence = config.presence;
        }

        this.setMaxListeners(Math.max(10, this.voiceChannels.length + 5));
    }

    connect() {
        if (this.invalidSession) {
            return;
        }

        if (this.ws && [WebSocket.CONNECTING, WebSocket.OPEN].includes(this.ws.readyState)) {
            return;
        }

        this.manualDisconnect = false;
        if (this.gatewayReconnectTimeout) {
            clearTimeout(this.gatewayReconnectTimeout);
            this.gatewayReconnectTimeout = null;
        }

        const socket = new WebSocket(GATEWAY_URL, {
            skipUTF8Validation: true,
        });
        this.ws = socket;

        socket.on('open', () => {
            this.emit('connected');
            this.emit('debug', '🌐 Connected to Discord Gateway');
        });

        socket.on('message', (data) => {
            let payload;
            try {
                payload = JSON.parse(data.toString());
            }
            catch (error) {
                this.emit('error', error);
                return;
            }

            const { t: eventType, s: seq, op, d } = payload;

            if (seq !== null && seq !== undefined) {
                this.sequenceNumber = seq;
            }

            if (blackListedEvents.includes(eventType)) {
                return;
            }

            switch (op) {
                case 10: // Hello
                    this.emit('debug', 'Received Hello (op 10)');
                    this.startHeartbeat(d.heartbeat_interval);
                    this.identify();
                    break;

                case 11: // Heartbeat ACK
                    this.emit('debug', 'Heartbeat acknowledged');
                    break;

                case 9: // Invalid Session
                    this.emit('debug', 'Invalid session. Connection stopped.');
                    this.invalidSession = true;
                    socket.terminate();
                    break;

                case 0: // Dispatch
                    if (eventType === 'READY') {
                        this.hasReady = true;
                        this.user_id = d.user.id;
                        this.emit('ready', {
                            username: d.user.username,
                            discriminator: d.user.discriminator,
                        });
                        this.emit('debug', `🎉 Logged in as ${d.user.username}#${d.user.discriminator}`);
                        this.joinAllVoiceChannels();
                        this.sendStatusUpdate();
                    }
                    else if (eventType === 'VOICE_STATE_UPDATE') {
                        this.handleVoiceStateUpdate(d);
                    }
                    break;
            }
        });

        socket.on('close', () => {
            const wasReady = this.hasReady;
            this.emit('disconnected');
            this.emit('debug', '❌ Disconnected from Discord Gateway');

            if (this.ws === socket) {
                this.cleanupGatewayState();
            }

            if (this.manualDisconnect || this.invalidSession) {
                return;
            }

            if (!wasReady) {
                console.log('Bad token or Discord Gateway rejected the session');
                return;
            }

            this.emit('debug', 'Reconnecting to Discord Gateway in 5 seconds...');
            this.gatewayReconnectTimeout = setTimeout(() => this.connect(), 5000);
        });

        socket.on('error', (error) => {
            this.emit('error', error);
            this.emit('debug', `WebSocket error: ${error.message}`);
        });
    }

    startHeartbeat(interval) {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        this.heartbeatInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ op: 1, d: this.sequenceNumber }));
                this.emit('debug', 'Sending heartbeat');
            }
        }, interval);
    }

    identify() {
        const payload = {
            op: 2,
            d: {
                token: this.token,
                intents: 128,
                properties: {
                    os: 'Windows',
                    browser: 'Chrome',
                    device: '',
                },
            },
        };

        this.sendGatewayPayload(payload);
        this.emit('debug', 'Sending identify payload');
    }

    joinAllVoiceChannels() {
        for (const { serverId } of this.voiceChannels) {
            this.joinVoiceChannel(serverId);
        }
    }

    joinVoiceChannel(serverId) {
        const target = this.voiceChannelsByGuild.get(String(serverId));
        if (!target) {
            return false;
        }

        // لا نرسل طلبًا ثانيًا بينما لا يزال الطلب الأول بانتظار تأكيد ديسكورد.
        if (this.pendingVoiceJoins.has(target.serverId)) {
            return false;
        }

        const sent = this.sendGatewayPayload({
            op: 4,
            d: {
                guild_id: target.serverId,
                channel_id: target.channelId,
                self_mute: target.selfMute,
                self_deaf: target.selfDeaf,
            },
        });

        if (sent) {
            const pendingJoin = {
                requestedAt: Date.now(),
                timeout: null,
            };
            pendingJoin.timeout = setTimeout(() => {
                if (this.pendingVoiceJoins.get(target.serverId) === pendingJoin) {
                    this.pendingVoiceJoins.delete(target.serverId);
                    this.emit(
                        'debug',
                        `Voice join confirmation timed out for server ${target.serverId}; no duplicate request sent`,
                    );
                }
            }, this.autoReconnect.confirmationTimeout);
            this.pendingVoiceJoins.set(target.serverId, pendingJoin);
            this.emit('debug', `🎤 Sent voice join request: ${target.serverId}/${target.channelId}`);
        }

        return sent;
    }

    handleVoiceStateUpdate(voiceState) {
        if (voiceState?.user_id !== this.user_id) {
            return;
        }

        const serverId = String(voiceState.guild_id ?? '');
        const target = this.voiceChannelsByGuild.get(serverId);

        // مهم: نتجاهل تغييرات السيرفرات الأخرى حتى لا يفصل رومٌ رومًا آخر.
        if (!target) {
            return;
        }

        if (voiceState.channel_id === target.channelId) {
            const isFirstConfirmation = !this.joinedGuilds.has(serverId);
            const hadPendingJoin = this.pendingVoiceJoins.has(serverId);

            // نحفظ جلسة الصوت التي أنشأها هذا الاتصال تحديدًا؛ عند وجود عدة
            // Gateway sessions لن نتفاعل مع حدث صادر من جلسة روم أخرى.
            if (voiceState.session_id && (hadPendingJoin || !this.voiceSessionIds.has(serverId))) {
                this.voiceSessionIds.set(serverId, voiceState.session_id);
            }

            this.clearPendingVoiceJoin(serverId);
            this.joinedGuilds.add(serverId);
            this.clearVoiceReconnect(serverId);

            if (isFirstConfirmation) {
                this.emit('voiceReady', target);
                this.emit('debug', `✅ Voice channel joined: ${target.serverId}/${target.channelId}`);
            }
            return;
        }

        // أحداث الحالة الانتقالية التي تصل أثناء أول دخول لا تعني أن الحساب طُرد.
        // لا نعيد الاتصال إلا إذا كان دخوله للروم قد تأكد سابقًا ثم خرج فعلًا.
        if (!this.joinedGuilds.has(serverId)) {
            return;
        }

        const expectedVoiceSessionId = this.voiceSessionIds.get(serverId);
        if (
            expectedVoiceSessionId
            && voiceState.session_id
            && voiceState.session_id !== expectedVoiceSessionId
        ) {
            this.emit('debug', `Ignored voice event from another session in server ${serverId}`);
            return;
        }

        this.joinedGuilds.delete(serverId);
        this.clearPendingVoiceJoin(serverId);
        this.scheduleVoiceReconnect(target);
    }

    scheduleVoiceReconnect(target) {
        if (!this.autoReconnect.enabled) {
            return;
        }

        const serverId = target.serverId;
        const state = this.voiceReconnectStates.get(serverId) ?? {
            attempts: 0,
            timeout: null,
            exhausted: false,
        };

        if (state.timeout || state.exhausted) {
            return;
        }

        if (state.attempts >= this.autoReconnect.maxRetries) {
            state.exhausted = true;
            this.voiceReconnectStates.set(serverId, state);
            this.emit('debug', `Max voice reconnect attempts reached for server ${serverId}`);
            return;
        }

        state.attempts += 1;
        this.emit(
            'debug',
            `Reconnecting voice in server ${serverId} (${state.attempts}/${this.autoReconnect.maxRetries})`,
        );

        state.timeout = setTimeout(() => {
            state.timeout = null;
            this.joinVoiceChannel(serverId);
        }, this.autoReconnect.delay);

        this.voiceReconnectStates.set(serverId, state);
    }

    clearVoiceReconnect(serverId) {
        const state = this.voiceReconnectStates.get(serverId);
        if (state?.timeout) {
            clearTimeout(state.timeout);
        }
        this.voiceReconnectStates.delete(serverId);
    }

    clearPendingVoiceJoin(serverId) {
        const pendingJoin = this.pendingVoiceJoins.get(serverId);
        if (pendingJoin?.timeout) {
            clearTimeout(pendingJoin.timeout);
        }
        this.pendingVoiceJoins.delete(serverId);
    }

    sendStatusUpdate() {
        const status = this.presence?.status?.toLowerCase();
        if (!status || !statusList.includes(status)) {
            return;
        }

        this.sendGatewayPayload({
            op: 3,
            d: {
                status,
                activities: [],
                since: Math.floor(Date.now() / 1000) - 10,
                afk: true,
            },
        });
        this.emit('debug', `Status updated to ${status}`);
    }

    sendGatewayPayload(payload) {
        if (this.ws?.readyState !== WebSocket.OPEN) {
            return false;
        }

        this.ws.send(JSON.stringify(payload));
        return true;
    }

    cleanupGatewayState() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }

        for (const state of this.voiceReconnectStates.values()) {
            if (state.timeout) {
                clearTimeout(state.timeout);
            }
        }

        for (const pendingJoin of this.pendingVoiceJoins.values()) {
            if (pendingJoin.timeout) {
                clearTimeout(pendingJoin.timeout);
            }
        }

        this.voiceReconnectStates.clear();
        this.pendingVoiceJoins.clear();
        this.voiceSessionIds.clear();
        this.joinedGuilds.clear();
        this.ws = null;
        this.sequenceNumber = null;
        this.user_id = null;
        this.hasReady = false;
    }

    disconnect() {
        this.manualDisconnect = true;

        if (this.gatewayReconnectTimeout) {
            clearTimeout(this.gatewayReconnectTimeout);
            this.gatewayReconnectTimeout = null;
        }

        const socket = this.ws;
        this.cleanupGatewayState();

        if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) {
            socket.close();
        }

        this.emit('debug', 'Client manually disconnected');
    }
}
