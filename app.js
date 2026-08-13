/* ============================================================
   دل‌پلیر
   ============================================================ */
(function () {
'use strict';

// ------------------------------------------------------------
// کمکی‌ها
// ------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// روی <svg> پراپرتیِ .hidden وجود ندارد (فقط HTMLElement آن را دارد)، پس
// نمایش/پنهان‌سازی آیکن‌ها باید از راه صفت انجام شود.
function setHidden(node, hidden) {
    if (!node) return;
    if (hidden) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
}

function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60) % 60;
    const h = Math.floor(sec / 3600);
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // بدون حروف/ارقام شبیه‌به‌هم
function randomId(len) {
    const bytes = new Uint8Array(len || 7);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    return out;
}

// ------------------------------------------------------------
// عناصر
// ------------------------------------------------------------
const el = {
    player: $('player'), video: $('video'), ytHost: $('yt-host'),
    bigPlay: $('big-play'), controls: $('controls'),
    scrub: $('scrub'), scrubFill: $('scrub-fill'), scrubBuffer: $('scrub-buffer'), scrubTip: $('scrub-tip'),
    btnPlay: $('btn-play'), iconPlay: $('icon-play'), iconPause: $('icon-pause'),
    btnBack: $('btn-back'), btnFwd: $('btn-fwd'),
    btnMute: $('btn-mute'), iconVol: $('icon-vol'), iconMute: $('icon-mute'), volume: $('volume'),
    timeCur: $('time-cur'), timeDur: $('time-dur'),
    btnChat: $('btn-chat'), btnSubs: $('btn-subs'), subsMenu: $('subs-menu'), subsMenuItems: $('subs-menu-items'),
    btnRate: $('btn-rate'), rateMenu: $('rate-menu'), rateMenuItems: $('rate-menu-items'),
    btnPip: $('btn-pip'), btnFs: $('btn-fs'), iconFs: $('icon-fs'), iconFsExit: $('icon-fs-exit'),
    subs: $('subs'), subsScan: $('subs-scan'), subsScanText: $('subs-scan-text'),
    overlayChat: $('overlay-chat'), overlayInput: $('overlay-input'), overlayChatInput: $('overlay-chat-input'),
    bufferingText: $('buffering-text'), playerToast: $('player-toast'),

    videoUrl: $('video-url'), loadUrl: $('load-url'),
    videoFile: $('video-file'), videoDrop: $('video-drop'), subtitleFile: $('subtitle-file'),
    myIdBtn: $('my-id'), myIdText: $('my-id-text'), inviteLink: $('invite-link'), copiedHint: $('copied-hint'),
    partnerId: $('partner-id'), connectBtn: $('connect-btn'), disconnectBtn: $('disconnect-btn'),
    lengthWarning: $('length-warning'),

    btnReactions: $('btn-reactions'), reactionMenu: $('reaction-menu'),
    reactionItems: $('reaction-items'), reactionLayer: $('reaction-layer'),

    stage: $('stage'), chatPanel: $('chat-panel'), chatLog: $('chat-log'),
    chatInput: $('chat-input'), chatSend: $('chat-send'),
    replyPreview: $('reply-preview'), replyText: $('reply-text'), replyCancel: $('reply-cancel'),
    emojiBtn: $('emoji-btn'), dockToggle: $('dock-toggle'), toggleOverlay: $('toggle-overlay'),

    statusFab: $('status-fab'), statusTip: $('status-tip'),
    fabIcons: { disconnected: $('fab-off'), connected: $('fab-on'), success: $('fab-on'), connecting: $('fab-wait'), error: $('fab-err') }
};

const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function validId(value) {
    return typeof value === 'string' && value.length === 7 &&
        value.split('').every((c) => ID_ALPHABET.indexOf(c) !== -1);
}

function inviteIdFromUrl() {
    try {
        const value = new URL(location.href).searchParams.get('invite');
        return validId(value) ? value : '';
    } catch (e) { return ''; }
}

let pendingInviteId = inviteIdFromUrl();

// جلسه در sessionStorage نگه داشته می‌شود تا یک رفرش تصادفی، تماشا را خراب نکند.
const SESSION_KEY = 'delplayer:session';
function saveSession() {
    try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ myId: state.myId, partnerId: state.partnerId }));
    } catch (e) {}
}
function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || {}; }
    catch (e) { return {}; }
}

// ------------------------------------------------------------
// وضعیت
// ------------------------------------------------------------
const state = {
    myId: '',
    partnerId: '',
    connected: false,
    peerUnstable: false,
    mode: 'html5',              // 'html5' | 'youtube'
    hasMedia: false,
    wantPlaying: false,
    localStalled: false,
    peerStalled: false,
    baseRate: 1,
    partnerDuration: null,
    partnerSource: null,
    clockOffset: 0,             // ساعت طرف مقابل منهای ساعت ما (میلی‌ثانیه)
    rttSamples: [],
    overlayEnabled: true,
    docked: false,
    replyingTo: null
};

// ------------------------------------------------------------
// آداپتور پلیر: رابط یکسان برای ویدیوی محلی و یوتیوب
// ------------------------------------------------------------
let ytPlayer = null;
let ytReady = false;
// یوتیوب برای یک جابه‌جایی، زنجیره‌ای از رویدادها می‌فرستد (مکث، بافر، پخش).
// بدون این دو پنجره، هر دستوری که خودمان دادیم دوباره برای طرف مقابل ارسال
// می‌شود و دو طرف بی‌وقفه همدیگر را متوقف و پخش می‌کنند.
let ytSuppressUntil = 0;
let ytSeekWatch = null;
let ytSeekRetried = false;
// یوتیوب بعد از seekTo هنوز چند لحظه زمان قدیمی را گزارش می‌کند. تا وقتی
// واقعاً نرسیده، همان مقصدی را که خواسته‌ایم گزارش می‌کنیم؛ وگرنه موقعیت
// کهنه برای طرف مقابل ارسال می‌شود و او ما را به عقب برمی‌گرداند.
let ytSeekTarget = null;
let ytApiLoading = null;

const html5Adapter = {
    get duration() { const d = el.video.duration; return isFinite(d) ? d : 0; },
    get currentTime() { return el.video.currentTime || 0; },
    set currentTime(t) { el.video.currentTime = t; },
    get paused() { return el.video.paused; },
    get rate() { return el.video.playbackRate; },
    set rate(r) { el.video.playbackRate = r; },
    get volume() { return el.video.volume; },
    set volume(v) { el.video.volume = v; },
    get muted() { return el.video.muted; },
    set muted(m) { el.video.muted = m; },
    get buffered() {
        const b = el.video.buffered;
        if (!b || !b.length) return 0;
        const t = el.video.currentTime;
        for (let i = 0; i < b.length; i++) if (b.start(i) <= t && t <= b.end(i)) return b.end(i);
        return b.end(b.length - 1);
    },
    play() { return el.video.play(); },
    pause() { el.video.pause(); }
};

const ytAdapter = {
    get duration() { return ytReady && ytPlayer.getDuration ? ytPlayer.getDuration() || 0 : 0; },
    get currentTime() {
        if (!ytReady || !ytPlayer.getCurrentTime) return 0;
        const actual = ytPlayer.getCurrentTime() || 0;
        // تا وقتی جابه‌جایی واقعاً ننشسته، مقصد را گزارش می‌کنیم نه موقعیت کهنه را.
        // مهلت زمانی نداریم: جابه‌جایی رو به جلو یعنی دانلود، و روی اینترنت کند
        // ممکن است ده‌ها ثانیه طول بکشد. مراقب جداگانه‌ای جلوی گیر ابدی را می‌گیرد.
        if (ytSeekTarget !== null) {
            if (Math.abs(actual - ytSeekTarget) < YT_SEEK_LANDED) ytSeekTarget = null;
            else return ytSeekTarget;
        }
        return actual;
    },
    set currentTime(t) {
        if (!ytReady) return;
        ytSeekTarget = t;
        ytSeekRetried = false;
        ytSuppress(2600);
        ytPlayer.seekTo(t, true);
        watchYtSeek();
    },
    get paused() {
        if (!ytReady) return true;
        const st = ytPlayer.getPlayerState();
        // ۳ = بافر شدن. یعنی دارد پخش می‌شود ولی داده ندارد، نه اینکه مکث شده
        return st !== 1 && st !== 3;
    },
    get rate() { return ytReady && ytPlayer.getPlaybackRate ? ytPlayer.getPlaybackRate() : 1; },
    set rate(r) { if (ytReady) ytPlayer.setPlaybackRate(r); },
    get volume() { return ytReady && ytPlayer.getVolume ? ytPlayer.getVolume() / 100 : 1; },
    set volume(v) { if (ytReady) ytPlayer.setVolume(Math.round(v * 100)); },
    get muted() { return ytReady && ytPlayer.isMuted ? ytPlayer.isMuted() : false; },
    set muted(m) { if (!ytReady) return; m ? ytPlayer.mute() : ytPlayer.unMute(); },
    get buffered() {
        if (!ytReady || !ytPlayer.getVideoLoadedFraction) return 0;
        return ytPlayer.getVideoLoadedFraction() * (ytPlayer.getDuration() || 0);
    },
    play() { if (ytReady) { ytSuppress(1600); ytPlayer.playVideo(); } return Promise.resolve(); },
    pause() { if (ytReady) { ytSuppress(1600); ytPlayer.pauseVideo(); } }
};

