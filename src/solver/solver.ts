/**
 * 相位展开求解器
 *
 * 模型：每格真实相位 Φ = 读数 a + 圈数 k × 周期 P。
 * 硬约束：
 *   1. 锚点格圈数固定；
 *   2. 每格圈数落在全局圈数区间（至多三个连续整数）；
 *   3. 任意横/纵相邻两格真实相位之差的绝对值 ≤ 相邻跳变上限（以圈数计）× P。
 * 裁决目标（字典序最小化）：
 *   1. 所有横纵连续三格的二阶差分绝对值之和；
 *   2. 所有横纵相邻差绝对值之和；
 *   3. 行优先圈数序列的字典序。
 *
 * 实现：按行优先逐格赋值，前沿动态规划 + 双目标 Pareto 剪枝。
 * 列数 ≤ 4，前沿只需保留最近两行（共 2C 个圈数），状态域 ≤ 3^(2C) ≤ 3^8。
 * 并列的等优路径全部保留，最终按圈数序列字典序取最小与次小见证。
 */

export const MIN_ROWS = 2;
export const MAX_ROWS = 24;
export const MIN_COLS = 2;
export const MAX_COLS = 4;
const MAX_ABS = 1_000_000_000;

export type ParamField =
  | 'period'
  | 'cycleMin'
  | 'cycleMax'
  | 'jumpCap'
  | 'anchorCycles';

export interface RawInputs {
  rows: number;
  cols: number;
  /** 行优先的原始文本，允许暂时非法 */
  cells: string[];
  period: string;
  cycleMin: string;
  cycleMax: string;
  jumpCap: string;
  anchorRow: number;
  anchorCol: number;
  anchorCycles: string;
}

export type Issue =
  | { kind: 'cell'; row: number; col: number; message: string }
  | { kind: 'field'; field: ParamField; message: string }
  | { kind: 'dim'; message: string };

export interface SolverParams {
  rows: number;
  cols: number;
  readings: number[];
  period: number;
  cycleMin: number;
  cycleMax: number;
  jumpCap: number;
  anchorRow: number;
  anchorCol: number;
  anchorCycles: number;
}

export interface Solution {
  cycles: number[];
  unwrapped: number[];
  objective2: number;
  objective1: number;
}

export interface EdgeFailure {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export type SolveResult =
  | { status: 'ok'; primary: Solution; witness: Solution | null }
  | {
      status: 'unsat';
      message: string;
      edgeFailures: EdgeFailure[];
      failCell: { row: number; col: number } | null;
    };

export type Evaluation =
  | { status: 'invalid'; issues: Issue[] }
  | { status: 'unsat'; result: Extract<SolveResult, { status: 'unsat' }> }
  | { status: 'ok'; result: Extract<SolveResult, { status: 'ok' }> };

/** 严格解析十进制整数（允许前后空白与正负号），超界或非法返回 null */
export function parseInteger(text: string): number | null {
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n) || Math.abs(n) > MAX_ABS) return null;
  return n;
}

/** 导入文本：支持逗号/空白分隔，定位行列错误 */
export function parseMatrixText(text: string):
  | { ok: true; values: number[][]; rows: number; cols: number }
  | { ok: false; error: string; row?: number; col?: number } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: false, error: '导入内容为空' };
  const matrix: number[][] = [];
  let width = -1;
  for (let r = 0; r < lines.length; r++) {
    const tokens = lines[r].split(/[,\t]|\s+/).filter((s) => s.length > 0);
    if (width === -1) width = tokens.length;
    else if (tokens.length !== width) {
      return {
        ok: false,
        error: `第 ${r + 1} 行有 ${tokens.length} 个数，首行有 ${width} 个，行列不齐`,
        row: r + 1,
      };
    }
    const row: number[] = [];
    for (let c = 0; c < tokens.length; c++) {
      const n = parseInteger(tokens[c]);
      if (n === null) {
        return { ok: false, error: `单元 (${r + 1}, ${c + 1}) 不是合法整数：「${tokens[c]}」`, row: r + 1, col: c + 1 };
      }
      row.push(n);
    }
    matrix.push(row);
  }
  const rows = matrix.length;
  const cols = width;
  if (rows < MIN_ROWS || rows > MAX_ROWS) {
    return { ok: false, error: `行数 ${rows} 超出允许范围 ${MIN_ROWS}–${MAX_ROWS}` };
  }
  if (cols < MIN_COLS || cols > MAX_COLS) {
    return { ok: false, error: `列数 ${cols} 超出允许范围 ${MIN_COLS}–${MAX_COLS}` };
  }
  return { ok: true, values: matrix, rows, cols };
}

