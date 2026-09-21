/**
 * AI の思考を裏で走らせる Worker。
 * 探索中もタップやスクロールが固まらないように、重い処理はここに閉じ込める。
 */
/* global importScripts, ReversiEngine */
importScripts('engine.js');

self.addEventListener('message', function (event) {
  var msg = event.data || {};
  var board = Int8Array.from(msg.board || []);

  try {
    if (msg.type === 'move') {
      var picked = ReversiEngine.chooseMove(board, msg.player, msg.level);
      self.postMessage({ type: 'move', id: msg.id, result: picked });
    } else if (msg.type === 'analyze') {
      var report = ReversiEngine.analyze(board, msg.player, msg.options);
      self.postMessage({ type: 'analyze', id: msg.id, result: report });
    } else if (msg.type === 'best') {
      var best = ReversiEngine.bestMove(board, msg.player, msg.options);
      self.postMessage({ type: 'best', id: msg.id, result: best });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: msg.id, message: String(e && e.message ? e.message : e) });
  }
});
