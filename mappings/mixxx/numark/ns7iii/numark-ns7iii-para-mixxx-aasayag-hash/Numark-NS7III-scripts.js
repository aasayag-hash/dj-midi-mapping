/*
 * Numark-NS7III-scripts.js — mapeo de la Numark NS7III con soporte nativo (fork ns7iii).
 *
 * El C++ de Mixxx (src/controllers/ns7iii/Ns7iiiHub) hace lo que antes hacía el bridge externo:
 * resume el plato en mensajes BF, maneja las pantallas Dashboard y el browser (espejo de la
 * biblioteca de Mixxx) y recibe el estado de los decks que este script manda (F0 7D 4E 37 ...).
 * Los mensajes BF 40..47 del browser antiguo ya no llegan. Protocolo: PROTOCOL.md del bridge.
 *  - Controles y LEDs viajan SIN CAMBIOS (números MIDI reales de la NS7III, ver
 *    vdj_mapping/NS7III_definition.csv). Canal 0 = mixer/browser/FX; canales 1..4 = decks.
 *  - El plato llega resumido: BF <deck> <64±delta> cada ~5 ms (3600 pasos/vuelta) y
 *    BF 0x10+deck 127/0 (plato en movimiento / detenido).
 *  - Estado hacia las pantallas: F0 7D 4E 37 <cmd> <pack7(datos)> F7.
 *    Comandos: 01 título, 02 artista, 03 tema, 04 posición, 05 tempo, 06 hot cue, 07 loop,
 *    08 nombres FX, 10 conectado, 11 desconectado, 12 orden (legado, el hub lo ignora),
 *    14 página de pads de loop, 15 tamaño de beats, 16 opciones de pantalla [zoom 1..64, colores 0/1].
 *  - Opciones del usuario: Preferencias → Controladores → NS7 III (bloque <settings> del XML,
 *    leídas con engine.getSetting en init; al aplicar, Mixxx reabre el mapeo).
 *
 * Estilo ES5 (var/function) para el QJSEngine de Mixxx. Sin dependencias de common-controller-scripts.
 */

var NS7III = {};

/* ------------------------------------------------------------------------------------------
 * Configuración (ajustable)
 * ---------------------------------------------------------------------------------------- */
NS7III.LED_ON = 0x7F;
NS7III.LED_OFF = 0x00;
NS7III.LED_DIM = 0x01;               // "luz tenue" para LEDs de función disponible

// Plato. 33 1/3 rpm × 3600 pasos/vuelta = 2000 pasos/s = 2.0 pasos/ms.
NS7III.PLATTER_STEPS = 3600;
NS7III.PLATTER_RPM = 33 + 1 / 3;
NS7III.PLATTER_NOMINAL = NS7III.PLATTER_STEPS * NS7III.PLATTER_RPM / 60000;   // pasos/ms
NS7III.PLATTER_SIGN = 1;             // invertir (-1) si el plato reporta al revés
NS7III.SCRATCH_ALPHA = 1.0 / 8;      // filtro alfa-beta estándar de Mixxx
NS7III.SCRATCH_BETA = NS7III.SCRATCH_ALPHA / 32;
NS7III.TOL_ENTER = 0.08;             // desvío relativo de velocidad para pasar a "audio sigue al plato"
NS7III.TOL_ENTER_COUNT = 3;          // lecturas consecutivas (~15 ms) por encima de TOL_ENTER
NS7III.TOL_EXIT = 0.03;              // desvío para volver a velocidad nominal…
NS7III.RETURN_MS = 150;              // …sostenido durante este tiempo
NS7III.VU_STEPS = 12;                // los vúmetros de la NS7III van de 0 a ~12 (un valor por LED)
NS7III.SPEED_EMA = 0.35;             // suavizado de la velocidad medida
// Con el deck parado y VINYL activo, velocidad mínima del plato (pasos/ms) para
// empezar a scratchear. Filtra la inercia del disco después de soltar CUE, que
// si no arrastraba la posición y dejaba el tema en cualquier lado.
NS7III.SCRATCH_MIN_SPEED = NS7III.PLATTER_NOMINAL * 0.15;
NS7III.START_TIMEOUT_MS = 2000;      // arranque del motor: no scratchear hasta llegar a nominal (o timeout)
NS7III.SPINDOWN_MS = 2500;           // tras apagar el motor se ignora el plato mientras frena
NS7III.JOG_PAUSED_DIV = 40;          // pasos de plato → unidades de 'jog' con el deck parado (sin vinyl)
NS7III.JOG_NUDGE_GAIN = 2.0;         // vinyl OFF: desvío relativo → 'jog' (pitch bend)
NS7III.GRID_STEPS = 60;              // GRID_ADJUST/GRID_SLIP: pasos de plato por ajuste

NS7III.PITCH_SIGN = 1;               // +1: fader hacia el DJ (valor alto) = más rápido
NS7III.PITCH_RANGES = [0.04, 0.08, 0.16, 0.24, 0.50, 1.00];

// Tamaños disponibles para beatloop/beatlooproll en Mixxx.
NS7III.LOOP_SIZES = [0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];
NS7III.SLICER_JUMPS = [-8, -4, -2, -1, 1, 2, 4, 8];

// Colores de pads (6 bits: RRGGBB, 2 bits por canal; medido en capturas de VirtualDJ:
// rojo = 0x30, blanco = 0x3F).
NS7III.COLOR = {
    off: 0x00, white: 0x3F, red: 0x30, orange: 0x34, green: 0x0C, blue: 0x03,
    loop: 0x0D, loop2: 0x36, magenta: 0x33, sampler2: 0x17, cyan: 0x0F, slicer2: 0x07,
    dimGreen: 0x04, dimBlue: 0x01, dimMagenta: 0x11, dimWhite: 0x15, dimPink: 0x21
};

// Modos de pads: botón (nota en el canal del deck), color página 1 / página 2 (como VDJ).
NS7III.MODES = {
    cues:    {note: 0x4F, c1: NS7III.COLOR.red,     c2: NS7III.COLOR.orange},
    roll:    {note: 0x50, c1: NS7III.COLOR.green,   c2: NS7III.COLOR.blue},
    loop:    {note: 0x51, c1: NS7III.COLOR.loop,    c2: NS7III.COLOR.loop2},
    sampler: {note: 0x52, c1: NS7III.COLOR.magenta, c2: NS7III.COLOR.sampler2},
    slicer:  {note: 0x53, c1: NS7III.COLOR.cyan,    c2: NS7III.COLOR.slicer2}
};
NS7III.PAD_NOTE = 0x47;              // PAD1..PAD8 = 0x47..0x4E (canal = deck)

// Notas/CC de salida (canal 0 salvo indicación).
NS7III.NOTE_DECK = {1: 0x02, 2: 0x03, 3: 0x04, 4: 0x05};
NS7III.CC_VU = {1: 0x4A, 2: 0x4B, 3: 0x4C, 4: 0x4D};
NS7III.CC_MASTER_VU = [0x48, 0x49];
NS7III.SIDE = {
    left:  {unit: 1, fxNotes: [0x0F, 0x10, 0x11], beatNote: 0x12, ringCC: [0x4E, 0x4F, 0x50],
            voltype: [0x61, 0x62, 0x63, 0x64], masterFxNote: 0x2B},
    right: {unit: 2, fxNotes: [0x13, 0x14, 0x15], beatNote: 0x16, ringCC: [0x52, 0x53, 0x54],
            voltype: [0x65, 0x66, 0x67, 0x68], masterFxNote: 0x2C}
};
NS7III.STATIC_LEDS = [0x01, 0x06, 0x07, 0x0A, 0x0B, 0x0C];   // PANEL_VIEW, BACK, FWD, FILES, CRATES, LOAD_PREPARE
NS7III.NOTE_TOUCH_MODE = 0x0D;
NS7III.NOTE_FILTERROLL = 0x0E;

// Protocolo de pantallas.
NS7III.SYSEX_HDR = [0xF0, 0x7D, 0x4E, 0x37];
NS7III.CMD = {TITLE: 0x01, ARTIST: 0x02, TRACK: 0x03, POS: 0x04, TEMPO: 0x05, HOTCUE: 0x06,
              LOOP: 0x07, FXNAMES: 0x08, CONNECTED: 0x10, DISCONNECTED: 0x11, SORT: 0x12,
              LOOPPADS: 0x14, BEATSIZE: 0x15, SETTINGS: 0x16};
NS7III.POS_TIMER_MS = 15;            // como VirtualDJ (~66 posiciones/s por deck): waveform fluido
NS7III.STRIP_LEDS = 15;              // LEDs de avance sobre el strip search
NS7III.RING_SEGMENTS = 11;           // segmentos del aro de cada encoder de FX
// Color de cada hot cue por número (RGB): rojo, verde, blanco, azul, rosa, violeta, amarillo, naranja.
NS7III.CUE_COLORS = [0xFF0000, 0x00FF00, 0xFFFFFF, 0x0040FF, 0xFF40C0, 0x8000FF, 0xFFFF00, 0xFF8000];
NS7III.MAX_TEXT_BYTES = 120;

/* ------------------------------------------------------------------------------------------
 * Estado
 * ---------------------------------------------------------------------------------------- */
NS7III.decks = {};
NS7III.side = {left: 1, right: 2};
NS7III.touchMode = 0;                // 0 normal, 1 touch FX activa, 2 touch EQ = kill (VDJ $fxeqtouch)
NS7III.filterRollMode = 0;           // 0 off, 1 filter-roll, 2 touch = quick effect (VDJ $filtertouch)
NS7III.connections = [];
NS7III.timers = [];

NS7III.newDeck = function(d) {
    return {
        n: d, group: '[Channel' + d + ']',
        shift: false, mode: 'cues', page: 0, offset: {roll: 1, loop: 3},
        heldPad: -1, rollKey: null,
        gridAdjust: false, gridSlip: false, gridAcc: 0,
        vinyl: true, startFactor: 0, stopFactor: 0,
        pitchMSB: 64, pitchLSB: 0, pitchS: 0,
        // plato
        motorOn: false, motorOnAt: 0, motorOffAt: 0, state: 'idle',
        speed: 0, lastT: 0, devCount: 0, tolSince: 0,
        // pantallas
        lastPosMs: -1, lastPlay: -1, trackTimer: 0, filterTouched: false,
        sentLoopPads: -1,    // init() recrea los decks antes de CONNECTED: se reenvía siempre
        rollSize: 0, slicerBeats: 1, lastBeats: 0   // cartel de beats (CC 0x07) de la pantalla
    };
};

