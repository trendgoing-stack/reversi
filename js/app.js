/**
 * リバーシの画面まわり。
 * トップ画面（段位選択・勝敗記録）と対局画面を切り替えながら、
 * 盤面の描画、着手・巻き戻し、アシスト、解説、勝敗記録を扱う。
 */
/* global ReversiEngine */
(function () {
  'use strict';

  var E = ReversiEngine;
  var BLACK = E.BLACK;
  var WHITE = E.WHITE;

  var SETTINGS_KEY = 'reversi.settings.v1';
  var RECORDS_KEY = 'reversi.records.v1';

  /* ------------------------------------------------------------------ *
   * AI 呼び出し（Worker が使えなければメインスレッドで代替）
   * ------------------------------------------------------------------ */

  var ai = (function () {
    var worker = null;
    var seq = 0;
    var pending = {};

    function fallback(type, payload, cb) {
      setTimeout(function () {
        var board = Int8Array.from(payload.board);
        if (type === 'move') cb(E.chooseMove(board, payload.player, payload.level));
        else if (type === 'analyze') cb(E.analyze(board, payload.player, payload.options));
        else cb(E.bestMove(board, payload.player, payload.options));
      }, 30);
    }

    try {
      worker = new Worker('js/worker.js');
      worker.onmessage = function (event) {
        var data = event.data || {};
        var cb = pending[data.id];
        delete pending[data.id];
        if (cb) cb(data.type === 'error' ? null : data.result);
      };
      worker.onerror = function () {
        worker = null; // 以後はメインスレッドで計算する
      };
    } catch (e) {
      worker = null;
    }

    return {
      call: function (type, payload, cb) {
        if (!worker) return fallback(type, payload, cb);
        var id = ++seq;
        pending[id] = cb;
        var msg = { type: type, id: id };
        for (var key in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, key)) msg[key] = payload[key];
        }
        try {
          worker.postMessage(msg);
        } catch (err) {
          delete pending[id];
          worker = null;
          fallback(type, payload, cb);
        }
      }
    };
  })();

  /* ------------------------------------------------------------------ *
   * 状態
   * ------------------------------------------------------------------ */

  var state = {
    positions: [],
    index: 0,
    playerColor: BLACK,
    level: 1, // 初回は初段から。トップ画面でいつでも変えられる
    hints: true,
    coords: false,
    assistMode: false, // 入れている間は毎手ずっと最善手を出す（対局を始めるたびにOFF）
    assistMove: -1,
    assistToken: -1,
    explainMode: false, // 入れている間は毎手ずっと解説を出し直す
    explainToken: -1,
    candidates: [],
    thinking: false,
    token: 0,
    started: false,
    recorded: false
  };

  var el = {};
  var cells = [];

  function $(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    [
      'homeScreen', 'gameScreen', 'levelList', 'colorChoice', 'btnStart', 'btnResume',
      'homeRecords', 'btnHome', 'levelBadge', 'colorBadge', 'updateBanner', 'appVersion',
      'board', 'axisX', 'axisY', 'boardOuter',
      'countBlack', 'countWhite', 'labelBlack', 'labelWhite', 'scoreBlack', 'scoreWhite',
      'turnText', 'message', 'btnUndo', 'btnRedo', 'btnAssist', 'btnExplain', 'btnCoords',
      'btnHints', 'btnNew', 'btnRecords', 'explainPanel', 'explainBody', 'recordsPanel',
      'recordsBody', 'moveList', 'toast', 'resultOverlay', 'resultTitle', 'resultScore',
      'resultDetail', 'resultRecord', 'btnResultNew', 'btnResultReview', 'btnResultHome'
    ].forEach(function (id) {
      el[id] = $(id);
    });
  }

  /* ------------------------------------------------------------------ *
   * 設定と記録の保存
   * ------------------------------------------------------------------ */

  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (typeof saved.level === 'number' && E.LEVELS[saved.level]) state.level = saved.level;
      if (saved.playerColor === BLACK || saved.playerColor === WHITE) {
        state.playerColor = saved.playerColor;
      }
      if (typeof saved.hints === 'boolean') state.hints = saved.hints;
      if (typeof saved.coords === 'boolean') state.coords = saved.coords;
    } catch (e) {
      /* 保存領域が使えない環境では既定値のまま */
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        level: state.level,
        playerColor: state.playerColor,
        hints: state.hints,
        coords: state.coords
      }));
    } catch (e) { /* 失敗しても対局は続けられる */ }
  }

  function loadRecords() {
    try {
      var raw = localStorage.getItem(RECORDS_KEY);
      if (!raw) return [];
      var data = JSON.parse(raw);
      return Array.isArray(data.games) ? data.games : [];
    } catch (e) {
      return [];
    }
  }

  function saveRecords(games) {
    try {
      localStorage.setItem(RECORDS_KEY, JSON.stringify({ version: 1, games: games }));
    } catch (e) { /* 保存できなくても続行 */ }
  }

  function addRecord(entry) {
    var games = loadRecords();
    games.push(entry);
    if (games.length > 500) games = games.slice(games.length - 500);
    saveRecords(games);
  }

  /** 段位ごとに勝敗を集計する */
  function summarize(games) {
    var byLevel = {};
    var totals = { win: 0, lose: 0, draw: 0 };
    games.forEach(function (g) {
      var key = typeof g.levelIndex === 'number' ? g.levelIndex : 0;
      if (!byLevel[key]) byLevel[key] = { win: 0, lose: 0, draw: 0, name: g.level || '' };
      if (g.result === 'win' || g.result === 'lose' || g.result === 'draw') {
        byLevel[key][g.result]++;
        totals[g.result]++;
      }
    });
    return { byLevel: byLevel, totals: totals };
  }

  /* ------------------------------------------------------------------ *
   * 画面の切り替え
   * ------------------------------------------------------------------ */

  function gameInProgress() {
    return state.started && state.positions.length > 1 && current().turn !== 0;
  }

  function showHome() {
    el.gameScreen.hidden = true;
    el.homeScreen.hidden = false;
    hide(el.resultOverlay);
    renderHome();
    window.scrollTo(0, 0);
  }

  function showGame() {
    el.homeScreen.hidden = true;
    el.gameScreen.hidden = false;
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------------ *
   * 局面の管理
   * ------------------------------------------------------------------ */

  function current() {
    return state.positions[state.index];
  }

  /** 着手後の手番を決める。turn が 0 なら終局。 */
  function resolveTurn(board, justMoved) {
    var opponent = -justMoved;
    if (E.countMoves(board, opponent) > 0) return { turn: opponent, passedBy: 0 };
    if (E.countMoves(board, justMoved) > 0) return { turn: justMoved, passedBy: opponent };
    return { turn: 0, passedBy: 0 };
  }

  function newGame() {
    var board = E.initialBoard();
    state.positions = [{ board: board, turn: BLACK, move: -1, mover: 0, flips: [], passedBy: 0 }];
    state.index = 0;
    state.assistMode = false; // 対局開始時はアシストOFF（ヒントは設定のまま）
    state.assistMove = -1;
    state.assistToken = -1;
    state.explainMode = false;
    state.explainToken = -1;
    state.candidates = [];
    state.thinking = false;
    state.recorded = false;
    state.started = true;
    state.token++;
    hide(el.resultOverlay);
    el.explainPanel.hidden = true;
    el.recordsPanel.hidden = true;
    render();
    scheduleAi();
  }

  function playMove(sq) {
    var pos = current();
    if (pos.turn === 0) return;
    if (!E.isLegal(pos.board, sq, pos.turn)) return;

    var board = Int8Array.from(pos.board);
    var flips = E.applyMove(board, sq, pos.turn);
    var next = resolveTurn(board, pos.turn);

    state.positions = state.positions.slice(0, state.index + 1);
    state.positions.push({
      board: board,
      turn: next.turn,
      move: sq,
      mover: pos.turn,
      flips: flips,
      passedBy: next.passedBy
    });
    state.index = state.positions.length - 1;
    state.assistMove = -1;
    state.candidates = [];
    state.token++;

    render({ placed: sq, flips: flips });

    if (next.passedBy !== 0) {
      toast((next.passedBy === state.playerColor ? 'あなたは' : 'AIは') + '打てる場所がないのでパスです');
    }
    if (next.turn === 0) {
      finishGame();
      return;
    }
    scheduleAi();
  }

  /** 自分が打てる1つ前の局面。なければ -1。 */
  function prevPlayerIndex() {
    for (var i = state.index - 1; i >= 0; i--) {
      if (state.positions[i].turn === state.playerColor) return i;
    }
    return -1;
  }

  /** 自分が打てる次の局面。なければ最後の局面まで進む。 */
  function nextPlayerIndex() {
    var last = state.positions.length - 1;
    for (var i = state.index + 1; i <= last; i++) {
      if (state.positions[i].turn === state.playerColor) return i;
    }
    return state.index < last ? last : -1;
  }

  function moveTo(i) {
    state.index = i;
    state.assistMove = -1;
    state.assistToken = -1;
    state.candidates = [];
    state.thinking = false;
    state.token++;
  }

  function undo() {
    var i = prevPlayerIndex();
    if (i < 0) return;
    moveTo(i);
    hide(el.resultOverlay);
    render();
  }

  function redo() {
    var i = nextPlayerIndex();
    if (i < 0) return;
    moveTo(i);
    render();
    scheduleAi();
  }

  function jumpTo(i) {
    if (i < 0 || i >= state.positions.length) return;
    moveTo(i);
    hide(el.resultOverlay);
    render();
    scheduleAi();
  }

  /* ------------------------------------------------------------------ *
   * AI の手番
   * ------------------------------------------------------------------ */

  function scheduleAi() {
    var pos = current();
    if (pos.turn === 0) return;
    if (pos.turn === state.playerColor) return;
    if (state.index !== state.positions.length - 1) return; // 過去の局面を見ているだけ

    state.thinking = true;
    var token = state.token;
    var startedAt = Date.now();
    render();

    ai.call('move', {
      board: Array.prototype.slice.call(pos.board),
      player: pos.turn,
      level: state.level
    }, function (result) {
      if (token !== state.token) return; // 巻き戻しなどで局面が変わっていたら捨てる
      var wait = Math.max(0, 280 - (Date.now() - startedAt)); // 速すぎると見づらい
      setTimeout(function () {
        if (token !== state.token) return;
        state.thinking = false;
        if (!result || result.move < 0) {
          render();
          return;
        }
        playMove(result.move);
      }, wait);
    });
  }

  /* ------------------------------------------------------------------ *
   * アシスト（モード。入れている間はずっと最善手を出す）
   * ------------------------------------------------------------------ */

  function toggleAssist() {
    state.assistMode = !state.assistMode;
    state.assistMove = -1;
    state.assistToken = -1;
    render();
    toast(state.assistMode
      ? 'アシストON — 手番のたびに最善手を光らせます'
      : 'アシストOFF');
  }

  /** いまの局面の最善手をまだ調べていなければ、裏で調べて光らせる */
  function maybeAssist() {
    if (!state.assistMode) return;
    if (state.explainMode) return; // 解説モードの分析が最善手も教えてくれる
    var pos = current();
    if (pos.turn === 0 || pos.turn !== state.playerColor) return;
    if (state.thinking) return;
    if (state.assistToken === state.token) return; // この局面はもう依頼済み

    state.assistToken = state.token;
    var token = state.token;
    ai.call('best', {
      board: Array.prototype.slice.call(pos.board),
      player: pos.turn,
      options: { depth: 8, time: 1200, exact: 15 }
    }, function (move) {
      if (token !== state.token) return;
      if (move === null || move === undefined || move < 0) return;
      state.assistMove = move;
      render();
    });
  }

  /* ------------------------------------------------------------------ *
   * 描画（対局画面）
   * ------------------------------------------------------------------ */

  var STAR_CELLS = { 18: 'star-tl', 21: 'star-tr', 42: 'star-bl', 45: 'star-br' };

  function buildBoard() {
    var frag = document.createDocumentFragment();
    for (var sq = 0; sq < 64; sq++) {
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      if (STAR_CELLS[sq]) cell.className += ' star ' + STAR_CELLS[sq];
      cell.dataset.sq = String(sq);
      cell.setAttribute('aria-label', E.toNotation(sq));

      var disc = document.createElement('span');
      disc.className = 'disc';
      cell.appendChild(disc);

      var coord = document.createElement('span');
      coord.className = 'coord';
      coord.textContent = E.toNotation(sq);
      cell.appendChild(coord);

      cells.push(cell);
      frag.appendChild(cell);
    }
    el.board.appendChild(frag);

    var letters = 'abcdefgh';
    for (var i = 0; i < 8; i++) {
      var x = document.createElement('span');
      x.textContent = letters.charAt(i);
      el.axisX.appendChild(x);
      var y = document.createElement('span');
      y.textContent = String(i + 1);
      el.axisY.appendChild(y);
    }
  }

  function render(animation) {
    var pos = current();
    var board = pos.board;
    var legal = pos.turn !== 0 ? E.legalMoves(board, pos.turn) : [];
    var legalSet = {};
    legal.forEach(function (sq) { legalSet[sq] = true; });
    var showHints = state.hints && pos.turn === state.playerColor && !state.thinking;
    var candidateSet = {};
    state.candidates.forEach(function (sq) { candidateSet[sq] = true; });

    for (var sq = 0; sq < 64; sq++) {
      var cell = cells[sq];
      var value = board[sq];
      var klass = 'cell';
      if (STAR_CELLS[sq]) klass += ' star ' + STAR_CELLS[sq];
      if (value === BLACK) klass += ' black';
      else if (value === WHITE) klass += ' white';
      if (value === 0 && showHints && legalSet[sq]) klass += ' legal';
      if (value === 0 && state.assistMove === sq) klass += ' legal best';
      if (value === 0 && candidateSet[sq] && state.assistMove !== sq) klass += ' legal candidate';
      if (sq === pos.move) klass += ' last-move';
      cell.className = klass;

      var disc = cell.firstChild;
      disc.classList.remove('placed', 'flipped');
      if (animation) {
        // クラスを付け直す前に一度レイアウトを読むと、アニメーションが再生され直す
        if (animation.placed === sq) {
          void disc.offsetWidth;
          disc.classList.add('placed');
        } else if (animation.flips && animation.flips.indexOf(sq) >= 0) {
          void disc.offsetWidth;
          disc.classList.add('flipped');
        }
      }
    }

    var counts = E.countDiscs(board);
    el.countBlack.textContent = String(counts.black);
    el.countWhite.textContent = String(counts.white);

    var playerIsBlack = state.playerColor === BLACK;
    el.labelBlack.textContent = playerIsBlack ? 'あなた' : 'AI';
    el.labelWhite.textContent = playerIsBlack ? 'AI' : 'あなた';
    el.levelBadge.textContent = 'AI ' + levelName();
    el.colorBadge.textContent = 'あなた：' + (playerIsBlack ? '黒' : '白');
    el.scoreBlack.classList.toggle('active', pos.turn === BLACK);
    el.scoreWhite.classList.toggle('active', pos.turn === WHITE);

    el.boardOuter.classList.toggle('show-coords', state.coords);
    el.board.classList.toggle('thinking', state.thinking || pos.turn !== state.playerColor);

    if (pos.turn === 0) {
      el.turnText.textContent = '終局';
      setMessage(finalMessage(counts), true);
    } else {
      el.turnText.textContent = (pos.turn === BLACK ? '黒番' : '白番');
      if (state.thinking) {
        setMessage('AI（' + levelName() + '）が考えています…', false);
      } else if (pos.turn === state.playerColor) {
        var hint = state.assistMode && state.assistMove >= 0
          ? '　おすすめは ' + E.toNotation(state.assistMove) + '。'
          : '';
        setMessage('あなたの手番です。置ける場所は ' + legal.length + ' か所。' + hint, false);
      } else {
        setMessage('AIの手番です。', false);
      }
    }

    el.btnUndo.disabled = prevPlayerIndex() < 0;
    el.btnRedo.disabled = nextPlayerIndex() < 0;
    el.btnExplain.disabled = state.thinking;
    el.btnAssist.setAttribute('aria-pressed', String(state.assistMode));
    el.btnExplain.setAttribute('aria-pressed', String(state.explainMode));
    el.btnCoords.setAttribute('aria-pressed', String(state.coords));
    el.btnHints.setAttribute('aria-pressed', String(state.hints));

    renderMoveList();
    maybeAssist();
    maybeExplain();
  }

  function setMessage(text, alert) {
    el.message.textContent = text;
    el.message.classList.toggle('alert', !!alert);
  }

  function levelName() {
    return E.LEVELS[state.level].name;
  }

  function finalMessage(counts) {
    var mine = state.playerColor === BLACK ? counts.black : counts.white;
    var theirs = state.playerColor === BLACK ? counts.white : counts.black;
    if (mine > theirs) return '対局終了 — あなたの勝ちです（' + mine + '対' + theirs + '）';
    if (mine < theirs) return '対局終了 — AIの勝ちです（' + theirs + '対' + mine + '）';
    return '対局終了 — 引き分けです（' + mine + '対' + theirs + '）';
  }

  function renderMoveList() {
    var list = el.moveList;
    list.innerHTML = '';
    if (state.positions.length <= 1) {
      var empty = document.createElement('li');
      empty.className = 'movelist-empty';
      empty.textContent = 'まだ着手はありません。';
      list.appendChild(empty);
      return;
    }
    for (var i = 1; i < state.positions.length; i++) {
      var pos = state.positions[i];
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.jump = String(i);
      if (i === state.index) btn.className = 'current';
      var who = document.createElement('span');
      who.className = 'who ' + (pos.mover === BLACK ? 'black' : 'white');
      btn.appendChild(who);
      btn.appendChild(document.createTextNode(i + '. ' + E.toNotation(pos.move)));
      li.appendChild(btn);
      list.appendChild(li);

      if (pos.passedBy !== 0) {
        var passLi = document.createElement('li');
        var passBtn = document.createElement('button');
        passBtn.type = 'button';
        passBtn.disabled = true;
        passBtn.textContent = (pos.passedBy === BLACK ? '黒' : '白') + 'パス';
        passLi.appendChild(passBtn);
        list.appendChild(passLi);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * トップ画面
   * ------------------------------------------------------------------ */

  function renderHome() {
    renderLevelList();
    renderColorChoice();
    buildRecordsView(el.homeRecords);
    el.btnResume.hidden = !gameInProgress();
  }

  function renderLevelList() {
    var stats = summarize(loadRecords()).byLevel;
    var list = el.levelList;
    list.innerHTML = '';

    E.LEVELS.forEach(function (level, i) {
      var li = document.createElement('li');
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'level-card';
      card.dataset.level = String(i);
      card.setAttribute('aria-pressed', String(i === state.level));

      var head = document.createElement('span');
      head.className = 'level-head';

      var rank = document.createElement('span');
      rank.className = 'level-rank';
      rank.textContent = level.name;
      head.appendChild(rank);

      var tag = document.createElement('span');
      tag.className = 'level-tag';
      tag.textContent = level.tagline || '';
      head.appendChild(tag);

      var record = document.createElement('span');
      record.className = 'level-record';
      var r = stats[i];
      record.textContent = r
        ? r.win + '勝' + r.lose + '敗' + (r.draw ? r.draw + '分' : '')
        : '未対局';
      head.appendChild(record);

      card.appendChild(head);

      var desc = document.createElement('span');
      desc.className = 'level-desc';
      desc.textContent = level.note || '';
      card.appendChild(desc);

      var meter = document.createElement('span');
      meter.className = 'level-meter';
      var fill = document.createElement('i');
      fill.style.width = Math.round(((i + 1) / E.LEVELS.length) * 100) + '%';
      meter.appendChild(fill);
      card.appendChild(meter);

      li.appendChild(card);
      list.appendChild(li);
    });
  }

  function renderColorChoice() {
    var buttons = el.colorChoice.querySelectorAll('.color-btn');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.setAttribute('aria-pressed', String(Number(btn.dataset.color) === state.playerColor));
    });
  }

  /* ------------------------------------------------------------------ *
   * 勝敗記録の表示
   * ------------------------------------------------------------------ */

  function buildRecordsView(container) {
    var games = loadRecords();
    container.innerHTML = '';

    if (!games.length) {
      container.appendChild(para('まだ記録がありません。対局を終えると、段位ごとに勝敗が残ります。'));
      return;
    }

    var stats = summarize(games);
    var table = document.createElement('table');
    table.className = 'record-table';
    table.innerHTML = '<thead><tr><th>段位</th><th>勝</th><th>敗</th><th>分</th><th>勝率</th></tr></thead>';
    var tbody = document.createElement('tbody');

    Object.keys(stats.byLevel)
      .sort(function (a, b) { return Number(a) - Number(b); })
      .forEach(function (key) {
        var r = stats.byLevel[key];
        var played = r.win + r.lose + r.draw;
        var rate = played ? Math.round((r.win / played) * 100) : 0;
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + (E.LEVELS[key] ? E.LEVELS[key].name : r.name) + '</td>'
          + '<td>' + r.win + '</td><td>' + r.lose + '</td><td>' + r.draw + '</td>'
          + '<td>' + rate + '%</td>';
        tbody.appendChild(tr);
      });

    var totals = stats.totals;
    var playedAll = totals.win + totals.lose + totals.draw;
    var trTotal = document.createElement('tr');
    trTotal.className = 'record-total';
    trTotal.innerHTML = '<td>合計</td><td>' + totals.win + '</td><td>' + totals.lose + '</td>'
      + '<td>' + totals.draw + '</td><td>'
      + (playedAll ? Math.round((totals.win / playedAll) * 100) : 0) + '%</td>';
    tbody.appendChild(trTotal);
    table.appendChild(tbody);
    container.appendChild(table);

    var recent = document.createElement('ul');
    recent.className = 'recent-list';
    games.slice(-8).reverse().forEach(function (g) {
      var li = document.createElement('li');
      var when = new Date(g.at);
      var date = isNaN(when.getTime()) ? '' :
        (when.getMonth() + 1) + '/' + when.getDate() + ' ' +
        ('0' + when.getHours()).slice(-2) + ':' + ('0' + when.getMinutes()).slice(-2);
      var mark = g.result === 'win' ? '<span class="res-win">勝</span>'
        : g.result === 'lose' ? '<span class="res-lose">敗</span>' : '分';
      li.innerHTML = date + '　' + g.level + '　' + mark + '　' + g.mine + '-' + g.theirs
        + '（' + (g.color === BLACK ? '黒' : '白') + '番）';
      recent.appendChild(li);
    });
    container.appendChild(recent);

    var actions = document.createElement('div');
    actions.className = 'record-actions';
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'link-danger';
    reset.textContent = '記録をすべて消す';
    reset.addEventListener('click', function () {
      if (window.confirm('保存されている勝敗記録をすべて削除します。よろしいですか？')) {
        saveRecords([]);
        buildRecordsView(container);
        if (!el.homeScreen.hidden) renderLevelList();
        toast('記録を消去しました');
      }
    });
    actions.appendChild(reset);
    container.appendChild(actions);
  }

  /* ------------------------------------------------------------------ *
   * 解説
   * ------------------------------------------------------------------ */

  var KIND_TEXT = {
    corner: '隅。絶対にひっくり返されない特別なマス',
    x: 'X打ち（隅のナナメ隣）。隅を渡す原因になりやすい',
    c: 'C打ち（隅の隣の辺）。辺の形を崩すと隅を失いやすい',
    edge: '辺。うまく打てば強いが、切れた形だと狙われる',
    center: '中央。返す石を少なく保ちたい序盤〜中盤の基本',
    inner: '辺のひとつ内側。打つと相手に辺を取られやすい位置'
  };

  /** 最善手との差を、点数ではなく言葉で伝える */
  function gapText(score, topScore) {
    var gap = topScore - score;
    if (gap <= 40) return 'ほぼ互角';
    if (gap <= 150) return 'わずかに劣る';
    if (gap <= 400) return 'やや劣る';
    if (gap <= 1000) return 'はっきり劣る';
    return '大きく劣る';
  }

  function phaseOf(empty) {
    if (empty > 40) return '序盤';
    if (empty > 12) return '中盤';
    return '終盤';
  }

  function phaseAdvice(empty) {
    if (empty > 40) {
      return '序盤は石の数を競う場面ではありません。返す石を少なくして中央にまとめ、'
        + '自分の置ける場所を増やすことを優先しましょう。';
    }
    if (empty > 12) {
      return '中盤は相手の選択肢を減らす戦いです。相手が打てる場所を絞りつつ、'
        + '隅につながる形を先に作れると有利になります。';
    }
    return '終盤は石数の勝負です。隅から連なる「返されない石（確定石）」を数えながら、'
      + '最後の数手を正確に選びましょう。';
  }

  function advantageText(score, exactSolved) {
    if (exactSolved || Math.abs(score) >= 100000) {
      var diff = Math.round(score / 2000);
      if (diff > 0) return { label: 'この先は読み切り済み：' + diff + '石差で勝ち', pct: 100 };
      if (diff < 0) return { label: 'この先は読み切り済み：' + (-diff) + '石差で負け', pct: 0 };
      return { label: 'この先は読み切り済み：引き分け', pct: 50 };
    }
    var abs = Math.abs(score);
    var word;
    if (abs < 60) word = 'ほぼ互角';
    else if (abs < 200) word = score > 0 ? 'ややあなたが良い' : 'ややAIが良い';
    else if (abs < 500) word = score > 0 ? 'あなたが優勢' : 'AIが優勢';
    else if (abs < 1200) word = score > 0 ? 'あなたが大優勢' : 'AIが大優勢';
    else word = score > 0 ? 'ほぼ勝勢' : 'かなり苦しい';
    var pct = 50 + 50 * Math.tanh(score / 700);
    return { label: word, pct: Math.max(2, Math.min(98, pct)) };
  }

  function section(title, nodes) {
    var wrap = document.createElement('div');
    wrap.className = 'explain-section';
    var h = document.createElement('h3');
    h.textContent = title;
    wrap.appendChild(h);
    nodes.forEach(function (node) { wrap.appendChild(node); });
    return wrap;
  }

  function para(text) {
    var p = document.createElement('p');
    p.textContent = text;
    return p;
  }

  function toggleExplain() {
    state.explainMode = !state.explainMode;
    state.explainToken = -1;

    if (!state.explainMode) {
      el.explainPanel.hidden = true;
      state.candidates = [];
      if (!state.assistMode) state.assistMove = -1;
      render();
      toast('解説OFF');
      return;
    }

    render(); // この中の maybeExplain が分析を始める
    el.explainPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast('解説ON — 局面が変わるたびに解説を出し直します');
  }

  /** 解説モードのとき、まだ解説していない局面なら分析して表示する */
  function maybeExplain() {
    if (!state.explainMode) return;
    if (state.thinking) return;
    if (state.explainToken === state.token) return; // この局面はもう解説済み

    var pos = current();
    var atTip = state.index === state.positions.length - 1;
    // これからAIが打つ局面は、指し終わるのを待ってから解説する
    if (pos.turn !== 0 && pos.turn !== state.playerColor && atTip) return;

    state.explainToken = state.token;
    el.explainPanel.hidden = false;

    if (pos.turn === 0) {
      showFinalReview();
      return;
    }

    el.explainBody.innerHTML = '';
    el.explainBody.appendChild(para('盤面を読んでいます…'));

    var token = state.token;
    ai.call('analyze', {
      board: Array.prototype.slice.call(pos.board),
      player: pos.turn,
      options: { depth: 9, time: 1800, exact: 16 }
    }, function (report) {
      if (token !== state.token || !state.explainMode) return;
      if (!report) {
        el.explainBody.innerHTML = '';
        el.explainBody.appendChild(para('解析に失敗しました。もう一度お試しください。'));
        return;
      }
      renderExplanation(report, pos);
    });
  }

  function renderExplanation(report, pos) {
    var body = el.explainBody;
    body.innerHTML = '';

    var turnIsPlayer = pos.turn === state.playerColor;
    var side = pos.turn === BLACK ? '黒' : '白';
    var counts = report.counts;
    var moveNo = state.index + 1;

    /* 1. 局面 */
    body.appendChild(section('局面', [
      para('第' + moveNo + '手 / ' + side + '番（' + (turnIsPlayer ? 'あなた' : 'AI') + '）。'
        + '黒 ' + counts.black + ' — 白 ' + counts.white + '、残り ' + counts.empty + 'マス。'
        + '進行は' + phaseOf(counts.empty) + 'です。'),
      para(phaseAdvice(counts.empty))
    ]));

    /* 2. 形勢 */
    var adv = advantageText(turnIsPlayer ? report.score : -report.score, report.exactSolved);
    var bar = document.createElement('div');
    bar.className = 'bar';
    var mark = document.createElement('span');
    mark.className = 'bar-mark';
    mark.style.left = adv.pct + '%';
    bar.appendChild(mark);
    body.appendChild(section('形勢', [
      para(adv.label + '（' + (report.exactSolved ? '終局まで読み切り' : report.depth + '手先まで読んだ評価')
        + '）。'),
      bar,
      para('バーは左へ寄るほどAI有利、右へ寄るほどあなたが有利という目安です。')
    ]));

    /* 3. 着手の自由度 */
    var mobilityNote;
    if (report.myMobility === 0) {
      mobilityNote = 'いま打てる場所がありません（パス）。';
    } else if (report.myMobility > report.oppMobility + 2) {
      mobilityNote = '選択肢が相手より多く、主導権を握れています。この差を保つ手を選びましょう。';
    } else if (report.oppMobility > report.myMobility + 2) {
      mobilityNote = '相手のほうが選択肢を多く持っています。返す石を減らし、'
        + '相手が打てる場所を狭める手を探してください。';
    } else {
      mobilityNote = '着手数はほぼ互角です。相手の選択肢を1つでも減らせる手が有効です。';
    }
    body.appendChild(section('着手の自由度', [
      para((pos.turn === BLACK ? '黒' : '白') + 'の着手可能数 ' + report.myMobility
        + ' か所、相手は ' + report.oppMobility + ' か所。'),
      para(mobilityNote)
    ]));

    /* 4. 隅 */
    var c = report.corners;
    var cornerLines = [];
    cornerLines.push(para('隅の状況 — 黒 ' + (c.black.length ? c.black.map(E.toNotation).join('・') : 'なし')
      + ' / 白 ' + (c.white.length ? c.white.map(E.toNotation).join('・') : 'なし')
      + ' / 空き ' + (c.open.length ? c.open.map(E.toNotation).join('・') : 'なし') + '。'));
    if (report.stability > 0) {
      cornerLines.push(para('隅から連なる確定石は自分のほうが ' + report.stability + ' 個多く、'
        + '終盤の下支えになっています。'));
    } else if (report.stability < 0) {
      cornerLines.push(para('確定石は相手のほうが ' + (-report.stability) + ' 個多い状態です。'
        + '空いている隅を1つでも取り返したいところ。'));
    }
    body.appendChild(section('隅と確定石', cornerLines));

    /* 5. 候補手 */
    var list = document.createElement('ul');
    list.className = 'explain-list';
    var topScore = report.candidates.length ? report.candidates[0].score : 0;

    report.candidates.forEach(function (cand, i) {
      var li = document.createElement('li');
      var head = document.createElement('div');
      head.className = 'move-head';
      var tag = document.createElement('span');
      tag.className = 'move-tag';
      tag.textContent = cand.notation;
      var rank = document.createElement('span');
      rank.className = 'move-rank';
      rank.textContent = i === 0
        ? '最善手'
        : '第' + (i + 1) + '候補（' + gapText(cand.score, topScore) + '）';
      head.appendChild(tag);
      head.appendChild(rank);
      li.appendChild(head);

      var why = document.createElement('div');
      why.className = 'move-why';
      var reasons = [];
      reasons.push(KIND_TEXT[cand.kind] || '');
      reasons.push('石を ' + cand.flips + ' 枚返し、相手の着手は ' + cand.oppMoves + ' か所になります');
      if (cand.oppMoves === 0) reasons.push('相手はパスになり、続けてもう一手打てます');
      else if (cand.oppMoves <= 2) reasons.push('相手の選択肢をかなり絞れます');
      if (cand.givesCorner) reasons.push('ただしこの手のあと、相手は ' + cand.givesCorner + ' の隅に入れます');
      if (cand.kind === 'corner') reasons.push('取れるなら迷わず確保したい一手です');
      why.textContent = reasons.filter(Boolean).join('。') + '。';
      li.appendChild(why);
      list.appendChild(li);
    });

    body.appendChild(section('次の一手（おすすめ順）', [
      list,
      para('盤面には最善手を濃い金色、次点以降を薄い枠で表示しています。')
    ]));

    /* 6. 注意点 */
    var cautions = [];
    if (report.risky.length) {
      var texts = report.risky.slice(0, 4).map(function (r) {
        return r.notation + '（' + r.corner + 'を渡す）';
      });
      cautions.push(para('次の手は打つと相手に隅を許します：' + texts.join('、')
        + (report.risky.length > 4 ? ' ほか' : '') + '。'));
    }
    var xRisk = [];
    E.legalMoves(pos.board, pos.turn).forEach(function (sq) {
      if (E.SQUARE_KIND[sq] === 'x') xRisk.push(E.toNotation(sq));
    });
    if (xRisk.length) {
      cautions.push(para('X打ちになるマス：' + xRisk.join('、')
        + '。隣の隅がまだ空いているうちは、よほどの理由がない限り避けましょう。'));
    }
    if (counts.empty <= 12) {
      cautions.push(para('残り ' + counts.empty + 'マス。ここからは1手のミスがそのまま石差になります。'
        + '打つ前に、その手で相手の最後の選択肢がどう変わるか確かめてください。'));
    }
    if (!cautions.length) cautions.push(para('いま特に大きな落とし穴はありません。'));
    body.appendChild(section('注意点', cautions));

    /* 盤面のハイライトを更新 */
    state.candidates = report.candidates.map(function (cand) { return cand.move; });
    state.assistMove = report.best;
    state.assistToken = state.token;
    render();
  }

  function showFinalReview() {
    el.explainPanel.hidden = false;
    var pos = current();
    var counts = E.countDiscs(pos.board);
    var mine = state.playerColor === BLACK ? counts.black : counts.white;
    var theirs = state.playerColor === BLACK ? counts.white : counts.black;
    el.explainBody.innerHTML = '';
    el.explainBody.appendChild(section('対局結果', [
      para('黒 ' + counts.black + ' — 白 ' + counts.white + '。'
        + (mine > theirs ? 'あなたの勝ちです。' : mine < theirs ? 'AIの勝ちです。' : '引き分けです。')),
      para('「戻る」で任意の局面まで戻れます。気になる場面で「解説」を押すと、'
        + 'そこでの最善手と考え方を確認できます。')
    ]));
  }

  /* ------------------------------------------------------------------ *
   * 終局処理と勝敗記録
   * ------------------------------------------------------------------ */

  function finishGame() {
    var pos = current();
    var counts = E.countDiscs(pos.board);
    var mine = state.playerColor === BLACK ? counts.black : counts.white;
    var theirs = state.playerColor === BLACK ? counts.white : counts.black;
    var result = mine > theirs ? 'win' : mine < theirs ? 'lose' : 'draw';

    if (!state.recorded) {
      state.recorded = true;
      addRecord({
        at: new Date().toISOString(),
        levelIndex: state.level,
        level: levelName(),
        color: state.playerColor,
        mine: mine,
        theirs: theirs,
        result: result
      });
    }

    el.resultTitle.textContent = result === 'win' ? 'あなたの勝ち！'
      : result === 'lose' ? 'AIの勝ち' : '引き分け';
    el.resultScore.textContent = mine + ' — ' + theirs;
    el.resultDetail.textContent = '対戦相手：' + levelName() + '　'
      + 'あなたの石：' + (state.playerColor === BLACK ? '黒' : '白');

    var r = summarize(loadRecords()).byLevel[state.level];
    el.resultRecord.textContent = r
      ? levelName() + 'との通算 ' + r.win + '勝' + r.lose + '敗' + r.draw + '分'
      : '';

    show(el.resultOverlay);
    render();
  }

  /* ------------------------------------------------------------------ *
   * 小物
   * ------------------------------------------------------------------ */

  var toastTimer = null;

  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 2200);
  }

  function show(node) { node.hidden = false; }
  function hide(node) { node.hidden = true; }

  /* ------------------------------------------------------------------ *
   * イベント
   * ------------------------------------------------------------------ */

  function bindEvents() {
    /* --- トップ画面 --- */

    el.levelList.addEventListener('click', function (event) {
      var card = event.target.closest ? event.target.closest('.level-card') : null;
      if (!card) return;
      state.level = Number(card.dataset.level);
      saveSettings();
      renderLevelList();
    });

    el.colorChoice.addEventListener('click', function (event) {
      var btn = event.target.closest ? event.target.closest('.color-btn') : null;
      if (!btn) return;
      state.playerColor = Number(btn.dataset.color);
      saveSettings();
      renderColorChoice();
    });

    el.btnStart.addEventListener('click', function () {
      if (gameInProgress() && !window.confirm('対局中です。新しく始めますか？')) return;
      showGame();
      newGame();
    });

    el.btnResume.addEventListener('click', function () {
      showGame();
      render();
      scheduleAi();
    });

    /* --- 対局画面 --- */

    el.btnHome.addEventListener('click', showHome);

    el.board.addEventListener('click', function (event) {
      var cell = event.target.closest ? event.target.closest('.cell') : null;
      if (!cell) return;
      var pos = current();
      if (pos.turn !== state.playerColor || state.thinking) return;
      var sq = Number(cell.dataset.sq);
      if (!E.isLegal(pos.board, sq, pos.turn)) {
        if (pos.board[sq] === 0) toast('そこには置けません');
        return;
      }
      playMove(sq);
    });

    el.moveList.addEventListener('click', function (event) {
      var btn = event.target.closest ? event.target.closest('button[data-jump]') : null;
      if (!btn) return;
      jumpTo(Number(btn.dataset.jump));
    });

    el.btnUndo.addEventListener('click', undo);
    el.btnRedo.addEventListener('click', redo);
    el.btnAssist.addEventListener('click', toggleAssist);
    el.btnExplain.addEventListener('click', toggleExplain);

    el.btnCoords.addEventListener('click', function () {
      state.coords = !state.coords;
      saveSettings();
      render();
    });

    el.btnHints.addEventListener('click', function () {
      state.hints = !state.hints;
      saveSettings();
      render();
      toast(state.hints ? '置けるマスを表示します' : '置けるマスの表示を消しました');
    });

    el.btnNew.addEventListener('click', function () {
      if (gameInProgress() && !window.confirm('いまの対局をやり直しますか？')) return;
      newGame();
    });

    el.btnRecords.addEventListener('click', function () {
      if (el.recordsPanel.hidden) {
        buildRecordsView(el.recordsBody);
        el.recordsPanel.hidden = false;
        el.recordsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        el.recordsPanel.hidden = true;
      }
    });

    document.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = $(btn.dataset.close);
        if (target) target.hidden = true;
        if (btn.dataset.close === 'explainPanel') {
          state.explainMode = false;
          state.explainToken = -1;
          state.candidates = [];
          state.assistMove = -1;
          state.assistToken = -1;
          render();
        }
      });
    });

    el.btnResultNew.addEventListener('click', newGame);
    el.btnResultReview.addEventListener('click', function () { hide(el.resultOverlay); });
    el.btnResultHome.addEventListener('click', showHome);

    document.addEventListener('keydown', function (event) {
      if (el.gameScreen.hidden) return;
      if (event.target && /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
      if (event.key === 'ArrowLeft') { undo(); event.preventDefault(); }
      else if (event.key === 'ArrowRight') { redo(); event.preventDefault(); }
    });
  }

  /** 新しいバージョンが用意できたら、画面上部に知らせる */
  function showUpdateBanner(worker) {
    if (!el.updateBanner) return;
    el.updateBanner.hidden = false;
    el.updateBanner.onclick = function () {
      el.updateBanner.disabled = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    };
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // localhost 以外の http では SW が使えない（iPhone 実機は GitHub Pages の https で確認する）
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
      reloading = true;
      location.reload();
    });

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { scope: './' }).then(function (reg) {
        // すでに待機中の新バージョンがある（前回開いたときに取得済み）
        if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);

        reg.addEventListener('updatefound', function () {
          var worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', function () {
            // controller がある＝初回インストールではなく更新
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner(worker);
            }
          });
        });

        // ホーム画面から起動したアプリは開きっぱなしになりやすいため、表示のたびに更新を確認する
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') reg.update().catch(function () {});
        });
      }).catch(function () { /* 登録できなくても遊べる */ });
    });
  }

  function init() {
    cacheElements();
    el.appVersion.textContent = 'バージョン ' + (window.APP_VERSION || '');
    loadSettings();
    buildBoard();
    bindEvents();

    // 盤面は先に作っておき、最初に見せるのはトップ画面
    state.positions = [{
      board: E.initialBoard(), turn: BLACK, move: -1, mover: 0, flips: [], passedBy: 0
    }];
    showHome();
    registerServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
