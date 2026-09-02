import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AppError, publicError } from './errors.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(moduleDirectory, 'public');
const COOKIE_NAME = 'discord_stream_control';
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const LOGIN_MAX_ATTEMPTS = 5;

function parseCookies(header = '') {
    const cookies = {};
    for (const part of header.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 1) continue;
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        try {
            cookies[name] = decodeURIComponent(value);
        }
        catch {
            cookies[name] = value;
        }
    }
    return cookies;
}

function sameSecret(left, right) {
    const leftHash = crypto.createHash('sha256').update(String(left)).digest();
    const rightHash = crypto.createHash('sha256').update(String(right)).digest();
    return crypto.timingSafeEqual(leftHash, rightHash);
}

function createSessionAuth(secret) {
    const sign = (payload) => crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('base64url');

    return {
        create() {
            const expiresAt = Date.now() + SESSION_SECONDS * 1_000;
            const payload = `v1.${expiresAt}`;
            return `${payload}.${sign(payload)}`;
        },
        verify(token) {
            const parts = String(token || '').split('.');
            if (parts.length !== 3 || parts[0] !== 'v1') return false;
            const payload = `${parts[0]}.${parts[1]}`;
            const expiresAt = Number(parts[1]);
            if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
            return sameSecret(parts[2], sign(payload));
        },
    };
}

