/* MEDI PdM 사내 배포용 공통 설정 (선택)
 *
 * 사용법: 이 파일을 config.js 로 복사해 값을 수정하면, 같은 웹서버/공유폴더에서
 * index.html을 여는 모든 PC에 기본값으로 적용됩니다 (한 번만 하드코딩).
 * 각 PC에서 설정 화면으로 저장한 개인 설정이 있으면 그것이 우선합니다.
 * config.js가 없으면 조용히 무시됩니다.
 */
window.MEDI_CONFIG = {
  mode: 'gateway',                        // 'demo' | 'gateway' | 'csv'
  gatewayUrl: 'http://historian-pc:8137', // 게이트웨이(backend/) 주소 — 사내망 호스트명/IP
  histDays: 7,                            // 불러올 과거 데이터 기간(일)
  recentHours: 24,                        // 진단 최근창(시간)
  autoRefresh: true,                      // 60초 자동 갱신
  notify: false,                          // 브라우저 알림 기본값 (개인별 옵트인 권장)
};