function P() { return state.mode === 'youtube' ? ytAdapter : html5Adapter; }

const YT_SEEK_LANDED = 1.0;      // ثانیه: این‌قدر نزدیک شد یعنی رسید
const YT_SEEK_PATIENCE = 8000;   // میلی‌ثانیه: بعد از این یک‌بار دوباره تلاش می‌کنیم

function ytSuppress(ms) { ytSuppressUntil = Math.max(ytSuppressUntil, performance.now() + ms); }
function ytSuppressed() { return performance.now() < ytSuppressUntil; }
function ytSeeking() { return ytSeekTarget !== null; }

// اگر یوتیوب جابه‌جایی را انجام نداد، یک‌بار دوباره می‌خواهیم و بعد رها می‌کنیم؛
// وگرنه پلیر تا ابد مقصدی را گزارش می‌کند که هرگز به آن نرسیده.
function watchYtSeek() {
    clearTimeout(ytSeekWatch);
    if (ytSeekTarget === null) return;
    ytSeekWatch = setTimeout(() => {
        if (ytSeekTarget === null || !ytReady) return;
        const actual = ytPlayer.getCurrentTime() || 0;
        if (Math.abs(actual - ytSeekTarget) < YT_SEEK_LANDED) { ytSeekTarget = null; return; }
        if (!ytSeekRetried) {
            ytSeekRetried = true;
            ytPlayer.seekTo(ytSeekTarget, true);
            watchYtSeek();
            return;
        }
        ytSeekTarget = null;
        playerToast('یوتیوب نتوانست به آن نقطه برود');
    }, YT_SEEK_PATIENCE);
}

// تا وقتی جابه‌جایی روی این دستگاه کامل نشده، موقعیتش قابل اتکا نیست و
// نباید پخش شود، وگرنه طرف مقابلِ درست را به عقب می‌کشد.
function seekPending() {
    return state.mode === 'youtube' ? ytSeeking() : el.video.seeking;
}

// ------------------------------------------------------------
// سرکوب اکو: رویدادهایی که خودمان به‌خاطر دستور طرف مقابل ساختیم
// نباید دوباره برای او فرستاده شوند.
// ------------------------------------------------------------
const expected = new Map();
function expectEvent(type, ms) { expected.set(type, performance.now() + (ms || 1200)); }
function consumeExpected(type) {
    const until = expected.get(type);
    if (until === undefined) return false;
    expected.delete(type);
    return performance.now() <= until;
}

// ------------------------------------------------------------
// سیگنالینگ
// ------------------------------------------------------------
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host;
}

function connectWebSocket() {
    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
        reconnectAttempts = 0;
        send({ type: 'hello', id: state.myId || null });
    };

    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }

        if (msg.type === 'welcome') {
            const previousId = state.myId;
            state.myId = msg.id;
            el.myIdText.textContent = msg.id;
            saveSession();
            if (pendingInviteId) {
                const inviteId = pendingInviteId;
                pendingInviteId = '';
                clearInviteFromUrl();
                if (inviteId === state.myId) {
                    setStatus('این لینک دعوت متعلق به خودتان است', 'error');
                    return;
                }
                state.partnerId = '';
                el.partnerId.value = inviteId;
                setStatus('لینک دعوت باز شد؛ در حال اتصال به ' + inviteId + '…', 'connecting');
                sendTo(inviteId, { type: 'connect_request' });
            } else if (state.partnerId) {
                state.peerUnstable = true;
                setStatus('اتصال با سرور برقرار شد، در حال اتصال دوباره به ' + state.partnerId + '…', 'connecting');
                // ممکن است سرور شناسهٔ تازه‌ای داده باشد؛ شناسهٔ قبلی را هم می‌فرستیم
                // تا طرف مقابل بتواند ما را بشناسد.
                el.partnerId.value = state.partnerId;
                el.connectBtn.hidden = true;
                el.disconnectBtn.hidden = false;
                sendTo(state.partnerId, { type: 'reconnect_request', wasId: previousId });
            } else {
                setStatus('آماده‌اید. شناسه‌تان را برای دوستتان بفرستید', 'success');
            }
            return;
        }
        if (msg.type === 'peer_gone' && msg.id === state.partnerId) {
            handlePeerLost('طرف مقابل صفحه را بست یا اتصالش قطع شد. منتظر بازگشت او…');
            return;
        }
        if (msg.type === 'signal' && msg.from) handleSignal(msg.data, msg.from);
    };

    ws.onclose = () => {
        const delay = Math.min(MAX_RECONNECT_DELAY, Math.pow(2, reconnectAttempts) * 1000);
        // پراکندگی تصادفی تا وقتی سرور ری‌استارت می‌شود همه با هم برنگردند
        const jitter = delay * (0.5 + Math.random() * 0.5);
        reconnectAttempts++;
        setStatus('ارتباط با سرور قطع شد. تلاش مجدد تا ' + Math.round(jitter / 1000) + ' ثانیهٔ دیگر…', 'error');
        setTimeout(connectWebSocket, jitter);
    };

    ws.onerror = () => {};
}

function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function sendTo(target, data) {
    if (!target) return;
    send({ type: 'signal', to: target, data: data });
}
function toPartner(data) { sendTo(state.partnerId, data); }

// ------------------------------------------------------------
// همگام‌سازی ساعت (سبک NTP). بدون این، جبران تأخیر بی‌معنی است
// ------------------------------------------------------------
let heartbeatTimer = null;
let lastPongAt = 0;

function startHeartbeat() {
    stopHeartbeat();
    lastPongAt = Date.now();
    state.peerUnstable = false;
    heartbeatTimer = setInterval(() => {
        if (!state.partnerId) { stopHeartbeat(); return; }
        // اگر tickها قطع شده‌اند، اصلاح سرعت نباید تا ابد روشن بماند
        if (nudging && Date.now() - lastTickAt > 6000) clearNudge();
        if (Date.now() - lastPongAt > 15000 && !state.peerUnstable) handlePeerLost();
        toPartner({ type: 'ping', a: Date.now() });
    }, 4000);
    toPartner({ type: 'ping', a: Date.now() });
}
function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
}

function recordClockSample(a, b) {
    const now = Date.now();
    const rtt = now - a;
    if (rtt < 0 || rtt > 4000) return;
    // offset = ساعت طرف مقابل منهای ساعت ما، در لحظهٔ میانی رفت‌وبرگشت
    const offset = b - (a + now) / 2;
    state.rttSamples.push({ rtt: rtt, offset: offset });
    if (state.rttSamples.length > 12) state.rttSamples.shift();
    // نمونه‌های با رفت‌وبرگشت کوتاه‌تر دقیق‌ترند
    const best = state.rttSamples.slice().sort((x, y) => x.rtt - y.rtt).slice(0, 5);
    best.sort((x, y) => x.offset - y.offset);
    state.clockOffset = best[Math.floor(best.length / 2)].offset;
}

// زمان طرف مقابل را به ساعت خودمان ترجمه می‌کند
function remoteToLocal(remoteTs) { return remoteTs - state.clockOffset; }

// ------------------------------------------------------------
// موتور همگام‌سازی
// ------------------------------------------------------------
const HARD_SEEK_THRESHOLD = 1.5;   // ثانیه، پرش
const NUDGE_THRESHOLD = 0.12;      // ثانیه، اصلاح نرم با تغییر سرعت
const MAX_NUDGE = 0.07;            // حداکثر ۷٪ تغییر سرعت
let tickTimer = null;
let nudging = false;
let lastTickAt = 0;

// یک طرف «مرجع» است تا هر دو هم‌زمان همدیگر را اصلاح نکنند و نوسان نگیرند.
function amFollower() {
    return !!state.partnerId && state.myId > state.partnerId;
}

function localState() {
    const p = P();
    return {
        time: p.currentTime,
        playing: !p.paused,
        rate: state.baseRate,
        duration: p.duration,
        sentAt: Date.now()
    };
}

function sendControl(action, extra) {
    if (!state.connected) return;
    const s = localState();
    s.type = 'control';
    s.action = action;
    if (extra) Object.assign(s, extra);
    toPartner(s);
}

function startTicker() {
    stopTicker();
    tickTimer = setInterval(() => {
        if (!state.connected || !state.hasMedia) return;
        const p = P();
        if (p.paused) return;
        if (seekPending()) return;
        const s = localState();
        s.type = 'tick';
        toPartner(s);
    }, 2000);
}
function stopTicker() { if (tickTimer) clearInterval(tickTimer); tickTimer = null; }

// زمان هدف طرف مقابل، با احتساب تأخیر شبکه
function targetTimeFrom(s) {
    const elapsed = Math.max(0, (Date.now() - remoteToLocal(s.sentAt)) / 1000);
    return s.playing ? s.time + elapsed * (s.rate || 1) : s.time;
}

function applyRate(r) {
    const p = P();
    if (Math.abs(p.rate - r) < 0.001) return;
    expectEvent('ratechange', 1200);
    p.rate = r;
}

function clearNudge() {
    if (!nudging) return;
    nudging = false;
    applyRate(state.baseRate);
}

function applyRemoteControl(s) {
    const p = P();
    state.partnerDuration = s.duration || null;
    checkLengthMatch();

    if (s.rate && Math.abs(s.rate - state.baseRate) > 0.001) {
        state.baseRate = s.rate;
        applyRate(s.rate);
        renderRateMenu();
    }

    const target = targetTimeFrom(s);
    if (Math.abs(p.currentTime - target) > (state.mode === 'youtube' ? 0.9 : 0.35)) {
        expectEvent('seeked', 4000);
        p.currentTime = target;
    }

    state.wantPlaying = s.playing;
    syncPlayback();
}

