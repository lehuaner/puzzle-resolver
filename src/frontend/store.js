/* 共享状态（单一数据源）
 * 原单文件里的模块级可变变量全部收在这里。
 * 各模块 import { S } 后直接读写属性，例如 S.cfg.total / S.states[i]。
 */
import { $ } from "./dom.js";

export var LS_PRE = "puzzleMap.v2.";
export var LS_CFG = "puzzleMap.cfg.v1";

export var DEFAULT_CFG = {
  total: 1000, cols: 40, zoneSize: 250,
  order: "col", origin: "tl", showIndex: true, cellSize: 56, gap: 3,
  guideMinView: 30
};

export function loadJSON(k, d) { try { var r = localStorage.getItem(k); if (r) return JSON.parse(r); } catch (e) {} return d; }
export function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

export var SCALE_MIN = 0.18, SCALE_MAX = 3.5;

// 视口是每人各自的，只存本机，按图 id 区分
export function viewKey() { return LS_PRE + "view." + (S.boardId || "local"); }

export var S = {
  cfg: Object.assign({}, DEFAULT_CFG, loadJSON(LS_CFG, {})),
  boardId: null, boardName: "",
  rows: 1, states: null, cells: [], adj: [], viewZone: "all",
  batchMode: false, sel: new Set(), undoStack: [],
  cellSize: 0, gap: 3, step: 0, contentW: 0, contentH: 0, tx: 0, ty: 0, scale: 1,
  // DOM 引用（模块脚本延迟执行，此时 DOM 已就绪）
  board: $("board"), wrap: $("wrap"), zonesEl: $("zones"), zVal: $("zVal"), mm: $("mm")
};
if (!S.cfg.origin) S.cfg.origin = "tl";        // 旧版本没有起点设置，按左上角算
S.cellSize = S.cfg.cellSize || 56;
S.gap = (S.cfg.gap == null ? 3 : S.cfg.gap);
S.step = S.cellSize + S.gap;