/* ------------------------------------------------------------------------------------------
 * Utilidades
 * ---------------------------------------------------------------------------------------- */
NS7III.deckFromGroup = function(group) {
    var m = /\[Channel(\d)\]/.exec(group);
    return m ? parseInt(m[1], 10) : 0;
};

NS7III.deckOf = function(channel, group) {
    var d = NS7III.deckFromGroup(group);
    return (d >= 1 && d <= 4) ? d : channel;
};

NS7III.isPress = function(value, status) {
    return (status & 0xF0) === 0x90 && value > 0;
};

NS7III.anyShift = function() {
    for (var d = 1; d <= 4; d++) {
        if (NS7III.decks[d].shift) { return true; }
    }
    return false;
};

NS7III.sideShift = function(sideName) {
    return NS7III.decks[NS7III.side[sideName]].shift || NS7III.anyShift();
};

NS7III.relative = function(value) {          // encoder en complemento a 2 de 7 bits
    return value >= 64 ? value - 128 : value;
};

// Conexiones que todavia no se pudieron crear: en Android el mapeo se aplica
// cuando se concede el permiso USB, a veces antes de que existan los controles
// del motor ([Main] vu_meter_*) o de los efectos ([EffectRack1_...] meta), y
// makeConnection devuelve vacio sin avisar y no se reintenta nunca.
NS7III.pendingConnections = [];

NS7III.connect = function(group, key, fn) {
    var c = engine.makeConnection(group, key, fn);
    if (c) {
        NS7III.connections.push(c);
        return c;
    }
    NS7III.pendingConnections.push({group: group, key: key, fn: fn});
    if (!NS7III.retryTimer) {
        NS7III.retryTimer = engine.beginTimer(500, NS7III.retryConnections);
        NS7III.timers.push(NS7III.retryTimer); // shutdown() lo detiene
    }
    return c;
};

/// Reintenta las conexiones que fallaron hasta que el control exista.
NS7III.retryConnections = function() {
    var pending = NS7III.pendingConnections;
    NS7III.pendingConnections = [];
    for (var i = 0; i < pending.length; ++i) {
        var p = pending[i];
        var c = engine.makeConnection(p.group, p.key, p.fn);
        if (c) {
            NS7III.connections.push(c);
            c.trigger(); // refleja el valor actual enseguida (LEDs, VU)
        } else {
            NS7III.pendingConnections.push(p);
        }
    }
    if (!NS7III.pendingConnections.length && NS7III.retryTimer) {
        engine.stopTimer(NS7III.retryTimer);
        NS7III.retryTimer = 0;
    }
};

NS7III.toggle = function(group, key) {
    engine.setValue(group, key, engine.getValue(group, key) ? 0 : 1);
};

NS7III.trigger = function(group, key) {
    engine.setValue(group, key, 1);
    engine.setValue(group, key, 0);
};

NS7III.clamp = function(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };

NS7III.rgbTo6 = function(rgb) {
    if (rgb === undefined || rgb < 0) { return NS7III.COLOR.dimWhite; }
    var r = Math.round(((rgb >> 16) & 0xFF) / 85);
    var g = Math.round(((rgb >> 8) & 0xFF) / 85);
    var b = Math.round((rgb & 0xFF) / 85);
    var c = (r << 4) | (g << 2) | b;
    return c || NS7III.COLOR.dimWhite;
};

NS7III.sizeKey = function(size) {            // 0.125 → "0.125", 4 → "4"
    return String(size);
};

/* ------------------------------------------------------------------------------------------
 * Protocolo de pantallas (pack7 idéntico a bridge/ns7bridge/protocol.py)
 * ---------------------------------------------------------------------------------------- */
NS7III.pack7 = function(data) {
    var out = [], acc = 0, nbits = 0;
    for (var i = 0; i < data.length; i++) {
        acc |= (data[i] & 0xFF) << nbits;
        nbits += 8;
        while (nbits >= 7) {
            out.push(acc & 0x7F);
            acc >>>= 7;
            nbits -= 7;
        }
    }
    if (nbits) { out.push(acc & 0x7F); }
    return out;
};

NS7III.le = function(value, n) {             // entero little-endian de n bytes (con signo en 32 bits)
    var out = [], v = Math.round(value) | 0;
    for (var i = 0; i < n; i++) { out.push((v >> (8 * i)) & 0xFF); }
    return out;
};

NS7III.utf8 = function(s) {
    var out = [];
    s = String(s || '');
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c >= 0xD800 && c < 0xDC00 && i + 1 < s.length) {
            var c2 = s.charCodeAt(i + 1);
            if (c2 >= 0xDC00 && c2 < 0xE000) { c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00); i++; }
        }
        var bytes;
        if (c < 0x80) { bytes = [c]; } else if (c < 0x800) {
            bytes = [0xC0 | (c >> 6), 0x80 | (c & 63)];
        } else if (c < 0x10000) {
            bytes = [0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
        } else {
            bytes = [0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
        }
        if (out.length + bytes.length > NS7III.MAX_TEXT_BYTES) { break; }
        out = out.concat(bytes);
    }
    return out;
};

NS7III.sendCmd = function(cmd, data) {
    var msg = NS7III.SYSEX_HDR.concat([cmd], NS7III.pack7(data || []), [0xF7]);
    midi.sendSysexMsg(msg, msg.length);
};

// Orden actual de la lista de Mixxx → el bridge ordena la pantalla central igual.
NS7III.sendSort = function() {
    var col = engine.getValue('[Library]', 'sort_column');
    var ord = engine.getValue('[Library]', 'sort_order');
    if (col === NS7III.lastSortCol && ord === NS7III.lastSortOrd) { return false; }
    NS7III.lastSortCol = col;
    NS7III.lastSortOrd = ord;
    console.log('NS7III browser: orden columna ' + col + (ord ? ' desc' : ' asc'));
    NS7III.sendCmd(NS7III.CMD.SORT, [col & 0x7F, ord ? 1 : 0]);
    return true;
};

// Columnas de Mixxx (TrackModel::SortColumnId) para el setting sortColumn.
NS7III.SORT_COLUMNS = {artist: 1, title: 2, bpm: 15};

NS7III.getSetting = function(name, fallback) {
    try {
        var v = engine.getSetting(name);
        return (v === undefined || v === null) ? fallback : v;
    } catch (e) {
        return fallback;
    }
};

// Lee las opciones de Preferencias → Controladores y las pasa al hub (zoom/colores) o a la tabla.
NS7III.applySettings = function() {
    var zoom = parseInt(NS7III.getSetting('waveZoom', '4'), 10);
    if (!(zoom >= 1 && zoom <= 64)) { zoom = 4; }
    var colors = NS7III.getSetting('waveColors', true) ? 1 : 0;
    NS7III.sendCmd(NS7III.CMD.SETTINGS, [zoom, colors]);
    var col = NS7III.SORT_COLUMNS[NS7III.getSetting('sortColumn', 'mixxx')];
    NS7III.forcedSort = col ? {col: col, ord: NS7III.getSetting('sortDescending', false) ? 1 : 0} : null;
    console.log('NS7III opciones: zoom ' + zoom + ', colores ' + colors + ', orden ' +
                (NS7III.forcedSort ? NS7III.forcedSort.col + '/' + NS7III.forcedSort.ord : 'como en Mixxx'));
    NS7III.enforceSort();
};

// Orden forzado: se aplica a la tabla de Mixxx (la pantalla la sigue). Mixxx restaura el orden
// propio de cada carpeta/lista al cambiarla, así que se vuelve a imponer en cada cambio.
NS7III.enforceSort = function() {
    var f = NS7III.forcedSort;
    if (!f) { return; }
    if (engine.getValue('[Library]', 'sort_column') !== f.col) {
        engine.setValue('[Library]', 'sort_column', f.col);
    }
    if (engine.getValue('[Library]', 'sort_order') !== f.ord) {
        engine.setValue('[Library]', 'sort_order', f.ord);
    }
};

NS7III.samplesToMs = function(group, samples) {
    var sr = engine.getValue(group, 'track_samplerate');
    if (!sr || samples < 0) { return -1; }
    return samples / (sr * 2) * 1000;          // posiciones de Mixxx: muestras estéreo intercaladas
};

NS7III.sendTrack = function(d) {               // cmd 03: duración ms + BPM×100 (identificación en el bridge)
    var g = NS7III.decks[d].group;
    var dur = engine.getValue(g, 'track_loaded') ? engine.getValue(g, 'duration') * 1000 : 0;
    var bpm = engine.getValue(g, 'file_bpm') * 100;
    NS7III.sendCmd(NS7III.CMD.TRACK, [d - 1].concat(NS7III.le(dur, 4), NS7III.le(bpm, 3)));
};

NS7III.scheduleTrack = function(d) {           // agrupa track_loaded/duration/file_bpm en un solo envío
    var st = NS7III.decks[d];
    if (st.trackTimer) { engine.stopTimer(st.trackTimer); }
    st.trackTimer = engine.beginTimer(100, function() {
        st.trackTimer = 0;
        NS7III.sendTrack(d);
        NS7III.sendTempo(d);
        for (var i = 1; i <= 8; i++) { NS7III.sendHotcue(d, i); }
        NS7III.sendLoop(d);
        NS7III.sendTexts(d);
    }, true);
};

NS7III.sendPosition = function(d, force) {     // cmd 04
    var st = NS7III.decks[d], g = st.group;
    var play = engine.getValue(g, 'play') ? 1 : 0;
    var dur = engine.getValue(g, 'duration');
    var pos = Math.round(engine.getValue(g, 'playposition') * dur * 1000);
    if (!force && pos === st.lastPosMs && play === st.lastPlay) { return; }
    st.lastPosMs = pos;
    st.lastPlay = play;
    NS7III.sendCmd(NS7III.CMD.POS, [d - 1].concat(NS7III.le(pos, 4), [play]));
};

NS7III.sendTempo = function(d) {               // cmd 05: BPM×100, pitch%×100+8192, rango %
    var g = NS7III.decks[d].group;
    var bpm = engine.getValue(g, 'bpm');
    var fileBpm = engine.getValue(g, 'file_bpm');
    var pitch = fileBpm > 0 ? (bpm / fileBpm - 1) * 100 : 0;
    var raw = NS7III.clamp(Math.round(pitch * 100) + 8192, 0, 0xFFFF);
    var range = NS7III.clamp(Math.round(engine.getValue(g, 'rateRange') * 100), 0, 255);
    NS7III.sendCmd(NS7III.CMD.TEMPO, [d - 1].concat(NS7III.le(bpm * 100, 3), NS7III.le(raw, 2), [range]));
};

