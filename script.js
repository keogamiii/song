// Плеер с синхронным текстом. Разметка строки собирается из lyrics.js.

const audio = document.getElementById('audio');
const list = document.getElementById('lines');
const lyricsBox = document.getElementById('lyrics');
const playBtn = document.getElementById('play');
const progress = document.getElementById('progress');
const fill = document.getElementById('fill');
const dot = document.getElementById('dot');
const timeNow = document.getElementById('time-now');
const timeAll = document.getElementById('time-all');
const hint = document.getElementById('hint');
const lyrToggle = document.getElementById('lyr-toggle');

const lyrics = window.LYRICS || [];
let nodes = [];
let active = -1;
let rafId = null;
let seeking = false;
let lyrTimer = null;

// ---------- разметка ----------

function buildLines() {
    const frag = document.createDocumentFragment();

    lyrics.forEach(function (item, i) {
        const p = document.createElement('p');
        p.className = 'line';
        p.dataset.index = String(i);
        // номер строки — чтобы при открытии текста они выезжали по очереди
        p.style.setProperty('--i', i);
        p.textContent = item[1];
        p.addEventListener('click', function () {
            seekTo(item[0] + 0.02);
            play();
        });
        frag.appendChild(p);
        nodes.push(p);
    });

    list.appendChild(frag);
}

// ---------- какая строка сейчас ----------

function findIndex(t) {
    let lo = 0;
    let hi = lyrics.length - 1;
    let res = -1;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lyrics[mid][0] <= t) {
            res = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    return res;
}

function setActive(i) {
    if (i === active) return;
    active = i;

    nodes.forEach(function (p, idx) {
        p.classList.toggle('line--done', idx < i);
        p.classList.toggle('line--active', idx === i);
        // следующая строка чуть виднеется, остальные ещё не появились
        p.classList.toggle('line--next', idx === i + 1);
    });

    scrollToLine(i);
}

// ---------- скролл текста ----------

function scrollToLine(i) {
    // до первой строки тоже держим её по центру, а не прижимаем к верху
    const idx = i < 0 ? 0 : i;

    if (idx < 0 || !nodes[idx]) {
        list.style.transform = 'translate3d(0, 0, 0)';
        return;
    }

    const box = lyricsBox.clientHeight;
    // текст закрыт — считать нечего, пересчитаем при открытии
    if (!box) return;

    const lineTop = nodes[idx].offsetTop;
    const lineH = nodes[idx].offsetHeight;
    const target = box / 2 - (lineTop + lineH / 2);

    list.style.transform = 'translate3d(0, ' + Math.round(target) + 'px, 0)';
}

// на поворот экрана/ресайз пересчитываем позицию
window.addEventListener('resize', function () {
    scrollToLine(active);
});

// ---------- реакция фона на бит ----------

// Считаем бас-удары по самому файлу: звук не трогаем, просто один раз
// декодируем трек и находим моменты, где бьёт низ.
let beats = [];
let beatPulse = 0;
let beatCursor = 0;
let beatPrevT = 0;
let lastPaintMs = 0;

function analyseBeats() {
    if (!window.fetch || !window.OfflineAudioContext) return;

    fetch('song.mp3')
        .then(function (r) {
            if (!r.ok) throw new Error('no file');
            return r.arrayBuffer();
        })
        .then(function (buf) {
            // OfflineAudioContext умеет декодировать без разрешения на звук
            const ctx = new OfflineAudioContext(1, 1, 44100);
            return ctx.decodeAudioData(buf);
        })
        .then(function (audioBuf) {
            beats = findBeats(audioBuf);
            beatCursor = 0;
            beatPrevT = 0;
        })
        .catch(function () {
            // не страшно: просто не будет вспышек
        });
}

function findBeats(buf) {
    const sr = buf.sampleRate;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;

    const hop = Math.round(sr * 0.01);          // окно 10 мс
    const n = Math.floor(ch0.length / hop);
    if (!n) return [];

    // простой ФНЧ на 120 Гц — оставляем только бас
    const rc = 1 / (2 * Math.PI * 120);
    const alpha = (1 / sr) / (rc + 1 / sr);
    let lp = 0;

    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let sum = 0;
        const start = i * hop;
        for (let j = 0; j < hop; j++) {
            const x = ch0[start + j] + (ch1 ? ch1[start + j] : 0);
            lp += alpha * (x - lp);
            sum += lp * lp;
        }
        env[i] = Math.sqrt(sum / hop);
    }

    // подъём энергии относительно соседних окон
    const diff = new Float32Array(n);
    for (let i = 2; i < n; i++) {
        const d = env[i] - env[i - 2];
        diff[i] = d > 0 ? d : 0;
    }

    let mean = 0;
    for (let i = 0; i < n; i++) mean += diff[i];
    mean /= n;

    let sq = 0;
    for (let i = 0; i < n; i++) {
        const v = diff[i] - mean;
        sq += v * v;
    }
    const sd = Math.sqrt(sq / n);
    // порог подобран на слух по этому треку: иначе в биты попадают хэты
    const thr = mean + sd * 1.6;

    let peak = 0;
    for (let i = 0; i < n; i++) if (diff[i] > peak) peak = diff[i];
    if (!peak) return [];

    const out = [];
    let lastT = -1;

    for (let i = 1; i < n - 1; i++) {
        if (diff[i] <= thr) continue;
        // только локальные максимумы, иначе одна вспышка растянется
        if (diff[i] < diff[i - 1] || diff[i] < diff[i + 1]) continue;

        const t = i * 0.01;
        if (t - lastT < 0.3) continue;          // не чаще ~3 раз в секунду

        lastT = t;
        out.push([Math.round(t * 100) / 100, Math.min(1, diff[i] / peak)]);
    }

    return out;
}

