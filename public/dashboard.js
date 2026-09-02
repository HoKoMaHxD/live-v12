const roomGrid = document.querySelector('#room-grid');
const template = document.querySelector('#room-template');
const toast = document.querySelector('#toast');
const syncState = document.querySelector('#sync-state');
const configuredCount = document.querySelector('#configured-count');
const activeCount = document.querySelector('#active-count');
const cards = new Map();
const joiningRooms = new Set();
const leavingRooms = new Set();
const settingVoiceRooms = new Set();
const startingRooms = new Set();
const stoppingRooms = new Set();
const playbackRooms = new Set();
const volumeTimers = new Map();
const discordIdPattern = /^\d{17,20}$/;
let toastTimer;

const voiceLabels = {
    disabled: 'غير مهيأ',
    offline: 'غير متصل',
    connecting: 'يتصل',
    joining: 'يدخل الروم',
    ready: 'الصوت جاهز',
    error: 'خطأ اتصال',
};
const streamLabels = {
    idle: 'الشير متوقف',
    resolving: 'يجهز الرابط',
    starting: 'يبدأ الشير',
    streaming: 'الشير يعمل',
    stopping: 'يوقف الشير',
    looping: 'يعيد المقطع',
    paused: 'متوقف مؤقتًا',
    ended: 'انتهى المقطع',
    error: 'خطأ في الشير',
};

function showToast(message, kind = 'normal') {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4_000);
}

async function api(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/json',
            'X-Control-Request': 'dashboard',
            ...(options.headers || {}),
        },
    });

    if (response.status === 401) {
        window.location.assign('/login');
        throw new Error('انتهت الجلسة.');
    }

    const data = response.status === 204 ? { ok: true } : await response.json();
    if (!response.ok || !data.ok) {
        throw new Error(data.error || 'تعذر تنفيذ الطلب.');
    }
    return data;
}

function statusClass(status) {
    if (status === 'ready' || status === 'streaming') return 'good';
    if (['connecting', 'joining', 'resolving', 'starting', 'paused', 'stopping', 'looping'].includes(status)) return 'busy';
    if (status === 'error') return 'bad';
    return 'neutral';
}

function storageKey(roomId, field) {
    return `discord-control:${roomId}:${field}`;
}

function readStored(roomId, field) {
    try {
        return localStorage.getItem(storageKey(roomId, field)) || '';
    }
    catch {
        return '';
    }
}

function storeValue(roomId, field, value) {
    try {
        localStorage.setItem(storageKey(roomId, field), value);
    }
    catch {
        // Private browsing may disable local storage; the controls still work.
    }
}

function roomIsBusy(roomId) {
    return joiningRooms.has(roomId)
        || leavingRooms.has(roomId)
        || settingVoiceRooms.has(roomId)
        || startingRooms.has(roomId)
        || stoppingRooms.has(roomId)
        || playbackRooms.has(roomId);
}

function updateVoiceControls(card) {
    const room = card.roomState;
    if (!room) return;
    const serverInput = card.querySelector('.server-id-input');
    const channelInput = card.querySelector('.channel-id-input');
    const joinButton = card.querySelector('.join-button');
    const leaveButton = card.querySelector('.leave-button');
    const muteButton = card.querySelector('.mute-button');
    const deafButton = card.querySelector('.deaf-button');
    const voiceTransition = ['connecting', 'joining'].includes(room.voiceStatus);
    const sameTarget = serverInput.value.trim() === room.serverId
        && channelInput.value.trim() === room.channelId;

    serverInput.disabled = !room.configured || voiceTransition || roomIsBusy(room.id);
    channelInput.disabled = !room.configured || voiceTransition || roomIsBusy(room.id);
    joinButton.disabled = !room.configured
        || voiceTransition
        || roomIsBusy(room.id)
        || (room.voiceStatus === 'ready' && sameTarget);
    joinButton.textContent = room.voiceStatus === 'ready' && !sameTarget
        ? 'انتقال للروم'
        : 'دخول الروم';
    leaveButton.disabled = !room.configured
        || roomIsBusy(room.id)
        || ['offline', 'disabled'].includes(room.voiceStatus);

    muteButton.disabled = !room.configured
        || room.voiceStatus !== 'ready'
        || roomIsBusy(room.id);
    muteButton.classList.toggle('is-active', room.selfMute);
    muteButton.setAttribute('aria-pressed', String(Boolean(room.selfMute)));
    muteButton.textContent = room.selfMute ? 'فك الميوت' : 'ميوت';

    deafButton.disabled = !room.configured
        || room.voiceStatus !== 'ready'
        || roomIsBusy(room.id);
    deafButton.classList.toggle('is-active', room.selfDeaf);
    deafButton.setAttribute('aria-pressed', String(Boolean(room.selfDeaf)));
    deafButton.textContent = room.selfDeaf ? 'فك الدفن' : 'دفن';
}

