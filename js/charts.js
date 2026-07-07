/* MEDI 예지보전 — 경량 캔버스 차트 엔진 (의존성 없음, 오프라인 동작)
 * lineChart: 시계열 다중 시리즈 + 임계선 + 밴드 + 이벤트 마커 + 호버 툴팁
 * sparkline, heatmap(상관행렬), gauge(건강지수)
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.MEDI = root.MEDI || {}; root.MEDI.charts = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FONT = '12px "Pretendard", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
  const PALETTE = ['#4fc3f7', '#ffb74d', '#81c784', '#f06292', '#ba68c8', '#4db6ac', '#fff176', '#a1887f', '#90a4ae', '#e57373'];

  function css(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  function theme() {
    return {
      grid: css('--chart-grid', 'rgba(140,160,180,0.15)'),
      axis: css('--chart-axis', 'rgba(160,180,200,0.55)'),
      text: css('--chart-text', '#9fb2c4'),
      tooltipBg: css('--chart-tooltip-bg', 'rgba(16,24,34,0.95)'),
      tooltipText: css('--chart-tooltip-text', '#dce8f2'),
    };
  }

  // HiDPI 대응 캔버스 준비 — 부모 폭에 맞춤
  function prep(canvas, height) {
    const dpr = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1;
    const w = canvas.parentElement ? canvas.parentElement.clientWidth : canvas.clientWidth || 600;
    const h = height || canvas.dataset.h || 220;
    canvas.width = Math.max(50, w) * dpr;
    canvas.height = h * dpr;
    canvas.style.width = Math.max(50, w) + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: Math.max(50, w), h: Number(h) };
  }

  // min-max 버킷 데시메이션: 화면 픽셀당 2점으로 축약 (스파이크 보존)
  function decimate(t, v, maxPts) {
    const n = t.length;
    if (n <= maxPts) return { t, v };
    const bucket = Math.ceil(n / (maxPts / 2));
    const ot = [], ov = [];
    for (let i = 0; i < n; i += bucket) {
      let lo = i, hi = i;
      for (let j = i; j < Math.min(i + bucket, n); j++) {
        if (v[j] < v[lo]) lo = j;
        if (v[j] > v[hi]) hi = j;
      }
      const a = Math.min(lo, hi), b = Math.max(lo, hi);
      ot.push(t[a]); ov.push(v[a]);
      if (b !== a) { ot.push(t[b]); ov.push(v[b]); }
    }
    return { t: ot, v: ov };
  }

  function niceTicks(lo, hi, count) {
    if (!isFinite(lo) || !isFinite(hi)) return [];
    if (lo === hi) { lo -= 1; hi += 1; }
    const span = hi - lo;
    const step0 = span / Math.max(2, count);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    let step = mag;
    for (const m of [1, 2, 2.5, 5, 10]) { if (step0 <= m * mag) { step = m * mag; break; } }
    const start = Math.ceil(lo / step) * step;
    const out = [];
    for (let x = start; x <= hi + 1e-9; x += step) out.push(Math.round(x / step) * step);
    return out;
  }

  function fmtNum(v) {
    if (!isFinite(v)) return '-';
    const a = Math.abs(v);
    if (a >= 10000) return v.toFixed(0);
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    return v.toFixed(3);
  }

  function fmtTime(ms, spanMs) {
    const d = new Date(ms);
    const p = x => String(x).padStart(2, '0');
    if (spanMs > 3 * 86400000) return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}시`;
    if (spanMs > 6 * 3600000) return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- 라인 차트 ----------
  // cfg: { series: [{name, t[], v[], color, dash, width}], thresholds: [{y, label, color}],
  //        bands: [{lo[], hi[], color}] (t는 series[0]과 공유), events: [{t, label, color}],
  //        vlines: [{t, label, color}], yLabel, height, yMin, yMax, legend(bool) }
  function lineChart(canvas, cfg) {
    const th = theme();
    const H = cfg.height || 220;
    const { ctx, w, h } = prep(canvas, H);
    const padL = 52, padR = 14, padT = cfg.legend === false ? 10 : 24, padB = 22;
    const iw = w - padL - padR, ih = h - padT - padB;
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;

    const series = (cfg.series || []).filter(s => s.t && s.t.length > 1);
    if (!series.length) {
      ctx.fillStyle = th.text;
      ctx.fillText('데이터 없음', padL + 10, padT + 30);
      return null;
    }

    // 범위 계산
    let t0 = Infinity, t1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of series) {
      t0 = Math.min(t0, s.t[0]); t1 = Math.max(t1, s.t[s.t.length - 1]);
      for (const v of s.v) if (isFinite(v)) { y0 = Math.min(y0, v); y1 = Math.max(y1, v); }
    }
    for (const tl of cfg.thresholds || []) { y0 = Math.min(y0, tl.y); y1 = Math.max(y1, tl.y); }
    for (const b of cfg.bands || []) {
      for (const v of b.lo) if (isFinite(v)) y0 = Math.min(y0, v);
      for (const v of b.hi) if (isFinite(v)) y1 = Math.max(y1, v);
    }
    if (cfg.yMin !== undefined) y0 = cfg.yMin;
    if (cfg.yMax !== undefined) y1 = cfg.yMax;
    const yPad = (y1 - y0) * 0.08 || 1;
    if (cfg.yMin === undefined) y0 -= yPad;
    if (cfg.yMax === undefined) y1 += yPad;

    const X = t => padL + ((t - t0) / Math.max(t1 - t0, 1)) * iw;
    const Y = v => padT + (1 - (v - y0) / Math.max(y1 - y0, 1e-12)) * ih;

    // 그리드 + 축
    ctx.strokeStyle = th.grid; ctx.lineWidth = 1;
    const yt = niceTicks(y0, y1, 5);
    for (const v of yt) {
      ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(w - padR, Y(v)); ctx.stroke();
      ctx.fillStyle = th.text; ctx.textAlign = 'right';
      ctx.fillText(fmtNum(v), padL - 6, Y(v) + 4);
    }
    const span = t1 - t0;
    const xtCount = Math.max(3, Math.floor(iw / 110));
    for (let i = 0; i <= xtCount; i++) {
      const t = t0 + (span * i) / xtCount;
      ctx.strokeStyle = th.grid;
      ctx.beginPath(); ctx.moveTo(X(t), padT); ctx.lineTo(X(t), h - padB); ctx.stroke();
      ctx.fillStyle = th.text; ctx.textAlign = 'center';
      ctx.fillText(fmtTime(t, span), X(t), h - 7);
    }

    // 밴드 (관리한계 영역 등)
    for (const b of cfg.bands || []) {
      const bt = b.t || series[0].t;
      ctx.beginPath();
      for (let i = 0; i < bt.length; i++) {
        const x = X(bt[i]), y = Y(b.hi[i]);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      for (let i = bt.length - 1; i >= 0; i--) ctx.lineTo(X(bt[i]), Y(b.lo[i]));
      ctx.closePath();
      ctx.fillStyle = b.color || 'rgba(79,195,247,0.08)';
      ctx.fill();
    }

    // 시리즈
    series.forEach((s, si) => {
      const dec = decimate(s.t, s.v, iw * 2.5);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < dec.t.length; i++) {
        if (!isFinite(dec.v[i])) { started = false; continue; }
        const x = X(dec.t[i]), y = Y(dec.v[i]);
        if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
      }
      ctx.strokeStyle = s.color || PALETTE[si % PALETTE.length];
      ctx.lineWidth = s.width || 1.6;
      ctx.setLineDash(s.dash || []);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // 임계선
    for (const tl of cfg.thresholds || []) {
      ctx.strokeStyle = tl.color || '#ef5350';
      ctx.setLineDash([6, 4]); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(padL, Y(tl.y)); ctx.lineTo(w - padR, Y(tl.y)); ctx.stroke();
      ctx.setLineDash([]);
      if (tl.label) {
        ctx.fillStyle = tl.color || '#ef5350'; ctx.textAlign = 'left';
        ctx.fillText(tl.label, padL + 4, Y(tl.y) - 4);
      }
    }

    // 수직 이벤트 라인
    for (const vl of cfg.vlines || []) {
      ctx.strokeStyle = vl.color || 'rgba(255,213,79,0.7)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(vl.t), padT); ctx.lineTo(X(vl.t), h - padB); ctx.stroke();
      ctx.setLineDash([]);
      if (vl.label) {
        ctx.fillStyle = vl.color || '#ffd54f'; ctx.textAlign = 'left';
        ctx.fillText(vl.label, X(vl.t) + 3, padT + 10);
      }
    }

    // 범례
    if (cfg.legend !== false && series.length) {
      let lx = padL;
      series.forEach((s, si) => {
        const color = s.color || PALETTE[si % PALETTE.length];
        ctx.fillStyle = color;
        ctx.fillRect(lx, 8, 10, 3);
        ctx.fillStyle = th.text; ctx.textAlign = 'left';
        ctx.fillText(s.name || `S${si + 1}`, lx + 14, 13);
        lx += 24 + ctx.measureText(s.name || `S${si + 1}`).width;
      });
    }

    // 호버 툴팁
    const state = { series, X, Y, t0, t1, y0, y1, padL, padR, padT, padB, w, h, span, cfg };
    attachTooltip(canvas, state);
    return state;
  }

  function attachTooltip(canvas, st) {
    if (canvas._mediTipAttached) { canvas._mediTipState = st; return; }
    canvas._mediTipAttached = true;
    canvas._mediTipState = st;

    canvas.addEventListener('mousemove', function (ev) {
      const s = canvas._mediTipState;
      if (!s) return;
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      if (mx < s.padL || mx > s.w - s.padR) { redraw(canvas); return; }
      redraw(canvas);
      const ctx = canvas.getContext('2d');
      const t = s.t0 + ((mx - s.padL) / (s.w - s.padL - s.padR)) * (s.t1 - s.t0);
      ctx.strokeStyle = 'rgba(200,220,240,0.4)';
      ctx.beginPath(); ctx.moveTo(mx, s.padT); ctx.lineTo(mx, s.h - s.padB); ctx.stroke();

      const th = theme();
      const rows = [];
      for (let si = 0; si < s.series.length; si++) {
        const sr = s.series[si];
        const idx = nearestIdx(sr.t, t);
        if (idx < 0) continue;
        rows.push({ name: sr.name || `S${si + 1}`, v: sr.v[idx], color: sr.color || PALETTE[si % PALETTE.length] });
      }
      if (!rows.length) return;
      ctx.font = FONT;
      const title = fmtTime(t, 0) + ' (' + new Date(t).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) + ')';
      let bw = ctx.measureText(title).width;
      for (const r of rows) bw = Math.max(bw, ctx.measureText(`${r.name}: ${fmtNum(r.v)}`).width + 14);
      bw += 16;
      const bh = 18 + rows.length * 15;
      let bx = mx + 10;
      if (bx + bw > s.w) bx = mx - bw - 10;
      const by = s.padT + 6;
      ctx.fillStyle = th.tooltipBg;
      ctx.strokeStyle = 'rgba(140,170,200,0.35)';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(bx, by, bw, bh, 5) : ctx.rect(bx, by, bw, bh);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = th.tooltipText; ctx.textAlign = 'left';
      ctx.fillText(title, bx + 8, by + 13);
      rows.forEach((r, i) => {
        ctx.fillStyle = r.color;
        ctx.fillRect(bx + 8, by + 21 + i * 15, 8, 3);
        ctx.fillStyle = th.tooltipText;
        ctx.fillText(`${r.name}: ${fmtNum(r.v)}`, bx + 20, by + 26 + i * 15);
      });
    });
    canvas.addEventListener('mouseleave', function () { redraw(canvas); });
  }

  function redraw(canvas) {
    const s = canvas._mediTipState;
    if (s && s.cfg) lineChartNoTip(canvas, s);
  }

  function lineChartNoTip(canvas, st) {
    // 툴팁 지우기용 재렌더 — attach 없이 본체만 다시 그림
    const attached = canvas._mediTipAttached;
    canvas._mediTipAttached = true; // attachTooltip 재등록 방지
    lineChart(canvas, st.cfg);
    canvas._mediTipAttached = attached;
  }

  function nearestIdx(ts, t) {
    if (!ts.length) return -1;
    let lo = 0, hi = ts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] < t) lo = mid; else hi = mid;
    }
    return (Math.abs(ts[lo] - t) < Math.abs(ts[hi] - t)) ? lo : hi;
  }

  // ---------- 스파크라인 ----------
  function sparkline(canvas, values, opts) {
    const o = Object.assign({ color: '#4fc3f7', height: 36, fill: true }, opts);
    const { ctx, w, h } = prep(canvas, o.height);
    ctx.clearRect(0, 0, w, h);
    const vs = values.filter(isFinite);
    if (vs.length < 2) return;
    let lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
    if (lo === hi) { lo -= 1; hi += 1; }
    const X = i => (i / (values.length - 1)) * (w - 4) + 2;
    const Y = v => 3 + (1 - (v - lo) / (hi - lo)) * (h - 8);
    ctx.beginPath();
    values.forEach((v, i) => { i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); });
    ctx.strokeStyle = o.color; ctx.lineWidth = 1.3; ctx.stroke();
    if (o.fill) {
      ctx.lineTo(X(values.length - 1), h); ctx.lineTo(X(0), h); ctx.closePath();
      ctx.fillStyle = o.color.replace(')', ',0.12)').replace('rgb', 'rgba').replace('#', '#');
      try { ctx.fill(); } catch (e) { /* 색상 파싱 실패 시 무시 */ }
    }
  }

  // ---------- 상관행렬 히트맵 ----------
  function heatmap(canvas, matrix, labels, opts) {
    const o = Object.assign({ height: null }, opts);
    const n = matrix.length;
    const labelW = 64;
    const size = o.height ? Math.floor((o.height - labelW) / n) : 26;
    const H = n * size + labelW + 8;
    const { ctx, w, h } = prep(canvas, H);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px "Pretendard", "Malgun Gothic", sans-serif';
    const cell = Math.min(size, (w - labelW - 8) / n);
    const ox = labelW, oy = 4;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const r = matrix[i][j];
        // -1(청) ~ 0(어두움) ~ +1(적)
        const mag = Math.min(1, Math.abs(r));
        const col = r >= 0
          ? `rgba(239,83,80,${0.08 + 0.8 * mag})`
          : `rgba(66,165,245,${0.08 + 0.8 * mag})`;
        ctx.fillStyle = col;
        ctx.fillRect(ox + j * cell, oy + i * cell, cell - 1, cell - 1);
        if (cell >= 22) {
          ctx.fillStyle = mag > 0.55 ? '#fff' : theme().text;
          ctx.textAlign = 'center';
          ctx.fillText(r.toFixed(1), ox + j * cell + cell / 2, oy + i * cell + cell / 2 + 3);
        }
      }
    }
    ctx.fillStyle = theme().text;
    for (let i = 0; i < n; i++) {
      ctx.textAlign = 'right';
      ctx.fillText(labels[i], ox - 4, oy + i * cell + cell / 2 + 3);
      ctx.save();
      ctx.translate(ox + i * cell + cell / 2 + 3, oy + n * cell + 4);
      ctx.rotate(Math.PI / 3);
      ctx.textAlign = 'left';
      ctx.fillText(labels[i], 0, 0);
      ctx.restore();
    }
  }

  // ---------- 산점도 (군집/회귀 시각화) ----------
  // cfg: { points: [{x, y, c}], xLabel, yLabel, height, colors, centroids: [[x,y],...], line: {slope, intercept} }
  function scatter(canvas, cfg) {
    const th = theme();
    const { ctx, w, h } = prep(canvas, cfg.height || 260);
    const padL = 52, padR = 14, padT = 12, padB = 30;
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;
    const pts = (cfg.points || []).filter(p => isFinite(p.x) && isFinite(p.y));
    if (!pts.length) { ctx.fillStyle = th.text; ctx.fillText('데이터 없음', padL, padT + 20); return; }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    const xp = (x1 - x0) * 0.06 || 1, yp = (y1 - y0) * 0.08 || 1;
    x0 -= xp; x1 += xp; y0 -= yp; y1 += yp;
    const X = x => padL + ((x - x0) / (x1 - x0)) * (w - padL - padR);
    const Y = y => padT + (1 - (y - y0) / (y1 - y0)) * (h - padT - padB);
    ctx.strokeStyle = th.grid;
    for (const v of niceTicks(y0, y1, 5)) {
      ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(w - padR, Y(v)); ctx.stroke();
      ctx.fillStyle = th.text; ctx.textAlign = 'right'; ctx.fillText(fmtNum(v), padL - 6, Y(v) + 4);
    }
    for (const v of niceTicks(x0, x1, 6)) {
      ctx.beginPath(); ctx.moveTo(X(v), padT); ctx.lineTo(X(v), h - padB); ctx.stroke();
      ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.fillText(fmtNum(v), X(v), h - 10);
    }
    const colors = cfg.colors || PALETTE;
    for (const p of pts) {
      ctx.fillStyle = colors[(p.c || 0) % colors.length];
      ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (let i = 0; i < (cfg.centroids || []).length; i++) {
      const c = cfg.centroids[i];
      ctx.strokeStyle = '#fff'; ctx.fillStyle = colors[i % colors.length];
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(X(c[0]), Y(c[1]), 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    if (cfg.line) {
      ctx.strokeStyle = '#ef5350'; ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(X(x0), Y(cfg.line.slope * x0 + cfg.line.intercept));
      ctx.lineTo(X(x1), Y(cfg.line.slope * x1 + cfg.line.intercept));
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle = th.text;
    if (cfg.xLabel) { ctx.textAlign = 'center'; ctx.fillText(cfg.xLabel, (padL + w - padR) / 2, h - 0.5); }
    if (cfg.yLabel) {
      ctx.save(); ctx.translate(11, (padT + h - padB) / 2); ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center'; ctx.fillText(cfg.yLabel, 0, 0); ctx.restore();
    }
  }

  // ---------- 건강지수 게이지 (도넛) ----------
  function gauge(canvas, score, opts) {
    const o = Object.assign({ size: 84 }, opts);
    const dpr = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1;
    canvas.width = o.size * dpr; canvas.height = o.size * dpr;
    canvas.style.width = o.size + 'px'; canvas.style.height = o.size + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, o.size, o.size);
    const c = o.size / 2, r = c - 7;
    const color = score === null ? '#78909c'
      : score >= 85 ? '#66bb6a' : score >= 70 ? '#ffca28' : score >= 50 ? '#ff9800' : '#ef5350';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(120,144,156,0.25)';
    ctx.beginPath(); ctx.arc(c, c, r, -Math.PI / 2, Math.PI * 1.5); ctx.stroke();
    if (score !== null) {
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + (score / 100) * Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.round(o.size / 3.4)}px "Pretendard", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(score === null ? '-' : String(score), c, c + o.size / 10);
  }

  return { lineChart, sparkline, heatmap, gauge, scatter, PALETTE, decimate, niceTicks, fmtNum, fmtTime, nearestIdx };
});