function applyRemoteTick(s) {
    const p = P();
    state.partnerDuration = s.duration || null;

    if (state.wantPlaying !== s.playing) {
        state.wantPlaying = s.playing;
        syncPlayback();
        return;
    }
    lastTickAt = Date.now();
    if (!s.playing || p.paused) return;
    if (!amFollower()) return;          // فقط دنبال‌کننده خودش را تنظیم می‌کند
    if (state.localStalled || state.peerStalled) return;
    // getCurrentTime یوتیوب بلافاصله بعد از جابه‌جایی هنوز عدد قدیمی می‌دهد؛
    // بدون این، هر تیک یک جابه‌جایی تازه می‌سازد و پخش مدام می‌پرد.
    if (state.mode === 'youtube' && ytSeeking()) return;

    const diff = targetTimeFrom(s) - p.currentTime;

    // آستانهٔ یوتیوب بازتر است چون گزارش زمانش دقیق نیست
    const seekThreshold = state.mode === 'youtube' ? 2.5 : HARD_SEEK_THRESHOLD;
    if (Math.abs(diff) > seekThreshold) {
        expectEvent('seeked', 4000);
        p.currentTime = p.currentTime + diff;
        clearNudge();
        return;
    }

    if (state.mode === 'youtube') return; // یوتیوب فقط سرعت‌های گسسته را می‌پذیرد

    if (Math.abs(diff) > NUDGE_THRESHOLD) {
        // به‌جای پرش، چند ثانیه کمی تندتر/کندتر پخش می‌کنیم تا بی‌صدا جبران شود
        const factor = clamp(diff * 0.35, -MAX_NUDGE, MAX_NUDGE);
        nudging = true;
        applyRate(state.baseRate * (1 + factor));
    } else {
        clearNudge();
    }
}

// پخش واقعی = خواستهٔ کاربر منهای گیرکردن هر یک از دو طرف
function syncPlayback() {
    const p = P();
    const shouldPlay = state.wantPlaying && !state.peerStalled;
    if (shouldPlay && p.paused) {
        expectEvent('play', 1500);
        const r = p.play();
        if (r && r.catch) r.catch(() => {
            // مرورگر پخش خودکار را رد کرد؛ کاربر باید خودش بزند
            state.wantPlaying = false;
            updatePlayIcon();
            playerToast('برای پخش، روی دکمهٔ وسط تصویر بزنید');
        });
    } else if (!shouldPlay && !p.paused) {
        expectEvent('pause', 1500);
        p.pause();
    }
    updateBufferingUi();
    updatePlayIcon();
}

function updateBufferingUi() {
    const waiting = state.localStalled || state.peerStalled;
    el.player.classList.toggle('is-buffering', waiting && state.wantPlaying);
    el.bufferingText.textContent = state.peerStalled && !state.localStalled
        ? 'منتظر طرف مقابل…'
        : 'در حال بارگذاری…';
}

function setLocalStalled(v) {
    if (state.localStalled === v) return;
    state.localStalled = v;
    if (state.connected) sendControl(v ? 'stall' : 'ready');
    syncPlayback();
}

let stallTimer = null;

// وقفهٔ ناشی از جابه‌جایی، بافر نیست. وقفهٔ خیلی کوتاه هم ارزش متوقف کردن
// طرف مقابل را ندارد، وگرنه پخش هر چند لحظه تکان می‌خورد.
function noteWaiting() {
    if (!state.wantPlaying) return;
    if (state.mode === 'youtube' ? ytSeeking() : el.video.seeking) return;
    clearTimeout(stallTimer);
    // یوتیوب بسیار بیشتر از ویدیوی محلی بافر می‌کند، پس صبر بیشتری لازم دارد
    stallTimer = setTimeout(() => setLocalStalled(true), state.mode === 'youtube' ? 1200 : 450);
}
function noteReady() {
    clearTimeout(stallTimer);
    setLocalStalled(false);
}

// ------------------------------------------------------------
// دریافت پیام‌ها
// ------------------------------------------------------------
function handleSignal(data, from) {
    if (!data || typeof data !== 'object') return;
    // هر پیامی از طرف مقابل یعنی او زنده است. تکیه کردن فقط به pong خطرناک
    // است چون مرورگر تایمرهای تب پس‌زمینه را کند می‌کند.
    if (from === state.partnerId) {
        lastPongAt = Date.now();
        if (state.peerUnstable) {
            state.peerUnstable = false;
            state.peerStalled = false;
            setStatus('اتصال با ' + from + ' دوباره برقرار شد', 'connected');
            setChatEnabled(true);
            syncPlayback();
        }
    }

    if (data.type === 'ping') { sendTo(from, { type: 'pong', a: data.a, b: Date.now() }); return; }
    if (data.type === 'pong' && from === state.partnerId) {
        lastPongAt = Date.now();
        recordClockSample(data.a, data.b);
        if (state.peerUnstable) {
            state.peerUnstable = false;
            state.peerStalled = false;
            setStatus('اتصال با ' + from + ' دوباره برقرار شد', 'connected');
            setChatEnabled(true);
            syncPlayback();
        }
        return;
    }

    if (data.type === 'connect_request') {
        if (state.partnerId && state.partnerId !== from) {
            sendTo(from, { type: 'busy' });
            return;
        }
        establishPair(from, 'متصل به ' + from);
        sendTo(from, { type: 'connect_confirm' });
        sendSourceInfo();
        sendControl('sync');
        return;
    }

    if (data.type === 'connect_confirm') {
        establishPair(from, 'اتصال با ' + from + ' برقرار شد');
        toPartner({ type: 'request_source' });
        return;
    }

    if (data.type === 'busy') {
        setStatus('طرف مقابل هم‌اکنون به فرد دیگری متصل است', 'error');
        return;
    }

    if (data.type === 'no_such_peer') {
        setStatus('کسی با این شناسه آنلاین نیست. شناسه را دوباره بررسی کنید.', 'error');
        return;
    }

    if (data.type === 'reconnect_request' &&
        (from === state.partnerId || (data.wasId && data.wasId === state.partnerId))) {
        resumePair(from);
        sendTo(from, { type: 'reconnect_confirm', wasId: state.myId });
        return;
    }
    if (data.type === 'reconnect_confirm' &&
        (from === state.partnerId || (data.wasId && data.wasId === state.partnerId))) {
        resumePair(from);
        return;
    }

    if (from !== state.partnerId) return;

    switch (data.type) {
        case 'request_source':
            sendSourceInfo();
            break;

        case 'request_state':
            sendControl('sync');
            break;

        case 'source':
            state.partnerSource = data;
            if (data.kind === 'youtube') {
                loadYouTube(data.videoId, false);
            } else if (data.kind === 'url') {
                loadUrl(data.url, false);
            } else if (data.kind === 'file') {
                state.partnerDuration = data.duration || null;
                playerToast('دوستتان فایل «' + data.name + '» را باز کرده. همان فایل را انتخاب کنید.');
                checkLengthMatch();
            }
            break;

        case 'control':
            if (data.action === 'stall') {
                state.peerStalled = true;
                syncPlayback();
            } else if (data.action === 'ready') {
                state.peerStalled = false;
                syncPlayback();
            } else {
                state.peerStalled = false;
                applyRemoteControl(data);
            }
            break;

        case 'tick':
            applyRemoteTick(data);
            break;

        case 'chat':
            receiveChat(data.msg);
            break;

        case 'reaction':
            receiveReaction(data.emoji);
            break;

        case 'disconnect':
            resetConnection('اتصال توسط طرف مقابل قطع شد');
            break;
    }
}

function establishPair(id, message) {
    lastTickAt = Date.now();
    state.partnerId = id;
    state.connected = true;
    state.peerUnstable = false;
    state.rttSamples = [];
    el.partnerId.value = id;
    el.connectBtn.hidden = true;
    el.disconnectBtn.hidden = false;
    setStatus(message, 'connected');
    setChatEnabled(true);
    startHeartbeat();
    startTicker();
    saveSession();
}

function resumePair(from) {
    state.partnerId = from;
    state.connected = true;
    state.peerUnstable = false;
    state.peerStalled = false;
    state.rttSamples = [];
    lastPongAt = Date.now();
    el.partnerId.value = from;
    el.connectBtn.hidden = true;
    el.disconnectBtn.hidden = false;
    setStatus('اتصال با ' + from + ' دوباره برقرار شد', 'connected');
    setChatEnabled(true);
    startHeartbeat();
    startTicker();
    saveSession();
}

function handlePeerLost(reason) {
    if (state.peerUnstable) return;
    state.peerUnstable = true;
    setStatus(reason || 'ارتباط با طرف مقابل ناپایدار است. منتظر اتصال دوباره…', 'connecting');
    setChatEnabled(false);
    // مثل «گیر کردن طرف مقابل» رفتار می‌کنیم نه مثل مکث کاربر: پخش نگه داشته
    // می‌شود ولی خواستهٔ کاربر پاک نمی‌شود، پس با بازگشت او خودکار ادامه می‌یابد.
    state.peerStalled = true;
    syncPlayback();
}

