/*
 * استخراج زیرنویس‌های soft-sub از داخل فایل‌های MKV (Matroska).
 *
 * مرورگرها کانتینر MKV را پخش می‌کنند ولی تِرَک‌های زیرنویس داخلش را
 * در video.textTracks در دسترس نمی‌گذارند. این ورکر خودش EBML را پارس
 * می‌کند و کیوها را همان‌طور که کلاسترها خوانده می‌شوند بیرون می‌دهد،
 * پس زیرنویس دقایق اول تقریباً بلافاصله آماده است.
 */

// شناسه‌های EBML (همراه با بیت نشانه، همان‌طور که در فایل ذخیره می‌شوند)
const ID = {
    EBML: 0x1a45dfa3,
    SEGMENT: 0x18538067,
    INFO: 0x1549a966,
    TIMESTAMP_SCALE: 0x2ad7b1,
    TRACKS: 0x1654ae6b,
    TRACK_ENTRY: 0xae,
    TRACK_NUMBER: 0xd7,
    TRACK_TYPE: 0x83,
    CODEC_ID: 0x86,
    CODEC_PRIVATE: 0x63a2,
    LANGUAGE: 0x22b59c,
    LANGUAGE_IETF: 0x22b59d,
    NAME: 0x536e,
    FLAG_DEFAULT: 0x88,
    FLAG_FORCED: 0x55aa,
    CLUSTER: 0x1f43b675,
    CLUSTER_TIMESTAMP: 0xe7,
    SIMPLE_BLOCK: 0xa3,
    BLOCK_GROUP: 0xa0,
    BLOCK: 0xa1,
    BLOCK_DURATION: 0x9b
};

// عناصری که باید واردشان شویم؛ بقیه یکجا رد می‌شوند
const MASTERS = new Set([ID.SEGMENT, ID.INFO, ID.TRACKS, ID.TRACK_ENTRY, ID.CLUSTER, ID.BLOCK_GROUP]);
// عناصری که مقدارشان را لازم داریم
const WANTED = new Set([
    ID.TIMESTAMP_SCALE, ID.TRACK_NUMBER, ID.TRACK_TYPE, ID.CODEC_ID, ID.CODEC_PRIVATE,
    ID.LANGUAGE, ID.LANGUAGE_IETF, ID.NAME, ID.FLAG_DEFAULT, ID.FLAG_FORCED,
    ID.CLUSTER_TIMESTAMP, ID.SIMPLE_BLOCK, ID.BLOCK, ID.BLOCK_DURATION
]);
// شناسه‌های سطح یک: برای بستن کلاسترهایی که اندازه‌شان نامعلوم است
const LEVEL1 = new Set([
    ID.INFO, ID.TRACKS, ID.CLUSTER, 0x114d9b74, 0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367
]);

const TRACK_TYPE_SUBTITLE = 0x11;
const TEXT_CODECS = /^S_TEXT\/(UTF8|ASS|SSA|WEBVTT)$/;
const DEFAULT_CUE_MS = 3000;

const utf8 = new TextDecoder('utf-8');

function MkvSubtitleParser(handlers) {
    this.on = handlers;
    this.buf = new Uint8Array(0);
    this.bufStart = 0;      // آفست مطلق فایل برای buf[0]
    this.skip = 0;          // بایت‌هایی که باید دور ریخته شوند
    this.stack = [];        // [{id, end}]
    this.tracks = new Map();// trackNumber -> track
    this.timestampScale = 1000000;
    this.clusterTime = 0;
    this.pendingBlock = null;   // بلاک داخل BlockGroup تا رسیدن BlockDuration
    this.inBlockGroup = false;
    this.tracksDone = false;
    this.aborted = false;
    this.sawEbmlHeader = false;
}