// вызывается из paint(): гасим вспышку и зажигаем новые удары
function beatTick(t) {
    const now = performance.now();
    const dt = lastPaintMs ? Math.min(0.12, (now - lastPaintMs) / 1000) : 0.016;
    lastPaintMs = now;

    beatPulse *= Math.exp(-dt / 0.16);          // затухание ~160 мс

    if (!beats.length) return;

    const step = t - beatPrevT;
    const jumped = step < 0 || step > 0.5;      // перемотка или первый кадр

    if (step < 0) beatCursor = 0;

    while (beatCursor < beats.length && beats[beatCursor][0] <= t) {
        // на перемотке не вспыхиваем пачкой, только двигаем курсор
        if (!jumped && beats[beatCursor][0] >= beatPrevT - 0.03) {
            // у слабых ударов вспышка всё равно заметная, у сильных — в полную
            const v = beats[beatCursor][1];
            beatPulse = Math.max(beatPulse, 0.45 + 0.55 * v);
        }
        beatCursor++;
    }

    beatPrevT = t;
    document.body.style.setProperty('--beat', beatPulse.toFixed(3));
}

function resetBeat() {
    beatPulse = 0;
    lastPaintMs = 0;
    document.body.style.setProperty('--beat', '0');
}

// ---------- отрисовка времени ----------

function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' + s : s);
}

function paint() {
    const t = audio.currentTime;
    const dur = audio.duration && isFinite(audio.duration) ? audio.duration : 0;

    const pct = dur ? Math.min(100, (t / dur) * 100) : 0;
    fill.style.width = pct + '%';
    dot.style.left = pct + '%';
    timeNow.textContent = fmt(t);
    progress.setAttribute('aria-valuenow', String(Math.round(pct)));

    beatTick(t);

    const i = findIndex(t);
    setActive(i);

    if (!audio.paused && !audio.ended) {
        rafId = requestAnimationFrame(paint);
    } else {
        rafId = null;
    }
}

function startPaint() {
    if (rafId === null) rafId = requestAnimationFrame(paint);
}

function showHint(text) {
    if (!hint) return;
    hint.textContent = text;
    hint.hidden = false;
}

// ---------- управление ----------

function play() {
    audio.play().then(function () {
        document.body.classList.add('is-playing');
        document.body.classList.add('lyrics-live');
        playBtn.classList.add('is-playing');
        playBtn.setAttribute('aria-label', 'Пауза');
        startPaint();
    }).catch(function (err) {
        // чаще всего это отсутствующий song.mp3
        showHint('не могу включить: ' + (err && err.name ? err.name : 'ошибка'));
    });
}

function pause() {
    audio.pause();
    document.body.classList.remove('is-playing');
    playBtn.classList.remove('is-playing');
    playBtn.setAttribute('aria-label', 'Включить');
    if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
    resetBeat();
    paint();
}

function seekTo(t) {
    audio.currentTime = Math.max(0, t);
    active = -1;
    paint();
}

// прогресс-бар: тап и перетаскивание
function seekFromEvent(e) {
    const rect = progress.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const ratio = rect.width ? x / rect.width : 0;
    const dur = audio.duration && isFinite(audio.duration) ? audio.duration : 0;
    seekTo(ratio * dur);
}

progress.addEventListener('pointerdown', function (e) {
    seeking = true;
    progress.classList.add('progress--seek');
    try {
        progress.setPointerCapture(e.pointerId);
    } catch (err) {
        // старые браузеры могут не знать pointer capture — переживём
    }
    seekFromEvent(e);
});

progress.addEventListener('pointermove', function (e) {
    if (seeking) seekFromEvent(e);
});

progress.addEventListener('pointerup', function (e) {
    if (!seeking) return;
    seeking = false;
    progress.classList.remove('progress--seek');
    seekFromEvent(e);
});

progress.addEventListener('pointercancel', function () {
    seeking = false;
    progress.classList.remove('progress--seek');
});

