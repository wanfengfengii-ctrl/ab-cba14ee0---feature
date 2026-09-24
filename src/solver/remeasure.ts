/**
 * 补测规划
 *
 * 当展开裁决已有主见证、但仍存在同等曲率（二阶差分和）与总变差（相邻差和）的
 * 替代圈数矩阵时，从计量员选定的可触达候选单元中确定下一轮人工测量的测点集合。
 *
 * 规则：
 *  - 每个被选单元的测量真值取主见证圈数；某替代矩阵只要在任一被选单元上与主见证
 *    取值不同，就会被该次补测排除；
 *  - 补测集合有效 ⇔ 全部替代矩阵都至少在一个被选单元上与主见证不同；
 *  - 候选范围由计量员选定，须为 2–10 个单元；系统在候选范围内完整比较全部子集，
 *    依次取测点数最少、行优先坐标序列字典序最小的计划；
 *  - 若候选范围整体仍无法区分某个替代矩阵，报告首个（行优先字典序最小）未被区分
 *    的矩阵及其与主见证的差异单元。
 */

export const MIN_PLAN_POINTS = 2;
export const MAX_PLAN_POINTS = 10;

export interface RemeasurePoint {
  /** 单元行优先下标 */
  index: number;
  row: number;
  col: number;
  /** 该测点的预期圈数（主见证取值） */
  expected: number;
  /** 移除该测点后会重新出现的替代见证下标（对应 alternatives 的顺序） */
  reappearing: number[];
}

export type RemeasurePlan =
  | { status: 'unique' }
  | { status: 'need-candidates'; count: number }
  | { status: 'too-many-candidates'; count: number }
  | {
      status: 'indistinguishable';
      /** 首个未被区分的替代矩阵下标与内容 */
      altIndex: number;
      matrix: number[];
      /** 它与主见证的全部差异单元（行优先下标，均落在候选范围之外） */
      diffCells: number[];
    }
  | { status: 'no-plan' }
  | {
      status: 'planned';
      points: RemeasurePoint[];
      alternativeCount: number;
    };

/**
 * 制定补测计划。
 *
 * @param primary      主见证圈数序列（行优先）
 * @param alternatives 全部替代圈数矩阵（不含主见证，按行优先字典序升序）
 * @param candidates   计量员选定的可触达候选单元（行优先下标，可乱序、可含重复）
 * @param cols         矩阵列数（用于换算坐标）
 */
export function planRemeasure(
  primary: number[],
  alternatives: number[][],
  candidates: number[],
  cols: number,
): RemeasurePlan {
  if (alternatives.length === 0) return { status: 'unique' };

  // 候选单元：去重、限定在主见证范围内、按行优先排序
  const n = primary.length;
  const cells = [...new Set(candidates.filter((i) => Number.isInteger(i) && i >= 0 && i < n))].sort(
    (a, b) => a - b,
  );
  if (cells.length < MIN_PLAN_POINTS) return { status: 'need-candidates', count: cells.length };
  if (cells.length > MAX_PLAN_POINTS) {
    return { status: 'too-many-candidates', count: cells.length };
  }

  // 每个替代矩阵相对主见证的差异单元，及其在候选范围上的覆盖位掩码（候选 ≤ 10 位）
  const diffCells: number[][] = alternatives.map((m) => {
    const d: number[] = [];
    for (let i = 0; i < n; i++) if (m[i] !== primary[i]) d.push(i);
    return d;
  });
  const posOf = new Map<number, number>(cells.map((cell, pos) => [cell, pos]));
  const masks = diffCells.map((d) => {
    let mask = 0;
    for (const i of d) {
      const pos = posOf.get(i);
      if (pos !== undefined) mask |= 1 << pos;
    }
    return mask;
  });

  // 候选范围整体仍无法区分：该替代矩阵在所有候选单元上都与主见证一致
  for (let i = 0; i < alternatives.length; i++) {
    if (masks[i] === 0) {
      return {
        status: 'indistinguishable',
        altIndex: i,
        matrix: alternatives[i],
        diffCells: diffCells[i],
      };
    }
  }

  // 完整比较候选子集：点数升序；同点数按行优先坐标序列字典序枚举，首个有效即最优
  let chosen = 0;
  let found = false;
  for (let size = MIN_PLAN_POINTS; size <= cells.length && !found; size++) {
    const idx = Array.from({ length: size }, (_, i) => i);
    for (;;) {
      let mask = 0;
      for (const pos of idx) mask |= 1 << pos;
      if (masks.every((m) => (m & mask) !== 0)) {
        chosen = mask;
        found = true;
        break;
      }
      // 下一个字典序组合
      let p = size - 1;
      while (p >= 0 && idx[p] === cells.length - size + p) p--;
      if (p < 0) break;
      idx[p]++;
      for (let q = p + 1; q < size; q++) idx[q] = idx[q - 1] + 1;
    }
  }
  if (!found) return { status: 'no-plan' };

  const points: RemeasurePoint[] = [];
  for (let pos = 0; pos < cells.length; pos++) {
    const bit = 1 << pos;
    if ((chosen & bit) === 0) continue;
    const index = cells[pos];
    points.push({
      index,
      row: Math.floor(index / cols),
      col: index % cols,
      expected: primary[index],
      // 移除该测点后重新出现的替代见证：其与计划的全部交集恰好只有该点
      reappearing: masks.flatMap((m, altIdx) => ((m & chosen) === bit ? [altIdx] : [])),
    });
  }
  return { status: 'planned', points, alternativeCount: alternatives.length };
}