function createCard(room, index) {
    const card = template.content.firstElementChild.cloneNode(true);
    card.id = room.id;
    card.dataset.roomId = room.id;
    card.querySelector('.room-index').textContent = `ROOM ${index + 1}`;

    const voiceForm = card.querySelector('.voice-form');
    const serverInput = card.querySelector('.server-id-input');
    const channelInput = card.querySelector('.channel-id-input');
    const leaveButton = card.querySelector('.leave-button');
    const muteButton = card.querySelector('.mute-button');
    const deafButton = card.querySelector('.deaf-button');
    const form = card.querySelector('.stream-form');
    const urlInput = card.querySelector('.url-input');
    const qualityInput = card.querySelector('.quality-input');
    const fpsInput = card.querySelector('.fps-input');
    const rewindButton = card.querySelector('.rewind-button');
    const pauseButton = card.querySelector('.pause-button');
    const forwardButton = card.querySelector('.forward-button');
    const stopButton = card.querySelector('.stop-button');
    const volumeInput = card.querySelector('.volume-input');

    serverInput.value = readStored(room.id, 'serverId') || room.serverId || '';
    channelInput.value = readStored(room.id, 'channelId') || room.channelId || '';
    serverInput.dataset.initialized = 'true';
    channelInput.dataset.initialized = 'true';
    qualityInput.value = readStored(room.id, 'streamHeight')
        || String(room.streamHeight ?? 480);
    fpsInput.value = readStored(room.id, 'streamFps')
        || String(room.streamFps ?? 24);
    if (!qualityInput.value) qualityInput.value = '480';
    if (!fpsInput.value) fpsInput.value = '24';

    qualityInput.addEventListener('change', () => {
        storeValue(room.id, 'streamHeight', qualityInput.value);
    });
    fpsInput.addEventListener('change', () => {
        storeValue(room.id, 'streamFps', fpsInput.value);
    });

    for (const [input, field] of [
        [serverInput, 'serverId'],
        [channelInput, 'channelId'],
    ]) {
        input.addEventListener('input', () => {
            input.value = input.value.replace(/\D/g, '').slice(0, 20);
            storeValue(room.id, field, input.value);
            updateVoiceControls(card);
        });
    }

    voiceForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (roomIsBusy(room.id)) return;
        const serverId = serverInput.value.trim();
        const channelId = channelInput.value.trim();
        if (!discordIdPattern.test(serverId) || !discordIdPattern.test(channelId)) {
            showToast('تأكد أن أيدي السيرفر والروم من 17 إلى 20 رقمًا.', 'error');
            (!discordIdPattern.test(serverId) ? serverInput : channelInput).focus();
            return;
        }

        joiningRooms.add(room.id);
        updateLoading(card, true);
        updateVoiceControls(card);
        try {
            const data = await api(`/api/rooms/${encodeURIComponent(room.id)}/join`, {
                method: 'POST',
                body: JSON.stringify({ serverId, channelId }),
            });
            storeValue(room.id, 'serverId', serverId);
            storeValue(room.id, 'channelId', channelId);
            updateCard(data.room, index);
            showToast(`تم دخول ${room.name}.`, 'success');
        }
        catch (error) {
            showToast(error.message, 'error');
        }
        finally {
            joiningRooms.delete(room.id);
            updateLoading(card, roomIsBusy(room.id));
            updateVoiceControls(card);
            refreshRooms();
        }
    });

    leaveButton.addEventListener('click', async () => {
        if (roomIsBusy(room.id)) return;
        leavingRooms.add(room.id);
        updateLoading(card, true);
        updateVoiceControls(card);
        try {
            const data = await api(`/api/rooms/${encodeURIComponent(room.id)}/leave`, {
                method: 'POST',
                body: '{}',
            });
            updateCard(data.room, index);
            showToast(`تم الخروج من ${room.name}.`, 'success');
        }
        catch (error) {
            showToast(error.message, 'error');
        }
        finally {
            leavingRooms.delete(room.id);
            updateLoading(card, roomIsBusy(room.id));
            updateVoiceControls(card);
            refreshRooms();
        }
    });

    const changeVoiceSetting = async (kind) => {
        if (roomIsBusy(room.id)) return;
        const current = card.roomState;
        const isMute = kind === 'mute';
        const property = isMute ? 'selfMute' : 'selfDeaf';
        const enabled = !Boolean(current?.[property]);
        settingVoiceRooms.add(room.id);
        updateLoading(card, true);
        updateVoiceControls(card);
        try {
            const data = await api(`/api/rooms/${encodeURIComponent(room.id)}/${kind}`, {
                method: 'POST',
                body: JSON.stringify({ enabled }),
            });
            updateCard(data.room, index);
            const label = isMute ? 'الميوت' : 'الدفن';
            showToast(`${enabled ? 'تم تفعيل' : 'تم فك'} ${label} في ${room.name}.`, 'success');
        }
        catch (error) {
            showToast(error.message, 'error');
        }
        finally {
            settingVoiceRooms.delete(room.id);
            updateLoading(card, roomIsBusy(room.id));
            updateVoiceControls(card);
            refreshRooms();
        }
    };

    muteButton.addEventListener('click', () => void changeVoiceSetting('mute'));
    deafButton.addEventListener('click', () => void changeVoiceSetting('deaf'));

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (roomIsBusy(room.id)) return;
        const url = urlInput.value.trim();
        if (!url) {
            showToast('ضع رابط المقطع أولًا.', 'error');
            urlInput.focus();
            return;
        }

        startingRooms.add(room.id);
        updateLoading(card, true);
        try {
            const data = await api(`/api/rooms/${encodeURIComponent(room.id)}/start`, {
                method: 'POST',
                body: JSON.stringify({
                    url,
                    height: Number(qualityInput.value),
                    frameRate: Number(fpsInput.value),
                }),
            });
            storeValue(room.id, 'streamHeight', qualityInput.value);
            storeValue(room.id, 'streamFps', fpsInput.value);
            updateCard(data.room, index);
            showToast(`بدأ الشير في ${room.name}.`, 'success');
        }
        catch (error) {
            showToast(error.message, 'error');
        }
        finally {
            startingRooms.delete(room.id);
            updateLoading(card, roomIsBusy(room.id));
            updateVoiceControls(card);
            refreshRooms();
        }
    });

    stopButton.addEventListener('click', async () => {
        if (roomIsBusy(room.id)) return;
        stoppingRooms.add(room.id);
        updateLoading(card, true);
        try {
            const data = await api(`/api/rooms/${encodeURIComponent(room.id)}/stop`, {
                method: 'POST',
                body: '{}',
            });
            updateCard(data.room, index);
            showToast(`توقف الشير في ${room.name}.`, 'success');
        }
        catch (error) {
            showToast(error.message, 'error');
        }
        finally {
            stoppingRooms.delete(room.id);
            updateLoading(card, roomIsBusy(room.id));
            updateVoiceControls(card);
            refreshRooms();
        }
    });

    const playbackAction = async (action, body, successMessage) => {
        if (roomIsBusy(room.id)) return;
        playbackRooms.add(room.id);
        updateLoading(card, true);
        try {
            const data = await api(`/api/rooms/${encodeURIComponent(room.id)}/${action}`, {
                method: 'POST',
                body: JSON.stringify(body || {}),
            });
            updateCard(data.room, index);
            showToast(successMessage, 'success');
        }
        catch (error) {
            showToast(error.message, 'error');
        }
        finally {
            playbackRooms.delete(room.id);
            updateLoading(card, roomIsBusy(room.id));
            updateCard(card.roomState, index);
            refreshRooms();
        }
    };

    pauseButton.addEventListener('click', () => {
        const paused = card.roomState?.streamStatus === 'paused';
        void playbackAction(
            paused ? 'resume' : 'pause',
            {},
            paused ? `تم استكمال المقطع في ${room.name}.` : `تم إيقاف المقطع مؤقتًا في ${room.name}.`,
        );
    });
    rewindButton.addEventListener('click', () => void playbackAction(
        'seek',
        { seconds: -15 },
        `تم تأخير المقطع 15 ثانية في ${room.name}.`,
    ));
    forwardButton.addEventListener('click', () => void playbackAction(
        'seek',
        { seconds: 15 },
        `تم تقديم المقطع 15 ثانية في ${room.name}.`,
    ));

    volumeInput.addEventListener('input', () => {
        card.querySelector('.volume-value').textContent = `${volumeInput.value}%`;
        clearTimeout(volumeTimers.get(room.id));
        volumeTimers.set(room.id, setTimeout(async () => {
            try {
                await api(`/api/rooms/${encodeURIComponent(room.id)}/volume`, {
                    method: 'POST',
                    body: JSON.stringify({ volume: Number(volumeInput.value) }),
                });
            }
            catch (error) {
                showToast(error.message, 'error');
            }
        }, 350));
    });

    roomGrid.append(card);
    cards.set(room.id, card);
    return card;
}