function resetConnection(reason) {
    state.partnerId = '';
    state.connected = false;
    state.peerUnstable = false;
    state.peerStalled = false;
    state.partnerDuration = null;
    state.partnerSource = null;
    state.wantPlaying = false;
    state.rttSamples = [];
    state.clockOffset = 0;
    clearNudge();
    syncPlayback();
    el.partnerId.value = '';
    el.connectBtn.hidden = false;
    el.disconnectBtn.hidden = true;
    stopHeartbeat();
    stopTicker();
    setChatEnabled(false);
    checkLengthMatch();
    setStatus(reason || 'اتصال قطع شد', 'disconnected');
    saveSession();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function sendSourceInfo() {
    if (!state.connected) return;
    if (state.mode === 'youtube' && ytReady && ytPlayer.getVideoData) {
        const vd = ytPlayer.getVideoData();
        if (vd && vd.video_id) toPartner({ type: 'source', kind: 'youtube', videoId: vd.video_id });
        return;
    }
    if (currentSource.kind === 'url') {
        toPartner({ type: 'source', kind: 'url', url: currentSource.url });
    } else if (currentSource.kind === 'file') {
        toPartner({
            type: 'source', kind: 'file',
            name: currentSource.name, size: currentSource.size,
            duration: P().duration
        });
    }
}

// ------------------------------------------------------------
// منبع ویدیو
// ------------------------------------------------------------
let currentSource = { kind: null, url: '', name: '', size: 0 };
let objectUrl = null;

function setMode(mode) {
    state.mode = mode;
    el.player.dataset.mode = mode;
}

function markHasMedia() {
    state.hasMedia = true;
    el.player.classList.add('has-media');
}

function loadUrl(url, share) {
    const ytId = youTubeId(url);
    if (ytId) { loadYouTube(ytId, share); return; }

    try { new URL(url, location.href); }
    catch (e) { setStatus('لینک وارد شده معتبر نیست', 'error'); return; }

    setMode('html5');
    stopSubtitleScan();
    clearSubtitles();
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    currentSource = { kind: 'url', url: url, name: '', size: 0 };
    el.video.src = url;
    el.videoUrl.value = url;
    markHasMedia();
    setStatus('در حال بارگذاری ویدیو…', 'connecting');
    if (share && state.connected) toPartner({ type: 'source', kind: 'url', url: url });
}

function loadFile(file) {
    setMode('html5');
    stopSubtitleScan();
    clearSubtitles();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    currentSource = { kind: 'file', url: '', name: file.name, size: file.size };
    el.video.src = objectUrl;
    el.videoUrl.value = '';
    markHasMedia();
    setStatus('فایل بارگذاری شد: ' + file.name, 'success');

    if (/\.mkv$/i.test(file.name) || file.type === 'video/x-matroska') scanMkvSubtitles(file);

    if (state.connected) {
        sendSourceInfo();
        if (state.partnerSource && state.partnerSource.kind === 'file' && state.partnerSource.size &&
            state.partnerSource.size !== file.size) {
            playerToast('حجم فایل شما با فایل دوستتان یکی نیست؛ احتمالاً دو نسخهٔ متفاوت است.');
        }
    }
}

function youTubeId(url) {
    const m = String(url).match(/(?:youtube\.com\/(?:[^/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

function loadYouTubeApi() {
    if (ytApiLoading) return ytApiLoading;
    ytApiLoading = new Promise((resolve) => {
        window.onYouTubeIframeAPIReady = () => resolve();
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(s);
    });
    return ytApiLoading;
}

async function loadYouTube(videoId, share) {
    setMode('youtube');
    stopSubtitleScan();
    clearSubtitles();
    markHasMedia();
    setStatus('در حال بارگذاری ویدیوی یوتیوب…', 'connecting');
    el.videoUrl.value = 'https://www.youtube.com/watch?v=' + videoId;
    el.video.removeAttribute('src');
    el.video.load();

    await loadYouTubeApi();

    if (ytPlayer && ytPlayer.destroy) { ytPlayer.destroy(); ytPlayer = null; ytReady = false; }
    ytSeekTarget = null;
    ytSeekRetried = false;
    ytSuppressUntil = 0;
    clearTimeout(ytSeekWatch);
    const host = document.createElement('div');
    host.id = 'yt-frame';
    el.ytHost.innerHTML = '';
    el.ytHost.appendChild(host);

    // اگر API یوتیوب جواب نداد، کاربر نباید جلوی صفحهٔ سیاه بماند
    const ytReadyTimeout = setTimeout(() => {
        if (!ytReady) setStatus('پخش‌کنندهٔ یوتیوب پاسخ نداد. اتصال یا فیلترشکن را بررسی کنید.', 'error');
    }, 15000);

    ytPlayer = new YT.Player('yt-frame', {
        videoId: videoId,
        host: 'https://www.youtube.com',
        playerVars: {
            playsinline: 1, controls: 0, rel: 0, modestbranding: 1,
            disablekb: 1, iv_load_policy: 3,
            enablejsapi: 1,
            origin: location.origin
        },
        events: {
            onError: (e) => {
                const why = { 2: 'شناسهٔ ویدیو نامعتبر است', 5: 'این ویدیو در پخش‌کنندهٔ وب پخش نمی‌شود',
                              100: 'ویدیو پیدا نشد یا حذف شده', 101: 'صاحب ویدیو اجازهٔ پخش در سایت دیگر را نداده',
                              150: 'صاحب ویدیو اجازهٔ پخش در سایت دیگر را نداده' }[e.data];
                setStatus(why || 'خطا در پخش ویدیوی یوتیوب', 'error');
                playerToast(why || 'این ویدیوی یوتیوب پخش نشد');
            },
            onReady: () => {
                ytReady = true;
                clearTimeout(ytReadyTimeout);
                setStatus('پخش‌کنندهٔ یوتیوب آماده است', 'success');
                el.volume.value = ytAdapter.volume;
                if (!state.connected) return;
                // اگر ویدیو را طرف مقابل باز کرده، وضعیت او مرجع است؛ وگرنه ما
                // تازه بارگذاری کرده‌ایم و وضعیت خودمان را اعلام می‌کنیم.
                if (share) sendControl('sync');
                else toPartner({ type: 'request_state' });
            },
            onStateChange: (e) => {
                if (!ytReady) return;
                const st = e.data;   // 1=پخش 2=مکث 3=بافر

                if (st === 3) {
                    noteWaiting();
                    return;
                }
                if (st !== 1 && st !== 2) return;

                // مقصد جابه‌جایی عمداً اینجا پاک نمی‌شود؛ فقط وقتی پاک می‌شود که
                // پلیر واقعاً به آن رسیده باشد. یوتیوب وسط یک جابه‌جایی هم وضعیت
                // «مکث» می‌فرستد و پاک کردن زودهنگام، تیک بعدی را گمراه می‌کند.
                noteReady();

                // اگر این تغییر نتیجهٔ دستور خودمان بود، دوباره پخشش نکن
                if (!ytSuppressed()) {
                    const playing = st === 1;
                    if (state.wantPlaying !== playing) {
                        state.wantPlaying = playing;
                        sendControl(playing ? 'play' : 'pause');
                    }
                }
                updatePlayIcon();
            }
        }
    });
    if (share && state.connected) toPartner({ type: 'source', kind: 'youtube', videoId: videoId });
}

// ------------------------------------------------------------
// زیرنویس
// ------------------------------------------------------------
// tracks: {id, label, lang, cues:[{start,end,text}], source:'file'|'mkv'}
let subTracks = [];
let activeTrackId = null;
let subWorker = null;
let lastCueText = '';

function clearSubtitles() {
    subTracks = [];
    activeTrackId = null;
    lastCueText = '';
    el.subs.textContent = '';
    renderSubsMenu();
}

function addTrack(track) {
    subTracks.push(track);
    if (activeTrackId === null) selectTrack(track.id);
    renderSubsMenu();
}

function selectTrack(id) {
    activeTrackId = id;
    lastCueText = '';
    el.subs.textContent = '';
    el.btnSubs.classList.toggle('on', id !== null);
    renderSubsMenu();
}

function renderSubsMenu() {
    const items = [];
    items.push({ id: null, label: 'خاموش', sub: '' });
    subTracks.forEach((t) => items.push({ id: t.id, label: t.label, sub: t.source === 'mkv' ? 'داخل فایل' : 'فایل جدا' }));

    el.subsMenuItems.innerHTML = '';
    items.forEach((it) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'menu-item';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(activeTrackId === it.id));
        const check = document.createElement('span');
        check.className = 'check';
        check.textContent = '✓';
        const label = document.createElement('span');
        label.textContent = it.label;
        b.appendChild(check);
        b.appendChild(label);
        if (it.sub) {
            const sub = document.createElement('span');
            sub.className = 'sub';
            sub.textContent = it.sub;
            b.appendChild(sub);
        }
        b.addEventListener('click', () => { selectTrack(it.id); closeMenus(); });
        el.subsMenuItems.appendChild(b);
    });
}

function renderSubtitleAt(t) {
    if (activeTrackId === null) {
        if (lastCueText) { lastCueText = ''; el.subs.textContent = ''; }
        return;
    }
    const track = subTracks.find((x) => x.id === activeTrackId);
    if (!track) return;
    const cues = track.cues;

    // جست‌وجوی دودویی روی کیوهای مرتب
    let lo = 0, hi = cues.length - 1, found = '';
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const c = cues[mid];
        if (t < c.start) hi = mid - 1;
        else if (t > c.end) lo = mid + 1;
        else { found = c.text; break; }
    }
    if (found === lastCueText) return;
    lastCueText = found;
    el.subs.innerHTML = '';
    if (found) {
        const span = document.createElement('span');
        span.className = 'subs-text';
        span.textContent = found;
        el.subs.appendChild(span);
    }
}

// ---- زیرنویس داخل MKV ----
function stopSubtitleScan() {
    if (subWorker) { subWorker.terminate(); subWorker = null; }
    el.subsScan.classList.remove('show');
}

function scanMkvSubtitles(file) {
    stopSubtitleScan();
    el.subsScanText.textContent = 'در حال خواندن زیرنویس‌های داخل فایل…';
    el.subsScan.classList.add('show');

    let worker;
    try { worker = new Worker('/mkv-subs.worker.js'); }
    catch (e) { el.subsScan.classList.remove('show'); return; }
    subWorker = worker;

    const byNumber = new Map();

    worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'tracks') {
            if (!m.tracks.length) {
                el.subsScan.classList.remove('show');
                return;
            }
            m.tracks.forEach((t, i) => {
                const id = 'mkv-' + t.number;
                const track = {
                    id: id,
                    label: t.name || langLabel(t.lang) || ('زیرنویس ' + (i + 1)),
                    lang: t.lang,
                    cues: [],
                    source: 'mkv'
                };
                byNumber.set(t.number, track);
                addTrack(track);
            });
            el.subsScanText.textContent = m.tracks.length + ' زیرنویس پیدا شد، در حال خواندن…';
        } else if (m.type === 'cues') {
            m.cues.forEach((c) => {
                const track = byNumber.get(c.track);
                if (track) track.cues.push({ start: c.start, end: c.end, text: c.text });
            });
        } else if (m.type === 'progress') {
            if (byNumber.size) {
                const pct = Math.round((m.done / m.total) * 100);
                el.subsScanText.textContent = 'خواندن زیرنویس‌ها: ٪' + pct;
            }
        } else if (m.type === 'done') {
            if (byNumber.size) {
                playerToast(byNumber.size + ' زیرنویس از داخل فایل خوانده شد');
            }
            el.subsScan.classList.remove('show');
            subWorker = null;
            worker.terminate();
        } else if (m.type === 'error') {
            el.subsScan.classList.remove('show');
            subWorker = null;
            worker.terminate();
        }
    };
    worker.onerror = () => { el.subsScan.classList.remove('show'); subWorker = null; };
    worker.postMessage({ file: file });
}

const LANG_NAMES = {
    fa: 'فارسی', fas: 'فارسی', per: 'فارسی',
    en: 'انگلیسی', eng: 'انگلیسی',
    ar: 'عربی', ara: 'عربی',
    fr: 'فرانسوی', fre: 'فرانسوی', fra: 'فرانسوی',
    de: 'آلمانی', ger: 'آلمانی', deu: 'آلمانی',
    es: 'اسپانیایی', spa: 'اسپانیایی',
    tr: 'ترکی', tur: 'ترکی',
    ru: 'روسی', rus: 'روسی'
};
function langLabel(code) {
    if (!code) return '';
    const k = String(code).toLowerCase().split('-')[0];
    return LANG_NAMES[k] || code;
}

// ---- زیرنویس از فایل جداگانه ----
async function loadSubtitleFile(file) {
    const buf = await file.arrayBuffer();
    const text = decodeSubtitle(buf);
    const cues = /^\s*WEBVTT/.test(text) ? parseVtt(text) : parseSrt(text);
    if (!cues.length) { playerToast('زیرنویسی در این فایل پیدا نشد'); return; }
    const id = 'file-' + Date.now();
    addTrack({ id: id, label: file.name.replace(/\.[^.]+$/, ''), lang: '', cues: cues, source: 'file' });
    selectTrack(id);
    playerToast('زیرنویس اضافه شد (' + cues.length + ' خط)');
}

// زیرنویس‌های فارسی قدیمی معمولاً windows-1256 هستند، نه UTF-8
function decodeSubtitle(buf) {
    const bytes = new Uint8Array(buf);
    let start = 0;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
    const body = bytes.subarray(start);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch (e) {
        try { return new TextDecoder('windows-1256').decode(body); }
        catch (e2) { return new TextDecoder('utf-8').decode(body); }
    }
}

function tc(str) {
    const m = str.trim().match(/(\d+):(\d{2}):(\d{2})[.,](\d{1,3})/);
    if (!m) return null;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
}

function cleanCue(s) {
    return s.replace(/\{\\[^}]*\}/g, '')
        .replace(/<\/?(i|b|u|font|ruby|rt)(\s[^>]*)?>/gi, '')
        .trim();
}

