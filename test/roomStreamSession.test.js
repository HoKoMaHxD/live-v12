import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createRoomSessions, RoomStreamSession } from '../roomStreamSession.js';

class FakeClient extends EventEmitter {
    constructor() {
        super();
        this.user = { id: '999999999999999999', tag: 'tester#0001' };
        this.destroyed = false;
    }
    async login() { return 'token'; }
    destroy() { this.destroyed = true; }
}

class CountingFakeClient extends FakeClient {
    static loginCount = 0;
    async login() {
        CountingFakeClient.loginCount += 1;
        return 'token';
    }
}

class FakeStreamer {
    constructor(client) {
        this.client = client;
        this._gatewayEmitter = new EventEmitter();
        this.voiceConnection = null;
        this.stopCount = 0;
        this.opcodes = [];
    }
    joinVoice(serverId, channelId) {
        this.voiceConnection = {
            guildId: serverId,
            channelId,
            streamConnection: null,
            sessions: [],
            setSession(sessionId) { this.sessions.push(sessionId); },
        };
        return Promise.resolve(this.voiceConnection);
    }
    stopStream() {
        this.stopCount += 1;
        if (this.voiceConnection) this.voiceConnection.streamConnection = null;
    }
    sendOpcode(code, data) { this.opcodes.push({ code, data }); }
    leaveVoice() { this.voiceConnection = null; }
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function waitUntil(check, timeoutMs = 1_000) {
    const startedAt = Date.now();
    while (!check()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Timed out waiting for test state');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function makeSession(id, serverId, channelId, mediaOverrides = {}) {
    const mediaDone = createDeferred();
    const playDone = createDeferred();
    let volume = 1;
    let prepareOptions;
    const killSignals = [];
    const runtime = {
        ClientClass: FakeClient,
        StreamerClass: FakeStreamer,
        resolveMedia: async (url) => ({
            inputUrl: url,
            mediaUrl: url,
            title: id,
            headers: {},
            mediaKind: 'video',
            seekable: true,
            duration: null,
            ...mediaOverrides,
        }),
        prepareStream: (mediaUrl, options) => {
            prepareOptions = options;
            return {
                output: {},
                command: { kill(signal) { killSignals.push(signal); } },
                promise: mediaDone.promise,
                controller: {
                    async setVolume(value) { volume = value; return true; },
                },
            };
        },
        playStream: async (output, streamer) => {
            streamer.voiceConnection.streamConnection = { webRtcParams: { ready: true } };
            return playDone.promise;
        },
    };
    const session = new RoomStreamSession({
        id,
        name: id,
        token: 'x'.repeat(60),
        serverId,
        channelId,
    }, runtime);
    return {
        session,
        mediaDone,
        playDone,
        getVolume: () => volume,
        getPrepareOptions: () => prepareOptions,
        getKillSignals: () => [...killSignals],
    };
}

test('rooms stream and stop independently', async (t) => {
    const first = makeSession('room-1', '111111111111111111', '211111111111111111');
    const second = makeSession('room-2', '122222222222222222', '222222222222222222');
    t.after(async () => Promise.all([first.session.shutdown(), second.session.shutdown()]));

    await Promise.all([
        first.session.join('111111111111111111', '211111111111111111'),
        second.session.join('122222222222222222', '222222222222222222'),
    ]);
    await Promise.all([
        first.session.start('https://8.8.8.8/first.mp4', { height: 2160, frameRate: 60 }),
        second.session.start('https://8.8.8.8/second.mp4', { height: 144, frameRate: 15 }),
    ]);
    assert.equal(first.session.getState().streamStatus, 'streaming');
    assert.equal(second.session.getState().streamStatus, 'streaming');
    assert.equal(first.session.getState().streamHeight, 2160);
    assert.equal(first.session.getState().streamFps, 60);
    assert.equal(first.getPrepareOptions().height, 2160);
    assert.equal(first.getPrepareOptions().frameRate, 60);
    assert.equal(second.getPrepareOptions().height, 144);
    assert.equal(second.getPrepareOptions().frameRate, 15);
    assert.ok(first.getPrepareOptions().bitrateVideo > second.getPrepareOptions().bitrateVideo);

    await first.session.stop();
    assert.equal(first.session.getState().streamStatus, 'idle');
    assert.equal(second.session.getState().streamStatus, 'streaming');

    await second.session.setVolume(75);
    assert.equal(second.getVolume(), 0.75);
    assert.equal(first.session.getState().volume, 100);
});

test('voice state events from another server cannot replace this session id', async (t) => {
    const target = makeSession('room-1', '111111111111111111', '211111111111111111');
    t.after(() => target.session.shutdown());
    await target.session.connect();

    const streamer = target.session.streamer;
    const connection = streamer.voiceConnection;
    streamer._gatewayEmitter.emit('VOICE_STATE_UPDATE', {
        user_id: streamer.client.user.id,
        guild_id: '199999999999999999',
        channel_id: '299999999999999999',
        session_id: 'wrong-session',
    });
    assert.deepEqual(connection.sessions, []);

    streamer._gatewayEmitter.emit('VOICE_STATE_UPDATE', {
        user_id: streamer.client.user.id,
        guild_id: '111111111111111111',
        channel_id: '211111111111111111',
        session_id: 'right-session',
        self_mute: true,
        self_deaf: true,
    });
    assert.deepEqual(connection.sessions, ['right-session']);
    assert.equal(target.session.getState().selfMute, true);
    assert.equal(target.session.getState().selfDeaf, true);
});

test('a room can be joined and left from dashboard-provided IDs', async (t) => {
    const target = makeSession('room-3', '', '');
    t.after(() => target.session.shutdown());

    await assert.rejects(
        target.session.join('bad-id', '211111111111111111'),
        (error) => error.code === 'INVALID_VOICE_TARGET',
    );

    const joined = await target.session.join(
        '133333333333333333',
        '233333333333333333',
    );
    assert.equal(joined.voiceStatus, 'ready');
    assert.equal(joined.serverId, '133333333333333333');
    assert.equal(joined.channelId, '233333333333333333');

    await target.session.setSelfMute(true);
    await target.session.setSelfDeaf(true);
    assert.equal(target.session.getState().selfMute, true);
    assert.equal(target.session.getState().selfDeaf, true);
    assert.deepEqual(target.session.streamer.opcodes.at(-1), {
        code: 4,
        data: {
            guild_id: '133333333333333333',
            channel_id: '233333333333333333',
            self_mute: true,
            self_deaf: true,
            self_video: false,
        },
    });

    const left = await target.session.leave();
    assert.equal(left.voiceStatus, 'offline');
    assert.equal(left.streamStatus, 'idle');
    assert.equal(left.selfMute, false);
    assert.equal(left.selfDeaf, false);
    assert.equal(target.session.client, null);
    assert.equal(target.session.streamer, null);
});

test('mute and deafen require an active voice room', async (t) => {
    const target = makeSession('room-3', '', '');
    t.after(() => target.session.shutdown());

    await assert.rejects(
        target.session.setSelfMute(true),
        (error) => error.code === 'VOICE_NOT_READY',
    );
    await assert.rejects(
        target.session.setSelfDeaf(true),
        (error) => error.code === 'VOICE_NOT_READY',
    );
});

test('invalid quality or FPS is rejected before a stream starts', async (t) => {
    const target = makeSession('room-2', '', '');
    t.after(() => target.session.shutdown());
    await target.session.join('122222222222222222', '222222222222222222');

    await assert.rejects(
        target.session.start('https://8.8.8.8/video.mp4', { height: 999, frameRate: 30 }),
        (error) => error.code === 'INVALID_STREAM_HEIGHT',
    );
    await assert.rejects(
        target.session.start('https://8.8.8.8/video.mp4', { height: 720, frameRate: 120 }),
        (error) => error.code === 'INVALID_STREAM_FPS',
    );
    assert.equal(target.session.getState().streamStatus, 'idle');
});

test('a YouTube proxy is also passed to FFmpeg media requests', async (t) => {
    const target = makeSession(
        'proxy',
        '177777777777777777',
        '277777777777777777',
        { proxyUrl: 'http://proxy.example:8080' },
    );
    t.after(() => target.session.shutdown());
    await target.session.connect();
    await target.session.start('https://8.8.8.8/video.mp4');

    assert.deepEqual(
        target.getPrepareOptions().customInputOptions.slice(0, 2),
        ['-http_proxy', 'http://proxy.example:8080'],
    );
});

test('a playing video can pause, resume, and seek by 15 seconds', async (t) => {
    const target = makeSession('room-2', '', '');
    t.after(() => target.session.shutdown());
    await target.session.join('122222222222222222', '222222222222222222');
    await target.session.start('https://8.8.8.8/video.mp4');

    const paused = await target.session.pause();
    assert.equal(paused.streamStatus, 'paused');
    assert.equal(target.getKillSignals().at(-1), 'SIGSTOP');

    const resumed = await target.session.resume();
    assert.equal(resumed.streamStatus, 'streaming');
    assert.equal(target.getKillSignals().at(-1), 'SIGCONT');

    const forwarded = await target.session.seek(15);
    assert.equal(forwarded.streamStatus, 'streaming');
    assert.ok(forwarded.positionSeconds >= 15);
    assert.deepEqual(
        target.getPrepareOptions().customInputOptions.slice(0, 2),
        ['-ss', '15.000'],
    );

    await target.session.seek(-15);
    assert.ok(target.session.getState().positionSeconds < 1);
    await assert.rejects(
        target.session.seek(30),
        (error) => error.code === 'INVALID_SEEK',
    );
});

test('direct PNG and GIF inputs use image-safe FFmpeg options', async (t) => {
    let pngCleanupCount = 0;
    let gifCleanupCount = 0;
    const png = makeSession('png', '', '', {
        mediaKind: 'image',
        seekable: false,
        cleanup: () => { pngCleanupCount += 1; },
    });
    const gif = makeSession('gif', '', '', {
        mediaKind: 'gif',
        seekable: false,
        cleanup: () => { gifCleanupCount += 1; },
    });
    t.after(async () => Promise.all([png.session.shutdown(), gif.session.shutdown()]));
    await Promise.all([
        png.session.join('133333333333333333', '233333333333333333'),
        gif.session.join('144444444444444444', '244444444444444444'),
    ]);
    await Promise.all([
        png.session.start('https://8.8.8.8/poster.png'),
        gif.session.start('https://8.8.8.8/animation.gif'),
    ]);

    assert.equal(png.getPrepareOptions().includeAudio, false);
    assert.equal(gif.getPrepareOptions().includeAudio, false);
    assert.deepEqual(
        png.getPrepareOptions().customInputOptions.slice(0, 4),
        ['-stream_loop', '-1', '-framerate', '24'],
    );
    assert.deepEqual(
        gif.getPrepareOptions().customInputOptions.slice(0, 4),
        ['-stream_loop', '-1', '-ignore_loop', '1'],
    );
    await assert.rejects(
        png.session.seek(15),
        (error) => error.code === 'MEDIA_NOT_SEEKABLE',
    );
    await Promise.all([png.session.stop(), gif.session.stop()]);
    assert.equal(pngCleanupCount, 1);
    assert.equal(gifCleanupCount, 1);
});

test('an invalid NUT stream reports the media error without waiting for timeout', async (t) => {
    const neverEnds = createDeferred();
    const session = new RoomStreamSession({
        id: 'bad-media',
        name: 'bad-media',
        token: 'x'.repeat(60),
        serverId: '166666666666666666',
        channelId: '266666666666666666',
    }, {
        ClientClass: FakeClient,
        StreamerClass: FakeStreamer,
        resolveMedia: async (url) => ({
            inputUrl: url,
            mediaUrl: url,
            title: 'bad',
            headers: {},
            mediaKind: 'video',
            seekable: true,
        }),
        prepareStream: () => ({
            output: {},
            command: { kill() {} },
            promise: neverEnds.promise,
            controller: { async setVolume() { return true; } },
        }),
        playStream: async () => {
            throw new Error('No main startcode found. EOF before video frames');
        },
    });
    t.after(() => session.shutdown());
    await session.connect();

    await assert.rejects(
        session.start('https://8.8.8.8/not-media.mp4'),
        (error) => error.code === 'MEDIA_HAS_NO_VIDEO',
    );
});

test('a completed video starts again automatically until stopped', async (t) => {
    const runs = [];
    const runtime = {
        ClientClass: FakeClient,
        StreamerClass: FakeStreamer,
        loopDelayMs: 0,
        resolveMedia: async (url) => ({
            inputUrl: url,
            mediaUrl: url,
            title: 'loop-video',
            headers: {},
        }),
        prepareStream: (mediaUrl, options) => {
            const mediaDone = createDeferred();
            const run = { mediaDone, playDone: createDeferred(), options };
            runs.push(run);
            return {
                output: {},
                command: { kill() {} },
                promise: mediaDone.promise,
                controller: { async setVolume() { return true; } },
            };
        },
        playStream: (output, streamer) => {
            const run = runs.at(-1);
            streamer.voiceConnection.streamConnection = { webRtcParams: { ready: true } };
            return run.playDone.promise;
        },
    };
    const session = new RoomStreamSession({
        id: 'room-4',
        name: 'room-4',
        token: 'x'.repeat(60),
        serverId: '',
        channelId: '',
    }, runtime);
    t.after(() => session.shutdown());

    await session.join('144444444444444444', '244444444444444444');
    await session.start('https://8.8.8.8/loop.mp4', { height: 2160, frameRate: 60 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].options.height, 2160);
    assert.equal(runs[0].options.frameRate, 60);

    runs[0].mediaDone.resolve();
    runs[0].playDone.resolve();
    await waitUntil(() => runs.length === 2 && session.getState().streamStatus === 'streaming');
    assert.equal(session.getState().loopCount, 1);
    assert.equal(runs[1].options.height, 2160);
    assert.equal(runs[1].options.frameRate, 60);

    await session.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runs.length, 2);
    assert.equal(session.getState().streamStatus, 'idle');
});

test('four server slots use isolated Gateway sessions and never move another room', async () => {
    CountingFakeClient.loginCount = 0;
    const runtime = {
        ClientClass: CountingFakeClient,
        StreamerClass: FakeStreamer,
    };
    const rooms = createRoomSessions([{
        token: 'x'.repeat(60),
        voiceChannels: [{ name: 'الأول' }],
    }], {}, runtime);

    assert.equal(rooms.length, 4);
    assert.deepEqual(rooms.map((room) => room.getState().configured), [true, true, true, true]);

    await rooms[0].join('111111111111111111', '211111111111111111');
    const firstClient = rooms[0].client;
    const firstStreamer = rooms[0].streamer;
    const firstConnection = firstStreamer.voiceConnection;
    const firstOpcodesBeforeSecondJoin = firstStreamer.opcodes.length;

    await rooms[1].join('122222222222222222', '222222222222222222');
    const secondClient = rooms[1].client;
    const secondConnection = rooms[1].streamer.voiceConnection;

    assert.notEqual(firstClient, secondClient);
    assert.equal(firstClient.destroyed, false);
    assert.equal(rooms[0].client, firstClient);
    assert.equal(rooms[0].streamer.voiceConnection, firstConnection);
    assert.equal(rooms[0].getState().voiceStatus, 'ready');
    assert.equal(firstStreamer.opcodes.length, firstOpcodesBeforeSecondJoin);

    await Promise.all([
        rooms[2].join('133333333333333333', '233333333333333333'),
        rooms[3].join('144444444444444444', '244444444444444444'),
    ]);

    assert.equal(CountingFakeClient.loginCount, 4);
    assert.equal(new Set(rooms.map((room) => room.client)).size, 4);
    assert.deepEqual(rooms.map((room) => room.getState().voiceStatus), [
        'ready', 'ready', 'ready', 'ready',
    ]);

    await rooms[0].leave();
    assert.equal(firstClient.destroyed, true);
    assert.equal(secondClient.destroyed, false);
    assert.equal(rooms[0].getState().voiceStatus, 'offline');
    assert.equal(rooms[1].getState().voiceStatus, 'ready');
    assert.equal(rooms[1].streamer.voiceConnection, secondConnection);

    await rooms[0].join('155555555555555555', '255555555555555555');
    assert.equal(CountingFakeClient.loginCount, 5);
    assert.notEqual(rooms[0].client, firstClient);
    assert.equal(new Set(rooms.map((room) => room.client)).size, 4);
    assert.equal(rooms[0].getState().voiceStatus, 'ready');

    const activeClients = rooms.map((room) => room.client);
    await Promise.all(rooms.map((room) => room.shutdown()));
    assert.ok(activeClients.every((client) => client.destroyed));
});
