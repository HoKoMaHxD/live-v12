import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
    buildYtDlpArgs,
    isPublicIp,
    resolveMedia,
    validatePublicHttpUrl,
} from '../mediaResolver.js';

test('private and reserved IP addresses are rejected', async () => {
    assert.equal(isPublicIp('127.0.0.1'), false);
    assert.equal(isPublicIp('10.10.1.5'), false);
    assert.equal(isPublicIp('169.254.169.254'), false);
    assert.equal(isPublicIp('::1'), false);
    assert.equal(isPublicIp('::ffff:127.0.0.1'), false);
    assert.equal(isPublicIp('2001:db8::1'), false);
    assert.equal(isPublicIp('8.8.8.8'), true);
    assert.equal(isPublicIp('2606:4700:4700::1111'), true);

    await assert.rejects(
        validatePublicHttpUrl('http://127.0.0.1/video.mp4'),
        (error) => error.code === 'PRIVATE_URL',
    );
});

test('a public direct media URL is returned without yt-dlp', async () => {
    const media = await resolveMedia('https://8.8.8.8/media/video.mp4?token=abc');
    assert.equal(media.source, 'direct');
    assert.equal(media.mediaUrl, 'https://8.8.8.8/media/video.mp4?token=abc');
    assert.equal(media.title, 'video.mp4');
    assert.equal(media.mediaKind, 'video');
    assert.equal(media.seekable, true);
});

test('direct GIF and PNG links are verified and cached locally', async () => {
    const originalFetch = globalThis.fetch;
    const gifBytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2P0WQAAAABJRU5ErkJggg==',
        'base64',
    );
    const responses = [gifBytes, pngBytes];
    globalThis.fetch = async () => new Response(responses.shift(), { status: 200 });
    let gif;
    let png;
    try {
        gif = await resolveMedia('https://8.8.8.8/media/animation?format=gif&token=abc');
        png = await resolveMedia('https://8.8.8.8/media/poster.PNG');
        assert.equal(gif.mediaKind, 'gif');
        assert.equal(gif.seekable, false);
        assert.equal(gif.source, 'direct-cached');
        assert.match(gif.mediaUrl, /\.gif$/);
        assert.equal((await readFile(gif.mediaUrl)).subarray(0, 6).toString('ascii'), 'GIF89a');
        assert.equal(png.mediaKind, 'image');
        assert.equal(png.seekable, false);
        assert.equal(png.source, 'direct-cached');
        assert.match(png.mediaUrl, /\.png$/);
        assert.equal((await readFile(png.mediaUrl)).subarray(1, 4).toString('ascii'), 'PNG');
    }
    finally {
        globalThis.fetch = originalFetch;
        await Promise.all([gif?.cleanup?.(), png?.cleanup?.()]);
    }
});

test('non-http protocols and URL credentials are rejected', async () => {
    await assert.rejects(
        validatePublicHttpUrl('file:///etc/passwd'),
        (error) => error.code === 'INVALID_PROTOCOL',
    );
    await assert.rejects(
        validatePublicHttpUrl('https://user:pass@8.8.8.8/video.mp4'),
        (error) => error.code === 'URL_CREDENTIALS',
    );
});

test('YouTube uses anonymous clients and never reads user cookies', () => {
    const args = buildYtDlpArgs(new URL('https://www.youtube.com/watch?v=example'));
    assert.equal(args.includes('--cookies'), false);
    assert.equal(args.includes('--cookies-from-browser'), false);
    assert.equal(args.includes('--no-cookies-from-browser'), true);
    assert.equal(args.includes('--extractor-args'), true);
    assert.equal(args.includes('--impersonate'), true);
    assert.match(args.join(' '), /mweb,web_safari,tv_simply,web_embedded,android_vr,ios/);
    assert.match(args.join(' '), /youtubepot-wpc:browser_path=\/usr\/bin\/chromium/);
});

test('an optional YouTube proxy is validated and passed to yt-dlp', () => {
    const previous = process.env.YOUTUBE_PROXY_URL;
    try {
        process.env.YOUTUBE_PROXY_URL = 'http://proxy.example:8080';
        const args = buildYtDlpArgs(new URL('https://youtu.be/example'));
        const proxyIndex = args.indexOf('--proxy');
        assert.ok(proxyIndex >= 0);
        assert.equal(args[proxyIndex + 1], 'http://proxy.example:8080');

        process.env.YOUTUBE_PROXY_URL = 'file:///tmp/proxy';
        assert.throws(
            () => buildYtDlpArgs(new URL('https://youtu.be/example')),
            (error) => error.code === 'YOUTUBE_PROXY_INVALID',
        );
    }
    finally {
        if (previous === undefined) delete process.env.YOUTUBE_PROXY_URL;
        else process.env.YOUTUBE_PROXY_URL = previous;
    }
});