function parseSrt(text) {
    const cues = [];
    const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
    for (const block of blocks) {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        if (lines.length < 2) continue;
        const timeLine = lines.find((l) => l.indexOf('-->') !== -1);
        if (!timeLine) continue;
        const parts = timeLine.split('-->');
        const start = tc(parts[0]), end = tc(parts[1]);
        if (start === null || end === null) continue;
        const body = lines.slice(lines.indexOf(timeLine) + 1).join('\n');
        const clean = cleanCue(body);
        if (clean) cues.push({ start: start, end: end, text: clean });
    }
    cues.sort((a, b) => a.start - b.start);
    return cues;
}

function parseVtt(text) {
    const cues = [];
    const blocks = text.replace(/\r/g, '').replace(/^\s*WEBVTT[^\n]*\n/, '').split(/\n{2,}/);
    for (const block of blocks) {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        const timeLine = lines.find((l) => l.indexOf('-->') !== -1);
        if (!timeLine) continue;
        const parts = timeLine.split('-->');
        const start = tc(parts[0]), end = tc(parts[1]);
        if (start === null || end === null) continue;
        const body = lines.slice(lines.indexOf(timeLine) + 1).join('\n');
        const clean = cleanCue(body);
        if (clean) cues.push({ start: start, end: end, text: clean });
    }
    cues.sort((a, b) => a.start - b.start);
    return cues;
}

// ------------------------------------------------------------
// رابط پلیر
// ------------------------------------------------------------
function updatePlayIcon() {
    const playing = state.hasMedia && !P().paused;
    el.player.classList.toggle('is-playing', playing);
    setHidden(el.iconPlay, playing);
    setHidden(el.iconPause, !playing);
}

function togglePlay() {
    if (!state.hasMedia) return;
    state.wantPlaying = P().paused;
    if (state.wantPlaying) {
        state.localStalled = false;
        syncPlayback();
        sendControl('play');
    } else {
        syncPlayback();
        sendControl('pause');
    }
}

function seekTo(t) {
    if (!state.hasMedia) return;
    const p = P();
    const d = p.duration || 0;
    // رویداد seeked خودش هم می‌خواهد این را بفرستد؛ یک‌بار کافی است
    expectEvent('seeked', 4000);
    p.currentTime = clamp(t, 0, d ? d - 0.15 : t);
    clearNudge();
    sendControl('seek');
}

function skip(sec) { seekTo(P().currentTime + sec); }

function playerToast(msg) {
    el.playerToast.textContent = msg;
    el.playerToast.classList.add('show');
    clearTimeout(playerToast._t);
    playerToast._t = setTimeout(() => el.playerToast.classList.remove('show'), 4200);
}

// ---- حلقهٔ رندر ----
let rafId = null;
function renderLoop() {
    rafId = requestAnimationFrame(renderLoop);
    if (!state.hasMedia) return;
    const p = P();
    const d = p.duration || 0;
    const t = p.currentTime;

    if (!scrubDragging) {
        const pct = d ? (t / d) * 100 : 0;
        el.scrubFill.style.width = pct + '%';
        el.scrub.setAttribute('aria-valuenow', String(Math.round(pct)));
        const buf = p.buffered;
        el.scrubBuffer.style.width = (d ? clamp((buf / d) * 100, 0, 100) : 0) + '%';
    }
    el.timeCur.textContent = fmtTime(t);
    el.timeDur.textContent = fmtTime(d);
    renderSubtitleAt(t);
}

// ---- نوار پیشرفت ----
let scrubDragging = false;

function scrubRatio(clientX) {
    const r = el.scrub.getBoundingClientRect();
    // چیدمان راست‌به‌چپ است ولی محور زمان از چپ به راست می‌ماند
    return clamp((clientX - r.left) / r.width, 0, 1);
}

function updateScrubTip(clientX) {
    const d = P().duration || 0;
    const ratio = scrubRatio(clientX);
    el.scrubTip.textContent = fmtTime(ratio * d);
    const r = el.scrub.getBoundingClientRect();
    el.scrubTip.style.left = clamp(clientX - r.left, 24, r.width - 24) + 'px';
}

el.scrub.addEventListener('pointerdown', (e) => {
    if (!state.hasMedia) return;
    scrubDragging = true;
    el.scrub.classList.add('dragging');
    el.scrub.setPointerCapture(e.pointerId);
    const ratio = scrubRatio(e.clientX);
    el.scrubFill.style.width = (ratio * 100) + '%';
    updateScrubTip(e.clientX);
});
el.scrub.addEventListener('pointermove', (e) => {
    if (!state.hasMedia) return;
    updateScrubTip(e.clientX);
    if (!scrubDragging) return;
    el.scrubFill.style.width = (scrubRatio(e.clientX) * 100) + '%';
});
el.scrub.addEventListener('pointerup', (e) => {
    if (!scrubDragging) return;
    scrubDragging = false;
    el.scrub.classList.remove('dragging');
    seekTo(scrubRatio(e.clientX) * (P().duration || 0));
});
el.scrub.addEventListener('pointercancel', () => { scrubDragging = false; el.scrub.classList.remove('dragging'); });
el.scrub.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { skip(5); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { skip(-5); e.preventDefault(); }
});