NS7III.sendHotcue = function(d, i) {           // cmd 06: índice 0..7, posición ms (-1 = vacío), color RGB
    var g = NS7III.decks[d].group;
    var pre = 'hotcue_' + i + '_';
    var pos = engine.getValue(g, pre + 'status') > 0 ?
        NS7III.samplesToMs(g, engine.getValue(g, pre + 'position')) : -1;
    var color = engine.getValue(g, pre + 'color');
    NS7III.sendCmd(NS7III.CMD.HOTCUE, [d - 1, i - 1].concat(NS7III.le(pos, 4), NS7III.le(color, 4)));
};

NS7III.sendLoop = function(d) {                // cmd 07
    var g = NS7III.decks[d].group;
    var a = NS7III.samplesToMs(g, engine.getValue(g, 'loop_start_position'));
    var b = NS7III.samplesToMs(g, engine.getValue(g, 'loop_end_position'));
    NS7III.sendCmd(NS7III.CMD.LOOP,
        [d - 1, engine.getValue(g, 'loop_enabled') ? 1 : 0].concat(NS7III.le(a, 4), NS7III.le(b, 4)));
};

NS7III.sendFxNames = function(sideName) {      // cmd 08 (Mixxx 2.5 no expone nombres de efectos como CO)
    var u = NS7III.SIDE[sideName].unit;
    var bytes = [];
    for (var s = 1; s <= 3; s++) {
        var slot = '[EffectRack1_EffectUnit' + u + '_Effect' + s + ']';
        var label = 'FX' + u + '.' + s + (engine.getValue(slot, 'enabled') ? ' ON' : '');
        if (s > 1) { bytes.push(0); }
        bytes = bytes.concat(NS7III.utf8(label));
    }
    NS7III.sendCmd(NS7III.CMD.FXNAMES, [NS7III.side[sideName] - 1].concat(bytes));
};

// Título/artista: sólo si existe engine.getPlayer (rama de desarrollo de Mixxx).
NS7III.hasPlayerApi = function() {
    return typeof engine.getPlayer === 'function';
};

NS7III.sendTexts = function(d) {
    if (!NS7III.hasPlayerApi()) { return; }
    try {
        var p = engine.getPlayer(NS7III.decks[d].group);
        if (!p) { return; }
        NS7III.sendCmd(NS7III.CMD.TITLE, [d - 1].concat(NS7III.utf8(p.title)));
        NS7III.sendCmd(NS7III.CMD.ARTIST, [d - 1].concat(NS7III.utf8(p.artist)));
    } catch (e) {
        print('NS7III: getPlayer falló: ' + e);
    }
};

NS7III.connectPlayer = function(d) {
    if (!NS7III.hasPlayerApi()) { return; }
    try {
        var p = engine.getPlayer(NS7III.decks[d].group);
        if (!p) { return; }
        if (p.titleChanged && p.titleChanged.connect) {
            p.titleChanged.connect(function(t) {
                NS7III.sendCmd(NS7III.CMD.TITLE, [d - 1].concat(NS7III.utf8(t !== undefined ? t : p.title)));
            });
        }
        if (p.artistChanged && p.artistChanged.connect) {
            p.artistChanged.connect(function(a) {
                NS7III.sendCmd(NS7III.CMD.ARTIST, [d - 1].concat(NS7III.utf8(a !== undefined ? a : p.artist)));
            });
        }
    } catch (e) {
        print('NS7III: no se pudo conectar getPlayer: ' + e);
    }
};

NS7III.positionTick = function() {
    for (var d = 1; d <= 4; d++) {
        if (engine.getValue(NS7III.decks[d].group, 'track_loaded')) { NS7III.sendPosition(d, false); }
    }
};

/* ------------------------------------------------------------------------------------------
 * Motor del plato (los mensajes van al bridge, que los reenvía a la NS7III)
 * ---------------------------------------------------------------------------------------- */
NS7III.motor = function(d, on) {
    var st = NS7III.decks[d];
    midi.sendShortMsg(0xB0 + d, 0x45, 0x00);                 // 33 rpm
    midi.sendShortMsg(0xB0 + d, on ? 0x41 : 0x42, 0x7F);     // ON / OFF
    var now = Date.now();
    if (on && !st.motorOn) {
        st.motorOnAt = now;
        if (st.state !== 'scratch') { st.state = 'starting'; }
    } else if (!on && st.motorOn) {
        st.motorOffAt = now;
        if (st.state === 'scratch') { engine.scratchDisable(d, true); }
        st.state = 'spindown';
    }
    st.motorOn = on;
};

NS7III.onPlayChanged = function(value, group) {
    var d = NS7III.deckFromGroup(group);
    NS7III.motor(d, value > 0);
    NS7III.sendPosition(d, true);
};

/* ------------------------------------------------------------------------------------------
 * Plato (mensajes del bridge: BF <deck> <64±delta>, BF 0x10+deck 127/0)
 *
 * Regla de VirtualDJ: el motor gira fijo a 33 1/3 rpm. Con el plato a velocidad nominal el
 * audio va al pitch elegido (Mixxx reproduce normal). Si el plato se frena/acelera/scratchea,
 * el audio sigue al plato: scratchEnable + scratchTick hasta que vuelve a nominal.
 * La NS7III no expone "touch" del plato en la definición: la detección es por velocidad.
 * ---------------------------------------------------------------------------------------- */
NS7III.platter = function(channel, control, value) {
    var d = control;
    if (d < 1 || d > 4) { return; }
    var st = NS7III.decks[d], g = st.group;
    var delta = (value - 64) * NS7III.PLATTER_SIGN;
    if (!delta) { return; }
    var now = Date.now();
    var dt = now - st.lastT;
    st.lastT = now;
    var inst = (dt > 0 && dt < 60) ? delta / dt : delta / 5;
    st.speed = (dt > 0 && dt < 60) ? st.speed + NS7III.SPEED_EMA * (inst - st.speed) : inst;

    // Grilla: con GRID_ADJUST/GRID_SLIP apretados el plato ajusta el beatgrid.
    if (st.gridAdjust || st.gridSlip) {
        st.gridAcc += delta;
        while (Math.abs(st.gridAcc) >= NS7III.GRID_STEPS) {
            var fwd = st.gridAcc > 0;
            st.gridAcc -= fwd ? NS7III.GRID_STEPS : -NS7III.GRID_STEPS;
            if (st.gridAdjust) {
                NS7III.trigger(g, fwd ? 'beats_adjust_faster' : 'beats_adjust_slower');
            } else {
                NS7III.trigger(g, fwd ? 'beats_translate_later' : 'beats_translate_earlier');
            }
        }
        return;
    }

    if (!st.motorOn) {
        if (st.state === 'spindown') {
            if (now - st.motorOffAt < NS7III.SPINDOWN_MS) { return; }   // el plato todavía frena
            st.state = 'idle';
        }
        if (st.vinyl) {                       // mano en el plato con el deck parado: scratch
            // Sólo si el plato se mueve de verdad. Sin esto, la inercia que queda
            // tras soltar CUE (el motor frena pero el disco sigue girando) entra en
            // scratch y arrastra la posición: el tema terminaba en cualquier lado en
            // vez de volver al punto de cue.
            if (st.state !== 'scratch' && Math.abs(st.speed) < NS7III.SCRATCH_MIN_SPEED) {
                return;
            }
            if (st.state !== 'scratch') {
                engine.scratchEnable(d, NS7III.PLATTER_STEPS, NS7III.PLATTER_RPM,
                    NS7III.SCRATCH_ALPHA, NS7III.SCRATCH_BETA, true);
                st.state = 'scratch';
            }
            engine.scratchTick(d, delta);
        } else {
            engine.setValue(g, 'jog', delta / NS7III.JOG_PAUSED_DIV);
        }
        return;
    }

    // Velocidad precisa del bridge (marcas de tiempo del hardware); si todavía no llegó, la estimada.
    var ratio = (st.ratio !== undefined && now - st.ratioT < 50) ? st.ratio : st.speed / NS7III.PLATTER_NOMINAL;
    var dev = Math.abs(ratio - 1);
    if (st.state === 'starting' || st.state === 'spindown' || st.state === 'idle') {
        if (dev < NS7III.TOL_EXIT || now - st.motorOnAt > NS7III.START_TIMEOUT_MS) {
            st.state = 'nominal';
            st.devCount = 0;
        }
        return;
    }
    if (st.state === 'nominal') {
        if (dev <= NS7III.TOL_ENTER) { st.devCount = 0; return; }
        if (++st.devCount < NS7III.TOL_ENTER_COUNT) { return; }
        if (!st.vinyl) {                      // vinyl OFF: el plato hace de pitch bend
            engine.setValue(g, 'jog', (ratio - 1) * NS7III.JOG_NUDGE_GAIN);
            return;
        }
        engine.scratchEnable(d, NS7III.PLATTER_STEPS, NS7III.PLATTER_RPM,
            NS7III.SCRATCH_ALPHA, NS7III.SCRATCH_BETA, true);
        st.state = 'scratch';
        st.tolSince = 0;
    }
    if (st.state === 'scratch') {
        engine.scratchTick(d, delta);
        if (dev < NS7III.TOL_EXIT) {
            if (!st.tolSince) {
                st.tolSince = now;
            } else if (now - st.tolSince > NS7III.RETURN_MS) {
                engine.scratchDisable(d, true);
                st.state = 'nominal';
                st.devCount = 0;
            }
        } else {
            st.tolSince = 0;
        }
    }
};

/* Velocidad del plato calculada por el bridge: BF 20+deck MSB, BF 28+deck LSB (14 bits);
 * ratio = valor / 4096 - 2  → 1.0 = 33⅓ rpm, 0 = quieto, negativo = hacia atrás. Llega MSB y luego LSB. */
NS7III.platterSpeed = function(channel, control, value) {
    var isMsb = control < 0x28;
    var d = control - (isMsb ? 0x20 : 0x28);
    if (d < 1 || d > 4) { return; }
    var st = NS7III.decks[d];
    if (isMsb) { st.ratioMsb = value; return; }
    st.ratio = (((st.ratioMsb || 0) << 7) | value) / 4096 - 2;
    st.ratio *= NS7III.PLATTER_SIGN;
    st.ratioT = Date.now();
};

