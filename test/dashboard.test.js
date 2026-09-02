import assert from 'node:assert/strict';
import test from 'node:test';
import { createDashboardApp } from '../dashboard.js';

class FakeRoom {
    constructor(index) {
        this.id = `room-${index}`;
        this.state = {
            id: this.id,
            name: `Room ${index}`,
            configured: true,
            serverId: `${index}`.repeat(18),
            channelId: `${index}`.repeat(19),
            voiceStatus: 'ready',
            streamStatus: 'idle',
            volume: 100,
            streamHeight: 480,
            streamFps: 24,
            videoBitrate: 1400,
            inputUrl: '',
            mediaTitle: '',
            mediaKind: 'video',
            durationSeconds: 120,
            positionSeconds: 0,
            seekable: true,
            hasAudio: true,
            startedAt: null,
            endedAt: null,
            loopCount: 0,
            selfMute: false,
            selfDeaf: false,
            error: null,
            username: 'tester',
        };
    }

    getState() { return { ...this.state }; }
    sharesAccountWith() { return true; }
    async join(serverId, channelId) {
        this.state.serverId = serverId;
        this.state.channelId = channelId;
        this.state.voiceStatus = 'ready';
        return this.getState();
    }
    async leave() {
        this.state.voiceStatus = 'offline';
        this.state.streamStatus = 'idle';
        return this.getState();
    }
    async setSelfMute(enabled) {
        this.state.selfMute = enabled;
        return this.getState();
    }
    async setSelfDeaf(enabled) {
        this.state.selfDeaf = enabled;
        return this.getState();
    }
    async start(url, settings = {}) {
        this.state.inputUrl = url;
        this.state.streamHeight = settings.height ?? this.state.streamHeight;
        this.state.streamFps = settings.frameRate ?? this.state.streamFps;
        this.state.streamStatus = 'streaming';
        return this.getState();
    }
    async pause() {
        this.state.streamStatus = 'paused';
        return this.getState();
    }
    async resume() {
        this.state.streamStatus = 'streaming';
        return this.getState();
    }
    async seek(seconds) {
        this.state.positionSeconds = Math.max(0, this.state.positionSeconds + Number(seconds));
        return this.getState();
    }
    async stop() {
        this.state.streamStatus = 'idle';
        return this.getState();
    }
    async setVolume(volume) {
        this.state.volume = volume;
        return this.getState();
    }
}

test('dashboard protects room controls and accepts a valid login', async (t) => {
    const rooms = [1, 2, 3, 4].map((index) => new FakeRoom(index));
    const app = createDashboardApp({
        rooms,
        controlPassword: 'correct-horse-battery',
        sessionSecret: 'test-session-secret',
        production: false,
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const unauthenticated = await fetch(`${base}/api/rooms`);
    assert.equal(unauthenticated.status, 401);

    const wrongLogin = await fetch(`${base}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'password=wrong',
    });
    assert.equal(wrongLogin.status, 303);
    assert.equal(wrongLogin.headers.get('location'), '/login?error=wrong');

    const login = await fetch(`${base}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'password=correct-horse-battery',
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^discord_stream_control=/);

    const page = await fetch(base, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('cache-control'), /no-store/);
    const pageHtml = await page.text();
    assert.match(pageHtml, /تحكم الرومات/);
    assert.match(pageHtml, /dashboard\.js\?v=3\.4\.0/);
    assert.match(pageHtml, /4 سيرفرات مستقلة/);
    assert.match(pageHtml, /جودة البث/);
    assert.match(pageHtml, /الإطارات FPS/);
    assert.match(pageHtml, /2160p 4K/);
    assert.match(pageHtml, /MP4 \/ GIF \/ PNG/);
    assert.match(pageHtml, /\+15 ثانية/);

    const dashboardScript = await fetch(`${base}/assets/dashboard.js?v=3.4.0`);
    assert.equal(dashboardScript.status, 200);
    assert.match(dashboardScript.headers.get('cache-control'), /no-store/);
    assert.match(await dashboardScript.text(), /\/join/);

    const roomsResponse = await fetch(`${base}/api/rooms`, { headers: { Cookie: cookie } });
    const roomsBody = await roomsResponse.json();
    assert.equal(roomsResponse.status, 200);
    assert.equal(roomsBody.rooms.length, 4);

    const duplicateJoin = await fetch(`${base}/api/rooms/room-1/join`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            'X-Control-Request': 'dashboard',
        },
        body: JSON.stringify({
            serverId: rooms[1].getState().serverId,
            channelId: '299999999999999999',
        }),
    });
    assert.equal(duplicateJoin.status, 409);

    const left = await fetch(`${base}/api/rooms/room-1/leave`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            'X-Control-Request': 'dashboard',
        },
        body: '{}',
    });
    assert.equal(left.status, 200);
    assert.equal((await left.json()).room.voiceStatus, 'offline');

    const joined = await fetch(`${base}/api/rooms/room-1/join`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            'X-Control-Request': 'dashboard',
        },
        body: JSON.stringify({
            serverId: '155555555555555555',
            channelId: '255555555555555555',
        }),
    });
    assert.equal(joined.status, 200);
    assert.equal((await joined.json()).room.serverId, '155555555555555555');

    const muted = await fetch(`${base}/api/rooms/room-1/mute`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            'X-Control-Request': 'dashboard',
        },
        body: JSON.stringify({ enabled: true }),
    });
    assert.equal(muted.status, 200);
    assert.equal((await muted.json()).room.selfMute, true);

    const deafened = await fetch(`${base}/api/rooms/room-1/deaf`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            'X-Control-Request': 'dashboard',
        },
        body: JSON.stringify({ enabled: true }),
    });
    assert.equal(deafened.status, 200);
    assert.equal((await deafened.json()).room.selfDeaf, true);
    assert.equal(rooms[1].getState().selfMute, false);

    const csrfBlocked = await fetch(`${base}/api/rooms/room-1/start`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/video.mp4' }),
    });
    assert.equal(csrfBlocked.status, 403);

    const started = await fetch(`${base}/api/rooms/room-1/start`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            'X-Control-Request': 'dashboard',
        },
        body: JSON.stringify({
            url: 'https://example.com/video.mp4',
            height: 2160,
            frameRate: 60,
        }),
    });
    assert.equal(started.status, 200);
    const startedRoom = (await started.json()).room;
    assert.equal(startedRoom.streamStatus, 'streaming');
    assert.equal(startedRoom.streamHeight, 2160);
    assert.equal(startedRoom.streamFps, 60);

    const playbackRequest = (action, body = {}) => fetch(
        `${base}/api/rooms/room-1/${action}`,
        {
            method: 'POST',
            headers: {
                Cookie: cookie,
                'Content-Type': 'application/json',
                'X-Control-Request': 'dashboard',
            },
            body: JSON.stringify(body),
        },
    );
    const paused = await playbackRequest('pause');
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).room.streamStatus, 'paused');

    const resumed = await playbackRequest('resume');
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).room.streamStatus, 'streaming');

    const forwarded = await playbackRequest('seek', { seconds: 15 });
    assert.equal(forwarded.status, 200);
    assert.equal((await forwarded.json()).room.positionSeconds, 15);

    const rewound = await playbackRequest('seek', { seconds: -15 });
    assert.equal(rewound.status, 200);
    assert.equal((await rewound.json()).room.positionSeconds, 0);
    assert.equal(rooms[1].getState().streamStatus, 'idle');
});