const FIELD_LABEL: Record<ParamField, string> = {
  period: '周期',
  cycleMin: '圈数下限',
  cycleMax: '圈数上限',
  jumpCap: '相邻跳变上限',
  anchorCycles: '锚点圈数',
};

/** 校验原始输入；合法时返回可供求解的参数 */
export function validate(raw: RawInputs): { params: SolverParams } | { issues: Issue[] } {
  const issues: Issue[] = [];
  const { rows, cols } = raw;

  if (!Number.isInteger(rows) || rows < MIN_ROWS || rows > MAX_ROWS) {
    issues.push({ kind: 'dim', message: `行数须为 ${MIN_ROWS}–${MAX_ROWS} 的整数` });
  }
  if (!Number.isInteger(cols) || cols < MIN_COLS || cols > MAX_COLS) {
    issues.push({ kind: 'dim', message: `列数须为 ${MIN_COLS}–${MAX_COLS} 的整数` });
  }
  if (
    raw.anchorRow < 0 ||
    raw.anchorCol < 0 ||
    raw.anchorRow >= rows ||
    raw.anchorCol >= cols
  ) {
    issues.push({ kind: 'dim', message: '锚点位置超出矩阵范围' });
  }

  const expected = rows * cols;
  let cells: number[] = [];
  if (raw.cells.length === expected) {
    cells = new Array(expected);
    for (let i = 0; i < expected; i++) {
      const n = parseInteger(raw.cells[i]);
      if (n === null) {
        issues.push({
          kind: 'cell',
          row: Math.floor(i / cols),
          col: i % cols,
          message: `读数「${raw.cells[i]}」不是合法整数`,
        });
      } else {
        cells[i] = n;
      }
    }
  } else {
    issues.push({ kind: 'dim', message: '读数矩阵尺寸与行列设置不一致' });
    cells = new Array(expected).fill(0);
  }

  const intField = (field: ParamField): number | null => {
    const n = parseInteger(raw[field]);
    if (n === null) {
      issues.push({ kind: 'field', field, message: `${FIELD_LABEL[field]}须为整数` });
      return null;
    }
    return n;
  };

  const period = intField('period');
  if (period !== null && period < 1) {
    issues.push({ kind: 'field', field: 'period', message: '周期须为正整数' });
  }
  const cycleMin = intField('cycleMin');
  const cycleMax = intField('cycleMax');
  if (cycleMin !== null && cycleMax !== null) {
    if (cycleMax < cycleMin) {
      issues.push({ kind: 'field', field: 'cycleMax', message: '圈数上限不得小于下限' });
    } else if (cycleMax - cycleMin > 2) {
      issues.push({
        kind: 'field',
        field: 'cycleMax',
        message: `圈数区间至多包含三个整数（当前跨 ${cycleMax - cycleMin + 1} 个）`,
      });
    }
  }
  const jumpCap = intField('jumpCap');
  if (jumpCap !== null && jumpCap < 0) {
    issues.push({ kind: 'field', field: 'jumpCap', message: '相邻跳变上限不得为负' });
  }
  const anchorCycles = intField('anchorCycles');
  if (
    anchorCycles !== null &&
    cycleMin !== null &&
    cycleMax !== null &&
    cycleMax >= cycleMin &&
    (anchorCycles < cycleMin || anchorCycles > cycleMax)
  ) {
    issues.push({
      kind: 'field',
      field: 'anchorCycles',
      message: `锚点圈数须落在区间 [${cycleMin}, ${cycleMax}] 内`,
    });
  }

  if (issues.length > 0) return { issues };
  return {
    params: {
      rows,
      cols,
      readings: cells,
      period: period as number,
      cycleMin: cycleMin as number,
      cycleMax: cycleMax as number,
      jumpCap: jumpCap as number,
      anchorRow: raw.anchorRow,
      anchorCol: raw.anchorCol,
      anchorCycles: anchorCycles as number,
    },
  };
}

interface Rec {
  /** 截至当前格的二阶差分绝对值累计 */
  o2: number;
  /** 截至当前格的相邻差绝对值累计 */
  o1: number;
  /** 本步赋给该格的圈数 */
  k: number;
  parent: Rec | null;
}

interface Node {
  /** 前行第 r-2 行、列 c..C-1 的圈数 */
  tb: number[];
  /** 第 r-1 行整行 */
  ob: number[];
  /** 当前行已处理的 0..c-1 列 */
  cur: number[];
  recs: Rec[];
}

