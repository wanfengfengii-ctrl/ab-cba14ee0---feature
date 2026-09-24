import { describe, expect, it } from 'vitest';
import {
  MAX_PLAN_POINTS,
  MIN_PLAN_POINTS,
  planRemeasure,
  type RemeasurePlan,
} from './remeasure';

const COLS = 2;

const planned = (p: RemeasurePlan) => {
  if (p.status !== 'planned') throw new Error(`应为 planned，实际 ${p.status}`);
  return p;
};

describe('planRemeasure 基本分支', () => {
  it('无替代矩阵 → 结论唯一，无需补测', () => {
    expect(planRemeasure([0, 0, 0, 0], [], [0, 1], COLS)).toEqual({ status: 'unique' });
  });

  it('候选不足 2 个 → 提示补选', () => {
    const alt = [[0, 0, 1, 0]];
    expect(planRemeasure([0, 0, 0, 0], alt, [], COLS)).toEqual({
      status: 'need-candidates',
      count: 0,
    });
    expect(planRemeasure([0, 0, 0, 0], alt, [3], COLS)).toEqual({
      status: 'need-candidates',
      count: 1,
    });
  });

  it('候选超过 10 个 → 拒绝', () => {
    const primary = new Array(12).fill(0);
    const alt = [new Array(12).fill(1)];
    const r = planRemeasure(primary, alt, [...Array(12).keys()], COLS);
    expect(r).toEqual({ status: 'too-many-candidates', count: 12 });
  });

  it('候选单元去重并按行优先排序', () => {
    // 与 [0,2] 等效：替代矩阵只在单元 2 不同
    const p = planned(planRemeasure([0, 0, 0, 0], [[0, 0, 1, 0]], [2, 0, 2], COLS));
    expect(p.points.map((pt) => pt.index)).toEqual([0, 2]);
  });

  it('越界候选下标被忽略', () => {
    const p = planned(planRemeasure([0, 0, 0, 0], [[0, 0, 1, 0]], [-1, 0, 2, 99], COLS));
    expect(p.points.map((pt) => pt.index)).toEqual([0, 2]);
  });
});

describe('planRemeasure 计划选择', () => {
  it('测点真值取主见证圈数，逐点给出移除后重现的替代见证', () => {
    // 唯一替代矩阵仅与主见证在单元 2 不同
    const p = planned(planRemeasure([5, 6, 7, 8], [[5, 6, 9, 8]], [0, 2], COLS));
    expect(p.alternativeCount).toBe(1);
    expect(p.points).toHaveLength(2);
    // 计划须含单元 2；单元 0 是为满足最少 2 测点而补入的冗余点
    const [p0, p2] = p.points;
    expect(p0).toMatchObject({ index: 0, row: 0, col: 0, expected: 5, reappearing: [] });
    expect(p2).toMatchObject({ index: 2, row: 1, col: 0, expected: 7, reappearing: [0] });
  });

  it('即使一个测点即可区分，计划仍至少包含 2 个测点', () => {
    const p = planned(planRemeasure([0, 0, 0, 0], [[0, 0, 1, 0]], [0, 2, 3], COLS));
    expect(p.points.map((pt) => pt.index)).toEqual([0, 2]);
  });

  it('优先选择测点数最少的计划', () => {
    // A 只在 0 不同，B 只在 1 不同，C 在 0、1 都不同 → 单点不够，最少 2 点
    const alts = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [1, 1, 0, 0],
    ];
    const p = planned(planRemeasure([0, 0, 0, 0], alts, [0, 1, 2, 3], COLS));
    expect(p.points.map((pt) => pt.index)).toEqual([0, 1]);
    expect(p.points[0].reappearing).toEqual([0]); // 移除 0 后 A 重现
    expect(p.points[1].reappearing).toEqual([1]); // 移除 1 后 B 重现
  });

  it('同点数时取行优先坐标序列字典序最小者', () => {
    // A 差异 {1,3}，B 差异 {2,3}：候选全选时
    // 两点组合依次 (0,1)✗ (0,2)✗ (0,3)✓ → 计划 [0,3]，而非同样有效的 [1,2]
    const alts = [
      [0, 1, 0, 1],
      [0, 0, 1, 1],
    ];
    const p = planned(planRemeasure([0, 0, 0, 0], alts, [0, 1, 2, 3], COLS));
    expect(p.points.map((pt) => pt.index)).toEqual([0, 3]);
    // 移除 0：A、B 仍各被 3 覆盖 → 无重现；移除 3：A、B 都重现
    expect(p.points[0].reappearing).toEqual([]);
    expect(p.points[1].reappearing).toEqual([0, 1]);
  });

  it('候选范围受限时只在其中选点', () => {
    // 差异单元为 1，但候选只有 {0,1} 之外的组合也能命中 → 必须含 1
    const alts = [[0, 2, 0, 0]];
    const p = planned(planRemeasure([0, 0, 0, 0], alts, [1, 3], COLS));
    expect(p.points.map((pt) => pt.index)).toEqual([1, 3]);
  });

  it('三点计划：两点无法覆盖时升级到三点', () => {
    // A 差异 {0,3}，B 差异 {1,4}，C 差异 {2,5}（6 单元矩阵，cols=3）
    const primary = [0, 0, 0, 0, 0, 0];
    const alts = [
      [1, 0, 0, 1, 0, 0],
      [0, 1, 0, 0, 1, 0],
      [0, 0, 1, 0, 0, 1],
    ];
    const p = planned(planRemeasure(primary, alts, [0, 1, 2, 3, 4, 5], 3));
    expect(p.points.map((pt) => pt.index)).toEqual([0, 1, 2]);
    expect(p.points[0].reappearing).toEqual([0]);
    expect(p.points[1].reappearing).toEqual([1]);
    expect(p.points[2].reappearing).toEqual([2]);
  });
});

describe('planRemeasure 无法区分', () => {
  it('候选范围外的差异 → 报告首个未被区分矩阵与差异单元', () => {
    const alts = [
      [1, 0, 0, 0], // 差异 {0}，可被候选覆盖
      [0, 0, 0, 7], // 差异 {3}，候选 {0,1} 覆盖不到
    ];
    const r = planRemeasure([0, 0, 0, 0], alts, [0, 1], COLS);
    expect(r.status).toBe('indistinguishable');
    if (r.status === 'indistinguishable') {
      expect(r.altIndex).toBe(1);
      expect(r.matrix).toEqual([0, 0, 0, 7]);
      expect(r.diffCells).toEqual([3]);
    }
  });

  it('按给定顺序报告首个未被区分的矩阵', () => {
    const alts = [
      [0, 0, 0, 7], // 差异 {3}
      [0, 0, 5, 0], // 差异 {2}
    ];
    const r = planRemeasure([0, 0, 0, 0], alts, [0, 1], COLS);
    expect(r.status).toBe('indistinguishable');
    if (r.status === 'indistinguishable') {
      expect(r.altIndex).toBe(0);
      expect(r.diffCells).toEqual([3]);
    }
  });
});

describe('常量约定', () => {
  it('测点数限制为 2–10', () => {
    expect(MIN_PLAN_POINTS).toBe(2);
    expect(MAX_PLAN_POINTS).toBe(10);
  });
});
