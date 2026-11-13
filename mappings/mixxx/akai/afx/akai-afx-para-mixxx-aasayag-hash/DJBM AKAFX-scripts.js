// Generado por DJ Backup Manager desde AKAFX: lo que el XML de Mixxx no puede expresar
// (vúmetros por nivel, jogs con scratch, encoders invertidos y capa de shift).
var DJBM_AKAFX = {};
DJBM_AKAFX.connections = [];
DJBM_AKAFX.init = function () {
};
DJBM_AKAFX.shutdown = function () {
    DJBM_AKAFX.connections.forEach(function (c) { c.disconnect(); });
};
DJBM_AKAFX.deckOf = function (group) { return parseInt(group.replace(/\D/g, ""), 10); };
DJBM_AKAFX.jogTouch = function (channel, control, value, status, group) {
    var deck = DJBM_AKAFX.deckOf(group);
    if (value > 0 && (status & 0xF0) !== 0x80) { engine.scratchEnable(deck, 512, 33 + 1 / 3, 1 / 8, (1 / 8) / 32); }
    else { engine.scratchDisable(deck); }
};
DJBM_AKAFX.jogMove = function (group, delta) {
    var deck = DJBM_AKAFX.deckOf(group);
    if (engine.isScratching(deck)) { engine.scratchTick(deck, delta); }
    else { engine.setValue(group, "jog", delta / 4); }
};
// Capa de shift: mientras el botón shift está apretado, los controles de abajo hacen su segunda función
DJBM_AKAFX.shifted = false;
DJBM_AKAFX.pressed = function (value, status) { return value > 0 && (status & 0xF0) !== 0x80; };
DJBM_AKAFX.shift = function (channel, control, value, status, group) { DJBM_AKAFX.shifted = DJBM_AKAFX.pressed(value, status); };
DJBM_AKAFX.push = function (group, key, value, status) { engine.setValue(group, key, DJBM_AKAFX.pressed(value, status) ? 1 : 0); };
DJBM_AKAFX.toggle = function (group, key, value, status) {
    if (DJBM_AKAFX.pressed(value, status)) { engine.setValue(group, key, engine.getValue(group, key) ? 0 : 1); }
};
DJBM_AKAFX.turn = function (group, key, steps) { engine.setParameter(group, key, engine.getParameter(group, key) + steps / 127); };
DJBM_AKAFX.fader = function (group, key, value, invert) {
    if (invert) { value = 127 - value; }
    engine.setParameter(group, key, value > 64 ? (value - 1) / 126 : value / 128);
};
DJBM_AKAFX.m9454 = function (channel, control, value, status, group) {
    if (DJBM_AKAFX.shifted) { DJBM_AKAFX.jogTouch(channel, control, value, status, "[Channel4]"); }
    else {  }
};