MkvSubtitleParser.prototype.push = function (chunk) {
    if (this.aborted) return;

    if (this.skip > 0) {
        if (chunk.length <= this.skip) { this.skip -= chunk.length; this.bufStart += chunk.length; return; }
        this.bufStart += this.skip;
        chunk = chunk.subarray(this.skip);
        this.skip = 0;
    }

    if (this.buf.length === 0) {
        this.buf = chunk;
    } else {
        const merged = new Uint8Array(this.buf.length + chunk.length);
        merged.set(this.buf, 0);
        merged.set(chunk, this.buf.length);
        this.buf = merged;
    }
    this.parse();
};

// خواندن vint. keepMarker=true برای شناسه‌ها (که با بیت نشانه ذخیره می‌شوند)
function readVint(buf, off, keepMarker) {
    if (off >= buf.length) return null;
    const first = buf[off];
    if (first === 0) return null; // vint نامعتبر / بیش از ۸ بایت
    let len = 1;
    let mask = 0x80;
    while (!(first & mask)) { mask >>= 1; len++; }
    if (off + len > buf.length) return null;

    let value;
    let unknown = false;
    if (keepMarker) {
        value = 0;
        for (let i = 0; i < len; i++) value = value * 256 + buf[off + i];
    } else {
        value = first & (mask - 1);
        let allOnes = value === mask - 1;
        for (let i = 1; i < len; i++) {
            if (buf[off + i] !== 0xff) allOnes = false;
            value = value * 256 + buf[off + i];
        }
        unknown = allOnes;
    }
    return { value: value, length: len, unknown: unknown };
}

function readUint(buf, off, len) {
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + buf[off + i];
    return v;
}

function readString(buf, off, len) {
    let end = off + len;
    while (end > off && buf[end - 1] === 0) end--; // پدینگ صفر
    return utf8.decode(buf.subarray(off, end));
}

MkvSubtitleParser.prototype.parse = function () {
    const self = this;

    for (;;) {
        if (this.aborted) return;
        const buf = this.buf;
        let off = 0;

        // بستن masterهایی که تمام شده‌اند
        while (this.stack.length && this.bufStart >= this.stack[this.stack.length - 1].end) {
            this.closeMaster(this.stack.pop());
        }

        // پیش از هر کاری: امضای EBML. فایل‌های mp4/avi همین‌جا رد می‌شوند.
        if (!this.sawEbmlHeader) {
            if (buf.length < 4) return;
            if (!(buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)) {
                this.fail('not-mkv', 'این فایل MKV نیست');
                return;
            }
        }

        const idr = readVint(buf, off, true);
        if (!idr) {
            if (buf.length > 12) { // vint خراب: همگام‌سازی از دست رفته
                this.fail('parse-error', 'ساختار فایل قابل خواندن نبود');
            }
            return;
        }
        const sizer = readVint(buf, off + idr.length, false);
        if (!sizer) return;

        const id = idr.value;
        const headerLen = idr.length + sizer.length;
        const size = sizer.unknown ? Infinity : sizer.value;
        const bodyStart = this.bufStart + headerLen;

        this.sawEbmlHeader = true;

        // کلاستر با اندازهٔ نامعلوم: با دیدن یک عنصر سطح‌یک بسته می‌شود
        if (this.stack.length && this.stack[this.stack.length - 1].end === Infinity && LEVEL1.has(id)) {
            this.closeMaster(this.stack.pop());
            continue;
        }

        if (MASTERS.has(id)) {
            this.openMaster(id);
            this.stack.push({ id: id, end: size === Infinity ? Infinity : bodyStart + size });
            this.consume(headerLen);
            continue;
        }

        if (WANTED.has(id)) {
            if (size === Infinity) { this.fail('parse-error', 'اندازهٔ نامعتبر'); return; }
            if (buf.length < headerLen + size) {
                if (size > 64 * 1024 * 1024) { this.fail('parse-error', 'عنصر بیش از حد بزرگ'); return; }
                return; // منتظر بایت‌های بیشتر
            }
            this.handleValue(id, buf, headerLen, size);
            this.consume(headerLen + size);
            continue;
        }

        // بی‌ربط: رد شو (بلاک‌های ویدیو/صدا، Cues، پیوست‌ها…)
        if (size === Infinity) { this.consume(headerLen); continue; }
        this.consume(headerLen);
        this.discard(size);
        if (this.buf.length === 0) return;
    }
};