NS7III.platterMoving = function(channel, control, value) {
    var d = control - 0x10;
    if (d < 1 || d > 4) { return; }
    var st = NS7III.decks[d];
    if (value > 0) { return; }
    st.speed = 0;
    if (!st.motorOn) {
        if (st.state === 'scratch') { engine.scratchDisable(d, true); }
        st.state = 'idle';
    }
    // Con motor ON y plato detenido (mano sujetando) el scratch sigue activo: audio parado.
};

/* ------------------------------------------------------------------------------------------
 * Transporte
 * ---------------------------------------------------------------------------------------- */
NS7III.shiftButton = function(channel, control, value, status, group) {
    var d = NS7III.deckOf(channel, group);
    NS7III.decks[d].shift = NS7III.isPress(value, status);
    midi.sendShortMsg(0x90 + d, 0x35, NS7III.decks[d].shift ? NS7III.LED_ON : NS7III.LED_OFF);
};

NS7III.playButton = function(channel, control, value, status, group) {
    if (!NS7III.isPress(value, status)) { return; }
    var d = NS7III.deckOf(channel, group), st = NS7III.decks[d], g = st.group;
    if (st.shift) {                           // VDJ play_stutter
        NS7III.trigger(g, 'cue_gotoandplay');
        return;
    }
    if (engine.getValue(g, 'play')) {
        if (st.stopFactor) { engine.brake(d, true, st.stopFactor); } else { engine.setValue(g, 'play', 0); }
    } else if (st.startFactor && typeof engine.softStart === 'function') {
        engine.softStart(d, true, st.startFactor);
    } else {
        engine.setValue(g, 'play', 1);
    }
};

/* Botón de auriculares (PFL).
 *
 * El equipo prende y apaga la luz del botón por su cuenta, una vez por cada
 * pulsación física completa (apretar + soltar), y no hace caso de lo que Mixxx
 * le mande a esa nota. Si Mixxx alterna en el note-on, termina cambiando la
 * mitad de las veces que la luz, y los dos quedan corridos: el primer toque
 * coincide, el segundo apaga la luz pero no el PFL, el tercero los deja al
 * revés. Alternar al SOLTAR deja a los dos en el mismo ritmo.
 */
NS7III.pflButton = function(channel, control, value, status, group) {
    // El botón de auriculares del NS7III no es momentáneo: engancha. Cada vez
    // que el usuario lo toca, el equipo manda UN solo mensaje, y alterna entre
    // note-on (0x90, al quedar hundido) y note-off (0x80, al soltarse), con
    // segundos de diferencia entre uno y otro. Tomar sólo el note-on hacía que
    // Mixxx cambiara una vez cada dos toques, que es justo lo que se veía.
    NS7III.toggle(group, 'pfl');
};

NS7III.cueButton = function(channel, control, value, status, group) {
    var d = NS7III.deckOf(channel, group), g = NS7III.decks[d].group;
    var press = NS7III.isPress(value, status);
    if (NS7III.decks[d].shift) {
        if (press) { NS7III.trigger(g, 'start'); }       // VDJ goto_start
        return;
    }
    engine.setValue(g, 'cue_default', press ? 1 : 0);
};

NS7III.syncButton = function(channel, control, value, status, group) {
    if (!NS7III.isPress(value, status)) { return; }
    var d = NS7III.deckOf(channel, group), g = NS7III.decks[d].group;
    NS7III.toggle(g, NS7III.decks[d].shift ? 'sync_leader' : 'sync_enabled');
};

NS7III.pitchRangeButton = function(channel, control, value, status, group) {
    if (!NS7III.isPress(value, status)) { return; }
    var d = NS7III.deckOf(channel, group), g = NS7III.decks[d].group;
    if (NS7III.decks[d].shift) { NS7III.toggle(g, 'keylock'); return; }
    var cur = engine.getValue(g, 'rateRange'), r = NS7III.PITCH_RANGES, next = r[0];
    for (var i = 0; i < r.length; i++) {
        if (r[i] > cur + 0.001) { next = r[i]; break; }
    }
    engine.setValue(g, 'rateRange', next);
};

// Fader de pitch de 14 bits (MSB cc 0x01, LSB cc 0x21, canal = deck).
NS7III.pitchMSB = function(channel, control, value, status, group) {
    var st = NS7III.decks[NS7III.deckOf(channel, group)];
    st.pitchMSB = value;
    NS7III.applyPitch(st);
};

NS7III.pitchLSB = function(channel, control, value, status, group) {
    var st = NS7III.decks[NS7III.deckOf(channel, group)];
    st.pitchLSB = value;
    NS7III.applyPitch(st);
};

NS7III.applyPitch = function(st) {
    var v = (st.pitchMSB << 7) | st.pitchLSB;
    st.pitchS = NS7III.clamp((v - 8192) / 8192, -1, 1) * NS7III.PITCH_SIGN;   // + = más rápido
    // 'rate' depende de la orientación elegida por el usuario (rate_dir): se compensa.
    engine.setValue(st.group, 'rate', st.pitchS * engine.getValue(st.group, 'rate_dir'));
    NS7III.pitchLeds(st.n);
};

NS7III.pitchLeds = function(d) {
    var st = NS7III.decks[d], g = st.group;
    var actual = engine.getValue(g, 'rate') * engine.getValue(g, 'rate_dir');
    var diff = actual - st.pitchS;
    midi.sendShortMsg(0x90 + d, 0x40, Math.abs(actual) < 0.0005 ? NS7III.LED_ON : NS7III.LED_OFF);
    // Flechas: hacia dónde mover el fader para retomar el pitch (soft takeover / sync).
    midi.sendShortMsg(0x90 + d, 0x3F, diff > 0.01 ? NS7III.LED_ON : NS7III.LED_OFF);
    midi.sendShortMsg(0x90 + d, 0x3E, diff < -0.01 ? NS7III.LED_ON : NS7III.LED_OFF);
};

NS7III.slipButton = function(channel, control, value, status, group) {
    if (!NS7III.isPress(value, status)) { return; }
    var d = NS7III.deckOf(channel, group), st = NS7III.decks[d];
    if (st.shift) {                           // VDJ vinyl_mode
        st.vinyl = !st.vinyl;
        NS7III.slipLed(d);
        return;
    }
    NS7III.toggle(st.group, 'slip_enabled');
};

NS7III.slipLed = function(d) {
    var st = NS7III.decks[d];
    var on = engine.getValue(st.group, 'slip_enabled') || st.vinyl;
    midi.sendShortMsg(0x90 + d, 0x44, on ? NS7III.LED_ON : NS7III.LED_OFF);
};

NS7III.hotcueButton = function(channel, control, value, status, group) {
    var d = NS7III.deckOf(channel, group), g = NS7III.decks[d].group;
    var i = control - 0x36 + 1;               // HOTCUE1..5 = 0x36..0x3A
    var press = NS7III.isPress(value, status);
    if (NS7III.decks[d].shift) {
        if (press) { NS7III.trigger(g, 'hotcue_' + i + '_clear'); }
        return;
    }
    engine.setValue(g, 'hotcue_' + i + '_activate', press ? 1 : 0);
};

NS7III.loadButton = function(channel, control, value, status, group) {
    if (!NS7III.isPress(value, status)) { return; }
    var d = NS7III.deckOf(channel, group), g = NS7III.decks[d].group;
    if (NS7III.decks[d].shift) { NS7III.trigger(g, 'eject'); } else { NS7III.trigger(g, 'LoadSelectedTrack'); }
};

NS7III.stripSearch = function(channel, control, value, status, group) {
    var d = NS7III.deckOf(channel, group), g = NS7III.decks[d].group;
    // Siempre mueve la posición, también sonando (en VDJ sólo con el deck parado o con SHIFT).
    engine.setValue(g, 'playposition', value / 127);
};

NS7III.startTime = function(channel, control, value, status, group) {   // VDJ startupspeed
    var st = NS7III.decks[NS7III.deckOf(channel, group)];
    st.startFactor = value < 4 ? 0 : 4.0 - 3.8 * value / 127;
};

NS7III.stopTime = function(channel, control, value, status, group) {    // VDJ brakespeed
    var st = NS7III.decks[NS7III.deckOf(channel, group)];
    st.stopFactor = value < 4 ? 0 : 4.0 - 3.8 * value / 127;
};

NS7III.gridAdjust = function(channel, control, value, status, group) {
    var d = NS7III.deckOf(channel, group), st = NS7III.decks[d];
    var press = NS7III.isPress(value, status);
    if (st.shift) {
        if (press) { NS7III.trigger(st.group, 'beats_translate_curpos'); }   // VDJ set_firstbeat
        return;
    }
    st.gridAdjust = press;
    st.gridAcc = 0;
};

NS7III.gridSlip = function(channel, control, value, status, group) {
    var d = NS7III.deckOf(channel, group), st = NS7III.decks[d];
    st.gridSlip = NS7III.isPress(value, status) && !st.shift;
    st.gridAcc = 0;
};

/* ------------------------------------------------------------------------------------------
 * Pads
 * ---------------------------------------------------------------------------------------- */
NS7III.modeButton = function(channel, control, value, status, group) {
    if (!NS7III.isPress(value, status)) { return; }
    var d = NS7III.deckOf(channel, group), st = NS7III.decks[d];
    var mode = null;
    for (var m in NS7III.MODES) {
        if (NS7III.MODES[m].note === control) { mode = m; }
    }
    if (!mode) { return; }
    if (mode === 'sampler' && st.shift) {     // VDJ sampler_rec → grabación de Mixxx
        NS7III.toggle('[Recording]', 'toggle_recording');
        return;
    }
    // Segunda pulsación del mismo modo = página 2 (como pad_pages de VDJ).
    st.page = (st.mode === mode) ? 1 - st.page : 0;
    st.mode = mode;
    NS7III.releaseRoll(st);
    NS7III.modeLeds(d);
    NS7III.padLeds(d);
};

NS7III.releaseRoll = function(st) {
    if (st.rollKey) {
        engine.setValue(st.group, st.rollKey, 0);
        st.rollKey = null;
        NS7III.sendBeatSize();
    }
};