function nodeKey(tb: number[], ob: number[], cur: number[]): string {
  return tb.join(',') + '|' + ob.join(',') + '|' + cur.join(',');
}

/** 两条等长记录链从根（第 0 格）起的行优先圈数字典序比较 */
function lexCompare(a: Rec, b: Rec): number {
  const sa: number[] = [];
  const sb: number[] = [];
  for (let x: Rec | null = a; x; x = x.parent) sa.push(x.k);
  for (let x: Rec | null = b; x; x = x.parent) sb.push(x.k);
  for (let i = sa.length - 1; i >= 0; i--) {
    if (sa[i] !== sb[i]) return sa[i] - sb[i];
  }
  return 0;
}

/**
 * Pareto 剪枝：
 *  - 按 (o2,o1) 分组，组间严格劣势组整体淘汰（同状态的未来增量完全相同，
 *    现在劣势则到终点仍劣势）；
 *  - 同组只留圈数前缀字典序最小的两条——同状态下未来可行决策集合一致，
 *    第三名前缀配上任何最优后缀都不可能进入全局前二名。
 */
function prune(recs: Rec[]): Rec[] {
  const groups = new Map<string, Rec[]>();
  for (const r of recs) {
    const key = r.o2 + '#' + r.o1;
    const g = groups.get(key);
    if (!g) groups.set(key, [r]);
    else g.push(r);
  }

  const pairs: { o2: number; o1: number; best: Rec[] }[] = [];
  for (const g of groups.values()) {
    g.sort(lexCompare);
    pairs.push({ o2: g[0].o2, o1: g[0].o1, best: g.slice(0, 2) });
  }
  pairs.sort((a, b) => a.o2 - b.o2 || a.o1 - b.o1);

  const kept: Rec[] = [];
  for (const p of pairs) {
    const dominated = pairs.some(
      (q) =>
        q !== p &&
        q.o2 <= p.o2 &&
        q.o1 <= p.o1 &&
        (q.o2 < p.o2 || q.o1 < p.o1),
    );
    if (!dominated) kept.push(...p.best);
  }
  return kept;
}