MkvSubtitleParser.prototype.consume = function (n) {
    this.buf = this.buf.subarray(n);
    this.bufStart += n;
};

MkvSubtitleParser.prototype.discard = function (n) {
    if (n <= this.buf.length) { this.consume(n); return; }
    const inBuffer = this.buf.length;
    this.skip = n - inBuffer;
    this.bufStart += inBuffer;
    this.buf = new Uint8Array(0);
};

MkvSubtitleParser.prototype.openMaster = function (id) {
    if (id === ID.TRACK_ENTRY) this.current = { number: null, type: null, codec: '', lang: '', name: '', def: false, forced: false, header: '' };
    if (id === ID.BLOCK_GROUP) { this.inBlockGroup = true; this.pendingBlock = null; }
};

MkvSubtitleParser.prototype.closeMaster = function (frame) {
    if (frame.id === ID.TRACK_ENTRY) {
        const t = this.current;
        this.current = null;
        if (t && t.type === TRACK_TYPE_SUBTITLE && TEXT_CODECS.test(t.codec) && t.number != null) {
            this.tracks.set(t.number, t);
        }
    } else if (frame.id === ID.TRACKS) {
        this.tracksDone = true;
        const list = [];
        this.tracks.forEach(function (t, num) {
            list.push({ number: num, codec: t.codec, lang: t.lang, name: t.name, def: t.def, forced: t.forced });
        });
        this.on.tracks(list);
        if (list.length === 0) this.abort('no-subs');
    } else if (frame.id === ID.BLOCK_GROUP) {
        if (this.pendingBlock) this.emitCue(this.pendingBlock, this.pendingBlock.duration || DEFAULT_CUE_MS);
        this.pendingBlock = null;
        this.inBlockGroup = false;
    }
};

MkvSubtitleParser.prototype.handleValue = function (id, buf, off, size) {
    switch (id) {
        case ID.TIMESTAMP_SCALE: this.timestampScale = readUint(buf, off, size); break;
        case ID.CLUSTER_TIMESTAMP: this.clusterTime = readUint(buf, off, size); break;
        case ID.TRACK_NUMBER: if (this.current) this.current.number = readUint(buf, off, size); break;
        case ID.TRACK_TYPE: if (this.current) this.current.type = readUint(buf, off, size); break;
        case ID.CODEC_ID: if (this.current) this.current.codec = readString(buf, off, size); break;
        case ID.CODEC_PRIVATE: if (this.current) this.current.header = readString(buf, off, size); break;
        case ID.LANGUAGE: if (this.current && !this.current.lang) this.current.lang = readString(buf, off, size); break;
        case ID.LANGUAGE_IETF: if (this.current) this.current.lang = readString(buf, off, size); break;
        case ID.NAME: if (this.current) this.current.name = readString(buf, off, size); break;
        case ID.FLAG_DEFAULT: if (this.current) this.current.def = readUint(buf, off, size) === 1; break;
        case ID.FLAG_FORCED: if (this.current) this.current.forced = readUint(buf, off, size) === 1; break;
        case ID.BLOCK_DURATION:
            if (this.pendingBlock) this.pendingBlock.duration = readUint(buf, off, size) * this.timestampScale / 1e6;
            break;
        case ID.SIMPLE_BLOCK:
        case ID.BLOCK: {
            const block = this.parseBlock(buf, off, size);
            if (!block) break;
            if (id === ID.BLOCK && this.inBlockGroup) this.pendingBlock = block;
            else this.emitCue(block, DEFAULT_CUE_MS);
            break;
        }
    }
};

MkvSubtitleParser.prototype.parseBlock = function (buf, off, size) {
    const end = off + size;
    const tn = readVint(buf, off, false);
    if (!tn) return null;
    const track = this.tracks.get(tn.value);
    if (!track) return null; // ویدیو/صدا، کاری نداریم

    let p = off + tn.length;
    if (p + 3 > end) return null;
    let rel = (buf[p] << 8) | buf[p + 1];
    if (rel & 0x8000) rel -= 0x10000; // علامت‌دار
    const flags = buf[p + 2];
    p += 3;
    if (flags & 0x06) return null; // lacing؛ برای زیرنویس متنی عملاً استفاده نمی‌شود

    const startMs = (this.clusterTime + rel) * this.timestampScale / 1e6;
    return { track: track, start: startMs, duration: 0, payload: buf.subarray(p, end) };
};