NS7III.padParam = function(channel, control, value, status, group) {
    if (!NS7III.isPress(value, status)) { return; }
    var d = NS7III.deckOf(channel, group), st = NS7III.decks[d];
    var dir = control === 0x46 ? 1 : -1;      // PAD_PARAMETER+ = 0x46, - = 0x45
    if (st.mode === 'roll' || st.mode === 'loop') {
        st.offset[st.mode] = NS7III.clamp(st.offset[st.mode] + dir, 0, NS7III.LOOP_SIZES.length - 8);
        NS7III.padLeds(d);
    } else {
        var js = engine.getValue(st.group, 'beatjump_size');
        engine.setValue(st.group, 'beatjump_size', dir > 0 ? Math.min(js * 2, 512) : Math.max(js / 2, 0.03125));
    }
};

NS7III.samplerCount = function() {
    var n = engine.getValue('[App]', 'num_samplers');
    if (!n) { n = engine.getValue('[Master]', 'num_samplers'); }
    return n || 0;
};

NS7III.pad = function(channel, control, value, status, group) {
    var d = NS7III.deckOf(channel, group), st = NS7III.decks[d], g = st.group;
    var i = control - NS7III.PAD_NOTE;        // 0..7
    if (i < 0 || i > 7) { return; }
    var press = NS7III.isPress(value, status);
    st.heldPad = press ? i : (st.heldPad === i ? -1 : st.heldPad);
    var size, key;

    switch (st.mode) {
    case 'cues':
        var n = i + 1 + st.page * 8;
        if (st.shift) {
            if (press) { NS7III.trigger(g, 'hotcue_' + n + '_clear'); }
        } else {
            engine.setValue(g, 'hotcue_' + n + '_activate', press ? 1 : 0);
        }
        break;
    case 'roll':
        size = NS7III.LOOP_SIZES[NS7III.padLoopFirst(st) + i];
        key = 'beatlooproll_' + NS7III.sizeKey(size) + '_activate';
        if (press) {
            NS7III.releaseRoll(st);
            engine.setValue(g, key, 1);
            st.rollKey = key;
            st.rollSize = size;
        } else if (st.rollKey === key) {
            NS7III.releaseRoll(st);
        }
        break;
    case 'loop':
        if (!press) { break; }
        if (st.page === 0) {
            size = NS7III.LOOP_SIZES[NS7III.padLoopFirst(st) + i];
            NS7III.trigger(g, 'beatloop_' + NS7III.sizeKey(size) + '_toggle');
        } else {
            var manual = ['loop_in', 'loop_out', 'reloop_toggle', 'loop_remove',
                          'loop_halve', 'loop_double', -1, 1];
            if (typeof manual[i] === 'number') {
                engine.setValue(g, 'loop_move', manual[i] * engine.getValue(g, 'beatjump_size'));
            } else {
                NS7III.trigger(g, manual[i]);
            }
        }
        break;
    case 'sampler':
        if (!press) { break; }
        var s = i + 1 + st.page * 8;
        if (s > NS7III.samplerCount()) { break; }
        var sg = '[Sampler' + s + ']';
        if (!engine.getValue(sg, 'track_loaded')) {
            NS7III.trigger(sg, 'LoadSelectedTrack');
        } else if (st.shift) {
            NS7III.trigger(sg, engine.getValue(sg, 'play') ? 'cue_gotoandstop' : 'eject');
        } else {
            NS7III.trigger(sg, 'cue_gotoandplay');
        }
        break;
    case 'slicer':
        // Mixxx no tiene slicer: página 1 = beatjump ±1/2/4/8, página 2 = mover loop.
        if (!press) { break; }
        var beats = NS7III.SLICER_JUMPS[i];
        st.slicerBeats = Math.abs(beats);
        if (st.page === 0) {
            engine.setValue(g, 'beatjump', beats);
        } else {
            engine.setValue(g, 'loop_move', beats);
        }
        break;
    }
    NS7III.padLeds(d);
};

NS7III.modeLeds = function(d) {
    var st = NS7III.decks[d];
    for (var m in NS7III.MODES) {
        var def = NS7III.MODES[m];
        var color = (st.mode === m) ? (st.page ? def.c2 : def.c1) : NS7III.COLOR.white;
        midi.sendShortMsg(0x90 + d, def.note, color);
    }
};

NS7III.padColor = function(st, i) {
    var g = st.group, C = NS7III.COLOR, size;
    switch (st.mode) {
    case 'cues':
        var n = i + 1 + st.page * 8;
        return engine.getValue(g, 'hotcue_' + n + '_status') > 0 ?
            NS7III.rgbTo6(engine.getValue(g, 'hotcue_' + n + '_color')) : C.off;
    case 'roll':
        return st.heldPad === i ? C.white : (st.page ? C.dimBlue : C.dimGreen);
    case 'loop':
        if (st.page === 0) {
            size = NS7III.LOOP_SIZES[st.offset.loop + i];
            return engine.getValue(g, 'beatloop_' + NS7III.sizeKey(size) + '_enabled') ? C.loop : C.dimGreen;
        }
        if (i === 2) { return engine.getValue(g, 'loop_enabled') ? C.white : C.loop2; }
        return C.dimPink;
    case 'sampler':
        var s = i + 1 + st.page * 8;
        if (s > NS7III.samplerCount()) { return C.off; }
        var sg = '[Sampler' + s + ']';
        if (!engine.getValue(sg, 'track_loaded')) { return C.off; }
        return engine.getValue(sg, 'play') ? (st.page ? C.sampler2 : C.magenta) : C.dimMagenta;
    case 'slicer':
        return st.heldPad === i ? C.white : (st.page ? C.slicer2 : C.cyan);
    }
    return C.off;
};

NS7III.padLeds = function(d) {
    var st = NS7III.decks[d];
    for (var i = 0; i < 8; i++) {
        midi.sendShortMsg(0x90 + d, NS7III.PAD_NOTE + i, NS7III.padColor(st, i));
    }
    NS7III.sendLoopPads(d);
    NS7III.sendBeatSize();
};

// Cartel de beats de la vista 1 (abajo a la derecha, CC 0x07 vía hub, cmd BEATSIZE). Es por
// unidad: muestra el deck seleccionado de cada lado. Roll: el tamaño del roll que suena (pad o
// filter-roll) o, sin roll, el primer tamaño de la página de pads. Slicer: los beats del último
// salto/movimiento. Otros modos: se mantiene el último valor de ese deck.
NS7III.beatSize = function(st) {
    if (st.mode === 'roll') {
        st.lastBeats = st.rollKey ? st.rollSize : NS7III.LOOP_SIZES[NS7III.padLoopFirst(st)];
    } else if (st.mode === 'slicer') {
        st.lastBeats = st.slicerBeats;
    } else if (!st.lastBeats) {
        st.lastBeats = NS7III.LOOP_SIZES[NS7III.padLoopFirst(NS7III.decks[st.n]) || 0];
    }
    return st.lastBeats;
};

NS7III.sentBeats = {left: -1, right: -1};
NS7III.sendBeatSize = function() {
    ['left', 'right'].forEach(function(s) {
        var d = NS7III.side[s];
        if (!NS7III.decks[d]) { return; }
        var v = Math.round(NS7III.beatSize(NS7III.decks[d]) * 32);   // en 1/32 de beat
        var key = d * 100000 + v;
        if (NS7III.sentBeats[s] === key) { return; }
        NS7III.sentBeats[s] = key;
        NS7III.sendCmd(NS7III.CMD.BEATSIZE, [s === 'left' ? 0 : 1].concat(NS7III.le(v, 2)));
    });
};

// Primer índice de LOOP_SIZES de los 8 pads de tamaño (página de PAD_PARAMETER +/-). Lo usan
// tanto la acción del pad como la etiqueta de la pantalla. null = los pads no son tamaños
// (modo loop página 2: acciones manuales loop_in/out, reloop, halve...).
NS7III.padLoopFirst = function(st) {
    var max = NS7III.LOOP_SIZES.length - 8;
    if (st.mode === 'roll') { return NS7III.clamp(st.offset.roll - st.page, 0, max); }
    if (st.mode === 'loop' && st.page !== 0) { return null; }
    return NS7III.clamp(st.offset.loop, 0, max);
};

// Etiquetas de la grilla de loops de la pantalla (msg 0x03 vía hub, cmd LOOPPADS). El firmware
// sólo admite índices de tamaño (0..32, sin valor "vacío"): en la página de acciones manuales
// no se manda nada y la grilla queda con la última página de tamaños.
NS7III.sendLoopPads = function(d) {
    var st = NS7III.decks[d];
    var first = NS7III.padLoopFirst(st);
    if (first === null || st.sentLoopPads === first) { return; }
    st.sentLoopPads = first;
    NS7III.sendCmd(NS7III.CMD.LOOPPADS, [d - 1, first]);
};


NS7III.allPadLeds = function() {
    for (var d = 1; d <= 4; d++) { NS7III.padLeds(d); }
};

/* ------------------------------------------------------------------------------------------
 * Selección de deck (izquierda 1/3, derecha 2/4). El hardware cambia solo el canal MIDI de los
 * controles de deck; acá se elige a qué deck apuntan los controles "left/right" (FX, BEAT).
 * ---------------------------------------------------------------------------------------- */
NS7III.deckSelect = function(channel, control, value, status) {
    if (!NS7III.isPress(value, status)) { return; }
    for (var d = 1; d <= 4; d++) {
        if (NS7III.NOTE_DECK[d] === control) {
            NS7III.side[(d % 2) ? 'left' : 'right'] = d;
        }
    }
    NS7III.deckLeds();
    NS7III.sideLeds('left');
    NS7III.sideLeds('right');
};

NS7III.deckLeds = function() {
    for (var d = 1; d <= 4; d++) {
        var active = NS7III.side.left === d || NS7III.side.right === d;
        midi.sendShortMsg(0x90, NS7III.NOTE_DECK[d], active ? NS7III.LED_ON : NS7III.LED_OFF);
    }
    NS7III.sendBeatSize();
};

/* ------------------------------------------------------------------------------------------
 * Efectos: unidad 1 = lado izquierdo, unidad 2 = lado derecho (FX1..3 = slots 1..3).
 * ---------------------------------------------------------------------------------------- */
NS7III.sideOfControl = function(control, kind) {
    for (var s in NS7III.SIDE) {
        var def = NS7III.SIDE[s];
        if (kind === 'fx' && def.fxNotes.indexOf(control) >= 0) { return s; }
        if (kind === 'beat' && def.beatNote === control) { return s; }
    }
    return null;
};