playBtn.addEventListener('click', function () {
    if (audio.paused) play();
    else pause();
});

// ---------- текст открыть/закрыть (телефон) ----------

function setLyrics(open) {
    const body = document.body;
    clearTimeout(lyrTimer);

    if (open) {
        body.classList.remove('lyrics-closing');
        body.classList.add('lyrics-open');
    } else {
        // сначала текст красиво уезжает, и только потом схлопывается место
        body.classList.add('lyrics-closing');
        lyrTimer = setTimeout(function () {
            body.classList.remove('lyrics-open');
            body.classList.remove('lyrics-closing');
        }, 320);
    }

    lyrToggle.setAttribute('aria-pressed', open ? 'true' : 'false');
    lyrToggle.querySelector('.lyr-toggle__label').textContent = open ? 'Скрыть' : 'Текст';

    if (open) {
        // высота текста растёт, пока обложка сжимается, поэтому позицию
        // пересчитываем несколько раз — так строка плавно доезжает до центра
        const fix = function () {
            scrollToLine(active);
        };

        requestAnimationFrame(function () {
            requestAnimationFrame(fix);
        });

        [80, 200, 380, 560].forEach(function (ms) {
            setTimeout(fix, ms);
        });
    }
}

lyrToggle.addEventListener('click', function () {
    setLyrics(!document.body.classList.contains('lyrics-open'));
});

// пробел — play/pause, стрелки — перемотка
document.addEventListener('keydown', function (e) {
    if (e.code === 'Space') {
        e.preventDefault();
        if (audio.paused) play();
        else pause();
    }
    if (e.code === 'ArrowRight') seekTo(audio.currentTime + 5);
    if (e.code === 'ArrowLeft') seekTo(audio.currentTime - 5);
});

audio.addEventListener('loadedmetadata', function () {
    timeAll.textContent = fmt(audio.duration);

    // если файл другой версии — предупредим в консоли, синхрон поедет
    const expected = 102.2;
    if (isFinite(audio.duration) && Math.abs(audio.duration - expected) > 1.5) {
        console.warn(
            'Длительность файла ' + audio.duration.toFixed(1) + 'с, а таймкоды под ' + expected + 'с. ' +
            'Похоже, это другая версия трека — синхрон поплывёт.'
        );
        showHint('длительность файла не совпадает с таймкодами');
    }

    paint();
});

audio.addEventListener('ended', function () {
    document.body.classList.remove('is-playing');
    playBtn.classList.remove('is-playing');
    playBtn.setAttribute('aria-label', 'Включить');
    resetBeat();
    paint();
});

// перемотка мимо плеера (локскрин, системные кнопки) тоже должна обновлять текст
audio.addEventListener('seeked', paint);
audio.addEventListener('timeupdate', function () {
    if (audio.paused) paint();
});

audio.addEventListener('error', function () {
    showHint('не нашёл song.mp3 — положи файл рядом с index.html');
});

audio.addEventListener('play', function () {
    document.body.classList.add('is-playing');
    document.body.classList.add('lyrics-live');
    playBtn.classList.add('is-playing');
    playBtn.setAttribute('aria-label', 'Пауза');
    startPaint();
});

audio.addEventListener('pause', function () {
    document.body.classList.remove('is-playing');
    playBtn.classList.remove('is-playing');
    playBtn.setAttribute('aria-label', 'Включить');
});

// ---------- старт ----------

buildLines();

// до старта видна только «следующая» строка — намёк, что текст вот-вот пойдёт
if (nodes[0]) nodes[0].classList.add('line--next');

scrollToLine(-1);

// шрифты/размеры могут доехать чуть позже — подстрахуемся
window.addEventListener('load', function () {
    scrollToLine(active);
});

// на телефоне в шторке/на локскрине показываем трек, а не «index.html»
if ('mediaSession' in navigator) {
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: 'Roman',
            artist: 'NEWLIGHTCHILD',
            album: 'Roman'
        });

        // обложку подставляем, только если файл реально есть
        const probe = new Image();
        probe.onload = function () {
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: 'Roman',
                    artist: 'NEWLIGHTCHILD',
                    album: 'Roman',
                    artwork: [{ src: 'obl.jpg', sizes: '1170x1154', type: 'image/jpeg' }]
                });
            } catch (e) {}
        };
        probe.src = 'obl.jpg';

        navigator.mediaSession.setActionHandler('play', play);
        navigator.mediaSession.setActionHandler('pause', pause);
        navigator.mediaSession.setActionHandler('seekto', function (d) {
            if (typeof d.seekTime === 'number') seekTo(d.seekTime);
        });
    } catch (e) {
        // старый браузер — не страшно
    }
}

paint();

// разбор трека на удары — не мешая загрузке страницы
window.addEventListener('load', function () {
    setTimeout(analyseBeats, 400);
});