function updateLoading(card, isLoading) {
    card.setAttribute('aria-busy', String(isLoading));
    card.classList.toggle('is-loading', isLoading);
}

function setBadge(element, label, status) {
    element.textContent = label;
    element.className = `badge ${element.classList.contains('voice-badge') ? 'voice-badge' : 'stream-badge'} ${statusClass(status)}`;
}

function formatStartedAt(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return '';
    return `بدأ ${new Intl.DateTimeFormat('ar-SA', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(date)}`;
}

function formatMediaTime(value) {
    const totalSeconds = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function updateCard(room, index) {
    const card = cards.get(room.id) || createCard(room, index);
    card.roomState = room;
    const active = ['resolving', 'starting', 'streaming', 'paused', 'stopping', 'looping'].includes(room.streamStatus);
    const transitioning = ['resolving', 'starting', 'stopping', 'looping'].includes(room.streamStatus);
    const urlInput = card.querySelector('.url-input');
    const qualityInput = card.querySelector('.quality-input');
    const fpsInput = card.querySelector('.fps-input');
    const volumeInput = card.querySelector('.volume-input');

    card.classList.toggle('is-disabled', !room.configured);
    card.classList.toggle('is-streaming', room.streamStatus === 'streaming');
    card.querySelector('.room-name').textContent = room.name;
    setBadge(card.querySelector('.voice-badge'), voiceLabels[room.voiceStatus] || room.voiceStatus, room.voiceStatus);
    setBadge(card.querySelector('.stream-badge'), streamLabels[room.streamStatus] || room.streamStatus, room.streamStatus);

    if (!urlInput.dataset.initialized) {
        urlInput.value = room.inputUrl || '';
        urlInput.dataset.initialized = 'true';
    }
    urlInput.disabled = !room.configured;
    qualityInput.disabled = !room.configured || transitioning || roomIsBusy(room.id);
    fpsInput.disabled = !room.configured || transitioning || roomIsBusy(room.id);
    if (active) {
        qualityInput.value = String(room.streamHeight ?? 480);
        fpsInput.value = String(room.streamFps ?? 24);
        storeValue(room.id, 'streamHeight', qualityInput.value);
        storeValue(room.id, 'streamFps', fpsInput.value);
    }
    volumeInput.disabled = !room.configured || (active && room.hasAudio === false);
    if (document.activeElement !== volumeInput) volumeInput.value = String(room.volume);
    card.querySelector('.volume-value').textContent = `${room.volume}%`;

    const startButton = card.querySelector('.start-button');
    startButton.disabled = !room.configured
        || room.voiceStatus !== 'ready'
        || transitioning
        || roomIsBusy(room.id);
    startButton.textContent = ['streaming', 'paused'].includes(room.streamStatus)
        ? 'تطبيق / تبديل'
        : 'تشغيل الشير';
    const stopButton = card.querySelector('.stop-button');
    stopButton.disabled = !room.configured || !active || roomIsBusy(room.id);
    const pauseButton = card.querySelector('.pause-button');
    const canControlPlayback = ['streaming', 'paused'].includes(room.streamStatus);
    pauseButton.disabled = !room.configured || !canControlPlayback || roomIsBusy(room.id);
    pauseButton.classList.toggle('is-active', room.streamStatus === 'paused');
    pauseButton.textContent = room.streamStatus === 'paused' ? 'استكمال المقطع' : 'إيقاف مؤقت';
    for (const button of [
        card.querySelector('.rewind-button'),
        card.querySelector('.forward-button'),
    ]) {
        button.disabled = !room.configured
            || !canControlPlayback
            || !room.seekable
            || roomIsBusy(room.id);
    }

    card.querySelector('.media-title').textContent = room.mediaTitle
        || (room.streamStatus === 'ended' ? 'انتهى المقطع' : 'لا يوجد بث حالي');
    card.querySelector('.started-at').textContent = formatStartedAt(room.startedAt);
    const durationLabel = room.durationSeconds !== null
        && room.durationSeconds !== undefined
        && Number.isFinite(Number(room.durationSeconds))
        ? ` / ${formatMediaTime(room.durationSeconds)}`
        : '';
    card.querySelector('.position-status').textContent = active
        ? `${formatMediaTime(room.positionSeconds)}${durationLabel}`
        : '';
    const bitrate = Number(room.videoBitrate);
    const bitrateLabel = Number.isFinite(bitrate)
        ? ` · ${bitrate >= 1_000 ? `${(bitrate / 1_000).toFixed(1)} Mbps` : `${bitrate} kbps`}`
        : '';
    card.querySelector('.encoding-status').textContent =
        `${room.streamHeight ?? 480}p · ${room.streamFps ?? 24} FPS${bitrateLabel}`;
    const error = card.querySelector('.room-error');
    error.textContent = room.error || '';
    error.hidden = !room.error;
    card.querySelector('.loop-status').textContent = room.loopCount > 0
        ? `التكرار التلقائي مفعّل · أُعيد ${room.loopCount} مرة`
        : 'التكرار التلقائي مفعّل';
    updateVoiceControls(card);
}

async function refreshRooms() {
    try {
        const data = await api('/api/rooms');
        data.rooms.forEach(updateCard);
        configuredCount.textContent = `${data.rooms.filter((room) => room.voiceStatus === 'ready').length} / 4`;
        activeCount.textContent = String(data.rooms.filter((room) =>
            ['resolving', 'starting', 'streaming', 'paused', 'stopping', 'looping'].includes(room.streamStatus)).length);
        syncState.classList.remove('sync-error');
        syncState.lastChild.textContent = ' متصل باللوحة';
    }
    catch (error) {
        syncState.classList.add('sync-error');
        syncState.lastChild.textContent = ' تعذر تحديث الحالة';
    }
}

document.querySelector('#logout-button').addEventListener('click', async () => {
    try {
        await api('/api/logout', { method: 'POST', body: '{}' });
    }
    finally {
        window.location.assign('/login');
    }
});

refreshRooms();
setInterval(refreshRooms, 2_500);