NS7III.ENC = {                                // cc de encoders: lado, slot (0 = BEAT)
    0x04: ['left', 1], 0x05: ['left', 2], 0x06: ['left', 3], 0x48: ['left', 0],
    0x49: ['right', 1], 0x4A: ['right', 2], 0x4B: ['right', 3], 0x4C: ['right', 0]
};
NS7III.ENC_TOUCH = {                          // nota de touch: lado, slot
    0x64: ['left', 1], 0x65: ['left', 2], 0x66: ['left', 3],
    0x68: ['right', 1], 0x69: ['right', 2], 0x6A: ['right', 3]
};

NS7III.slotGroup = function(sideName, slot) {
    return '[EffectRack1_EffectUnit' + NS7III.SIDE[sideName].unit + '_Effect' + slot + ']';
};

NS7III.unitGroup = function(sideName) {
    return '[EffectRack1_EffectUnit' + NS7III.SIDE[sideName].unit + ']';
};

NS7III.fxButton = function(channel, control, value, status) {
    if (!NS7III.isPress(value, status)) { return; }
    var s = NS7III.sideOfControl(control, 'fx');
    if (!s) { return; }
    var slot = NS7III.SIDE[s].fxNotes.indexOf(control) + 1;
    var sg = NS7III.slotGroup(s, slot);
    NS7III.fxActiveSlot[s] = slot;                // el encoder BEAT cambia el modelo de este slot
    if (NS7III.sideShift(s)) {
        NS7III.trigger(sg, 'next_effect');
    } else {
        NS7III.toggle(sg, 'enabled');
    }
};

NS7III.fxEncoder = function(channel, control, value) {
    var e = NS7III.ENC[control];
    if (!e) { return; }
    var s = e[0], slot = e[1], delta = NS7III.relative(value);
    if (slot === 0) { NS7III.beatEncoder(s, delta); return; }
    // Knob: % del parámetro del efecto de su slot (arco de la pantalla y aro de LEDs).
    var grp = NS7III.slotGroup(s, slot);
    engine.setParameter(grp, 'meta', NS7III.clamp(engine.getParameter(grp, 'meta') + delta / 64, 0, 1));
};

// Encoder BEAT: cambia el modelo de efecto del slot activo (el último FX encendido con su botón),
// uno cada FX_SELECT_STEPS pasos.
NS7III.fxSelect = function(sideName, delta) {
    var slot = NS7III.fxActiveSlot[sideName] || 1;
    var grp = NS7III.slotGroup(sideName, slot);
    NS7III.fxSelectAcc[sideName] = (NS7III.fxSelectAcc[sideName] || 0) + delta;
    while (Math.abs(NS7III.fxSelectAcc[sideName]) >= NS7III.FX_SELECT_STEPS) {
        var fwd = NS7III.fxSelectAcc[sideName] > 0;
        NS7III.trigger(grp, fwd ? 'next_effect' : 'prev_effect');
        NS7III.fxSelectAcc[sideName] += fwd ? -NS7III.FX_SELECT_STEPS : NS7III.FX_SELECT_STEPS;
    }
};
NS7III.fxActiveSlot = {left: 1, right: 1};

NS7III.anyFxEnabled = function(sideName) {
    for (var slot = 1; slot <= 3; slot++) {
        if (engine.getValue(NS7III.slotGroup(sideName, slot), 'enabled')) { return true; }
    }
    return false;
};

// Encoder BEAT sin FX prendidos: tamaño del loop (…1/4, 1/2, 1, 2, 4…), a la derecha más grande.
NS7III.loopSizeStep = function(sideName, group, delta) {
    var k = 'loop_' + sideName;
    NS7III.fxSelectAcc[k] = (NS7III.fxSelectAcc[k] || 0) + delta;
    while (Math.abs(NS7III.fxSelectAcc[k]) >= NS7III.FX_SELECT_STEPS) {
        var up = NS7III.fxSelectAcc[k] > 0;
        NS7III.trigger(group, up ? 'loop_double' : 'loop_halve');
        NS7III.fxSelectAcc[k] += up ? -NS7III.FX_SELECT_STEPS : NS7III.FX_SELECT_STEPS;
    }
};

NS7III.FX_SELECT_STEPS = 2;                     // pasos del encoder por cada cambio de efecto
NS7III.FX_WET = 0.5;                            // wet (mix) fijo de todas las unidades de efectos
NS7III.fxSelectAcc = {};

// Wet de las 4 unidades siempre en 50 %: al iniciar y cada vez que algo lo cambie.
NS7III.keepFxWet = function() {
    for (var u = 1; u <= 4; u++) {
        (function(g) {
            engine.setParameter(g, 'mix', NS7III.FX_WET);
            NS7III.connect(g, 'mix', function(v) {
                if (Math.abs(v - NS7III.FX_WET) > 0.001) { engine.setParameter(g, 'mix', NS7III.FX_WET); }
            });
        })('[EffectRack1_EffectUnit' + u + ']');
    }
};

NS7III.fxEncTouch = function(channel, control, value, status) {
    var e = NS7III.ENC_TOUCH[control];
    if (!e || NS7III.touchMode !== 1) { return; }      // VDJ: sólo con $fxeqtouch activo
    engine.setValue(NS7III.slotGroup(e[0], e[1]), 'enabled', NS7III.isPress(value, status) ? 1 : 0);
};

NS7III.beatEncoder = function(sideName, delta) {
    var g = '[Channel' + NS7III.side[sideName] + ']';
    delta = -delta;                               // a la derecha = adelante (el encoder viene invertido)
    if (NS7III.sideShift(sideName)) {             // SHIFT: adelantar/atrasar el tema (beatjump)
        NS7III.trigger(g, delta > 0 ? 'beatjump_forward' : 'beatjump_backward');
    } else if (NS7III.anyFxEnabled(sideName)) {   // modelo de efecto del slot activo
        NS7III.fxSelect(sideName, delta);
    } else {                                      // sin FX prendidos: tamaño del loop
        NS7III.loopSizeStep(sideName, g, delta);
    }
};

NS7III.beatPush = function(channel, control, value, status) {
    if (!NS7III.isPress(value, status)) { return; }
    var s = control === 0x35 ? 'left' : 'right';
    if (NS7III.sideShift(s)) { NS7III.trigger('[Channel' + NS7III.side[s] + ']', 'reset_key'); }
};

NS7III.beatButton = function(channel, control, value, status) {
    if (!NS7III.isPress(value, status)) { return; }
    var s = NS7III.sideOfControl(control, 'beat');
    if (s) { NS7III.toggle('[Channel' + NS7III.side[s] + ']', 'quantize'); NS7III.sideLeds(s); }
};

NS7III.masterFx = function(channel, control, value, status) {
    if (!NS7III.isPress(value, status)) { return; }
    var s = control === 0x2B ? 'left' : 'right';
    NS7III.toggle(NS7III.unitGroup(s), 'group_[Master]_enable');
};

// FX_A / FX_B por canal del mixer: asignan el canal a la unidad 1/2 (SHIFT: 3/4). VDJ effect_clone.
NS7III.FX_ASSIGN = {0x23: [1, 1], 0x24: [1, 2], 0x25: [2, 1], 0x26: [2, 2],
                    0x27: [3, 1], 0x28: [3, 2], 0x29: [4, 1], 0x2A: [4, 2]};

NS7III.fxAssign = function(channel, control, value, status) {
    if (!NS7III.isPress(value, status)) { return; }
    var a = NS7III.FX_ASSIGN[control];
    if (!a) { return; }
    var unit = a[1] + (NS7III.anyShift() ? 2 : 0);
    NS7III.toggle('[EffectRack1_EffectUnit' + unit + ']', 'group_[Channel' + a[0] + ']_enable');
};

NS7III.sideLeds = function(sideName) {
    var def = NS7III.SIDE[sideName];
    for (var slot = 1; slot <= 3; slot++) {
        var sg = NS7III.slotGroup(sideName, slot);
        midi.sendShortMsg(0x90, def.fxNotes[slot - 1], engine.getValue(sg, 'enabled') ? NS7III.LED_ON : NS7III.LED_DIM);
        // aro del encoder: cantidad de segmentos encendidos (0..11), como VirtualDJ
        midi.sendShortMsg(0xB0, def.ringCC[slot - 1],
            Math.round(engine.getParameter(sg, 'meta') * NS7III.RING_SEGMENTS));
    }
    var q = engine.getValue('[Channel' + NS7III.side[sideName] + ']', 'quantize');
    midi.sendShortMsg(0x90, def.beatNote, q ? NS7III.LED_ON : NS7III.LED_DIM);
    midi.sendShortMsg(0x90, def.masterFxNote,
        engine.getValue(NS7III.unitGroup(sideName), 'group_[Master]_enable') ? NS7III.LED_ON : NS7III.LED_OFF);
    NS7III.sendFxNames(sideName);
};

/* ------------------------------------------------------------------------------------------
 * Mixer
 * ---------------------------------------------------------------------------------------- */
// CF_A / CF_B (interruptores de 3 posiciones) por canal del mixer.
NS7III.CF = {0x1B: [1, 0], 0x1C: [1, 2], 0x1D: [2, 0], 0x1E: [2, 2],
             0x1F: [3, 0], 0x20: [3, 2], 0x21: [4, 0], 0x22: [4, 2]};

NS7III.cfAssign = function(channel, control, value, status) {
    var a = NS7III.CF[control];
    if (!a) { return; }
    var g = '[Channel' + a[0] + ']';
    if (NS7III.isPress(value, status)) {
        engine.setValue(g, 'orientation', a[1]);
    } else if (engine.getValue(g, 'orientation') === a[1]) {
        engine.setValue(g, 'orientation', 1);        // posición central
    }
};

NS7III.xfaderCurve = function(channel, control, value) {
    engine.setParameter('[Mixer Profile]', 'xFaderCurve', value / 127);
};

// Touch de EQ: modo TOUCH 2 = kill mientras se toca (VDJ eq_kill_*).
NS7III.EQ_TOUCH = {0x58: [1, 1], 0x59: [1, 2], 0x5A: [1, 3], 0x5C: [2, 1], 0x5D: [2, 2], 0x5E: [2, 3],
                   0x54: [3, 1], 0x55: [3, 2], 0x56: [3, 3], 0x60: [4, 1], 0x61: [4, 2], 0x62: [4, 3]};

NS7III.eqTouch = function(channel, control, value, status) {
    var a = NS7III.EQ_TOUCH[control];
    if (!a || NS7III.touchMode !== 2) { return; }
    engine.setValue('[EqualizerRack1_[Channel' + a[0] + ']_Effect1]', 'button_parameter' + a[1],
        NS7III.isPress(value, status) ? 1 : 0);
};

