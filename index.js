import tokens from './tokens.js';
import { createDashboardApp } from './dashboard.js';
import { createRoomSessions } from './roomStreamSession.js';

function envNumber(name, fallback, minimum, maximum) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
        return fallback;
    }
    return Math.round(value);
}

const controlPassword = process.env.CONTROL_PASSWORD;
if (!controlPassword) {
    throw new Error('CONTROL_PASSWORD is required to protect the web dashboard.');
}
if (controlPassword.length < 10) {
    console.warn('CONTROL_PASSWORD is short; use at least 10 characters.');
}

const videoBitrate = envNumber('STREAM_VIDEO_BITRATE', 1_400, 300, 8_000);
const streamOptions = {
    height: envNumber('STREAM_HEIGHT', 480, 240, 1_080),
    frameRate: envNumber('STREAM_FPS', 24, 10, 60),
    bitrateVideo: videoBitrate,
    bitrateVideoMax: Math.max(
        videoBitrate,
        envNumber('STREAM_VIDEO_MAX_BITRATE', 1_800, 400, 10_000),
    ),
    bitrateAudio: envNumber('STREAM_AUDIO_BITRATE', 96, 32, 320),
};

const rooms = createRoomSessions(tokens, streamOptions);
const app = createDashboardApp({
    rooms,
    controlPassword,
    sessionSecret: process.env.DASHBOARD_SECRET,
});
const port = envNumber('PORT', 3_000, 1, 65_535);
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Protected dashboard listening on port ${port}`);
    console.log(`Dashboard room slots: ${rooms.filter((room) => room.getState().configured).length}/4`);
    console.log('Voice mode: manual join from dashboard');
    console.log('YouTube mode: anonymous PO Token + browser impersonation (no user cookies)');
});

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal}: stopping streams and closing connections...`);

    const forceExit = setTimeout(() => {
        console.error('Shutdown timed out.');
        process.exit(1);
    }, 20_000);
    forceExit.unref();

    server.close();
    await Promise.allSettled(rooms.map((room) => room.shutdown()));
    server.closeAllConnections?.();
    clearTimeout(forceExit);
    process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    console.error(`Unhandled rejection: ${String(reason?.message || reason).slice(0, 800)}`);
});
process.on('uncaughtException', (error) => {
    console.error(`Uncaught exception: ${String(error?.message || error).slice(0, 800)}`);
    void shutdown('uncaughtException');
});