MkvSubtitleParser.prototype.emitCue = function (block, fallbackMs) {
    let text = utf8.decode(block.payload);
    if (/^S_TEXT\/(ASS|SSA)$/.test(block.track.codec)) text = assDialogueToText(text);
    text = stripMarkup(text).replace(/\r/g, '').trim();
    if (!text) return;
    this.on.cue({
        track: block.track.number,
        start: block.start / 1000,
        end: (block.start + (block.duration || fallbackMs)) / 1000,
        text: text
    });
};

MkvSubtitleParser.prototype.abort = function (reason) {
    this.aborted = true;
    this.on.done(reason);
};

MkvSubtitleParser.prototype.fail = function (code, message) {
    this.aborted = true;
    this.on.error(code, message);
};

MkvSubtitleParser.prototype.end = function () {
    if (this.aborted) return;
    if (this.pendingBlock) this.emitCue(this.pendingBlock, DEFAULT_CUE_MS);
    this.aborted = true;
    this.on.done(this.tracksDone ? 'complete' : 'no-tracks');
};

// در MKV، فیلد Text دیالوگ ASS بعد از ۸ کاما می‌آید (بدون Start/End)
function assDialogueToText(raw) {
    let idx = 0;
    for (let i = 0; i < 8; i++) {
        idx = raw.indexOf(',', idx);
        if (idx === -1) return stripAssTags(raw);
        idx++;
    }
    return stripAssTags(raw.slice(idx));
}

function stripAssTags(s) {
    return s
        .replace(/\\[Nn]/g, '\n')
        .replace(/\\h/g, ' ');
}

// کیوها را خودمان به‌صورت متن ساده رندر می‌کنیم، پس تگ‌های override اِی‌اس‌اس
// و تگ‌های شبه‌HTML رایج در SRT باید حذف شوند نه اینکه عیناً روی تصویر دیده شوند.
function stripMarkup(s) {
    return s
        .replace(/\{\\[^}]*\}/g, '')
        .replace(/<\/?(i|b|u|font|ruby|rt)(\s[^>]*)?>/gi, '');
}

// ---- رابط ورکر ----
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    const CHUNK = 4 * 1024 * 1024;

    self.onmessage = async function (e) {
        const file = e.data && e.data.file;
        if (!file) return;

        let cues = [];
        let sent = 0;
        const flush = function (force) {
            if (!cues.length) return;
            if (!force && cues.length < 120) return;
            self.postMessage({ type: 'cues', cues: cues });
            sent += cues.length;
            cues = [];
        };

        const parser = new MkvSubtitleParser({
            tracks: function (list) { self.postMessage({ type: 'tracks', tracks: list }); },
            cue: function (c) { cues.push(c); flush(false); },
            done: function (reason) { flush(true); self.postMessage({ type: 'done', reason: reason, count: sent }); },
            error: function (code, msg) { flush(true); self.postMessage({ type: 'error', code: code, message: msg }); }
        });

        try {
            for (let pos = 0; pos < file.size; pos += CHUNK) {
                if (parser.aborted) break;
                const slice = file.slice(pos, Math.min(pos + CHUNK, file.size));
                const bytes = new Uint8Array(await slice.arrayBuffer());
                parser.push(bytes);
                flush(false);
                self.postMessage({ type: 'progress', done: Math.min(pos + CHUNK, file.size), total: file.size });
            }
            parser.end();
        } catch (err) {
            self.postMessage({ type: 'error', code: 'parse-error', message: String(err && err.message || err) });
        }
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MkvSubtitleParser: MkvSubtitleParser, assDialogueToText: assDialogueToText, stripMarkup: stripMarkup };
}