NS7III.touchModeButton = function(channel, control, value, status) {
    if (!NS7III.isPress(value, status)) { return; }
    var want = NS7III.anyShift() ? 2 : 1;
    NS7III.touchMode = NS7III.touchMode === want ? 0 : want;
    midi.sendShortMsg(0x90, NS7III.NOTE_TOUCH_MODE, NS7III.touchMode ? NS7III.LED_ON : NS7III.LED_OFF);
};

NS7III.filterRollButton = function(channel, control, value, status) {
    if (!NS7III.isPress(value, status)) { return; }
    var want = NS7III.anyShift() ? 2 : 1;
    NS7III.filterRollMode = NS7III.filterRollMode === want ? 0 : want;
    midi.sendShortMsg(0x90, NS7III.NOTE_FILTERROLL, NS7III.filterRollMode ? NS7III.LED_ON : NS7III.LED_OFF);
};

NS7III.FILTER_TOUCH = {0x70: 1, 0x71: 2, 0x6F: 3, 0x72: 4};

NS7III.filterTouch = function(channel, control, value, status) {
    var d = NS7III.FILTER_TOUCH[control];
    if (!d) { return; }
    var st = NS7III.decks[d], press = NS7III.isPress(value, status);
    st.filterTouched = press;
    if (NS7III.filterRollMode === 2) {
        engine.setValue('[QuickEffectRack1_' + st.group + ']', 'enabled', press ? 1 : 0);
    } else if (NS7III.filterRollMode === 1) {
        if (press) { NS7III.filterRoll(d); } else { NS7III.releaseRoll(st); }
    }
};

// Filter-roll (VDJ): con el filtro tocado, cuanto más lejos del centro, más corto el roll.
NS7III.filterRoll = function(d) {
    var st = NS7III.decks[d];
    if (NS7III.filterRollMode !== 1 || !st.filterTouched) { return; }
    var p = engine.getParameter('[QuickEffectRack1_' + st.group + ']', 'super1');
    var dist = Math.abs(p - 0.5);
    var size = dist > 0.45 ? 0.0625 : dist > 0.30 ? 0.125 : dist > 0.20 ? 0.25 : dist > 0.05 ? 0.5 : 0;
    var key = size ? 'beatlooproll_' + NS7III.sizeKey(size) + '_activate' : null;
    if (key === st.rollKey) { return; }
    NS7III.releaseRoll(st);
    if (key) { engine.setValue(st.group, key, 1); st.rollKey = key; st.rollSize = size; }
    NS7III.sendBeatSize();
};

/* ------------------------------------------------------------------------------------------
 * Browser sincronizado con la pantalla central (lo maneja el bridge, ver PROTOCOL.md BF 40..43).
 * El bridge manda la posición ABSOLUTA; acá se reposiciona Mixxx con controles [Playlist] que
 * funcionan aunque la ventana de Mixxx no tenga el foco: subir al tope y bajar N filas.
 * La lista se ordena por ubicación (sort_column 25, ascendente), igual que en la pantalla.
 * ---------------------------------------------------------------------------------------- */
NS7III.SORT_LOCATION = 25;
NS7III.SIDEBAR_SETTLE_MS = 80;       // tiempo para que Mixxx muestre la vista nueva antes de mover la lista
NS7III.br = {sidebar: -1, pendingSidebar: 0, hi: 0, lo: 0, timer: 0, track: -1};

NS7III.browserSync = function(channel, control, value) {
    var br = NS7III.br;
    if (control === 0x40) { br.pendingSidebar = value; return; }
    if (control === 0x41) { br.hi = value; return; }
    if (control === 0x42) { br.lo = value; return; }
    // Mixxx mueve [Playlist] fila por fila: para ir al tope se usa la cantidad real (no 100000).
    if (control === 0x44) { br.totalHi = value; return; }
    if (control === 0x45) { br.total = ((br.totalHi || 0) << 7) | value; return; }
    if (control === 0x46) { br.sidebarRows = value; return; }
    if (control === 0x47) { br.fixDelta = value - 64; return; }
    if (value >= 0x20) {
        // Corrección del bridge: Mixxx cargó otro tema → su selección estaba corrida fixDelta filas.
        // Se mueve esa diferencia (br.track no cambia: la fila pedida es la misma) y se recarga.
        var fixGroup = '[Channel' + (value - 0x20) + ']';
        console.log('NS7III browser: corrección ' + br.fixDelta + ' filas y recarga ' + fixGroup);
        NS7III.browserStep(br.fixDelta || 0);
        br.fixDelta = 0;
        NS7III.loadWhenReady(fixGroup, 0);
        return;
    }
    var track = (br.hi << 7) | br.lo;
    var toggle = value === 2;
    var loadDeck = value >= 0x10 ? value - 0x10 : 0;
    if (br.pendingSidebar === br.sidebar && !toggle) {
        // Misma vista: movimiento relativo. La selección de Mixxx queda calibrada por las correcciones
        // del bridge (no se reposiciona en absoluto, que es lo que no es exacto).
        NS7III.browserSelectTrack(track);
        if (loadDeck) {
            console.log('NS7III browser: fila ' + track + ' LOAD deck ' + loadDeck);
            engine.beginTimer(40, function() {
                engine.setValue('[Channel' + loadDeck + ']', 'LoadSelectedTrack', 1);
            }, true);
        }
        return;
    }
    if (loadDeck) { br.loadDeck = loadDeck; }               // vista nueva: se carga tras reposicionar
    br.sidebar = br.pendingSidebar;
    br.track = -1;                                                  // vista nueva: reposicionar desde el tope
    engine.setValue('[Library]', 'clear_search', 1);
    // Barra lateral: pasos exactos de una fila (SelectPlaylist con valores grandes no es exacto).
    var i;
    for (i = (br.sidebarRows || 32) + 1; i > 0; i--) { engine.setValue('[Playlist]', 'SelectPrevPlaylist', 1); }
    for (i = br.sidebar; i > 0; i--) { engine.setValue('[Playlist]', 'SelectNextPlaylist', 1); }
    if (toggle) { engine.setValue('[Playlist]', 'ToggleSelectedSidebarItem', 1); }
    if (br.timer) { engine.stopTimer(br.timer); }
    br.timer = engine.beginTimer(NS7III.SIDEBAR_SETTLE_MS, function() {
        br.timer = 0;
        // El bridge ordena igual que Mixxx. Si el orden de esta vista cambió, la fila calculada ya no
        // vale: no se carga; el bridge reordena y repite el LOAD con la fila correcta.
        if (NS7III.sendSort() && br.loadDeck) {
            console.log('NS7III browser: orden cambió, LOAD diferido');
            br.loadDeck = 0;
            return;
        }
        NS7III.browserSelectTrack(track);
        console.log('NS7III browser: vista ' + br.sidebar + ' fila ' + track + ' total ' + br.total
                    + (br.loadDeck ? ' LOAD deck ' + br.loadDeck : ''));
        if (br.loadDeck) {
            var g = '[Channel' + br.loadDeck + ']';
            br.loadDeck = 0;
            engine.beginTimer(40, function() { engine.setValue(g, 'LoadSelectedTrack', 1); }, true);
        }
    }, true);
};

// Mixxx ignora LoadSelectedTrack mientras el deck todavía está cargando el tema anterior: se espera
// a track_loaded (y un margen para que termine de leerlo) antes de recargar. Máximo ~3 s.
NS7III.loadWhenReady = function(group, tries) {
    engine.beginTimer(tries ? 100 : 250, function() {
        if (!engine.getValue(group, 'track_loaded') && tries < 30) {
            NS7III.loadWhenReady(group, tries + 1);
            return;
        }
        console.log('NS7III browser: recarga ' + group + ' (espera ' + tries + ')');
        engine.setValue(group, 'LoadSelectedTrack', 1);
    }, true);
};

NS7III.browserSort = function() {
    if (engine.getValue('[Library]', 'sort_column') !== NS7III.SORT_LOCATION) {
        engine.setValue('[Library]', 'sort_column_toggle', NS7III.SORT_LOCATION);   // nueva columna → ascendente
    }
    if (engine.getValue('[Library]', 'sort_order') !== 0) {
        engine.setValue('[Library]', 'sort_column_toggle', NS7III.SORT_LOCATION);   // misma columna → invierte
    }
};

// SelectTrackKnob NO mueve exactamente N filas con valores grandes (medido: -17 movió 8). Se usan
// SelectPrevTrack/SelectNextTrack, que mueven exactamente una fila por llamada.
NS7III.browserStep = function(n) {
    var key = n < 0 ? 'SelectPrevTrack' : 'SelectNextTrack';
    for (var i = Math.abs(n); i > 0; i--) { engine.setValue('[Playlist]', key, 1); }
};

NS7III.browserSelectTrack = function(track) {
    var br = NS7III.br;
    if (br.track >= 0 && br.track !== track) {
        NS7III.browserStep(track - br.track);                   // misma vista: sólo la diferencia
    } else if (br.track < 0) {
        NS7III.browserStep(-((br.total || 0) + 1));             // vista nueva: a la primera fila
        NS7III.browserStep(track);
    }
    br.track = track;
};

// Handlers anteriores (ya no reciben SCROLL/PUSH/BACK/FWD/FILES/CRATES: los consume el bridge).
NS7III.scroll = function(channel, control, value) {
    var delta = NS7III.relative(value);
    engine.setValue('[Library]', 'MoveVertical', NS7III.anyShift() ? delta * 10 : delta);
};

NS7III.scrollPush = function(channel, control, value, status) {
    if (!NS7III.isPress(value, status)) { return; }
    if (NS7III.anyShift()) { NS7III.toggle('[Skin]', 'show_maximized_library'); } else {
        NS7III.trigger('[Library]', 'GoToItem');
    }
};

NS7III.cratesButton = function(channel, control, value, status) {
    if (NS7III.isPress(value, status)) { engine.setValue('[Library]', 'focused_widget', 2); }   // árbol
};

NS7III.filesButton = function(channel, control, value, status) {
    if (NS7III.isPress(value, status)) { engine.setValue('[Library]', 'focused_widget', 3); }   // lista
};

NS7III.panelView = function(channel, control, value, status) {
    if (NS7III.isPress(value, status)) { NS7III.toggle('[Skin]', 'show_maximized_library'); }
};

NS7III.loadPrepare = function(channel, control, value, status) {
    if (!NS7III.isPress(value, status)) { return; }
    NS7III.trigger('[Library]', NS7III.anyShift() ? 'AutoDjAddTop' : 'AutoDjAddBottom');
};