// ---- دکمه‌ها ----
el.btnPlay.addEventListener('click', togglePlay);
el.bigPlay.addEventListener('click', togglePlay);
el.btnBack.addEventListener('click', () => skip(-10));
el.btnFwd.addEventListener('click', () => skip(10));

el.btnMute.addEventListener('click', () => {
    const p = P();
    p.muted = !p.muted;
    updateVolumeUi();
});
el.volume.addEventListener('input', () => {
    const p = P();
    p.volume = +el.volume.value;
    p.muted = +el.volume.value === 0;
    updateVolumeUi();
});
function updateVolumeUi() {
    const p = P();
    const muted = p.muted || p.volume === 0;
    setHidden(el.iconVol, muted);
    setHidden(el.iconMute, !muted);
    el.volume.value = muted ? 0 : p.volume;
}

// ---- منوها ----
function closeMenus() {
    el.subsMenu.classList.remove('open');
    el.rateMenu.classList.remove('open');
    el.reactionMenu.classList.remove('open');
    el.btnSubs.setAttribute('aria-expanded', 'false');
    el.btnRate.setAttribute('aria-expanded', 'false');
    el.btnReactions.setAttribute('aria-expanded', 'false');
}
function toggleMenu(menu, btn) {
    const open = menu.classList.contains('open');
    closeMenus();
    if (!open) {
        menu.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
    }
}
el.btnSubs.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(el.subsMenu, el.btnSubs); });
el.btnRate.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(el.rateMenu, el.btnRate); });
el.btnReactions.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.connected) { playerToast('برای فرستادن واکنش ابتدا متصل شوید'); return; }
    toggleMenu(el.reactionMenu, el.btnReactions);
    wakeControls();
});
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeMenus(); });

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
function renderRateMenu() {
    el.rateMenuItems.innerHTML = '';
    RATES.forEach((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'menu-item';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(Math.abs(state.baseRate - r) < 0.001));
        const check = document.createElement('span');
        check.className = 'check'; check.textContent = '✓';
        const label = document.createElement('span');
        label.textContent = r === 1 ? 'عادی' : '×' + r;
        b.appendChild(check); b.appendChild(label);
        b.addEventListener('click', () => {
            state.baseRate = r;
            clearNudge();
            applyRate(r);
            renderRateMenu();
            closeMenus();
            sendControl('rate');
        });
        el.rateMenuItems.appendChild(b);
    });
}

// ---- تمام‌صفحه ----
el.btnFs.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else el.player.requestFullscreen().catch(() => {});
});
document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    setHidden(el.iconFs, fs);
    setHidden(el.iconFsExit, !fs);
});

// ---- تصویر در تصویر ----
if (document.pictureInPictureEnabled) {
    el.btnPip.hidden = false;
    el.btnPip.addEventListener('click', async () => {
        if (state.mode !== 'html5') return;
        try {
            if (document.pictureInPictureElement) await document.exitPictureInPicture();
            else await el.video.requestPictureInPicture();
        } catch (e) {}
    });
}

// ---- مخفی شدن خودکار کنترل‌ها ----
let idleTimer = null;
function wakeControls() {
    el.player.classList.remove('controls-hidden', 'is-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (!state.hasMedia || P().paused) return;
        if (el.player.classList.contains('chat-open')) return;
        if (el.subsMenu.classList.contains('open') || el.rateMenu.classList.contains('open') || el.reactionMenu.classList.contains('open')) return;
        el.player.classList.add('controls-hidden', 'is-idle');
    }, 2800);
}
el.player.addEventListener('pointermove', wakeControls);
el.player.addEventListener('pointerleave', () => {
    if (state.hasMedia && !P().paused && !el.player.classList.contains('chat-open')) {
        el.player.classList.add('controls-hidden');
    }
});
el.player.addEventListener('pointerdown', wakeControls);

// کلیک روی خود تصویر = پخش/مکث
el.video.addEventListener('click', togglePlay);
el.video.addEventListener('dblclick', () => el.btnFs.click());

// ---- کلیدهای میان‌بر ----
document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) {
        if (e.key === 'Escape' && e.target === el.overlayChatInput) closeOverlayChat();
        return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // اگر فوکوس روی یک دکمه است، Space و Enter کار خودِ آن دکمه را بکنند
    if ((e.key === ' ' || e.key === 'Enter') && e.target.closest('button,[role="slider"]')) return;

    switch (e.key) {
        case ' ': case 'k': case 'K': e.preventDefault(); togglePlay(); wakeControls(); break;
        case 'ArrowRight': e.preventDefault(); skip(10); wakeControls(); break;
        case 'ArrowLeft': e.preventDefault(); skip(-10); wakeControls(); break;
        case 'ArrowUp': e.preventDefault(); setVolumeBy(0.05); wakeControls(); break;
        case 'ArrowDown': e.preventDefault(); setVolumeBy(-0.05); wakeControls(); break;
        case 'f': case 'F': el.btnFs.click(); break;
        case 'm': case 'M': el.btnMute.click(); break;
        case 's': case 'S': cycleSubtitles(); break;
        case 'c': case 'C': e.preventDefault(); openOverlayChat(); break;
        case 'Escape': if (el.player.classList.contains('chat-open')) closeOverlayChat(); break;
    }
});

function setVolumeBy(delta) {
    const p = P();
    p.volume = clamp(p.volume + delta, 0, 1);
    p.muted = p.volume === 0;
    updateVolumeUi();
}

function cycleSubtitles() {
    if (!subTracks.length) { playerToast('زیرنویسی موجود نیست'); return; }
    const ids = [null].concat(subTracks.map((t) => t.id));
    const i = ids.indexOf(activeTrackId);
    selectTrack(ids[(i + 1) % ids.length]);
    const t = subTracks.find((x) => x.id === activeTrackId);
    playerToast(t ? 'زیرنویس: ' + t.label : 'زیرنویس خاموش');
}

// ------------------------------------------------------------
// واکنش‌های سریع
// ------------------------------------------------------------
const QUICK_REACTIONS = [
    { emoji: '❤️', label: 'عاشقش شدم' },
    { emoji: '😂', label: 'خیلی خنده‌دار' },
    { emoji: '😍', label: 'فوق‌العاده‌ست' },
    { emoji: '😮', label: 'وااای' },
    { emoji: '😭', label: 'گریه‌ام گرفت' },
    { emoji: '😱', label: 'ترسیدم' },
    { emoji: '🔥', label: 'ترکوند' },
    { emoji: '👏', label: 'آفرین' },
    { emoji: '🍿', label: 'چه فیلمی' },
    { emoji: '🤯', label: 'ذهنم منفجر شد' }
];
const QUICK_REACTION_SET = new Set(QUICK_REACTIONS.map((item) => item.emoji));
let lastReactionAt = 0;

function renderQuickReactions() {
    el.reactionItems.innerHTML = '';
    QUICK_REACTIONS.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'reaction-choice';
        button.textContent = item.emoji;
        button.title = item.label;
        button.setAttribute('role', 'menuitem');
        button.setAttribute('aria-label', item.label + ' ' + item.emoji);
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            sendReaction(item.emoji);
            button.classList.remove('sent');
            requestAnimationFrame(() => button.classList.add('sent'));
            setTimeout(() => button.classList.remove('sent'), 400);
            wakeControls();
        });
        el.reactionItems.appendChild(button);
    });
}

function sendReaction(emoji) {
    if (!state.connected || !QUICK_REACTION_SET.has(emoji)) return;
    const now = Date.now();
    if (now - lastReactionAt < 180) return;
    lastReactionAt = now;
    showReaction(emoji, true);
    toPartner({ type: 'reaction', emoji: emoji });
}

function receiveReaction(emoji) {
    if (!QUICK_REACTION_SET.has(emoji)) return;
    showReaction(emoji, false);
}

function showReaction(emoji, mine) {
    const burst = document.createElement('div');
    burst.className = 'reaction-burst' + (mine ? ' mine' : '');
    burst.style.setProperty('--x', (28 + Math.random() * 44).toFixed(1) + '%');
    burst.style.setProperty('--drift', ((Math.random() - 0.5) * 110).toFixed(0) + 'px');
    burst.style.setProperty('--tilt', ((Math.random() - 0.5) * 18).toFixed(1) + 'deg');

    const icon = document.createElement('span');
    icon.className = 'reaction-emoji';
    icon.textContent = emoji;
    burst.appendChild(icon);

    const who = document.createElement('span');
    who.className = 'reaction-from';
    who.textContent = mine ? 'تو' : 'دوستت';
    burst.appendChild(who);

    const sparks = [[-48, -38], [46, -30], [-58, 20], [58, 14], [-22, 48], [28, 46]];
    sparks.forEach((point, index) => {
        const spark = document.createElement('i');
        spark.className = 'reaction-spark';
        spark.textContent = index % 2 ? '•' : '✦';
        spark.style.setProperty('--sx', point[0] + 'px');
        spark.style.setProperty('--sy', point[1] + 'px');
        spark.style.setProperty('--delay', (index * 0.035) + 's');
        burst.appendChild(spark);
    });

    el.reactionLayer.appendChild(burst);
    while (el.reactionLayer.children.length > 12) el.reactionLayer.removeChild(el.reactionLayer.firstChild);
    setTimeout(() => burst.remove(), prefersReducedMotion ? 300 : 2600);
}