export function solve(p: SolverParams): SolveResult {
  const { rows: R, cols: C, readings: rd, period: P } = p;
  const N = R * C;
  const limit = p.jumpCap * P;
  const anchorIndex = p.anchorRow * C + p.anchorCol;

  const domain: number[][] = new Array(N);
  for (let i = 0; i < N; i++) {
    domain[i] =
      i === anchorIndex
        ? [p.anchorCycles]
        : Array.from({ length: p.cycleMax - p.cycleMin + 1 }, (_, d) => p.cycleMin + d);
  }

  // 单边固有可行性预检：任一相邻对在各自圈数域内都无法满足跳变上限 → 定位该边
  const edgeFailures: EdgeFailure[] = [];
  const pairFeasible = (i: number, j: number): boolean => {
    for (const ki of domain[i]) {
      for (const kj of domain[j]) {
        if (Math.abs(rd[i] - rd[j] + (ki - kj) * P) <= limit) return true;
      }
    }
    return false;
  };
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const i = r * C + c;
      if (c + 1 < C && !pairFeasible(i, i + 1)) {
        edgeFailures.push({ r1: r, c1: c, r2: r, c2: c + 1 });
      }
      if (r + 1 < R && !pairFeasible(i, i + C)) {
        edgeFailures.push({ r1: r, c1: c, r2: r + 1, c2: c });
      }
    }
  }
  if (edgeFailures.length > 0) {
    return {
      status: 'unsat',
      message: '存在无论怎样选择圈数都无法满足相邻跳变上限的边，约束相互冲突',
      edgeFailures,
      failCell: null,
    };
  }

  const initial: Node = { tb: [], ob: [], cur: [], recs: [{ o2: 0, o1: 0, k: -1, parent: null }] };
  let frontier = new Map<string, Node>([[nodeKey([], [], []), initial]]);
  let failCell: { row: number; col: number } | null = null;

  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const i = r * C + c;
      const next = new Map<string, Node>();

      for (const node of frontier.values()) {
        const leftK = c > 0 ? node.cur[c - 1] : null;
        const upK = r > 0 ? node.ob[c] : null;
        const tbK = r >= 2 ? node.tb[0] : null;

        for (const k of domain[i]) {
          let o2add = 0;
          let o1add = 0;
          let feasible = true;

          if (leftK !== null) {
            const dNew = rd[i] - rd[i - 1] + (k - leftK) * P;
            if (Math.abs(dNew) > limit) {
              feasible = false;
            } else {
              o1add += Math.abs(dNew);
              if (c >= 2) {
                const dPrev = rd[i - 1] - rd[i - 2] + (leftK - node.cur[c - 2]) * P;
                o2add += Math.abs(dNew - dPrev);
              }
            }
          }
          if (feasible && upK !== null) {
            const dNew = rd[i] - rd[i - C] + (k - upK) * P;
            if (Math.abs(dNew) > limit) {
              feasible = false;
            } else {
              o1add += Math.abs(dNew);
              if (r >= 2) {
                const dPrev = rd[i - C] - rd[i - 2 * C] + (upK - (tbK as number)) * P;
                o2add += Math.abs(dNew - dPrev);
              }
            }
          }
          if (!feasible) continue;

          let ntb: number[];
          let nob: number[];
          let ncur: number[];
          if (c + 1 < C) {
            ntb = r >= 2 ? node.tb.slice(1) : [];
            nob = node.ob;
            ncur = [...node.cur, k];
          } else {
            // 换行：上一行成为 tb（若下下行需要），当前行成为 ob
            ntb = node.ob;
            nob = [...node.cur, k];
            ncur = [];
          }

          const key = nodeKey(ntb, nob, ncur);
          let bucket = next.get(key);
          if (!bucket) {
            bucket = { tb: ntb, ob: nob, cur: ncur, recs: [] };
            next.set(key, bucket);
          }
          for (const parent of node.recs) {
            bucket.recs.push({
              o2: parent.o2 + o2add,
              o1: parent.o1 + o1add,
              k,
              parent,
            });
          }
        }
      }

      if (next.size === 0) {
        failCell = { row: r, col: c };
        frontier = next;
        break;
      }
      for (const node of next.values()) node.recs = prune(node.recs);
      frontier = next;
    }
    if (frontier.size === 0) break;
  }

  if (frontier.size === 0) {
    return {
      status: 'unsat',
      message:
        '不存在同时满足锚点、圈数区间与相邻跳变上限的圈数分配（二阶/一阶目标尚无可行解）',
      edgeFailures: [],
      failCell,
    };
  }

  // 终点唯一（空前沿），其中保留全局 Pareto 最优路径
  const terminals: Rec[] = [];
  for (const node of frontier.values()) terminals.push(...node.recs);
  let best: Rec | null = null;
  for (const rec of terminals) {
    if (!best || rec.o2 < best.o2 || (rec.o2 === best.o2 && rec.o1 < best.o1)) best = rec;
  }
  const bestPair = terminals.filter(
    (rec) => rec.o2 === best!.o2 && rec.o1 === best!.o1,
  );

  const rebuild = (rec: Rec): number[] => {
    const cycles = new Array<number>(N);
    let cur: Rec | null = rec;
    for (let i = N - 1; i >= 0; i--) {
      cycles[i] = cur!.k;
      cur = cur!.parent;
    }
    return cycles;
  };
  const toSolution = (cycles: number[], rec: Rec): Solution => ({
    cycles,
    unwrapped: cycles.map((k, i) => rd[i] + k * P),
    objective2: rec.o2,
    objective1: rec.o1,
  });

  // 同目标值的路径按行优先圈数序列去重、字典序排序
  const seen = new Set<string>();
  const opts: { cycles: number[]; rec: Rec }[] = [];
  for (const rec of bestPair) {
    const cycles = rebuild(rec);
    const key = cycles.join(',');
    if (!seen.has(key)) {
      seen.add(key);
      opts.push({ cycles, rec });
    }
  }
  opts.sort((a, b) => {
    for (let i = 0; i < N; i++) {
      if (a.cycles[i] !== b.cycles[i]) return a.cycles[i] - b.cycles[i];
    }
    return 0;
  });

  return {
    status: 'ok',
    primary: toSolution(opts[0].cycles, opts[0].rec),
    witness: opts.length > 1 ? toSolution(opts[1].cycles, opts[1].rec) : null,
  };
}

/** 页面与测试共用的总入口：校验 → 求解 */
export function evaluate(raw: RawInputs): Evaluation {
  const checked = validate(raw);
  if ('issues' in checked) return { status: 'invalid', issues: checked.issues };
  const result = solve(checked.params);
  return result.status === 'ok'
    ? { status: 'ok', result }
    : { status: 'unsat', result };
}