/* ------------------------------------------------------------------------------------------
 * Salidas por conexión
 * ---------------------------------------------------------------------------------------- */
NS7III.connectDeck = function(d) {
    var g = NS7III.decks[d].group;
    var redrawPads = function() { NS7III.padLeds(d); };
    var track = function() { NS7III.scheduleTrack(d); };
    var tempo = function() { NS7III.sendTempo(d); NS7III.pitchLeds(d); };
    var loop = function() { NS7III.sendLoop(d); NS7III.padLeds(d); };

    NS7III.connect(g, 'play', NS7III.onPlayChanged);
    // Traza temporal: cada cambio real de pfl, para ver si una sola pulsación
    // del botón de auriculares produce uno o dos cambios de estado.
    NS7III.connect(g, 'pfl', function(v) {
        print('NS7III: pfl ' + g + ' = ' + v + ' @' + Date.now());
    });
    NS7III.connect(g, 'track_loaded', track);
    NS7III.connect(g, 'duration', track);
    NS7III.connect(g, 'file_bpm', track);
    NS7III.connect(g, 'bpm', tempo);
    NS7III.connect(g, 'rate', tempo);
    NS7III.connect(g, 'rateRange', tempo);
    NS7III.connect(g, 'loop_enabled', loop);
    NS7III.connect(g, 'loop_start_position', loop);
    NS7III.connect(g, 'loop_end_position', loop);
    NS7III.connect(g, 'slip_enabled', function() { NS7III.slipLed(d); });
    NS7III.connect(g, 'quantize', function() { NS7III.sideLeds((d % 2) ? 'left' : 'right'); });
    NS7III.connect(g, 'playposition', function(v) {
        // LED_STRIPSEARCH: cantidad de LEDs encendidos (0..15), como VirtualDJ; sólo al cambiar.
        var n = Math.floor(NS7III.clamp(v, 0, 1) * NS7III.STRIP_LEDS + 0.5);
        if (n !== NS7III.decks[d].stripLeds) {
            NS7III.decks[d].stripLeds = n;
            midi.sendShortMsg(0xB0 + d, 0x6E, n);
        }
    });
    NS7III.connect(g, 'vu_meter', function(v) {
        midi.sendShortMsg(0xB0, NS7III.CC_VU[d], Math.round(v * NS7III.VU_STEPS));
    });
    for (var i = 1; i <= 16; i++) {
        (function(n) {
            var hc = function() { if (n <= 8) { NS7III.sendHotcue(d, n); } NS7III.padLeds(d); };
            // Color fijo por número de cue (Mixxx, pads y pantalla iguales).
            NS7III.connect(g, 'hotcue_' + n + '_status', function(v) {
                var want = NS7III.CUE_COLORS[(n - 1) % NS7III.CUE_COLORS.length];
                if (v > 0 && engine.getValue(g, 'hotcue_' + n + '_color') !== want) {
                    engine.setValue(g, 'hotcue_' + n + '_color', want);   // dispara hc por _color
                }
                hc();
            });
            NS7III.connect(g, 'hotcue_' + n + '_color', hc);
            if (n <= 8) { NS7III.connect(g, 'hotcue_' + n + '_position', hc); }
        })(i);
    }
    for (var k = 0; k < NS7III.LOOP_SIZES.length; k++) {
        NS7III.connect(g, 'beatloop_' + NS7III.sizeKey(NS7III.LOOP_SIZES[k]) + '_enabled', redrawPads);
    }
    NS7III.connectPlayer(d);
};

NS7III.connectGlobal = function() {
    NS7III.connect('[Main]', 'vu_meter_left', function(v) {
        midi.sendShortMsg(0xB0, NS7III.CC_MASTER_VU[0], Math.round(v * NS7III.VU_STEPS));
    });
    NS7III.connect('[Main]', 'vu_meter_right', function(v) {
        midi.sendShortMsg(0xB0, NS7III.CC_MASTER_VU[1], Math.round(v * NS7III.VU_STEPS));
    });
    ['left', 'right'].forEach(function(s) {
        var u = NS7III.unitGroup(s);
        var redraw = function() { NS7III.sideLeds(s); };
        NS7III.connect(u, 'group_[Master]_enable', redraw);
        for (var slot = 1; slot <= 3; slot++) {
            NS7III.connect(NS7III.slotGroup(s, slot), 'enabled', redraw);
            NS7III.connect(NS7III.slotGroup(s, slot), 'meta', redraw);
        }
    });
    for (var d = 1; d <= 4; d++) {
        (function(n) {
            NS7III.connect('[QuickEffectRack1_[Channel' + n + ']]', 'super1', function() { NS7III.filterRoll(n); });
        })(d);
    }
    var samplers = Math.min(NS7III.samplerCount(), 16);
    for (var s = 1; s <= samplers; s++) {
        NS7III.connect('[Sampler' + s + ']', 'play', NS7III.allPadLeds);
        NS7III.connect('[Sampler' + s + ']', 'track_loaded', NS7III.allPadLeds);
    }
};

/* ------------------------------------------------------------------------------------------
 * init / shutdown
 * ---------------------------------------------------------------------------------------- */
NS7III.init = function(id, debugging) {
    NS7III.connections = [];
    NS7III.timers = [];
    NS7III.pendingConnections = [];
    NS7III.retryTimer = 0;
    for (var d = 1; d <= 4; d++) {
        NS7III.decks[d] = NS7III.newDeck(d);
        engine.softTakeover(NS7III.decks[d].group, 'rate', true);
    }
    NS7III.sendCmd(NS7III.CMD.CONNECTED, []);
    NS7III.sentBeats = {left: -1, right: -1};
    NS7III.lastSortCol = NS7III.lastSortOrd = -1;
    NS7III.forcedSort = null;
    NS7III.applySettings();                                     // Preferencias → Controladores
    NS7III.sendSort();                                          // orden actual de la lista de Mixxx
    NS7III.connect('[Library]', 'sort_column', function() { NS7III.enforceSort(); NS7III.sendSort(); });
    NS7III.connect('[Library]', 'sort_order', function() { NS7III.enforceSort(); NS7III.sendSort(); });

    for (d = 1; d <= 4; d++) {
        NS7III.motor(d, false);
        NS7III.decks[d].state = 'idle';
        midi.sendShortMsg(0xB0 + d, 0x46, 0x00);           // sin reversa
        NS7III.connectDeck(d);
    }
    NS7III.connectGlobal();

    // LEDs estáticos y tipos de aro de encoder (VDJ LED_VOLTYPE_* = true).
    ['left', 'right'].forEach(function(s) {
        NS7III.SIDE[s].voltype.forEach(function(n) { midi.sendShortMsg(0x90, n, 0x01); });
    });
    NS7III.STATIC_LEDS.forEach(function(n) { midi.sendShortMsg(0x90, n, NS7III.LED_DIM); });
    midi.sendShortMsg(0x90, NS7III.NOTE_TOUCH_MODE, NS7III.LED_OFF);
    midi.sendShortMsg(0x90, NS7III.NOTE_FILTERROLL, NS7III.LED_OFF);
    NS7III.deckLeds();
    NS7III.sideLeds('left');
    NS7III.sideLeds('right');
    NS7III.keepFxWet();

    for (d = 1; d <= 4; d++) {
        midi.sendShortMsg(0x90 + d, 0x45, NS7III.LED_DIM);   // PAD_PARAMETER-
        midi.sendShortMsg(0x90 + d, 0x46, NS7III.LED_DIM);   // PAD_PARAMETER+
        midi.sendShortMsg(0x90 + d, 0x35, NS7III.LED_OFF);   // SHIFT
        NS7III.modeLeds(d);
        NS7III.padLeds(d);
        NS7III.slipLed(d);
        NS7III.pitchLeds(d);
        NS7III.sendTrack(d);
        NS7III.sendTempo(d);
        NS7III.sendPosition(d, true);
        NS7III.sendTexts(d);
    }
    // Arrancar siempre con los auriculares sin monitorear ningún canal. pfl se
    // guarda entre sesiones, así que al abrir Mixxx ya venía en 1: además de
    // escucharse un deck sin haberlo pedido, el primer toque del botón lo
    // APAGABA, que es lo que se percibía como "hay que apretar dos veces".
    // Al final de init() para que ya estén hechas las conexiones de arriba.
    // Lo mismo con los faders de canal: Mixxx los recuerda, así que al abrir
    // puede sonar un deck de entrada con el fader físico abajo. Arrancar en 0
    // y con soft takeover: el canal no suena hasta que el fader pasa por el
    // valor actual, así no hay salto de volumen al moverlo por primera vez.
    for (d = 1; d <= 4; d++) {
        var g0 = NS7III.decks[d].group;
        if (engine.getValue(g0, 'pfl')) {
            engine.setValue(g0, 'pfl', 0);
        }
        engine.setValue(g0, 'volume', 0);
        engine.softTakeover(g0, 'volume', true);
    }
    NS7III.timers.push(engine.beginTimer(NS7III.POS_TIMER_MS, NS7III.positionTick));
    print('NS7III Bridge: init (getPlayer ' + (NS7III.hasPlayerApi() ? 'sí' : 'no') + ')');
};

NS7III.shutdown = function() {
    NS7III.timers.forEach(function(t) { if (t) { engine.stopTimer(t); } });
    NS7III.timers = [];
    NS7III.retryTimer = 0;
    NS7III.pendingConnections = [];
    NS7III.connections.forEach(function(c) { if (c && c.disconnect) { c.disconnect(); } });
    NS7III.connections = [];
    for (var d = 1; d <= 4; d++) {
        if (NS7III.decks[d] && NS7III.decks[d].state === 'scratch') { engine.scratchDisable(d, false); }
        midi.sendShortMsg(0xB0 + d, 0x42, 0x7F);             // motor OFF
        for (var i = 0; i < 8; i++) { midi.sendShortMsg(0x90 + d, NS7III.PAD_NOTE + i, 0x00); }
        for (var m in NS7III.MODES) { midi.sendShortMsg(0x90 + d, NS7III.MODES[m].note, 0x00); }
        [0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x3D, 0x3E, 0x3F, 0x40, 0x44, 0x45, 0x46]
            .forEach(function(n) { midi.sendShortMsg(0x90 + d, n, 0x00); });
    }
    for (var n = 0x01; n <= 0x2C; n++) { midi.sendShortMsg(0x90, n, 0x00); }
    NS7III.sendCmd(NS7III.CMD.DISCONNECTED, []);
};
