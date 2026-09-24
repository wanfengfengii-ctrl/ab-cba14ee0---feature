import { useMemo, useState } from 'react';
import {
  parseMatrixText,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  type Evaluation,
  type Issue,
  type RawInputs,
  type TiedInfo,
} from './solver/solver';
import {
  MAX_PLAN_POINTS,
  MIN_PLAN_POINTS,
  planRemeasure,
} from './solver/remeasure';
import { useUnwrap } from './useUnwrap';

/* ---------------- 默认与示例 ---------------- */

const DEFAULT: RawInputs = {
  rows: 3,
  cols: 3,
  cells: ['0', '3', '6', '5', '0', '3', '2', '5', '0'],
  period: '8',
  cycleMin: '-1',
  cycleMax: '1',
  jumpCap: '1',
  anchorRow: 0,
  anchorCol: 0,
  anchorCycles: '0',
};

const RAMP: RawInputs = {
  rows: 4,
  cols: 4,
  cells: [
    '0', '1', '2', '3',
    '3', '0', '1', '2',
    '2', '3', '0', '1',
    '1', '2', '3', '0',
  ],
  period: '4',
  cycleMin: '0',
  cycleMax: '1',
  jumpCap: '1',
  anchorRow: 0,
  anchorCol: 0,
  anchorCycles: '0',
};

/* ---------------- 小部件 ---------------- */

const EMPTY_SET: Set<number> = new Set();

function NumberField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  hint?: string;
  width?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <input
        className={props.invalid ? 'input input-bad' : 'input'}
        value={props.value}
        inputMode="numeric"
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
        style={props.width ? { width: props.width } : undefined}
      />
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  );
}