// ------------------------------------------------------------
// رویدادهای ویدیوی محلی
// ------------------------------------------------------------
el.video.addEventListener('play', () => {
    updatePlayIcon();
    wakeControls();
    if (consumeExpected('play')) return;
    state.wantPlaying = true;
    state.localStalled = false;
    sendControl('play');
});
el.video.addEventListener('pause', () => {
    updatePlayIcon();
    if (consumeExpected('pause')) return;
    state.wantPlaying = false;
    sendControl('pause');
});
el.video.addEventListener('seeked', () => {
    if (consumeExpected('seeked')) return;
    clearNudge();
    sendControl('seek');
});
el.video.addEventListener('ratechange', () => {
    if (consumeExpected('ratechange')) return;
    if (nudging) return;
    state.baseRate = el.video.playbackRate;
    renderRateMenu();
    sendControl('rate');
});
el.video.addEventListener('waiting', noteWaiting);
el.video.addEventListener('stalled', noteWaiting);
el.video.addEventListener('playing', noteReady);
el.video.addEventListener('canplay', noteReady);
el.video.addEventListener('seeked', noteReady);
el.video.addEventListener('loadedmetadata', () => {
    updateVolumeUi();
    checkLengthMatch();
    if (state.connected) sendSourceInfo();
});
el.video.addEventListener('loadeddata', () => setStatus('ویدیو بارگذاری شد', 'success'));
el.video.addEventListener('error', () => {
    if (!el.video.getAttribute('src')) return;
    const isMkv = /\.mkv$/i.test(currentSource.name || currentSource.url || '');
    setStatus(isMkv
        ? 'این فایل MKV در مرورگر شما پخش نمی‌شود. کروم معمولاً MKV را پشتیبانی می‌کند.'
        : 'خطا در بارگذاری ویدیو. لینک ممکن است نامعتبر یا غیرقابل دسترس باشد.', 'error');
});

function checkLengthMatch() {
    const mine = P().duration;
    const theirs = state.partnerDuration;
    const bad = state.connected && mine && theirs && Math.abs(mine - theirs) > 1.5;
    el.lengthWarning.classList.toggle('show', !!bad);
}

// ------------------------------------------------------------
// چت
// ------------------------------------------------------------
const MAX_CHAT_NODES = 200;
let chatEmptyShown = true;

function setChatEnabled(enabled) {
    const on = enabled && !state.peerUnstable;
    el.chatInput.disabled = !on;
    el.chatSend.disabled = !on;
    el.chatInput.placeholder = on ? 'پیام خود را بنویسید…' : 'برای چت ابتدا متصل شوید';
    el.overlayChatInput.disabled = !on;
}

function chatId() { return 'm' + Date.now().toString(36) + randomId(4); }

function sendChat(text) {
    const msg = String(text || '').trim();
    if (!msg || !state.connected) return;
    const payload = { id: chatId(), text: msg.slice(0, 500), replyTo: state.replyingTo };
    appendChat(payload, true);
    toPartner({ type: 'chat', msg: payload });
    state.replyingTo = null;
    renderReplyPreview();
}

function receiveChat(msg) {
    if (!msg || typeof msg.text !== 'string') return;
    appendChat({
        id: String(msg.id || chatId()),
        text: msg.text.slice(0, 500),
        replyTo: msg.replyTo && typeof msg.replyTo.text === 'string'
            ? { id: String(msg.replyTo.id || ''), text: msg.replyTo.text.slice(0, 120) }
            : null
    }, false);
    notify();
}

function appendChat(msg, mine) {
    if (chatEmptyShown) { el.chatLog.innerHTML = ''; chatEmptyShown = false; }

    const row = document.createElement('div');
    row.className = 'msg-row ' + (mine ? 'mine' : 'theirs');

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.id = 'bubble-' + msg.id;

    if (msg.replyTo) {
        const quote = document.createElement('span');
        quote.className = 'quote';
        quote.textContent = msg.replyTo.text;
        quote.addEventListener('click', () => {
            const target = document.getElementById('bubble-' + msg.replyTo.id);
            if (!target) return;
            target.scrollIntoView({ block: 'center', behavior: prefersReducedMotion ? 'auto' : 'smooth' });
            target.classList.add('flash');
            setTimeout(() => target.classList.remove('flash'), 1400);
        });
        bubble.appendChild(quote);
    }

    const body = document.createElement('span');
    body.textContent = msg.text;   // متن خام؛ هیچ HTML‌ای تفسیر نمی‌شود
    bubble.appendChild(body);

    const reply = document.createElement('button');
    reply.type = 'button';
    reply.className = 'reply-btn';
    reply.setAttribute('aria-label', 'پاسخ به این پیام');
    reply.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 17-5-5 5-5"></path><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>';
    reply.addEventListener('click', () => {
        state.replyingTo = { id: msg.id, text: msg.text.slice(0, 120) };
        renderReplyPreview();
        el.chatInput.focus();
    });

    row.appendChild(bubble);
    row.appendChild(reply);
    el.chatLog.appendChild(row);

    while (el.chatLog.children.length > MAX_CHAT_NODES) el.chatLog.removeChild(el.chatLog.firstChild);

    const nearBottom = el.chatLog.scrollHeight - el.chatLog.scrollTop - el.chatLog.clientHeight < 90;
    if (nearBottom || mine) scrollChatToEnd();

    if (state.overlayEnabled) showOverlayMessage(msg.text, mine);
}

function scrollChatToEnd() {
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
    requestAnimationFrame(() => { el.chatLog.scrollTop = el.chatLog.scrollHeight; });
}

function renderReplyPreview() {
    if (state.replyingTo) {
        el.replyText.textContent = 'در پاسخ به: ' + state.replyingTo.text;
        el.replyPreview.classList.add('show');
    } else {
        el.replyPreview.classList.remove('show');
    }
}

el.replyCancel.addEventListener('click', () => { state.replyingTo = null; renderReplyPreview(); });
el.chatSend.addEventListener('click', () => { sendChat(el.chatInput.value); el.chatInput.value = ''; autoGrow(); });
el.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat(el.chatInput.value);
        el.chatInput.value = '';
        autoGrow();
    }
});
function autoGrow() {
    // ارتفاع پایه از CSS می‌آید تا با دکمه‌های کناری یکی بماند
    const base = parseFloat(getComputedStyle(el.chatInput).minHeight) || 43;
    el.chatInput.style.height = 'auto';
    el.chatInput.style.height = clamp(el.chatInput.scrollHeight, base, 112) + 'px';
}
el.chatInput.addEventListener('input', autoGrow);

// ---- چت روی تصویر ----
const OVERLAY_LIFETIME = 7000;
const MAX_OVERLAY = 4;

function showOverlayMessage(text, mine) {
    const bubble = document.createElement('div');
    bubble.className = 'overlay-msg' + (mine ? ' mine' : '');

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = mine ? 'شما' : 'دوستتان';
    bubble.appendChild(who);

    const body = document.createElement('span');
    body.textContent = text;
    bubble.appendChild(body);

    el.overlayChat.appendChild(bubble);
    while (el.overlayChat.children.length > MAX_OVERLAY) {
        el.overlayChat.removeChild(el.overlayChat.firstChild);
    }

    setTimeout(() => {
        bubble.classList.add('leaving');
        setTimeout(() => bubble.remove(), 460);
    }, OVERLAY_LIFETIME);
}

function openOverlayChat() {
    if (!state.connected) { playerToast('برای چت ابتدا متصل شوید'); return; }
    el.player.classList.add('chat-open');
    el.btnChat.classList.add('on');
    wakeControls();
    el.overlayChatInput.focus();
}
function closeOverlayChat() {
    el.player.classList.remove('chat-open');
    el.btnChat.classList.remove('on');
    el.overlayChatInput.blur();
}
el.btnChat.addEventListener('click', () => {
    if (el.player.classList.contains('chat-open')) closeOverlayChat();
    else openOverlayChat();
});
el.overlayChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendChat(el.overlayChatInput.value);
        el.overlayChatInput.value = '';
    } else if (e.key === 'Escape') {
        closeOverlayChat();
    }
    e.stopPropagation();
});

el.toggleOverlay.addEventListener('click', () => {
    state.overlayEnabled = !state.overlayEnabled;
    el.toggleOverlay.classList.toggle('on', state.overlayEnabled);
    el.toggleOverlay.setAttribute('aria-pressed', String(state.overlayEnabled));
    el.toggleOverlay.title = state.overlayEnabled ? 'نمایش پیام‌ها روی تصویر' : 'پیام‌ها روی تصویر نشان داده نمی‌شوند';
    if (!state.overlayEnabled) el.overlayChat.innerHTML = '';
});
el.toggleOverlay.classList.add('on');

// ---- صدای اعلان ----
let audioCtx = null;
function notify() {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const now = audioCtx.currentTime;
        [1046.5, 1318.51, 1567.98].forEach((freq, i) => {
            const t0 = now + i * 0.09;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, t0);
            gain.gain.setValueAtTime(0, t0);
            gain.gain.linearRampToValueAtTime(0.08, t0 + 0.01);
            gain.gain.linearRampToValueAtTime(0, t0 + 0.15);
            osc.connect(gain); gain.connect(audioCtx.destination);
            osc.start(t0); osc.stop(t0 + 0.16);
        });
    } catch (e) {}
}

