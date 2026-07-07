/* MEDI 예지보전 — 룰베이스 진단 리포트 생성기
 * AI/API 키 없이 동작하는 한국어 종합 진단 리포트.
 * 온톨로지(고장모드 라이브러리) + 통계 분석 결과를 조합해 생성한다.
 * LLM은 추후 선택 기능 — 이 모듈이 기본 분석 경로다.
 * 브라우저(window.MEDI.report)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./ontology.js'), require('./analytics/health.js'));
  } else {
    root.MEDI = root.MEDI || {};
    root.MEDI.report = factory(root.MEDI.ontology, root.MEDI.health);
  }
})(typeof self !== 'undefined' ? self : this, function (ontology, health) {
  'use strict';

  const fmt = health.fmt;

  function gradeKo(grade) {
    return { good: '양호', watch: '관찰', warn: '주의', alarm: '경고', unknown: '판정불가' }[grade] || grade;
  }

  // 자산 하나에 대한 진단 리포트 (마크다운)
  function assetReport(asset, analysis, healthRes, opts) {
    const o = Object.assign({ now: null }, opts);
    const lines = [];
    const now = o.now ? new Date(o.now) : new Date();

    lines.push(`# ${asset.name} 진단 리포트`);
    lines.push(`- 생성: ${now.toLocaleString('ko-KR')} · 방식: 룰베이스 (통계 + ISO 14224 고장모드 매칭)`);
    lines.push(`- 위치: ${asset.areaName || ''} / ${asset.unitName || ''} · 설비등급: ${asset.criticality || '-'}`);
    lines.push('');

    if (!analysis || !analysis.ok) {
      lines.push(`> ⚠ 분석 불가: ${analysis ? analysis.reason : '데이터 없음'}`);
      return lines.join('\n');
    }

    // 1) 종합 판정
    lines.push(`## 1. 종합 판정: ${healthRes.score}점 (${gradeKo(healthRes.grade)})`);
    if (healthRes.parts.length) {
      lines.push('감점 요인:');
      for (const p of healthRes.parts) {
        lines.push(`- ${p.name} (−${p.penalty.toFixed(0)}점) — ${p.detail}`);
      }
    } else {
      lines.push('- 특이 감점 요인 없음. 정상 운전 범위 내.');
    }
    lines.push('');

    // 2) 고장모드 추정
    lines.push('## 2. 고장모드 추정 (증상 매칭)');
    const cands = (analysis.candidates || []).filter(c => c.score > 0.15).slice(0, 3);
    if (!cands.length) {
      lines.push('- 라이브러리 내 고장모드와 유의미하게 일치하는 증상 조합 없음.');
    }
    for (const c of cands) {
      const m = c.mode;
      lines.push(`### ${m.name} — 일치도 ${(c.score * 100).toFixed(0)}%`);
      lines.push(`- 메커니즘: ${m.mechanism}`);
      lines.push(`- 관측된 증상: ${c.matched.map(x => `${roleKo(asset, x.role)} ${health.patternKo(x.pattern)}(${(x.strength * 100).toFixed(0)}%)`).join(', ') || '없음'}`);
      if (c.missing.length) {
        lines.push(`- 미관측 증상(감별 포인트): ${c.missing.map(x => `${roleKo(asset, x.role)} ${health.patternKo(x.pattern)}`).join(', ')}`);
      }
      lines.push(`- 추정 원인: ${m.causes.join(' / ')}`);
      lines.push(`- 권고 조치: ${m.actions.join(' / ')}`);
      lines.push(`- 진행 속도 참고: ${m.leadTime}`);
      lines.push('');
    }

    // 3) 다변량 분석
    lines.push('## 3. 다변량 분석 (복합 신호)');
    if (analysis.mv) {
      const mv = analysis.mv;
      lines.push(`- PCA 주성분 ${mv.pcaK}개 유지 (설명분산 ${(mv.pcaVarRatio.reduce((a, b) => a + b, 0) * 100).toFixed(0)}%)`);
      lines.push(`- T² 위반율(최근): ${(mv.t2ViolFrac * 100).toFixed(0)}% — 운전점이 정상영역을 ${mv.t2ViolFrac > 0.3 ? '벗어나는 중' : '유지 중'}`);
      lines.push(`- SPE 위반율(최근): ${(mv.speViolFrac * 100).toFixed(0)}% — 신호 간 상관구조 ${mv.speViolFrac > 0.3 ? '붕괴 진행 (개별 태그가 정상범위라도 관계가 비정상)' : '정상'}`);
      if (mv.topContributors && mv.topContributors.length) {
        lines.push(`- 이상 기여 상위 태그: ${mv.topContributors.map(c => `${c.name}(${(c.share * 100).toFixed(0)}%)`).join(', ')}`);
      }
    } else {
      lines.push('- 다변량 모델 구성 불가 (태그 수 또는 학습 데이터 부족)');
    }
    lines.push('');

    // 4) 태그별 상세
    lines.push('## 4. 태그별 상세');
    lines.push('| 태그 | 설명 | 현재값 | 베이스라인 대비 | 변동성 | 추세(σ/h) | 판정 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const [tagId, d] of Object.entries(analysis.tagDiag || {})) {
      const flags = [];
      if (d.up > 0.3) flags.push('상승');
      if (d.down > 0.3) flags.push('하강');
      if (d.variance > 0.3) flags.push('변동성↑');
      if (d.spike > 0.3) flags.push('스파이크');
      if (d.high > 0.3) flags.push('상한접근');
      if (d.low > 0.3) flags.push('하한접근');
      lines.push(`| ${tagId} | ${d.desc || ''} | ${fmt(d.lastValue)}${d.unit || ''} | ${d.zShift >= 0 ? '+' : ''}${d.zShift.toFixed(1)}σ | ×${d.varRatio.toFixed(1)} | ${(d.slopePerHour / Math.max(d.baseStd, 1e-9)).toFixed(2)} | ${flags.join(', ') || '정상'} |`);
    }
    lines.push('');

    // 5) 파생지표
    const dd = Object.entries(analysis.derivedDiag || {});
    if (dd.length) {
      lines.push('## 5. 물리 파생지표');
      for (const [role, d] of dd) {
        const dir = d.zShift >= 0 ? '+' : '';
        const bad = d.aboveIsBad ? d.zShift > 1 : d.zShift < -1;
        lines.push(`- ${d.desc}: 베이스라인 대비 ${dir}${d.zShift.toFixed(1)}σ ${bad ? '⚠ 악화 추세' : '(정상 범위)'}`);
      }
      lines.push('');
    }

    // 6) 생산팀 공유 메모
    lines.push('## 6. 정비-생산 공유 메모');
    if (healthRes.grade === 'good') {
      lines.push('- 특이사항 없음. 다음 정기 감시 주기까지 현행 유지.');
    } else {
      const top = cands[0];
      lines.push(`- ${asset.id}에서 ${top ? `[${top.mode.name}] 의심 증상` : '통계적 이상 징후'}이 감지되었습니다.`);
      lines.push('- 생산팀 확인 요청: 최근 운전조건 변경(부하/원료/밸브 조작) 여부.');
      lines.push(`- 정비팀 조치: ${top ? top.mode.actions.slice(0, 2).join(', ') : '현장 육안점검 및 추세 감시 강화'}.`);
      if (healthRes.grade === 'alarm') lines.push('- **우선순위 높음 — 계획정지 전 예비기 전환/부하 저감 검토.**');
    }

    return lines.join('\n');
  }

  function roleKo(asset, role) {
    const tag = (asset.tags || []).find(t => t.role === role);
    if (tag) return `${tag.id}(${tag.desc})`;
    const names = {
      u_proxy: 'U값 프록시', approach: '접근온도차', eff_proxy: '효율 프록시',
      surge_margin: '서지마진', temp_ratio: '압축비보정 토출온도',
    };
    return names[role] || role;
  }

  // 전체 플랜트 요약 리포트
  function plantSummary(results, now) {
    const lines = [];
    const d = now ? new Date(now) : new Date();
    lines.push(`# 플랜트 설비건강 요약 (${d.toLocaleString('ko-KR')})`);
    lines.push('');
    lines.push('| 설비 | 건강지수 | 판정 | 최우선 의심 고장모드 | 일치도 |');
    lines.push('|---|---|---|---|---|');
    const sorted = results.slice().sort((a, b) => (a.health.score ?? 101) - (b.health.score ?? 101));
    for (const r of sorted) {
      const top = r.analysis && r.analysis.ok && r.analysis.candidates[0];
      lines.push(`| ${r.asset.name} | ${r.health.score ?? '-'} | ${gradeKo(r.health.grade)} | ${top && top.score > 0.2 ? top.mode.name : '-'} | ${top && top.score > 0.2 ? (top.score * 100).toFixed(0) + '%' : '-'} |`);
    }
    lines.push('');
    const worst = sorted[0];
    if (worst && worst.health.score !== null && worst.health.score < 85) {
      lines.push(`**우선 점검 대상: ${worst.asset.name} (${worst.health.score}점)** — 상세는 설비 리포트 참조.`);
    } else {
      lines.push('전 설비 양호 — 특이사항 없습니다.');
    }
    return lines.join('\n');
  }

  return { assetReport, plantSummary, gradeKo };
});