function MatrixView(props: {
  rows: number;
  cols: number;
  values: number[];
  badge: number[];
  mark?: Set<number>;
  anchorIndex?: number;
  title: string;
  caption?: string;
}) {
  const { rows, cols } = props;
  return (
    <div className="result-block">
      <h4>{props.title}</h4>
      {props.caption && <p className="caption">{props.caption}</p>}
      <div
        className="matrix-view"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(64px, 1fr))` }}
      >
        {Array.from({ length: rows * cols }, (_, i) => {
          const r = Math.floor(i / cols);
          const c = i % cols;
          return (
            <div
              key={i}
              className={
                'mv-cell' +
                (props.mark?.has(i) ? ' mv-mark' : '') +
                (props.anchorIndex === i ? ' mv-anchor' : '')
              }
              title={`第 ${r + 1} 行第 ${c + 1} 列`}
            >
              <span className="mv-coord">
                {r + 1},{c + 1}
              </span>
              <span className="mv-value">{props.values[i]}</span>
              <span className="mv-badge">k = {props.badge[i]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- 主组件 ---------------- */

export default function App(props: { initial?: RawInputs }) {
  const [raw, setRaw] = useState<RawInputs>(props.initial ?? DEFAULT);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<{ message: string; row?: number; col?: number } | null>(null);

  /*
   * 补测候选范围（可触达单元）。选择随所属输入一起记录：
   * 原始输入一旦变化（patch 必产生新对象），旧候选与旧计划立即失效撤下，
   * 计量员需针对新输入重新选定候选范围。
   */
  const [selection, setSelection] = useState<{ owner: RawInputs; cells: Set<number> }>({
    owner: raw,
    cells: new Set(),
  });
  const selectedCells = selection.owner === raw ? selection.cells : EMPTY_SET;
  const toggleCandidate = (i: number) => {
    const next = new Set(selectedCells);
    if (next.has(i)) {
      next.delete(i);
    } else {
      if (next.size >= MAX_PLAN_POINTS) return;
      next.add(i);
    }
    setSelection({ owner: raw, cells: next });
  };
  const setCandidates = (cells: number[]) =>
    setSelection({ owner: raw, cells: new Set(cells) });

  const patch = (p: Partial<RawInputs>) => setRaw((s) => ({ ...s, ...p }));

  /* 输入一变：旧结果立即撤下（置空），由 Worker 重新裁决 */
  const { evaluation } = useUnwrap(raw);

  const issues: Issue[] = evaluation?.status === 'invalid' ? evaluation.issues : [];
  const cellIssues = new Map<number, string>();
  const fieldIssues = new Map<string, string>();
  for (const iss of issues) {
    if (iss.kind === 'cell') cellIssues.set(iss.row * raw.cols + iss.col, iss.message);
    if (iss.kind === 'field') fieldIssues.set(iss.field, iss.message);
  }

  const anchorIndex = raw.anchorRow * raw.cols + raw.anchorCol;
  const dimBad = issues.some((i) => i.kind === 'dim');

  const setCell = (i: number, text: string) => {
    const cells = raw.cells.slice();
    cells[i] = text;
    patch({ cells });
  };

  const resize = (rows: number, cols: number) => {
    const cells: string[] = new Array(rows * cols).fill('0');
    for (let r = 0; r < Math.min(rows, raw.rows); r++) {
      for (let c = 0; c < Math.min(cols, raw.cols); c++) {
        cells[r * cols + c] = raw.cells[r * raw.cols + c];
      }
    }
    setRaw((s) => ({
      ...s,
      rows,
      cols,
      cells,
      anchorRow: Math.min(s.anchorRow, rows - 1),
      anchorCol: Math.min(s.anchorCol, cols - 1),
    }));
  };

  const applyImport = () => {
    const parsed = parseMatrixText(importText);
    if (!parsed.ok) {
      setImportError({ message: parsed.error, row: parsed.row, col: parsed.col });
      return;
    }
    setImportError(null);
    patch({
      rows: parsed.rows,
      cols: parsed.cols,
      cells: parsed.values.flat().map(String),
      anchorRow: Math.min(raw.anchorRow, parsed.rows - 1),
      anchorCol: Math.min(raw.anchorCol, parsed.cols - 1),
    });
  };

  const edgeMark = new Set<number>();
  let failCellIndex: number | null = null;
  if (evaluation?.status === 'unsat') {
    for (const e of evaluation.result.edgeFailures) {
      edgeMark.add(e.r1 * raw.cols + e.c1);
      edgeMark.add(e.r2 * raw.cols + e.c2);
    }
    if (evaluation.result.failCell) {
      failCellIndex = evaluation.result.failCell.row * raw.cols + evaluation.result.failCell.col;
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>干涉相位展开台</h1>
        <p>
          每格真实相位 <code>Φ = 读数 + 圈数 × 周期</code>。在锚点、全局圈数区间与相邻跳变上限约束下，
          依次最小化 <strong>横纵连续三格二阶差分绝对值之和</strong>、<strong>相邻差绝对值之和</strong>，
          再取行优先圈数序列字典序最小者。
        </p>
      </header>

      <div className="layout">
        {/* ---------------- 左：输入 ---------------- */}
        <section className="card">
          <h2>① 读数矩阵</h2>
          <div className="row-controls">
            <label className="field">
              <span className="field-label">行数</span>
              <select
                className="input narrow"
                value={raw.rows}
                onChange={(e) => resize(Number(e.target.value), raw.cols)}
              >
                {range(MIN_ROWS, MAX_ROWS).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">列数</span>
              <select
                className="input narrow"
                value={raw.cols}
                onChange={(e) => resize(raw.rows, Number(e.target.value))}
              >
                {range(MIN_COLS, MAX_COLS).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <div className="spacer" />
            <button type="button" className="btn ghost" onClick={() => setRaw(DEFAULT)}>
              载入示例 A
            </button>
            <button type="button" className="btn ghost" onClick={() => setRaw(RAMP)}>
              载入示例 B
            </button>
          </div>

          <div
            className={'grid-inputs' + (dimBad ? ' dim-bad' : '')}
            style={{ gridTemplateColumns: `repeat(${raw.cols}, minmax(76px, 1fr))` }}
          >
            {raw.cells.map((text, i) => {
              const r = Math.floor(i / raw.cols);
              const c = i % raw.cols;
              const isAnchor = raw.anchorRow === r && raw.anchorCol === c;
              const err = cellIssues.get(i);
              const marked =
                evaluation?.status === 'unsat' &&
                (edgeMark.has(i) || failCellIndex === i);
              return (
                <div
                  key={i}
                  className={
                    'cell-wrap' +
                    (isAnchor ? ' is-anchor' : '') +
                    (err || marked ? ' is-bad' : '')
                  }
                >
                  <span className="cell-coord">
                    {r + 1},{c + 1}
                  </span>
                  <input
                    className={'cell-input' + (err ? ' input-bad' : '')}
                    value={text}
                    inputMode="numeric"
                    spellCheck={false}
                    aria-label={`第 ${r + 1} 行第 ${c + 1} 列读数`}
                    onChange={(e) => setCell(i, e.target.value)}
                  />
                  <button
                    type="button"
                    className={'anchor-btn' + (isAnchor ? ' on' : '')}
                    title="把该格设为锚点"
                    onClick={() => patch({ anchorRow: r, anchorCol: c })}
                  >
                    {isAnchor ? '⚓ 锚点' : '设锚'}
                  </button>
                </div>
              );
            })}
          </div>
          <p className="hint">
            蓝框为锚点（真实相位由此格指定）；红框为非法单元或无解定位。
          </p>

          <h2>② 参数</h2>
          <div className="params">
            <NumberField
              label="周期 P（正整数）"
              value={raw.period}
              onChange={(v) => patch({ period: v })}
              invalid={fieldIssues.has('period')}
              width="96px"
            />
            <NumberField
              label="圈数下限"
              value={raw.cycleMin}
              onChange={(v) => patch({ cycleMin: v })}
              invalid={fieldIssues.has('cycleMin')}
              width="96px"
            />
            <NumberField
              label="圈数上限"
              value={raw.cycleMax}
              onChange={(v) => patch({ cycleMax: v })}
              invalid={fieldIssues.has('cycleMax')}
              hint="区间至多 3 个整数"
              width="96px"
            />
            <NumberField
              label="相邻跳变上限（圈）"
              value={raw.jumpCap}
              onChange={(v) => patch({ jumpCap: v })}
              invalid={fieldIssues.has('jumpCap')}
              hint="|ΔΦ| ≤ 上限 × P"
              width="96px"
            />
            <label className="field">
              <span className="field-label">锚点行</span>
              <select
                className="input narrow"
                value={raw.anchorRow}
                onChange={(e) => patch({ anchorRow: Number(e.target.value) })}
              >
                {range(0, raw.rows - 1).map((n) => (
                  <option key={n} value={n}>{n + 1}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">锚点列</span>
              <select
                className="input narrow"
                value={raw.anchorCol}
                onChange={(e) => patch({ anchorCol: Number(e.target.value) })}
              >
                {range(0, raw.cols - 1).map((n) => (
                  <option key={n} value={n}>{n + 1}</option>
                ))}
              </select>
            </label>
            <NumberField
              label="锚点真实圈数"
              value={raw.anchorCycles}
              onChange={(v) => patch({ anchorCycles: v })}
              invalid={fieldIssues.has('anchorCycles')}
              hint="须在圈数区间内"
              width="96px"
            />
          </div>

          <h2>③ 导入读数</h2>
          <p className="hint">每行一行，单元间用逗号、空格或制表符分隔；导入后按其行列数重建矩阵。</p>
          <textarea
            className="textarea"
            rows={4}
            placeholder={'例如：\n0, 3, 6\n5, 0, 3\n2, 5, 0'}
            value={importText}
            onChange={(e) => {
              setImportText(e.target.value);
              setImportError(null);
            }}
          />
          <div className="row-controls">
            <button type="button" className="btn" onClick={applyImport}>
              导入并重建矩阵
            </button>
            {importError && (
              <span className="err-text">
                {importError.row ? `第 ${importError.row} 行${importError.col ? `第 ${importError.col} 列` : ''}：` : ''}
                {importError.message}
              </span>
            )}
          </div>
        </section>

        {/* ---------------- 右：结果 ---------------- */}
        <section className="card result-card">
          <h2>裁决结果</h2>

          {evaluation === null && (
            <div className="panel panel-pending">
              <h3>正在裁决…</h3>
              <p className="sub">输入已变化，旧结果已撤下，正在按新输入求解。</p>
            </div>
          )}

          {evaluation?.status === 'invalid' && (
            <div className="panel panel-bad">
              <h3>输入非法，已停止求解</h3>
              <ul className="issue-list">
                {issues.map((iss, idx) => {
                  if (iss.kind === 'cell') {
                    return (
                      <li key={idx}>
                        <button
                          type="button"
                          className="linklike"
                          onClick={() => focusCell(iss.row, iss.col)}
                        >
                          单元（{iss.row + 1}, {iss.col + 1}）
                        </button>
                        ：{iss.message}
                      </li>
                    );
                  }
                  if (iss.kind === 'field') {
                    return <li key={idx}>参数「{fieldLabel(iss.field)}」：{iss.message}</li>;
                  }
                  return <li key={idx}>{iss.message}</li>;
                })}
              </ul>
            </div>
          )}

          {evaluation?.status === 'unsat' && (
            <div className="panel panel-bad">
              <h3>无解</h3>
              <p>{evaluation.result.message}</p>
              {evaluation.result.edgeFailures.length > 0 && (
                <>
                  <p className="sub">下列相邻边在任意圈数选择下都无法满足跳变上限（矩阵中红框定位）：</p>
                  <ul className="issue-list">
                    {evaluation.result.edgeFailures.map((e, idx) => (
                      <li key={idx}>
                        （{e.r1 + 1}, {e.c1 + 1}）—（{e.r2 + 1}, {e.c2 + 1}）
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {evaluation.result.failCell && (
                <p className="sub">
                  按行优先传播，首个无法与已有格同时相容的位置：第{' '}
                  <strong>{evaluation.result.failCell.row + 1}</strong> 行第{' '}
                  <strong>{evaluation.result.failCell.col + 1}</strong> 列（红框）。
                </p>
              )}
            </div>
          )}

          {evaluation?.status === 'ok' && (
            <ResultView
              result={evaluation.result}
              tied={evaluation.tied}
              rows={raw.rows}
              cols={raw.cols}
              anchorIndex={anchorIndex}
              selectedCells={selectedCells}
              onToggleCandidate={toggleCandidate}
              onSetCandidates={setCandidates}
            />
          )}
        </section>
      </div>

      <footer className="page-footer">
        纯前端实现 · 全部计算在浏览器内完成 · React + TypeScript
      </footer>
    </div>
  );
}

/* ---------------- 结果展示 ---------------- */

function ResultView(props: {
  result: Extract<Evaluation, { status: 'ok' }>['result'];
  tied: TiedInfo;
  rows: number;
  cols: number;
  anchorIndex: number;
  selectedCells: Set<number>;
  onToggleCandidate: (i: number) => void;
  onSetCandidates: (cells: number[]) => void;
}) {
  const { result, rows, cols, anchorIndex } = props;
  const { primary, witness } = result;
  return (
    <>
      <div className="objectives">
        <div className="obj">
          <span className="obj-name">目标一 · 二阶差分绝对值之和</span>
          <span className="obj-value">{primary.objective2}</span>
        </div>
        <div className="obj">
          <span className="obj-name">目标二 · 相邻差绝对值之和</span>
          <span className="obj-value">{primary.objective1}</span>
        </div>
      </div>

      <MatrixView
        title="展开矩阵（真实相位 Φ）与逐格圈数"
        rows={rows}
        cols={cols}
        values={primary.unwrapped}
        badge={primary.cycles}
        anchorIndex={anchorIndex}
        caption="格内大字为 Φ = 读数 + k × P，下方徽标为该格裁决圈数 k。"
      />

      {witness ? (
        <details className="witness" open>
          <summary>
            两项目标并列：存在字典序更大的同分圈数序列 —— 点击查看第二小字典序见证
          </summary>
          <div className="objectives small">
            <div className="obj">
              <span className="obj-name">二阶和（并列）</span>
              <span className="obj-value">{witness.objective2}</span>
            </div>
            <div className="obj">
              <span className="obj-name">相邻差和（并列）</span>
              <span className="obj-value">{witness.objective1}</span>
            </div>
          </div>
          <MatrixView
            title="第二小字典序见证"
            rows={rows}
            cols={cols}
            values={witness.unwrapped}
            badge={witness.cycles}
            anchorIndex={anchorIndex}
            caption="与主解同样满足全部硬约束且两项目标值相同，但行优先圈数序列字典序严格更大，故不取。"
          />
        </details>
      ) : (
        <p className="ok-note">两项目标最优值下圈数序列唯一，无并列见证。</p>
      )}

      <RemeasurePanel
        primary={primary.cycles}
        tied={props.tied}
        hasWitness={witness !== null}
        rows={rows}
        cols={cols}
        selectedCells={props.selectedCells}
        onToggleCandidate={props.onToggleCandidate}
        onSetCandidates={props.onSetCandidates}
      />
    </>
  );
}

/* ---------------- 补测规划 ---------------- */

/** 紧凑圈数矩阵：仅展示逐格圈数，可标红指定单元 */
function CyclesGrid(props: {
  cycles: number[];
  rows: number;
  cols: number;
  mark?: Set<number>;
  title: string;
  caption?: string;
}) {
  const { rows, cols } = props;
  return (
    <div className="result-block">
      <h4>{props.title}</h4>
      {props.caption && <p className="caption">{props.caption}</p>}
      <div
        className="matrix-view"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(64px, 1fr))` }}
      >
        {Array.from({ length: rows * cols }, (_, i) => {
          const r = Math.floor(i / cols);
          const c = i % cols;
          return (
            <div
              key={i}
              className={'mv-cell' + (props.mark?.has(i) ? ' mv-mark' : '')}
              title={`第 ${r + 1} 行第 ${c + 1} 列`}
            >
              <span className="mv-coord">
                {r + 1},{c + 1}
              </span>
              <span className="mv-value">{props.cycles[i]}</span>
              <span className="mv-badge">k = {props.cycles[i]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RemeasurePanel(props: {
  primary: number[];
  tied: TiedInfo;
  hasWitness: boolean;
  rows: number;
  cols: number;
  selectedCells: Set<number>;
  onToggleCandidate: (i: number) => void;
  onSetCandidates: (cells: number[]) => void;
}) {
  const { primary, tied, hasWitness, rows, cols, selectedCells } = props;

  // 主见证之外的全部同分替代矩阵（tied.matrices 已按行优先字典序升序，首项即主见证）
  const alternatives = useMemo(
    () => (tied.truncated ? [] : tied.matrices.slice(1)),
    [tied],
  );

  // 替代矩阵相对主见证的差异单元并集（用于在候选网格中提示“争议”位置）
  const diffUnion = useMemo(() => {
    const set = new Set<number>();
    for (const m of alternatives) {
      for (let i = 0; i < primary.length; i++) if (m[i] !== primary[i]) set.add(i);
    }
    return set;
  }, [alternatives, primary]);

  /* 计划完全由当前主见证、替代矩阵集合与候选范围推导：
     原始输入或候选范围一变，旧计划立即被新推导取代（输入变化时整个结果区已先行撤下）。 */
  const plan = useMemo(
    () => planRemeasure(primary, alternatives, [...selectedCells], cols),
    [primary, alternatives, selectedCells, cols],
  );

  const pickDiffCells = () => props.onSetCandidates([...diffUnion].slice(0, MAX_PLAN_POINTS));

  return (
    <div className="remeasure">
      <h3>补测规划</h3>

      {!hasWitness && (
        <p className="ok-note" data-testid="remeasure-unique">
          当前结论唯一：不存在同等曲率与总变差的替代圈数矩阵，无需补测。
        </p>
      )}

      {hasWitness && tied.truncated && (
        <div className="panel panel-bad">
          <h3>替代矩阵过多</h3>
          <p className="sub">
            同等曲率与总变差的替代圈数矩阵数量超出可完整枚举的上限，无法保证完整比较，
            本轮暂不生成补测计划；请收紧圈数区间或相邻跳变上限后再试。
          </p>
        </div>
      )}

      {hasWitness && !tied.truncated && (
        <>
          <p className="caption">
            除主见证外仍有 <strong>{alternatives.length}</strong> 个同等曲率与总变差的替代圈数矩阵
            （按行优先字典序编号：替代 #1 即上方第二小字典序见证）。点击下方单元选定{' '}
            {MIN_PLAN_POINTS}–{MAX_PLAN_POINTS} 个可触达单元作为候选范围，
            系统将在其中完整比较全部子集，给出测点最少、行优先坐标字典序最小的补测计划；
            每个测点的测量真值取主见证圈数。
          </p>

          <div
            className="cand-grid"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(64px, 1fr))` }}
          >
            {Array.from({ length: rows * cols }, (_, i) => {
              const r = Math.floor(i / cols);
              const c = i % cols;
              const selected = selectedCells.has(i);
              const inPlan =
                plan.status === 'planned' && plan.points.some((pt) => pt.index === i);
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={`候选单元 ${r + 1}-${c + 1}`}
                  aria-pressed={selected}
                  className={
                    'cand-cell' +
                    (selected ? ' on' : '') +
                    (inPlan ? ' in-plan' : '') +
                    (diffUnion.has(i) ? ' has-diff' : '')
                  }
                  title={
                    `第 ${r + 1} 行第 ${c + 1} 列 · 主见证圈数 k=${primary[i]}` +
                    (diffUnion.has(i) ? ' · 替代矩阵在此存在分歧' : '')
                  }
                  onClick={() => props.onToggleCandidate(i)}
                >
                  <span className="cand-coord">
                    {r + 1},{c + 1}
                  </span>
                  <span className="cand-k">k={primary[i]}</span>
                </button>
              );
            })}
          </div>

          <div className="row-controls">
            <span className="hint">
              已选 {selectedCells.size} / {MAX_PLAN_POINTS} 个候选单元（至少 {MIN_PLAN_POINTS} 个）
            </span>
            <div className="spacer" />
            <button
              type="button"
              className="btn ghost"
              disabled={diffUnion.size === 0}
              onClick={pickDiffCells}
              title={
                diffUnion.size > MAX_PLAN_POINTS
                  ? `差异单元共 ${diffUnion.size} 个，先选前 ${MAX_PLAN_POINTS} 个`
                  : '选中全部存在分歧的单元'
              }
            >
              选中差异单元
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={selectedCells.size === 0}
              onClick={() => props.onSetCandidates([])}
            >
              清空
            </button>
          </div>

          {plan.status === 'need-candidates' && (
            <p className="hint" data-testid="remeasure-need">
              请至少选定 {MIN_PLAN_POINTS} 个候选单元（当前 {plan.count} 个），系统随即生成补测计划。
            </p>
          )}

          {plan.status === 'too-many-candidates' && (
            <p className="err-text">
              候选单元已达 {plan.count} 个，超过上限 {MAX_PLAN_POINTS} 个，请精简后再生成计划。
            </p>
          )}

          {plan.status === 'no-plan' && (
            <div className="panel panel-bad">
              <h3>候选范围内无有效计划</h3>
              <p className="sub">
                在 {MIN_PLAN_POINTS}–{MAX_PLAN_POINTS} 个测点的限制内，候选范围的任何子集都无法
                区分全部替代矩阵，请调整候选范围。
              </p>
            </div>
          )}

          {plan.status === 'indistinguishable' && (
            <div className="panel panel-bad" data-testid="remeasure-indistinguishable">
              <h3>候选范围不能区分全部替代解</h3>
              <p className="sub">
                首个未被区分的圈数矩阵（替代 #{plan.altIndex + 1}）在所有候选单元上都与主见证一致，
                无论怎样取舍候选子集都无法排除它。差异单元：
                {plan.diffCells
                  .map((i) => `（${Math.floor(i / cols) + 1}, ${(i % cols) + 1}）`)
                  .join('、')}
                —— 均不在候选范围内，请调整候选范围后重试。
              </p>
              <CyclesGrid
                title={`替代 #${plan.altIndex + 1} 的圈数矩阵（红框为与主见证的差异单元）`}
                cycles={plan.matrix}
                rows={rows}
                cols={cols}
                mark={new Set(plan.diffCells)}
              />
            </div>
          )}

          {plan.status === 'planned' && (
            <div className="panel panel-plan" data-testid="remeasure-planned">
              <h3>
                补测计划：{plan.points.length} 个测点即可区分全部 {plan.alternativeCount} 个替代矩阵
              </h3>
              <p className="sub">
                已完整比较候选范围的全部子集，此为测点最少、行优先坐标字典序最小的计划；
                各测点实测圈数若与预期一致，全部替代矩阵即被排除。
              </p>
              <ul className="plan-points">
                {plan.points.map((pt) => (
                  <li key={pt.index}>
                    <strong>
                      测点（{pt.row + 1}, {pt.col + 1}）
                    </strong>
                    ：预期圈数 k = {pt.expected}；移除该点后重新出现的替代见证：
                    {pt.reappearing.length > 0
                      ? pt.reappearing.map((a) => `#${a + 1}`).join('、')
                      : '无（该点为冗余测点，移除后计划仍有效）'}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------- 工具 ---------------- */

function range(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

function fieldLabel(f: string): string {
  return (
    {
      period: '周期',
      cycleMin: '圈数下限',
      cycleMax: '圈数上限',
      jumpCap: '相邻跳变上限',
      anchorCycles: '锚点圈数',
    } as Record<string, string>
  )[f] ?? f;
}

function focusCell(row: number, col: number) {
  const el = document.querySelector<HTMLInputElement>(
    `input[aria-label="第 ${row + 1} 行第 ${col + 1} 列读数"]`,
  );
  el?.focus();
  el?.select();
}