// ---- چیدمان چت ----
el.dockToggle.addEventListener('click', () => {
    const panels = [el.player, el.chatPanel];
    const before = panels.map((p) => p.getBoundingClientRect());

    state.docked = !state.docked;
    el.stage.classList.toggle('docked', state.docked);
    el.dockToggle.classList.toggle('on', state.docked);
    el.dockToggle.setAttribute('aria-pressed', String(state.docked));
    el.dockToggle.title = state.docked ? 'بازگرداندن چت به زیر پلیر' : 'بردن چت کنار پلیر';

    if (!prefersReducedMotion) {
        panels.forEach((panel, i) => {
            const a = before[i], b = panel.getBoundingClientRect();
            if (!a.width || !b.width) return;
            panel.animate([
                { transformOrigin: 'top right', transform: 'translate(' + (a.right - b.right) + 'px,' + (a.top - b.top) + 'px) scale(' + (a.width / b.width) + ',' + (a.height / b.height) + ')' },
                { transformOrigin: 'top right', transform: 'none' }
            ], { duration: 340, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
        });
    }
    setTimeout(scrollChatToEnd, 360);
});

// ------------------------------------------------------------
// ایموجی (بدون وابستگی بیرونی)
// ------------------------------------------------------------
const EMOJI = {
    'احساسات': '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😍 🥰 😘 😗 😋 😛 🤪 🤨 🧐 🤓 😎 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 😬 🙄 😯 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕',
    'دست و آدم': '👍 👎 👌 ✌️ 🤞 🤟 🤘 👏 🙌 👐 🤲 🙏 💪 👀 🫶 🤝 ✍️ 💅 🕺 💃 🙋 🙆 🙅 🤦 🤷 👨‍💻 👩‍💻',
    'قلب': '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝',
    'فیلم و خوراکی': '🎬 🍿 🎞️ 📺 🎧 🎵 🎶 🔥 ✨ ⭐ 🌙 ☕ 🍫 🍕 🍔 🍟 🌮 🍜 🍩 🍪 🎂 🍦 🥤 🧃',
    'نشانه': '✅ ❌ ⚠️ ❓ ❗ 💯 🎉 🎊 👌 🆗 🔇 🔈 ⏯️ ⏸️ ▶️ ⏩ ⏪ 🔁 💤 🌚 🌝 👻 💀 🤖 👽'
};

let emojiPanel = null;
function buildEmojiPanel() {
    if (emojiPanel) return emojiPanel;
    const panel = document.createElement('div');
    panel.className = 'emoji-panel';

    Object.keys(EMOJI).forEach((group) => {
        const title = document.createElement('div');
        title.className = 'emoji-group';
        title.textContent = group;
        panel.appendChild(title);

        const grid = document.createElement('div');
        grid.className = 'emoji-grid';
        EMOJI[group].split(' ').forEach((ch) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'emoji';
            b.textContent = ch;
            b.addEventListener('click', () => {
                const target = el.player.classList.contains('chat-open') ? el.overlayChatInput : el.chatInput;
                target.value += ch;
                target.focus();
                target.setSelectionRange(target.value.length, target.value.length);
                if (target === el.chatInput) autoGrow();
            });
            grid.appendChild(b);
        });
        panel.appendChild(grid);
    });

    panel.addEventListener('mouseenter', () => clearTimeout(emojiHideTimer));
    panel.addEventListener('mouseleave', scheduleCloseEmoji);

    el.emojiBtn.parentElement.parentElement.appendChild(panel);
    emojiPanel = panel;
    return panel;
}

let emojiHideTimer = null;

function openEmoji() {
    clearTimeout(emojiHideTimer);
    buildEmojiPanel().classList.add('open');
}
function closeEmoji() {
    if (emojiPanel) emojiPanel.classList.remove('open');
}
// با کمی تأخیر بسته می‌شود تا عبور موس از فاصلهٔ بین دکمه و پنل آن را نبندد
function scheduleCloseEmoji() {
    clearTimeout(emojiHideTimer);
    emojiHideTimer = setTimeout(closeEmoji, 220);
}

el.emojiBtn.addEventListener('mouseenter', openEmoji);
el.emojiBtn.addEventListener('mouseleave', scheduleCloseEmoji);
// روی دستگاه لمسی hover وجود ندارد، پس کلیک هم باز و بسته می‌کند
el.emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (emojiPanel && emojiPanel.classList.contains('open')) closeEmoji();
    else openEmoji();
});
document.addEventListener('click', (e) => {
    if (emojiPanel && !e.target.closest('.emoji-panel') && e.target !== el.emojiBtn) closeEmoji();
});

// ------------------------------------------------------------
// وضعیت اتصال
// ------------------------------------------------------------
let tipTimer = null;
function setStatus(message, type) {
    el.statusFab.dataset.state = type || 'disconnected';
    el.statusFab.title = message;
    el.statusFab.setAttribute('aria-label', 'وضعیت: ' + message);
    Object.keys(el.fabIcons).forEach((k) => setHidden(el.fabIcons[k], true));
    setHidden(el.fabIcons[type] || el.fabIcons.disconnected, false);
    showTip(message, true);
}
function showTip(message, temporary) {
    el.statusTip.textContent = message;
    el.statusTip.classList.add('show');
    clearTimeout(tipTimer);
    if (temporary) tipTimer = setTimeout(() => el.statusTip.classList.remove('show'), 3500);
}
el.statusFab.addEventListener('mouseenter', () => showTip(el.statusFab.title, false));
el.statusFab.addEventListener('mouseleave', () => { clearTimeout(tipTimer); el.statusTip.classList.remove('show'); });
el.statusFab.addEventListener('click', () => showTip(el.statusFab.title, true));

// ------------------------------------------------------------
// ورودی‌های کاربر
// ------------------------------------------------------------
el.loadUrl.addEventListener('click', () => {
    const url = el.videoUrl.value.trim();
    if (!url) { setStatus('لطفاً لینک را وارد کنید', 'error'); return; }
    loadUrl(url, true);
});
el.videoUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.loadUrl.click(); });

el.videoFile.addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });
el.subtitleFile.addEventListener('change', (e) => { if (e.target.files[0]) loadSubtitleFile(e.target.files[0]); });

// کشیدن و رها کردن فایل روی صفحه
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault();
    el.videoDrop.classList.add('is-over');
}));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && e.relatedTarget) return;
    el.videoDrop.classList.remove('is-over');
}));
document.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (/\.(srt|vtt|txt)$/i.test(file.name)) loadSubtitleFile(file);
    else loadFile(file);
});

async function copyText(value) {
    try {
        await navigator.clipboard.writeText(value);
        return true;
    } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        let copied = false;
        try { copied = document.execCommand('copy'); } catch (e2) {}
        ta.remove();
        return copied;
    }
}

function showCopiedHint(message) {
    el.copiedHint.textContent = message;
    el.copiedHint.classList.add('show');
    clearTimeout(showCopiedHint._t);
    showCopiedHint._t = setTimeout(() => el.copiedHint.classList.remove('show'), 1800);
}

function inviteUrl() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('invite', state.myId);
    return url.href;
}

function clearInviteFromUrl() {
    try {
        const url = new URL(location.href);
        if (!url.searchParams.has('invite')) return;
        url.searchParams.delete('invite');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) {}
}

el.myIdBtn.addEventListener('click', async () => {
    if (!state.myId) return;
    if (await copyText(state.myId)) showCopiedHint('شناسه کپی شد');
    else setStatus('کپی خودکار ممکن نبود؛ شناسه را دستی کپی کنید', 'error');
});

el.inviteLink.addEventListener('click', async () => {
    if (!state.myId) { setStatus('هنوز به سرور متصل نشده‌اید', 'error'); return; }
    if (await copyText(inviteUrl())) showCopiedHint('لینک دعوت کپی شد');
    else setStatus('کپی خودکار ممکن نبود؛ دوباره تلاش کنید', 'error');
});

el.connectBtn.addEventListener('click', () => {
    const id = el.partnerId.value.trim().toLowerCase();
    if (!id) { setStatus('شناسهٔ دوستتان را وارد کنید', 'error'); return; }
    if (id === state.myId) { setStatus('نمی‌توانید به خودتان متصل شوید', 'error'); return; }
    setStatus('درخواست اتصال به ' + id + ' ارسال شد…', 'connecting');
    sendTo(id, { type: 'connect_request' });
});
el.partnerId.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.connectBtn.click(); });

el.disconnectBtn.addEventListener('click', () => {
    if (state.partnerId) toPartner({ type: 'disconnect' });
    resetConnection('اتصال قطع شد');
});

// عمداً روی unload پیام «قطع اتصال» نمی‌فرستیم: بسته‌شدن سوکت را سرور
// به طرف مقابل خبر می‌دهد و او منتظر می‌ماند، پس یک رفرش تصادفی جلسه را
// از بین نمی‌برد. قطع قطعی فقط با دکمهٔ «قطع اتصال» انجام می‌شود.

// ------------------------------------------------------------
// شروع
// ------------------------------------------------------------
const saved = loadSession();
if (saved.myId) state.myId = saved.myId;
if (saved.partnerId && !pendingInviteId) state.partnerId = saved.partnerId;

setChatEnabled(false);
renderRateMenu();
renderSubsMenu();
renderQuickReactions();
updateVolumeUi();
updatePlayIcon();
setStatus('در حال اتصال به سرور…', 'connecting');
renderLoop();
connectWebSocket();

})();