function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function createDashboardApp({
    rooms,
    controlPassword,
    sessionSecret,
    production = process.env.NODE_ENV === 'production',
}) {
    if (!controlPassword) {
        throw new Error('CONTROL_PASSWORD is required');
    }

    const app = express();
    const auth = createSessionAuth(sessionSecret || `discord-dashboard:${controlPassword}`);
    const loginAttempts = new Map();
    const joinReservations = new Map();

    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use((req, res, next) => {
        res.set({
            'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        });
        if (production) {
            res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }
        if (req.path !== '/health') {
            res.set('Cache-Control', 'no-store');
        }
        next();
    });
    app.use(express.json({ limit: '16kb' }));
    app.use(express.urlencoded({ extended: false, limit: '8kb' }));
    app.use('/assets', express.static(publicDirectory, {
        etag: false,
        fallthrough: false,
        maxAge: 0,
        setHeaders(res) {
            res.setHeader('Cache-Control', 'no-store');
        },
    }));

    const isAuthenticated = (req) => {
        const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
        return auth.verify(token);
    };

    const setAuthCookie = (res) => {
        const attributes = [
            `${COOKIE_NAME}=${encodeURIComponent(auth.create())}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Strict',
            `Max-Age=${SESSION_SECONDS}`,
        ];
        if (production) attributes.push('Secure');
        res.setHeader('Set-Cookie', attributes.join('; '));
    };

    const clearAuthCookie = (res) => {
        const attributes = [
            `${COOKIE_NAME}=`,
            'Path=/',
            'HttpOnly',
            'SameSite=Strict',
            'Max-Age=0',
        ];
        if (production) attributes.push('Secure');
        res.setHeader('Set-Cookie', attributes.join('; '));
    };

    const requirePageAuth = (req, res, next) => {
        if (isAuthenticated(req)) return next();
        return res.redirect(303, '/login');
    };
    const requireApiAuth = (req, res, next) => {
        if (isAuthenticated(req)) return next();
        return res.status(401).json({ ok: false, error: 'انتهت الجلسة. سجل الدخول من جديد.' });
    };
    const requireDashboardRequest = (req, res, next) => {
        if (req.get('X-Control-Request') !== 'dashboard') {
            return res.status(403).json({ ok: false, error: 'طلب غير مسموح.' });
        }
        const origin = req.get('Origin');
        if (origin) {
            try {
                if (new URL(origin).host !== req.get('host')) {
                    return res.status(403).json({ ok: false, error: 'مصدر الطلب غير مسموح.' });
                }
            }
            catch {
                return res.status(403).json({ ok: false, error: 'مصدر الطلب غير صحيح.' });
            }
        }
        return next();
    };

    const findRoom = (roomId) => {
        const room = rooms.find(({ id }) => id === roomId);
        if (!room) throw new AppError('الروم غير موجود.', 404, 'ROOM_NOT_FOUND');
        return room;
    };

    app.get('/health', (req, res) => {
        res.json({
            ok: true,
            configuredRooms: rooms.filter((room) => room.getState().configured).length,
        });
    });

    app.get('/login', (req, res) => {
        if (isAuthenticated(req)) return res.redirect(303, '/');
        return res.sendFile(path.join(publicDirectory, 'login.html'));
    });

    app.post('/login', (req, res) => {
        const key = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        for (const [attemptKey, attempt] of loginAttempts) {
            if (now - attempt.startedAt >= LOGIN_WINDOW_MS) loginAttempts.delete(attemptKey);
        }
        const previous = loginAttempts.get(key);
        const record = !previous || now - previous.startedAt >= LOGIN_WINDOW_MS
            ? { startedAt: now, attempts: 0 }
            : previous;

        if (record.attempts >= LOGIN_MAX_ATTEMPTS) {
            loginAttempts.set(key, record);
            return res.redirect(303, '/login?error=rate');
        }

        if (!sameSecret(req.body?.password ?? '', controlPassword)) {
            record.attempts += 1;
            loginAttempts.set(key, record);
            return res.redirect(303, '/login?error=wrong');
        }

        loginAttempts.delete(key);
        setAuthCookie(res);
        return res.redirect(303, '/');
    });

    app.get('/', requirePageAuth, (req, res) => {
        res.sendFile(path.join(publicDirectory, 'dashboard.html'));
    });

    app.use('/api', requireApiAuth);

    app.get('/api/rooms', (req, res) => {
        res.json({ ok: true, rooms: rooms.map((room) => room.getState()) });
    });

    app.post('/api/rooms/:roomId/join', requireDashboardRequest, asyncRoute(async (req, res) => {
        const room = findRoom(req.params.roomId);
        const serverId = String(req.body?.serverId ?? '').trim();
        const channelId = String(req.body?.channelId ?? '').trim();
        const reservation = joinReservations.get(serverId);
        const duplicate = rooms.find((other) => {
            if (other === room) return false;
            if (room.sharesAccountWith?.(other) === false) return false;
            const state = other.getState();
            return state.serverId === serverId
                && ['connecting', 'joining', 'ready'].includes(state.voiceStatus);
        });

        if ((reservation && reservation !== room.id) || duplicate) {
            throw new AppError(
                'الحساب داخل هذا السيرفر من بطاقة أخرى. استخدم سيرفرًا مختلفًا أو اخرج من البطاقة الأخرى.',
                409,
                'SERVER_ALREADY_ACTIVE',
            );
        }

        joinReservations.set(serverId, room.id);
        try {
            const state = await room.join(serverId, channelId);
            res.json({ ok: true, room: state });
        }
        finally {
            if (joinReservations.get(serverId) === room.id) {
                joinReservations.delete(serverId);
            }
        }
    }));

    app.post('/api/rooms/:roomId/leave', requireDashboardRequest, asyncRoute(async (req, res) => {
        const room = findRoom(req.params.roomId);
        const state = await room.leave();
        res.json({ ok: true, room: state });
    }));

    app.post('/api/rooms/:roomId/mute', requireDashboardRequest, asyncRoute(async (req, res) => {
        const room = findRoom(req.params.roomId);
        const state = await room.setSelfMute(req.body?.enabled);
        res.json({ ok: true, room: state });
    }));

    app.post('/api/rooms/:roomId/deaf', requireDashboardRequest, asyncRoute(async (req, res) => {
        const room = findRoom(req.params.roomId);
        const state = await room.setSelfDeaf(req.body?.enabled);
        res.json({ ok: true, room: state });
    }));

    app.post('/api/rooms/:roomId/start', requireDashboardRequest, asyncRoute(async (req, res) => {
        const room = findRoom(req.params.roomId);
        const state = await room.start(req.body?.url, {
            height: req.body?.height,
            frameRate: req.body?.frameRate,
        });
        res.json({ ok: true, room: state });
    }));

    app.post('/api/rooms/:roomId/pause', requireDashboardRequest, asyncRoute(async (req, res) => {
        const room = findRoom(req.params.roomId);
        const state = await room.pause();
        res.json({ ok: true, room: state });
    }));

    app.post('/api/rooms/:roomId/resume', requireDashboardRequest, asyncRoute(async (req, res) => {
        const room = findRoom(req.params.roomId);
        const state = await room.resume();
        res.json({ ok: true, room: state });
    }));

    app.post('/api/rooms/:roomId/seek', requireDashboardRequest, asyncRoute(async (req, res) => {
        const room = findRoom(req.params.roomId);
        const state = await room.seek(req.body?.seconds);
        res.json({ ok: true, room: state });
    }));

    app.post('/api/rooms/:roomId/stop', requireDashboardRequest, asyncRoute(async (req, res) => {
        const room = findRoom(req.params.roomId);
        const state = await room.stop();
        res.json({ ok: true, room: state });
    }));

    app.post('/api/rooms/:roomId/volume', requireDashboardRequest, asyncRoute(async (req, res) => {
        const room = findRoom(req.params.roomId);
        const state = await room.setVolume(req.body?.volume);
        res.json({ ok: true, room: state });
    }));

    app.post('/api/logout', requireApiAuth, requireDashboardRequest, (req, res) => {
        clearAuthCookie(res);
        res.status(204).end();
    });

    app.use('/api', (req, res) => {
        res.status(404).json({ ok: false, error: 'المسار غير موجود.' });
    });

    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        const malformedJson = error instanceof SyntaxError && error.status === 400 && 'body' in error;
        const safe = malformedJson
            ? new AppError('بيانات الطلب غير صحيحة.', 400, 'INVALID_JSON')
            : publicError(error);
        if (!(error instanceof AppError) && !malformedJson) {
            console.error(`Dashboard request failed: ${String(error?.message || error).slice(0, 500)}`);
        }
        return res.status(safe.statusCode).json({
            ok: false,
            error: safe.message,
            code: safe.code,
        });
    });

    return app;
}
