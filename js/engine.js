/**
 * リバーシの対局エンジン。
 * DOM に一切触らないので、メインスレッドからも Web Worker からも同じように使える。
 *
 *   盤面: 長さ 64 の Int8Array。0 = 空き / 1 = 黒 / -1 = 白
 *   マス番号: 0 = a1(左上) … 7 = h1 … 63 = h8(右下)
 */
(function (global) {
  'use strict';

  var EMPTY = 0;
  var BLACK = 1;
  var WHITE = -1;

  /* ------------------------------------------------------------------ *
   * 盤面の基本操作
   * ------------------------------------------------------------------ */

  var DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

  /** RAYS[マス][方向] = 盤の端まで並ぶマス番号の配列 */
  var RAYS = [];
  for (var sq = 0; sq < 64; sq++) {
    var r0 = sq >> 3;
    var c0 = sq & 7;
    var rays = [];
    for (var d = 0; d < 8; d++) {
      var cells = [];
      var rr = r0 + DIRS[d][0];
      var cc = c0 + DIRS[d][1];
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
        cells.push(rr * 8 + cc);
        rr += DIRS[d][0];
        cc += DIRS[d][1];
      }
      rays.push(Uint8Array.from(cells));
    }
    RAYS.push(rays);
  }

  /** 隣接マス（空きマス判定などに使う） */
  var NEIGHBORS = [];
  for (var sq2 = 0; sq2 < 64; sq2++) {
    var list = [];
    for (var d2 = 0; d2 < 8; d2++) {
      var nr = (sq2 >> 3) + DIRS[d2][0];
      var nc = (sq2 & 7) + DIRS[d2][1];
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) list.push(nr * 8 + nc);
    }
    NEIGHBORS.push(Uint8Array.from(list));
  }

  function initialBoard() {
    var b = new Int8Array(64);
    b[27] = WHITE; // d4
    b[28] = BLACK; // e4
    b[35] = BLACK; // d5
    b[36] = WHITE; // e5
    return b;
  }

  /** sq に player が打ったとき裏返るマスを out に書き込み、枚数を返す */
  function getFlipsInto(board, sq, player, out) {
    var n = 0;
    var rays = RAYS[sq];
    for (var d = 0; d < 8; d++) {
      var ray = rays[d];
      var len = ray.length;
      var i = 0;
      while (i < len && board[ray[i]] === -player) i++;
      if (i > 0 && i < len && board[ray[i]] === player) {
        for (var k = 0; k < i; k++) out[n++] = ray[k];
      }
    }
    return n;
  }

  function isLegal(board, sq, player) {
    if (board[sq] !== EMPTY) return false;
    var rays = RAYS[sq];
    for (var d = 0; d < 8; d++) {
      var ray = rays[d];
      var len = ray.length;
      var i = 0;
      while (i < len && board[ray[i]] === -player) i++;
      if (i > 0 && i < len && board[ray[i]] === player) return true;
    }
    return false;
  }

  function legalMoves(board, player) {
    var res = [];
    for (var sq = 0; sq < 64; sq++) {
      if (board[sq] === EMPTY && isLegal(board, sq, player)) res.push(sq);
    }
    return res;
  }

  function countMoves(board, player) {
    var n = 0;
    for (var sq = 0; sq < 64; sq++) {
      if (board[sq] === EMPTY && isLegal(board, sq, player)) n++;
    }
    return n;
  }

  var scratch = new Uint8Array(24);

  /** 盤面を破壊的に更新し、裏返したマスの配列を返す */
  function applyMove(board, sq, player) {
    var n = getFlipsInto(board, sq, player, scratch);
    board[sq] = player;
    for (var i = 0; i < n; i++) board[scratch[i]] = player;
    return Array.prototype.slice.call(scratch.subarray(0, n));
  }

  function countDiscs(board) {
    var black = 0;
    var white = 0;
    for (var i = 0; i < 64; i++) {
      if (board[i] === BLACK) black++;
      else if (board[i] === WHITE) white++;
    }
    return { black: black, white: white, empty: 64 - black - white };
  }

  /* ------------------------------------------------------------------ *
   * 評価関数
   * ------------------------------------------------------------------ */

  /** マスの価値（黒から見た値）。隅が高く、X打ち・C打ちは大きくマイナス。 */
  var W = [
    120, -24, 20, 5, 5, 20, -24, 120,
    -24, -50, -6, -4, -4, -6, -50, -24,
     20,  -6, 15,  3,  3, 15,  -6,  20,
      5,  -4,  3,  3,  3,  3,  -4,   5,
      5,  -4,  3,  3,  3,  3,  -4,   5,
     20,  -6, 15,  3,  3, 15,  -6,  20,
    -24, -50, -6, -4, -4, -6, -50, -24,
    120, -24, 20, 5, 5, 20, -24, 120
  ];

  var CORNERS = [0, 7, 56, 63];
  /** 隅ごとの X打ちのマス */
  var X_OF_CORNER = { 0: 9, 7: 14, 56: 49, 63: 54 };
  /** 隅ごとの C打ちのマス */
  var C_OF_CORNER = { 0: [1, 8], 7: [6, 15], 56: [48, 57], 63: [62, 55] };
  /** 隅から伸びる2辺（確定石を数えるのに使う） */
  var EDGES_FROM_CORNER = {
    0: [[1, 2, 3, 4, 5, 6, 7], [8, 16, 24, 32, 40, 48, 56]],
    7: [[6, 5, 4, 3, 2, 1, 0], [15, 23, 31, 39, 47, 55, 63]],
    56: [[57, 58, 59, 60, 61, 62, 63], [48, 40, 32, 24, 16, 8, 0]],
    63: [[62, 61, 60, 59, 58, 57, 56], [55, 47, 39, 31, 23, 15, 7]]
  };

  function isFrontier(board, sq) {
    var nb = NEIGHBORS[sq];
    for (var i = 0; i < nb.length; i++) {
      if (board[nb[i]] === EMPTY) return true;
    }
    return false;
  }

  /** 隅から連続する確定石の差（黒が有利ならプラス） */
  function stabilityDiff(board) {
    var diff = 0;
    for (var i = 0; i < 4; i++) {
      var c = CORNERS[i];
      var cv = board[c];
      if (cv === EMPTY) continue;
      diff += cv;
      var edges = EDGES_FROM_CORNER[c];
      for (var e = 0; e < 2; e++) {
        var line = edges[e];
        for (var k = 0; k < line.length; k++) {
          if (board[line[k]] !== cv) break;
          diff += cv;
        }
      }
    }
    return diff;
  }

  /** player から見た評価値（大きいほど player が良い） */
  function evaluate(board, player) {
    var pos = 0;
    var my = 0;
    var op = 0;
    var myFront = 0;
    var opFront = 0;
    for (var sq = 0; sq < 64; sq++) {
      var v = board[sq];
      if (v === EMPTY) continue;
      pos += v * W[sq];
      if (v === player) my++; else op++;
      if (isFrontier(board, sq)) {
        if (v === player) myFront++; else opFront++;
      }
    }

    // 隅が埋まっていれば、その隣の X打ち・C打ちはもう悪手ではない
    for (var i = 0; i < 4; i++) {
      var c = CORNERS[i];
      if (board[c] === EMPTY) continue;
      var x = X_OF_CORNER[c];
      pos -= board[x] * W[x];
      var cs = C_OF_CORNER[c];
      pos -= board[cs[0]] * W[cs[0]];
      pos -= board[cs[1]] * W[cs[1]];
    }

    var empties = 64 - my - op;
    var myMob = countMoves(board, player);
    var opMob = countMoves(board, -player);

    var mobWeight = empties > 40 ? 14 : empties > 12 ? 11 : 6;
    var discWeight = empties > 40 ? 0 : empties > 20 ? 1 : empties > 8 ? 4 : 12;

    var score = player * (pos + 22 * stabilityDiff(board));
    score += mobWeight * (myMob - opMob);
    score += 6 * (opFront - myFront);
    score += discWeight * (my - op);
    if (myMob === 0 && opMob > 0) score -= 60; // 自分だけパスは損
    return score;
  }

  /** 終局時の評価（石差）。中盤の評価値よりずっと大きい値にしておく。 */
  function terminalScore(board, player) {
    var c = countDiscs(board);
    var my = player === BLACK ? c.black : c.white;
    var op = player === BLACK ? c.white : c.black;
    var diff = my - op;
    if (diff > 0) diff += c.empty;   // 打ち切り時の空きは勝者のもの
    else if (diff < 0) diff -= c.empty;
    return diff * 2000;
  }

  /* ------------------------------------------------------------------ *
   * 置換表（Zobrist ハッシュ）
   * ------------------------------------------------------------------ */

  var TT_BITS = 18;
  var TT_SIZE = 1 << TT_BITS;
  var TT_MASK = TT_SIZE - 1;
  var ttKey = new Int32Array(TT_SIZE);
  var ttScore = new Int32Array(TT_SIZE);
  var ttDepth = new Int8Array(TT_SIZE);
  var ttFlag = new Int8Array(TT_SIZE);
  var ttMove = new Int8Array(TT_SIZE);
  var ttStamp = new Int32Array(TT_SIZE);
  var ttGeneration = 0;

  var ZL = new Int32Array(128);
  var ZH = new Int32Array(128);
  (function initZobrist() {
    var x = 123456789;
    var y = 362436069;
    for (var i = 0; i < 128; i++) {
      x ^= x << 13; x |= 0;
      x ^= x >>> 17;
      x ^= x << 5; x |= 0;
      y ^= y << 11; y |= 0;
      y ^= y >>> 8;
      y ^= y << 7; y |= 0;
      ZL[i] = x | 0;
      ZH[i] = y | 0;
    }
  })();

  var hashLo = 0;
  var hashHi = 0;

  function hashBoard(board, player) {
    var lo = player === BLACK ? 0x9e3779b9 | 0 : 0x7f4a7c15 | 0;
    var hi = player === BLACK ? 0x85ebca6b | 0 : 0xc2b2ae35 | 0;
    for (var sq = 0; sq < 64; sq++) {
      var v = board[sq];
      if (v === EMPTY) continue;
      var idx = v === BLACK ? sq : sq + 64;
      lo ^= ZL[idx];
      hi ^= ZH[idx];
    }
    hashLo = lo | 0;
    hashHi = hi | 0;
  }

  /* ------------------------------------------------------------------ *
   * 探索（アルファベータ + 反復深化）
   * ------------------------------------------------------------------ */

  var FLAG_EXACT = 0;
  var FLAG_LOWER = 1;
  var FLAG_UPPER = 2;
  var INF = 1 << 28;
  var ABORT = { aborted: true };

  /** 手の並べ替え用。良さそうな手から読むほどアルファベータがよく効く。 */
  var ORDER_W = [
    100, -20, 12, 6, 6, 12, -20, 100,
    -20, -40, -3, -2, -2, -3, -40, -20,
     12,  -3,  8,  2,  2,  8,  -3,  12,
      6,  -2,  2,  1,  1,  2,  -2,   6,
      6,  -2,  2,  1,  1,  2,  -2,   6,
     12,  -3,  8,  2,  2,  8,  -3,  12,
    -20, -40, -3, -2, -2, -3, -40, -20,
    100, -20, 12, 6, 6, 12, -20, 100
  ];

  var nodes = 0;
  var deadline = Infinity;
  var flipStack = new Uint8Array(64 * 24);
  var moveBuf = new Uint8Array(24);

  function now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  function make(board, sq, player, ply) {
    var off = ply * 24;
    var n = getFlipsInto(board, sq, player, moveBuf);
    board[sq] = player;
    for (var i = 0; i < n; i++) {
      flipStack[off + i] = moveBuf[i];
      board[moveBuf[i]] = player;
    }
    return n;
  }

  function unmake(board, sq, player, ply, n) {
    var off = ply * 24;
    board[sq] = EMPTY;
    for (var i = 0; i < n; i++) board[flipStack[off + i]] = -player;
  }

  function orderMoves(board, moves, player, ply, hashMove, deep) {
    var scored = [];
    for (var i = 0; i < moves.length; i++) {
      var sq = moves[i];
      var s;
      if (sq === hashMove) {
        s = 1000000;
      } else {
        s = ORDER_W[sq] * 10;
        if (deep) {
          var n = make(board, sq, player, ply);
          s -= countMoves(board, -player) * 24;
          unmake(board, sq, player, ply, n);
        }
      }
      scored.push({ sq: sq, s: s });
    }
    scored.sort(function (a, b) { return b.s - a.s; });
    var out = [];
    for (var j = 0; j < scored.length; j++) out.push(scored[j].sq);
    return out;
  }

  function negamax(board, player, depth, alpha, beta, passed, ply) {
    nodes++;
    if ((nodes & 2047) === 0 && now() > deadline) throw ABORT;

    var moves = legalMoves(board, player);
    if (moves.length === 0) {
      if (passed) return terminalScore(board, player);
      return -negamax(board, -player, depth, -beta, -alpha, true, ply + 1);
    }
    if (depth <= 0) return evaluate(board, player);

    var useTT = depth >= 3;
    var idx = 0;
    var keyHi = 0;
    var hashMove = -1;
    if (useTT) {
      hashBoard(board, player);
      idx = hashLo & TT_MASK;
      keyHi = hashHi;
      if (ttKey[idx] === keyHi && ttStamp[idx] === ttGeneration) {
        if (ttDepth[idx] >= depth) {
          var ts = ttScore[idx];
          var tf = ttFlag[idx];
          if (tf === FLAG_EXACT) return ts;
          if (tf === FLAG_LOWER) { if (ts > alpha) alpha = ts; }
          else if (tf === FLAG_UPPER) { if (ts < beta) beta = ts; }
          if (alpha >= beta) return ts;
        }
        hashMove = ttMove[idx];
      }
    }

    var ordered = orderMoves(board, moves, player, ply, hashMove, depth >= 4);
    var best = -INF;
    var bestMoveHere = ordered[0];
    var origAlpha = alpha;

    for (var i = 0; i < ordered.length; i++) {
      var sq = ordered[i];
      var n = make(board, sq, player, ply);
      var score;
      if (i === 0) {
        score = -negamax(board, -player, depth - 1, -beta, -alpha, false, ply + 1);
      } else {
        // 2手目以降はまず狭い窓で調べ、超えたときだけ読み直す
        score = -negamax(board, -player, depth - 1, -alpha - 1, -alpha, false, ply + 1);
        if (score > alpha && score < beta) {
          score = -negamax(board, -player, depth - 1, -beta, -alpha, false, ply + 1);
        }
      }
      unmake(board, sq, player, ply, n);

      if (score > best) {
        best = score;
        bestMoveHere = sq;
      }
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }

    if (useTT && (ttStamp[idx] !== ttGeneration || ttDepth[idx] <= depth)) {
      ttKey[idx] = keyHi;
      ttScore[idx] = best;
      ttDepth[idx] = depth;
      ttMove[idx] = bestMoveHere;
      ttStamp[idx] = ttGeneration;
      ttFlag[idx] = best <= origAlpha ? FLAG_UPPER : best >= beta ? FLAG_LOWER : FLAG_EXACT;
    }
    return best;
  }

  /**
   * ルートで全ての合法手に点数をつける（反復深化）。
   * 時間切れになったら、最後に読み切った深さの結果を返す。
   *
   * options.trueScores を立てると、ルートの各手を毎回フルウィンドウで読む。
   * 速度は落ちるが、返ってくる点数が「上限値」ではなく本当の評価値になるので、
   * 段位ごとの揺らぎや解説の候補手比較に使える。
   */
  function searchRoot(board, player, options) {
    var maxDepth = options.depth || 6;
    var timeLimit = options.time || 1000;
    var exactFrom = options.exact || 0;
    var trueScores = !!options.trueScores;

    var moves = legalMoves(board, player);
    if (moves.length === 0) {
      return { move: -1, scored: [], depth: 0, exact: false, nodes: 0 };
    }

    var empties = countDiscs(board).empty;
    var exact = empties <= exactFrom;
    var targetDepth = exact ? empties : maxDepth;

    nodes = 0;
    ttGeneration++;
    deadline = now() + timeLimit;

    var work = new Int8Array(board);
    var scored = moves.map(function (sq) { return { move: sq, score: 0 }; });
    var completed = 0;
    var startDepth = Math.min(2, targetDepth);

    for (var depth = startDepth; depth <= targetDepth; depth++) {
      var iter = [];
      var alpha = -INF;
      var aborted = false;
      var order = scored.map(function (m) { return m.move; }); // 前回の並びを引き継ぐ
      for (var i = 0; i < order.length; i++) {
        var sq = order[i];
        var n = make(work, sq, player, 0);
        var score = 0;
        try {
          if (trueScores || i === 0) {
            score = -negamax(work, -player, depth - 1, -INF, INF, false, 1);
          } else {
            score = -negamax(work, -player, depth - 1, -alpha - 1, -alpha, false, 1);
            if (score > alpha) {
              score = -negamax(work, -player, depth - 1, -INF, -alpha, false, 1);
            }
          }
        } catch (e) {
          if (e !== ABORT) { unmake(work, sq, player, 0, n); throw e; }
          aborted = true;
        }
        unmake(work, sq, player, 0, n);
        if (aborted) break;
        if (!trueScores && score > alpha) alpha = score;
        iter.push({ move: sq, score: score });
      }
      if (aborted) break;
      iter.sort(function (a, b) { return b.score - a.score; });
      scored = iter;
      completed = depth;
      if (Math.abs(scored[0].score) > 1000000) break; // 勝敗が確定した
    }

    deadline = Infinity;
    return {
      move: scored[0].move,
      scored: scored,
      depth: completed,
      exact: exact && completed >= targetDepth,
      nodes: nodes
    };
  }

  /* ------------------------------------------------------------------ *
   * 段位
   * ------------------------------------------------------------------ */

  /**
   * 段位の定義。tagline / note は選択画面にそのまま表示される説明文。
   * 段位を増やすときは、この配列に1行足すだけでよい。
   *
   *   depth  … 通常の読みの深さ（手数）
   *   time   … 1手に使う上限時間(ms)。反復深化なので、間に合わなければ浅い結果を使う
   *   exact  … 残りマスがこの数以下になったら最後まで読み切る
   *   noise  … 評価に乗せる揺らぎ。大きいほど最善手を外す
   *   random … 完全にでたらめな手を打つ確率
   *   greedy … いちばん多く返せる手を選ぶ確率
   */
  var LEVELS = [
    {
      name: '入門', depth: 1, time: 150, exact: 0, noise: 0, random: 0.35, greedy: 0.65,
      tagline: '枚数を優先する',
      note: 'いちばん多く石を返せる手を選びがちで、ときどき気まぐれに打ちます。ルールを覚えるのにちょうどいい相手です。'
    },
    {
      name: '初段', depth: 2, time: 250, exact: 4, noise: 220, random: 0.12, greedy: 0,
      tagline: '2手先を読む',
      note: '隅が大事なことは知っていますが、読みが浅く手のブレも大きいので、隙がたくさん残ります。'
    },
    {
      name: '二段', depth: 3, time: 350, exact: 6, noise: 160, random: 0.07, greedy: 0,
      tagline: '3手先を読む',
      note: '大きな見落としは減ります。残り6マスからは最後まで読み切って石数を合わせてきます。'
    },
    {
      name: '三段', depth: 4, time: 500, exact: 8, noise: 110, random: 0.04, greedy: 0,
      tagline: '4手先を読む',
      note: 'あなたの打てる場所を減らす手を選び始めます。残り8マスから読み切り。'
    },
    {
      name: '四段', depth: 5, time: 700, exact: 10, noise: 70, random: 0.02, greedy: 0,
      tagline: '5手先を読む',
      note: '序盤に石を取りすぎない打ち方をします。残り10マスから読み切り。'
    },
    {
      name: '五段', depth: 6, time: 900, exact: 12, noise: 45, random: 0.01, greedy: 0,
      tagline: '6手先を読む',
      note: '隅からつながる確定石を意識して組み立ててきます。残り12マスから読み切り。'
    },
    {
      name: '六段', depth: 7, time: 1200, exact: 13, noise: 25, random: 0, greedy: 0,
      tagline: '7手先を読む',
      note: 'X打ち・C打ちの隙を的確に突いてきます。こちらのミスはほぼ見逃しません。'
    },
    {
      name: '七段', depth: 8, time: 1600, exact: 14, noise: 12, random: 0, greedy: 0,
      tagline: '8手先を読む',
      note: '中盤からこちらの選択肢を絞ってきます。残り14マスから読み切り。'
    },
    {
      name: '八段', depth: 9, time: 2000, exact: 15, noise: 5, random: 0, greedy: 0,
      tagline: '9手先を読む',
      note: 'わずかな緩みも逃しません。勝つには序盤から形を崩さない必要があります。'
    },
    {
      name: '九段', depth: 10, time: 2600, exact: 16, noise: 0, random: 0, greedy: 0,
      tagline: '10手先を読む',
      note: '手加減なし。残り16マスからは完全に読み切るので、終盤の逆転はほぼ望めません。'
    },
    {
      name: '十段', depth: 12, time: 3400, exact: 18, noise: 0, random: 0, greedy: 0,
      tagline: '12手先を読む',
      note: '最強設定。残り18マスから完全読み切り。1手に数秒考えることがあります。'
    }
  ];

  /** 段位に応じて着手を選ぶ */
  function chooseMove(board, player, levelIndex) {
    var level = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, levelIndex | 0))];
    var work = new Int8Array(board);
    var moves = legalMoves(work, player);
    if (moves.length === 0) return { move: -1, level: level.name };
    if (moves.length === 1) return { move: moves[0], level: level.name, style: 'only' };

    if (Math.random() < level.random) {
      return { move: moves[(Math.random() * moves.length) | 0], level: level.name, style: 'random' };
    }
    if (level.greedy && Math.random() < level.greedy) {
      // 入門らしく「たくさん取れる手」を選ぶ
      var bestSq = moves[0];
      var bestN = -1;
      for (var i = 0; i < moves.length; i++) {
        var n = getFlipsInto(work, moves[i], player, scratch);
        if (n > bestN) { bestN = n; bestSq = moves[i]; }
      }
      return { move: bestSq, level: level.name, style: 'greedy' };
    }

    var res = searchRoot(work, player, {
      depth: level.depth,
      time: level.time,
      exact: level.exact,
      // 揺らぎを乗せる段位では、候補手の点数が正確でないと意味がない
      trueScores: level.noise > 0
    });
    if (level.noise > 0) {
      var best = res.move;
      var bestScore = -Infinity;
      for (var k = 0; k < res.scored.length; k++) {
        var s = res.scored[k].score + (Math.random() * 2 - 1) * level.noise;
        if (s > bestScore) { bestScore = s; best = res.scored[k].move; }
      }
      return { move: best, level: level.name, depth: res.depth, style: 'search' };
    }
    return {
      move: res.move,
      level: level.name,
      depth: res.depth,
      exact: res.exact,
      style: 'search'
    };
  }

  /* ------------------------------------------------------------------ *
   * 解説用の分析
   * ------------------------------------------------------------------ */

  /** マスの種類。解説の言い回しを変えるのに使う。 */
  var SQUARE_KIND = (function () {
    var kind = new Array(64);
    for (var sq = 0; sq < 64; sq++) {
      var r = sq >> 3;
      var c = sq & 7;
      var onEdge = r === 0 || r === 7 || c === 0 || c === 7;
      if ((r === 0 || r === 7) && (c === 0 || c === 7)) kind[sq] = 'corner';
      else if ((r === 1 || r === 6) && (c === 1 || c === 6)) kind[sq] = 'x';
      else if (onEdge && (r === 1 || r === 6 || c === 1 || c === 6)) kind[sq] = 'c';
      else if (onEdge) kind[sq] = 'edge';
      else if (r >= 2 && r <= 5 && c >= 2 && c <= 5) kind[sq] = 'center';
      else kind[sq] = 'inner';
    }
    return kind;
  })();

  function toNotation(sq) {
    if (sq === null || sq === undefined || sq < 0) return 'パス';
    return 'abcdefgh'.charAt(sq & 7) + String(1 + (sq >> 3));
  }

  function fromNotation(text) {
    if (!text || text.length < 2) return -1;
    var c = 'abcdefgh'.indexOf(text.charAt(0).toLowerCase());
    var r = parseInt(text.charAt(1), 10) - 1;
    if (c < 0 || isNaN(r) || r < 0 || r > 7) return -1;
    return r * 8 + c;
  }

  /** 隅の取得状況 */
  function cornerStatus(board) {
    var status = { black: [], white: [], open: [] };
    for (var i = 0; i < 4; i++) {
      var c = CORNERS[i];
      if (board[c] === BLACK) status.black.push(c);
      else if (board[c] === WHITE) status.white.push(c);
      else status.open.push(c);
    }
    return status;
  }

  /** この手を打った直後、相手が隅に入れるようになるか */
  function givesCornerAway(board, sq, player) {
    var probe = new Int8Array(board);
    applyMove(probe, sq, player);
    for (var i = 0; i < 4; i++) {
      var c = CORNERS[i];
      if (probe[c] === EMPTY && isLegal(probe, c, -player)) return toNotation(c);
    }
    return null;
  }

  /**
   * 現局面を詳しく調べて、解説に必要な材料をまとめて返す。
   */
  function analyze(board, player, options) {
    options = options || {};
    var work = new Int8Array(board);
    var counts = countDiscs(work);
    var myMob = countMoves(work, player);
    var opMob = countMoves(work, -player);

    var res = searchRoot(work, player, {
      depth: options.depth || 9,
      time: options.time || 1800,
      exact: options.exact || 16,
      trueScores: true // 候補手どうしを比べるので、正確な点数が要る
    });

    var candidates = res.scored.slice(0, 4).map(function (item) {
      var probe = new Int8Array(board);
      var flips = getFlipsInto(probe, item.move, player, scratch);
      applyMove(probe, item.move, player);
      return {
        move: item.move,
        notation: toNotation(item.move),
        score: item.score,
        flips: flips,
        kind: SQUARE_KIND[item.move],
        oppMoves: countMoves(probe, -player),
        givesCorner: givesCornerAway(board, item.move, player)
      };
    });

    // 相手に隅を渡してしまう手（注意喚起用）
    var risky = [];
    var moves = legalMoves(work, player);
    for (var m = 0; m < moves.length; m++) {
      var corner = givesCornerAway(work, moves[m], player);
      if (corner) {
        risky.push({ move: moves[m], notation: toNotation(moves[m]), corner: corner });
      }
    }

    return {
      player: player,
      counts: counts,
      myMobility: myMob,
      oppMobility: opMob,
      corners: cornerStatus(work),
      candidates: candidates,
      risky: risky,
      best: res.move,
      bestNotation: toNotation(res.move),
      score: res.scored.length ? res.scored[0].score : 0,
      depth: res.depth,
      exactSolved: res.exact,
      stability: player * stabilityDiff(work)
    };
  }

  /** 最善手だけ手早く求める（アシストボタン用） */
  function bestMove(board, player, options) {
    options = options || {};
    var res = searchRoot(new Int8Array(board), player, {
      depth: options.depth || 8,
      time: options.time || 1200,
      exact: options.exact || 14
    });
    return res.move;
  }

  global.ReversiEngine = {
    BLACK: BLACK,
    WHITE: WHITE,
    EMPTY: EMPTY,
    LEVELS: LEVELS,
    SQUARE_KIND: SQUARE_KIND,
    CORNERS: CORNERS,
    initialBoard: initialBoard,
    legalMoves: legalMoves,
    countMoves: countMoves,
    isLegal: isLegal,
    applyMove: applyMove,
    getFlips: function (board, sq, player) {
      var buf = new Uint8Array(24);
      var n = getFlipsInto(board, sq, player, buf);
      return Array.prototype.slice.call(buf.subarray(0, n));
    },
    countDiscs: countDiscs,
    evaluate: evaluate,
    searchRoot: searchRoot,
    chooseMove: chooseMove,
    analyze: analyze,
    bestMove: bestMove,
    toNotation: toNotation,
    fromNotation: fromNotation,
    cornerStatus: cornerStatus,
    givesCornerAway: givesCornerAway
  };
})(typeof self !== 'undefined' ? self : this);
